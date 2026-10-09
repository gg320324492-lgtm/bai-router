# REFACTOR-CONTRACT v16 — Claude 桌面版在 openai 桥（qd/wb/zen/or）上「模型不可用」

**单 agent 任务，独占 `src/server/server.mjs`**。v1.0.61 已发布并复验，**绝不许回退**：准入门（Bug B）、`FreeUsageLimitError`/`upstream_500`/`dumpUpstreamBody`、7 家清单（C1–C13 全绿）、故障转移影子 res。

> **你是执行者，我是复验者**。本契约写的是**已实测的证据 + 明确规格**；规格与事实不符就**停下来报告**，不要闷头发明方案。

---

## 一、现象（用户报告 + 截图）

用户在 Claude **桌面版**接入 Qoder 后，UI 报：

```
Model isn't available
Switch to a different model to continue.
There's an issue with the selected model (claude-opus-5[1m]). It may not exist or you may not have access to it.
```

底部模型显示 `Qoder Lite 1M`（即 `labelOverride` + `supports1m:true` 的呈现）。

## 二、已实测的证据（我已跑过，不用重查，但**修复后要复跑**）

| 探测 | 结果 |
|---|---|
| `POST /v1/messages`（含 `claude-opus-5[1m]` / 1M beta 头 / 桌面版 UA） | **全部 200 OK**，`"model":"lite"` —— 映射与 `[1m]` 归一化都正常 |
| `POST /v1/messages/count_tokens` | **200，但返回的是完整 assistant message**：`{"id":"msg_…","type":"message","role":"assistant","model":"lite","content":[…]}` ← **违反 Anthropic 规范**，规范要求 `{"input_tokens": <int>}` |
| `GET /v1/models` | **405**（准入门：`if (req.method !== "POST") → 405`） |
| 中转侧日志 | qd 桥**没有任何 401/403/上游错误 dump**（`wb-last-4xx.json` 里只有 WorkBuddy 的 WAF 401，与本问题无关） |
| 代码自述 | server.mjs:2809「桌面版健康探测兼容」、2814-2815「桌面版后台小请求(健康探测/起标题/摘要, max_tokens 通常 ≤128) 不算『用户正在用的档位』」——**桌面版确实会发这类小请求**，而它们**不写 relayLast**，所以日志里看不见 |

**推断（待验证）**：桌面版在把模型显示进选择器前，会对 `inferenceGatewayBaseUrl` 做可用性探测（token 计数 / 模型列表一类）。桥把 `count_tokens` 答成了 message 对象、`GET /v1/models` 答 405 → 桌面版判定「模型不可用」→ 报上面那句。CLI 不做这类探测，所以 CLI 侧一直正常；B.AI/SenseNova 是原样透传、`count_tokens` 由上游按规范回答，所以也正常 —— **只有 openai 桥（wb/qd/zen/or）受影响**。

## 三、要修的三件事

### 1. `POST /v1/messages/count_tokens` → 按 Anthropic 规范应答
- 命中该路径时**不再走模型调用**，直接回 `{"input_tokens": <int>}`（HTTP 200，content-type application/json）。
- token 数用**本地估算**，**不许为此调用上游**（现在这个请求会真的打一次上游，白烧额度 —— 这是修它的第二个收益）。估算口径写进注释：以请求体字符数近似（`Math.ceil(chars/4)` 即可，Anthropic 客户端只用它做预算/截断判断，不要求精确）。body 解析失败时返回 400（沿用现有 `wbAnthroError` 的错误格式，不要自造形状）。
- 统计范围要含：`system` + 全部 `messages` 的文本、`tools`（若存在）。别只算 messages。
- **不许**改变 `/v1/messages` 的任何行为。

### 2. `GET /v1/models` → 按 Anthropic 规范应答
- 返回 `{"data":[{"type":"model","id":"<档位名>","display_name":"<清单 label>"}],"has_more":false}`，`id` 用本家的四档档位名（`TIERS` 的 key，含 `claude-opus-5[1m]` 之类的 1M 变体**不必**列，桌面版按 `inferenceModels` 匹配基础名），`display_name` 取清单该档的 label（读 `ctx`/slice 的 mapping，找不到就退回档位 key）。**清单驱动，不许写死任何提供方名**（C11 会拦）。
- 405 分支相应收窄：**只对「不是这两个已知端点」的请求保持 405/404 现状**。

