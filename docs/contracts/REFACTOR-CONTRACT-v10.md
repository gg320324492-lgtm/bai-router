# REFACTOR-CONTRACT v10 — Qoder 中转两个已确证 bug（v1.0.58）

**单个 agent 的任务，独占 `src/server/server.mjs`。** 与 WorkBuddy 令牌捕获（v1.0.59，另一契约）**互斥——两个任务不能同时改 server.mjs**，必须串行或由我（编排者）依次派发。

本契约只覆盖以下两个 bug。**不要动 WorkBuddy 令牌捕获的任何代码**（`WB_CAPTURE_HOOK` / `wbCaptureToken` / `wbCaptureRestore` / `findWbCliScript`）。

---

## 背景（我已实测确证，可采信）

用户报告「本机 Qoder 接入失败」。我实测：**中转和上游全是通的**（200），所以不是接入问题。但排查过程中确证了两个真实 bug。

**端口对照（别搞错，我一开始就把 15742 当成了总入口）：**

| 提供方 | relayPort |
|---|---|
| bai | 15722 |
| sn  | 15732 |
| wb  | **15742** |
| zen | 15752 |
| qd  | **15762** |

---

## Bug A — 5xx 响应不落盘诊断（诊断盲区）

**位置**：`server.mjs` 的 `openaiExchange` 里，4xx 诊断落盘那一段：

```js
if (r.status >= 400 && r.status < 500) {
  try { writeFileSync(path.join(DATA_DIR, "wb-last-4xx.json"), bodyStr); } catch { }
  log(`${NAME} 上游 ${r.status} 拒绝了请求，翻译后请求体已存 wb-last-4xx.json：...`);
}
```

**问题**：只在 **4xx** 时落盘。Qoder 返回 **500 `internal server error`** 时（我日志里出现 38 次），**没有任何存证**，只能看到一行摘要，无法判断是上游真错还是中转翻译错。我为此多花了很久。

**要做的**：
1. 5xx 也落盘，写到**另一个文件**（如 `wb-last-5xx.json`），**不要覆盖** 4xx 的存证（两者都要留着，可能同时发生）。
2. 5xx 的 log 文案要如实说「上游 5xx」，不要复用 4xx 那句「拒绝了请求」——500 是服务端错，措辞要区分。
3. 顺带在该 log 里补一行**关键上下文**，方便下次一眼定位：`model`、`max_tokens`、`stream`、`messages` 条数。现在只打了 `system 首行`，对 Qoder 的 500 不够用。

**注意**：`bodyStr` 是翻译后的 OpenAI 请求体（可能很大，你的日志里实测到 1.3MB）。**落盘要防爆盘**：
- 超过一定大小（建议 2MB）就截断并注明「已截断」；
- 或者只保留最近 N 份（覆盖写即可，因为文件名带语义）。
- 你判断并说明理由。

---

## Bug B — 非 POST / 非 JSON 请求被误判成「坏请求体」

**位置**：`makeRelay` 的 `req.on("end")` 回调 + `handleUpstream` 的 `if (fo.opts.openai)` 分支。

**复现（实测）**：

```bash
curl http://127.0.0.1:15762/api/status
# → {"type":"error","error":{"message":"[Qoder] 请求体必须是 Anthropic messages JSON"}}
```

**原因链**：
- `makeRelay` 里只有 `if (body.length && ct.includes("json"))` 才解析，`rewritten` 才有值；
- `GET` 请求没有 body → `rewritten === null`；
- `handleUpstream` 里 `if (fo.opts.openai) { if (!rewritten) return wbAnthroError(res, 400, "请求体必须是 Anthropic messages JSON"); }`

于是**任何 GET、任何 body 不是合法 JSON 的请求**，在 wb / zen / qd 三个 `openai:true` 渠道上一律返回这个误导性的 400。**真正的病根是「请求本来就不该被当成一次模型调用」。**

**要做的**：分两层判断，语义要准：

1. **不是一次模型调用**（`GET`、或 `req.method !== "POST"`、或 url 不是 `/v1/messages*` 之类）→ **不要走 openai 桥**，按中转自身能力返回（例如返回 405，或对 `/api/status` 这类路径直接不进 relay 路由）。
   - **先查清楚**：`GET /api/status` 是**谁**在处理？我看到 `/api/status` 由面板的 server（2614 行）注册，但它**同时**出现在 15762 中转端口的响应里——说明 relay 端口和面板端口可能是同一个 server 实例，或者有交叉注册。**搞清楚这个再动手**，别改错地方。如果 15762 根本不该服务 `/api/status`，那正确做法可能是让 relay 端口 404 掉非 `/v1/` 路径。

2. **确实是模型调用、但 body 不是合法 JSON**（`POST /v1/messages` 但 JSON.parse 失败）→ 才返回 400，但**文案要如实**：现在这句「请求体必须是 Anthropic messages JSON」在「body 为空」「body 是非法 JSON」「Content-Type 不是 json」三种情况下的含义不同，要能区分。至少要说明**实际收到了什么**（长度 / Content-Type / 前 80 字节的原文）。

**判断标准**：改完后
- `curl http://127.0.0.1:15762/api/status` **不再是**「请求体必须是 Anthropic messages JSON」
- `curl -X POST http://127.0.0.1:15762/v1/messages -d '{非法json}'` **仍然返回 400**，但文案能说明实际收到了什么
- `curl -X POST http://127.0.0.1:15762/v1/messages -H 'content-type: application/json' -d '{"model":"lite",...}'` **仍然 200**（回归）

---

## 验证要求（必须做，不许假装验过）

1. 起**隔离实例**，不碰正式实例：
   ```
   BAI_DATA_DIR=%TEMP%/bvb10  端口 17xxx/18xxx
   ```
   测完 `taskkill //PID <pid> //F`
2. **绝对禁止** `taskkill /IM node.exe` —— 之前有 agent 这么做杀掉了用户的正式实例
3. 三个 curl 用例（上面「判断标准」那三条）**把真实输出贴进报告**
4. `node scripts/check-manifest.cjs` → **必须 0 error**
   - 注意：我刚加了 **C13**（禁止 `config.defaults.json` 带本机绝对路径/用户名）。如果你让种子配置写进了 `C:\Users\...`，C13 会报错——**这正是我加它的目的，不许绕过**。

---

## 文件边界

- `src/server/server.mjs` —— **只能改这个**（Bug A/B 相关段落）
- **不许改**：`scripts/check-manifest.cjs`、`src/server/providers.js`、`provider.html`、`package.json`
- **不许改** WorkBuddy 捕获相关代码（见开头说明）

## 通用要求

- 代码注释与文案**都是中文**
- **不要发** GitHub release，**不要改** `package.json` 的 version（我来做）
- 打包/联网需 `export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`

## 报告要求

分 A/B 两节。写：改了什么、**怎么验的（贴实际输出）**、**不确定的地方**。
如果我上面说的原因不对，**直接说**，不要顺着我写。**不要假装验过自己没验的东西。**
