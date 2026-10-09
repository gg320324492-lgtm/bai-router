# REFACTOR-CONTRACT v11 — WorkBuddy 一键获取令牌（v1.0.58）

> **前置**：`REFACTOR-CONTRACT-v10.md` 已完成并复验，`server.mjs` 可接手。

---

## 【附加任务 T0】Zen 500 文案误导（我复验 v10 时发现，顺手修，**先做这个**）

### 现象（我实测的）

```
zen.relayLast = "转移走（HTTP 500）：[OpenCode Zen] internal server error
                 —— OpenCode Zen 限流很严（连发几次探测就会被顶掉）。等 30 秒左右再试…"
```

**上游返回 500（自己出错），文案却说「限流、等 30 秒」** —— 与已完成的 429 归因是同一类误导。

### 位置（`server.mjs`，`if (p === "zen")` 内）

```js
if (r.status === 429 || (r.status === 500 && /internal server error/i.test(txt))) {
  // （内部已按 FreeUsageLimitError 细分 429）
  if (/FreeUsageLimitError/.test(txt)) { …额度用尽文案… }
  else { why = " —— OpenCode Zen 限流很严…等 30 秒左右再试…"; }   // ← 500 也走到这里
```

**根因**：`r.status === 500 && /internal server error/` 与 429 挤在同一个外层 if 里，导致 **500 落进 429 的文案分支**。

### 要做的

把 **500 拆出独立分支**（放在 429 之前或之后均可，语义要清楚）：

- **`r.status === 500`** → 文案要点：**上游自己出错**，不是你的配置问题、也不是限流；**等 30 秒没用**；中转会自动转移到别的渠道。`noteRelayError` 的 kind 用 **`upstream_500`**（别再用 `rate_limit`）。
- **`r.status === 429`** → 保持现有两分（额度用尽 / 瞬时限流），**不要动已完成的 `FreeUsageLimitError` 逻辑**。
- 瞬时 429 仍需给短冷却；**500 是否该走长冷却**你判断并说明理由（我倾向：500 是上游瞬时故障，**90 秒短冷却 + 保留 `quota:false`** 即可，因为下次可能就好了——但如果你认为该更长，给出依据）。

### 验证

用假上游返回 `{"error":{"message":"internal server error"}}` + HTTP 500，走 openai 桥（zen 端点）触发，确认：
1. 归因文案**不再说「限流」**，明确说上游自身故障
2. `noteRelayError` kind 为 `upstream_500`
3. **429 的两分文案未被改坏**（`FreeUsageLimitError` 分支、瞬时 429 分支原样在）
4. 贴出 `zen.relayLast` 实际 JSON

---

## 主任务：WorkBuddy 一键获取令牌

### 用户现象

另一台电脑（**v1.0.57**）上，WorkBuddy 开着，点「一键获取令牌」，**等 2 分 30 秒仍无法接入**。
（`wbCaptureToken(timeoutMs = 150000)` = 150 秒，与用户看到的时长吻合）

**已确证：v1.0.57 的修复没解决这个问题。** 别再重复它已经做过的事。

---

## 已实测确证的事实（**别重新验证，直接用**）

我逆向了 `app.asar` 并实测，结论见 `HANDOFF.md` 第二节。核心四条：

1. **注入位置正确** — 桌面版确实调 `cli/bin/codebuddy`
   （`main/code-cache.js:69963` `resolveCLIPath()`）
2. **钩子机制有效** — 打桩 `require("https").request` 后，lite-wb bundle 内联 node-fetch 的真实请求**命中 2 次**，`Authorization` 在 `arguments[0].headers` 里
3. **`--version` 测试会误判** — 这条路径不发请求，钩子无输出是**正常的**，不代表钩子坏了
4. **CLI 以 `ELECTRON_RUN_AS_NODE=1` 跑**，`process.execPath` = WorkBuddyAI.exe

### 完整进程链路

```
WorkBuddyAI.exe
  └─ main/sidecar-entry.js          ← 常驻侧车，有 PID 文件、会复用
       └─ 控制命名管道收 session.create RPC
            └─ spawn(WorkBuddyAI.exe, [cli/bin/codebuddy, --serve, --port N])
                 └─ 这个 CLI 进程才发 HTTP 请求
```

**侧车复用逻辑**（`main/code-cache.js`）：`ensureSidecar` = 查 PID 文件 → ping 已有 → 没有才 spawn。

---

## 要修的三件事

### 1. 注入后踢侧车重启（**根因**）