### 3. 未识别请求留痕（排查友好，不改行为）
- 准入门每拒绝一个请求（404 / 405）时，`log()` 一行：`method + path + 状态码 + 一句话用途`。这让我们下次能直接从日志看出「桌面版到底打了什么」。
- **同时**：桥的 openai 路径对**小请求**（max_tokens < 512，即桌面版后台探测那类）现在完全不写任何记录 —— 补一条**只记路径与状态、不记内容**的访问行（`log()` 一行即可，不要写 body、不要落盘文件），让「桌面版探测」在日志里可见。**注意别把正常对话流量也刷屏**：对话流量（max_tokens ≥ 512）继续走现有 relayLast 记录，不额外打日志。

## 四、验证要求（硬性，全部贴真实输出）

1. `node scripts/check-manifest.cjs` → **0 error**。
2. **协议实测（隔离实例，`BAI_DATA_DIR` 指 `%TEMP%`，端口一律 17xxx 段；绝不碰正式实例，绝不 `taskkill /IM node.exe`）**，对 **qd 与 wb 两家**（同代码不同家，证明与家无关）各跑一遍，贴真实响应体：
   - `POST /v1/messages/count_tokens`（body 带 system + 2 条 messages + 一个 tools）→ 断言 **响应 JSON 里只有 `input_tokens` 且是数字**、**响应里不含 `"type":"message"`**、**上游没有被调用**（用第二招验证：调用前后对比中转日志里该家的上游调用计数，或用一个假上游地址证明没发出请求）。
   - `GET /v1/models` → 断言 200、JSON 结构 `data[]` 四项、`has_more:false`。
   - `POST /v1/messages`（普通 + `claude-opus-5[1m]`）→ 仍 **200 且 `"model"` 是映射目标**（回归，别修坏）。
   - `GET /v1/nope` → 仍 404；`PUT /v1/messages` → 仍 405（回归）。
   - 起一个**假上游**（本地 http 服务，端口 18xxx，记录收到的请求数）：验证 count_tokens 期间上游收到 **0** 个请求。
3. **日志留痕实测**：贴出未识别请求（如 `DELETE /v1/whatever`）在 `server.log` 里留下的那一行，以及一个小请求（如 max_tokens=16 的 /v1/messages）在日志里的样子。
4. `node --check src/server/server.mjs`。

## 五、诚实边界（报告里必须单列）

- **无法在本机验证「桌面版真的因此恢复可用」**：本机没有可被自动驱动的 Claude 桌面版会话。修复后需要**用户在正式机升级到含本修复的版本、重新接入 Qoder 并在桌面版发一条消息**来确认。若用户复现后仍报同样错误，**日志留痕（第 3 条）就是下一步的线索来源** —— 请在报告里明确写这一句。
- token 计数是**估算**，不是精确分词；写进注释与报告。

## 六、红线

- **不 commit、不 push、不改 version、不跑任何发布/打包命令**。
- 只许改 `src/server/server.mjs`；**`src/server/providers.js`、`panel-common.*`、`cards/*`、`check-manifest.cjs`、`package.json` 一律不许碰**。
- 不许改 `/v1/messages` 主链路行为、不许改准入门对**非**这两个端点的既有语义（404/405 原样保留）、不许改故障转移与错误归因逻辑。
- 测试只许 `BAI_DATA_DIR` + 隔离 USERPROFILE + 17xxx/18xxx 端口；不写真实 `%APPDATA%\bai-router`；taskkill 只按 PID。
- 仓库里不留 log/临时文件；注释与日志文案中文。

## 七、汇报要求

分节：① 三处改动逐点说明（贴关键 diff）② 四项验证的真实输出（含假上游 0 请求的证据）③ 诚实边界 ④ 你发现规格与事实不符的地方（直接说）。1500 字内，验证输出不限。