**问题**：侧车常驻，注入脚本时**已运行的进程不会重读它**。没有新建会话、没踢侧车 → 钩子永不加载 → 干等 150 秒超时。

**要做**：
- 注入后**主动踢侧车重启**，强制新建 CLI 进程；
- 或者：注入后等待**新建会话**（`session.create`）才认为钩子有生效机会，并**如实告诉用户当前状态**。
- **踢之前必须考虑安全**：侧车重启会打断用户正在跑的会话。给出判断——是无条件踢、还是只在「没有活跃会话」时踢。**说明你的理由。**

**踢侧车的可选手段**（自行查证哪个可行）：
- 删 PID 文件后等下次 `ensureSidecar` 重建（`fs.unlinkSync(pidFilePath())`，见 `restartExistingSidecar`）
- 通过控制管道发 `sidecar.shutdown` RPC（`case "sidecar.shutdown": ... process.exit(0)`）
- 杀 sidecar 进程（**注意**：只能杀 sidecar，**绝不许** `taskkill /IM node.exe` 或杀 WorkBuddyAI.exe 主进程）

### 2. 钩子同时覆盖 undici dispatcher

**问题**：WorkBuddy CLI 自己会装 undici 代理 dispatcher（日志 `[NetProxy] installUndiciProxyDispatcher: ENTER`）。若出网走 undici 的 `Dispatcher`，`globalThis.fetch` 就不是原来那个。

**要做**：钩子除 `http.request` / `https.request` / `globalThis.fetch` 外，**同时拦 undici**。
先**实测确认** undici 是否真的在这条链路上——如果实测发现请求始终走 `https.request`，undici 那块就是**多余的**，**不要为了「看起来保险」而加没有证据的拦截**（那是我在契约里明确反对的过度设计）。**没验过就不写。**

### 3. 捕获进度实时回传 + 有用的失败提示

**问题**：现在失败只说「请在 WorkBuddy 客户端里随便发一条消息」，但实测证明**发了消息也未必够**。

**要做**：
- 等待期间**实时反馈当前状态**（已抓到 accessToken？还差什么？钩子注入了没？踢侧车了没？等新建会话？）
- 超时文案要**如实**说明卡在哪一步。
- 前端进度：`src/server/cards/token-capture.js`（接 `#btnCapture`）

### 4. 附带修复：备份要落盘（安全隐患）

**问题**：捕获中途 `taskkill /F` 杀掉中转 → `finally` 还原不跑 → 用户的 WorkBuddy CLI 脚本**永久卡在打补丁状态**。备份只在内存 `wbCapState.backup`。
（我上次就是这么搞坏的，花了 5 次尝试才逆回原状）

**要做**：注入前把备份**写到磁盘临时文件**（如 `%TEMP%`），异常退出后下次启动能自愈还原。
当前原文件基准：**11407 字节，md5 `d3d1378b8efccc9dba2af9061cb3508d`**（已实测确认）。

---

## 验证要求（硬性）

1. **隔离实例**：`BAI_DATA_DIR=%TEMP%/bvb11` + 端口 17xxx/18xxx，测完 `taskkill //PID <pid> //F`
2. **绝对禁止** `taskkill /IM node.exe`
3. **本机 WorkBuddy 没开时，钩子抓不到是正常的** —— 我上次就在这里误判过。要验「钩子被加载了」，用：
   ```bash
   ELECTRON_RUN_AS_NODE=1 WorkBuddyAI.exe <codebuddy路径> --version   # 退出码 0 = 加载成功
   ```
   要验「真的能抓到令牌」，**必须有活跃的 WorkBuddy 客户端会话**；本机没有就**如实写「无法在本机验证」**，不许假装验过。
4. 跑完**必须校验还原**：`md5sum <codebuddy>` 应为 `d3d1378b8efccc9dba2af9061cb3508d`
5. `node scripts/check-manifest.cjs` → **0 error**（C13 已生效）

---

## 文件边界

- `src/server/server.mjs` — 主要改动
- `src/server/cards/token-capture.js` — 进度回传
- **不许改**：`scripts/check-manifest.cjs`、`src/server/providers.js`、`provider.html`、`package.json`

## 通用要求

- 注释与文案**中文**
- **不跑** `gh release create`、**不改** `package.json` 的 `version`
- 联网需 `export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`

## 报告要求

分节写：改了什么、**怎么验的（贴真实输出）**、**不确定/没做到的地方**。
**如果我上面的根因判断错了，直接说**——我这次已经错过两次（先说用户跑旧版、再怀疑注入位置错）。**不要顺着我写。**
