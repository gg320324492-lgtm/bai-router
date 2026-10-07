# HANDOFF — 让其他机器直接接手当前工作

> 最后更新：2026-10-07 · 当前版本 `1.0.57`（本地领先 `origin/main` **11 个提交**，未推送）

## 这份文档给谁看

接手的机器/会话。读完你应该知道：**现在卡在哪、哪些是已经实测确证的事实（别再查一遍）、哪些是我猜的（还没验）。**

---

## 一、当前待办（按优先级 / 执行顺序）

> **三个修复任务都改 `src/server/server.mjs`，必须串行**，不能并行派 agent（会冲突）。

| 顺序 | 任务 | 契约 | 状态 |
|---|---|---|---|
| 1 | OpenCode Zen 429 归因 + 故障转移让位 | `REFACTOR-CONTRACT-v12.md` | ✅ 完成并复验 |
| 2 | 修 Qoder 中转 Bug A/B | `REFACTOR-CONTRACT-v10.md` | ✅ 完成并复验 |
| 3 | Zen 500 文案 + WorkBuddy 令牌（v1.0.58） | `REFACTOR-CONTRACT-v11.md` | ✅ 完成并复验 |
| 4 | **OpenRouter 免费兜底区**（第 6 个提供方） | `REFACTOR-CONTRACT-v13.md` | ✅ 完成并复验 |
| 5 | 发布 v1.0.58（bump → 打包 → 推送 → publish） | `docs/evidence/release-checklist-1.0.58.md` | ✅ **已发布** [v1.0.58](https://github.com/gg320324492-lgtm/bai-router/releases/tag/v1.0.58)（2026-10-07，两道闸门全过、latest.yml 带 releaseNotes、快照脱敏复验 C13=0） |
| 6 | **WorkBuddy 国内版支持（v1.0.59）** | `REFACTOR-CONTRACT-v14.md` + `docs/evidence/workbuddy-two-editions-2026-10-07.md` | ✅ **已发布** [v1.0.59](https://github.com/gg320324492-lgtm/bai-router/releases/tag/v1.0.59)（三场景隔离实测：intl不翻转/cn翻转/自定义不覆盖；闸门0；.cn 对话路径未真机验证） |

**任务 1–4 全部完成。** 复验方式统一为：隔离实例实测（17xxx 端口）+ 闸门全量 + 回归计数比对基线，**不采信 agent 自述**。

### 任务 4（OpenRouter）复验要点

- **C1→6 providers / C7→6 色块 / C9→+or / C4→52 id 未动**（三条基线按预期变化）
- **`noProxyList` 两处同步**（`main.js:171` ↔ `server.mjs:384`，启动日志 0 条 `NO_PROXY 不一致`）
- **`/or` 与 `/qd` 页面字节相同**（同模板，清单驱动架构正确）
- **无 key + 故障转移开** → or 被跳过、qd 顶上 → 200（兜底语义正确）；**关故障转移** → 401 准确指引
- **免费模型筛选 20 个**，含无 `:free` 后缀的 `inclusionai/ling-3.1-flash`（pricing 判据正确）
- **`chain = [qd,bai,sn,zen,wb,or]`** —— 只追加，前五家顺序未动
- **安全**：`or.keys = []` 进种子、`git diff` 无 `sk-or-v1-`、真实 key 前缀全仓库 0（我写的两处掩码已收敛）

远端：`git@github.com:gg320324492-lgtm/bai-router.git`（本地 remote 是 https 形式）

### 复验记录（我独立实测，不采信 agent 自述）

| 任务 | 关键实测证据 |
|---|---|
| Zen 429 归因 | 隔离实例 → `failover_quota`、`cooling {quota:true, 1790s}`、请求转 Qoder 成功 |
| Qoder Bug A/B | 5 条 curl（404/405/400-详述/200/面板对照）+ **假 OpenAI 上游触发 5xx 落盘**，`wb-last-4xx` 与 `wb-last-5xx` 并存 |
| Zen 500 + WorkBuddy | `upstream_500` 分支存在；**崩溃自愈端到端跑 2 次**：注入→`taskkill /F`→重启→md5 回 `d3d1378b…`、备份自动清理 |
| 全程回归 | 闸门 0 error；`FreeUsageLimitError`×9 / `rate_limit_quota` / `dumpUpstreamBody` / `中转端口只承接` / `wbCaptureSelfHeal` 全在；正式实例 PID 54032 未动 |

### 我被纠正过的两处（**别再犯**）

1. **「用户在跑旧版」** —— 错。用户那台就是 1.0.57，v1.0.57 的修复确实没解决问题。
2. **「WorkBuddy CLI 会装 undici，钩子要拦」** —— **错，agent 用实测纠正了我**：
   `codebuddy` 和 `codebuddy-lite-wb.mjs` 里 `installUndiciProxyDispatcher|NetProxy` **各 0 次**。
   我把**主进程 asar** 里的 `[NetProxy]` 日志误归给了 CLI。
   → 教训：**没验过就别让 agent 写**（契约里我写了这条，agent 正确执行了）。

### 加第 6 家（OpenRouter）时的必查项 —— 历史事故清单

v13 执行时，我（编排者）会逐条复验：

1. **`noProxyList` 两处必须同步** —— 这是**会引发重启死循环**的坑：
   - `src/main.js:159-166` 的 `addNoProxyHost(...)` **四处调用**（wb/sn/zen/qd）
   - `src/server/server.mjs:317-324` 的 `computeNoProxy` 里 **四处 `add(hostOf(...))`**
   - 两边**不对称** → `noProxyMismatch` → 重启 → 看门狗计成崩溃 → **无限重启**
   - `main.js:159` 注释原话：「v1.0.37 加 zen 漏加就是一次真实故障」
   - `server.mjs:360` 有**告警但不自动纠正**的设计（纠正本身会导致重启循环）
2. **闸门必须全绿** —— 加第 6 家会触发 **C1 / C4 / C7 / C9 / C10 / C12** 检查
3. **`provider.html` 的 52 个契约 id 只增不改**（红线）
4. **key 明文绝不进** `config.defaults.json` / `providers.js` / 任何会提交的文件
5. **端口**：现有 15722/15732/15742/15752/15762 + 面板 15723，新家用 15772

---

## 二、WorkBuddy 令牌捕获 —— 根因（已实测确证）

### 用户现象

另一台电脑（**v1.0.57**）上，WorkBuddy 开着，点「一键获取令牌」，**等 2 分 30 秒仍无法接入**。

> **我犯过的错，别重蹈**：我一开始断定「用户在跑旧版」——错的，用户明确说那台就是 1.0.57。v1.0.57 的修复**确实没解决问题**。

### 我逆向 `app.asar` 得到的完整进程链路

```
WorkBuddyAI.exe
  └─ main/sidecar-entry.js          ← 常驻「侧车」，有 PID 文件、会复用
       └─ 控制命名管道收 session.create RPC
            └─ spawn(WorkBuddyAI.exe, [cli/bin/codebuddy, --serve, --port N])
                 └─ 这个 CLI 进程才发 HTTP 请求
```

**关键代码位置**（都在 `app.asar` 里，可用 `npx @electron/asar extract-file` 取）：

- `main/code-cache.js:69963` — `resolveCLIPath()`：`resolveAsset("cli","bin","codebuddy") ?? lite-wb.mjs ?? headless.js` → **确认注入 `cli/bin/codebuddy` 是对的位置**
- `main/code-cache.js:69686` — `ensureHostEndpoint`：`command: process.execPath`（= WorkBuddyAI.exe），`args: [resolveCLIPath(), "--serve", ...]`
- `main/code-cache.js:69095/69106` — `spawnSidecar()`：`entryPath = sidecar-entry.js`
- `main/code-cache.js:69301` — `resolveSidecarEntry() → path.resolve(__dirname, "./sidecar-entry.js")`
- `main/sidecar-entry.js:34205` — `createSessionProcess({command: params.command, args: [...params.args, "--port", N], env: cliProcessEnv})`
- `main/code-cache.js:67901` — `buildAgentCliRuntimeEnv()` 设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE:"1"` + `ELECTRON_RUN_AS_NODE:"1"`

### 三条实测结论（**别再重复验证**）

1. **注入位置正确。** 桌面版确实调 `cli/bin/codebuddy`。
2. **钩子机制有效。** 打桩 `require("https").request` 后，让 `codebuddy-lite-wb.mjs` 内联的 node-fetch 发真实 HTTPS 请求 → **钩子命中 2 次**，`Authorization` 确实在 `arguments[0].headers` 里。
3. **CLI 用 `--version` 测试会误判。** `--version` 这条路径**根本不发请求**，钩子当然没输出。我第一次就这么误判过。

### 真正的原因（**我的最强假设，尚未端到端验证**）

**侧车是常驻的。** `sidecar-entry.js` 的 `ensureSidecar` 是「查 PID 文件 → ping 已有 → 没有才 spawn」。用户开着 WorkBuddy 时侧车早就在跑，**注入脚本后，已运行的进程不会重读它**。

所以「点注入 → 发消息」这条路上，如果没有**新建会话**或**踢侧车重启**，钩子永远不会被加载。

### 两个待处理的补充点

1. **undici 干扰**：WorkBuddy CLI 自己会装 undici dispatcher（日志 `[NetProxy] installUndiciProxyDispatcher`）。如果出网走 undici 的 `Dispatcher`，`globalThis.fetch` 不是原来那个——钩子需一并覆盖。
2. **`codebuddy-lite-wb.mjs` 是 rspack 打的 ESM**，用 `createRequire(import.meta.url)("node:https")` 取模块。`require("https")` 与 `node:https` 在 Node 里是同一对象，所以覆盖 `mod.request` 理论上有效（已被实测 2/2 命中佐证）。

### 一个真实的安全隐患（记下来）

**捕获中途 `taskkill /F` 杀掉中转，会导致用户 WorkBuddy 的 CLI 脚本卡在打补丁状态**（`finally` 里的还原不会跑，且备份只在内存 `wbCapState.backup`）。

我上次就是这么搞坏的，花了 5 次尝试才按原算法逆出正确还原（目标：**11407 字节，md5 `d3d1378b8efccc9dba2af9061cb3508d`**）。

**→ 修复方向：备份要落盘（临时文件），不能只在内存；或者注入前先把备份写到 `%TEMP%`。**

---

## 三、Qoder —— 已实测确证「链路是通的」

用户报告「本机 Qoder 接入失败」。实测**中转和上游都正常**（HTTP 200）。详见 `REFACTOR-CONTRACT-v10.md`。

要点（省得你重查）：

- **端口表**：`bai=15722  sn=15732  wb=15742  zen=15752  qd=15762`
  > **我踩过的坑**：把 **15742 当成了故障转移总入口**，白折腾一轮——15742 是 **WorkBuddy**。
- 中转 15762、上游直连（走/不走代理）、Claude Code 同款配置（`x-api-key: qd-local` + SSE）**全部 200**
- `/api/status` 的 `cooling: {}`（**90 秒冷却早就过期**），`qd.rerecent` 记录到成功请求
- 补丁 **4/4 已装**，令牌 51 秒新鲜（`jt-…`，27 字节）

**两个真 bug**（agent 在修）：① 5xx 不落盘诊断；② GET 请求被误判成「坏请求体必须是 Anthropic messages JSON」。

**一个可读性问题**（未修）：`relayLast` 在成功后**不刷新**，面板会一直显示 12 分钟前的旧错误，让人以为还坏着。

---

## 三·五、OpenCode Zen「接入失效」—— 已实测定性（2026-10-07）

**用户现象**：本机及其他电脑 Zen 接入失效，但去 OpenCode 官网看**免费档仍然显示有效**，用户困惑。

**我绕过中转、直连上游实测**（`https://opencode.ai/zen/v1/chat/completions`）：

| 测试 | 结果 |
|---|---|
| `space-bunny-free`（我们实际用的） | **429 `FreeUsageLimitError`**，**连打 3 次全 429** |
| `fledge-alpha-free` | 403 `FreeTierError`（只能在 OpenCode 客户端内用） |
| `longcat-2.5-preview-free` | 403 `FreeTierError`（同上） |
| `GET /zen/v1/models` | **200** ← **key 完全有效** |

### 三条结论（证据充分，别再重复排查）

1. **key 没失效** —— `/models` 返回 200，列得出 84 个模型。
2. **`space-bunny-free` 是唯一能从外部调用的免费模型** —— 代码里 `ZEN_EXTERNAL_OK = new Set(["space-bunny-free"])` 早写明了；其余 `-free` 全是 `FreeTierError` **产品级封锁**，**换模型没用**。
3. **429 的真实含义是「这个 key 的免费额度用完了」** —— **持续性**（非瞬时），**等 30 秒不会恢复**。

### 为什么「官网显示仍有效」和「实际 429」不矛盾

官网显示的是「**该模型仍在免费列表里**」（模型存在性 / 活动没结束），
**不等于**「你这个 key 的用量额度还没满」。**两件事不同。**

### 顺带挖出的 bug（任务 #9 / 契约 v12）

`server.mjs` 的 Zen 归因分支把**所有 429** 一律当成「瞬时限流，等 30 秒再试」：

```js
if (r.status === 429 || (...)) { why = " —— OpenCode Zen 限流很严…等 30 秒左右再试…"; }
```

而真实 body 是 `error.type = "FreeUsageLimitError"`。**`FreeUsageLimitError` 在整个代码库 0 次出现** —— 完全没被处理。**这句提示在误导用户白等**（实测 3 连打全 429）。

> 注：403 的 `FreeTierError` 分支（约 1732 行）**已经**单独处理了——说明「按 error.type 归因」的思路代码里本来就有，只是漏了 `FreeUsageLimitError`。

**日志证据**：`server-child.log` 里 Zen 429 相关 **2701 行**，最早 `2026-10-02T19:54`，最新 `2026-10-06T17:03`。

**官方文档**（`https://opencode.ai/docs/zen/`）：`Space Bunny Free` 确在免费列表里；`Monthly limits` 那节讲的是**付费**月度限额，**与免费档无关**；**文档里查不到免费额度的具体数字和重置周期** —— 所以修复提示里**不要编造重置时间**。

---

## 四、踩过的坑（跨会话血泪）

1. **`taskkill /IM node.exe` 会杀掉用户的正式实例** —— 只许 `taskkill //PID <pid> //F`，测完必须 `BAI_DATA_DIR` 指向临时目录 + 端口挪 17xxx/18xxx。
2. **模板字面量里的 `\s` 退化成字母 `s`** —— 正则闸门会变**永久绿灯**。每个正则闸门**必须用负样本测**（C11 就是这么修的，见 `scripts/check-manifest.cjs` 注释）。
3. **报故障前先重测** —— 跨会话的「某某坏了」结论会过期。我凭旧印象报错了证书问题好几轮。
4. **`asar l` 输出带前导反斜杠和尾部 CR** —— 归一化成 `src/main.js` 再比，别裸用 `includes`。
5. **发布必须走代理** —— `export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`
6. **种子配置不许带本机路径** —— `config.defaults.json` 是随包的，写脏了所有新机器都读发布机的死路径。已有闸门 **C13** 拦截（正负样本都验过）。

---

## 五、怎么复现 WorkBuddy 的验证

```bash
# 1. 取钩子原文（从 server.mjs 里抠，别手抄）
#    起点: const WB_CAPTURE_HOOK = `   终点: `;   （注意内容里有反引号，要按字面量扫描）

# 2. 注入到 shebang 之后
#    <WorkBuddyAI>\resources\app.asar.unpacked\cli\bin\codebuddy

# 3. 以 WorkBuddy 真实方式启动
ELECTRON_RUN_AS_NODE=1 WorkBuddyAI.exe <codebuddy路径> --version
#    ↑ 退出码 0 = 钩子被加载了（但 --version 不发请求，钩子不会落盘——正常）

# 4. 要看到真实命中，必须让 CLI 走 --serve 并由主进程下发 ACP 指令
#    （单独跑 --serve 不会主动出网）

# 5. 【必须】还原并校验
md5sum cli/bin/codebuddy   # 应为 d3d1378b8efccc9dba2af9061cb3508d，11407 字节
```

**钩子有效性实测证据**（我自己跑的，可复现思路）：打桩 `require("https").request` → `await globalThis.fetch("https://example.com/")` → 输出里出现 `HOOK-HIT` 且 `fetch-ok 200`。

---

## 六、安全红线（一直有效）

- **绝不写真实的** `%APPDATA%\bai-router\config.json` —— 永远 `BAI_DATA_DIR` 指临时目录
- Qoder 的 `jt-` 令牌、WorkBuddy 的 JWT、**OpenRouter 的 `sk-or-v1-`** **绝不写进** `config.json` 之外会提交的文件
- 不跑 `gh release create`、不改 `package.json` 的 `version`（**编排者/用户负责**）
- 不改 `provider.html` 的 52 个契约 id

---

## 七、发布流程（v1.0.58）

完整清单：**`docs/evidence/release-checklist-1.0.58.md`**
release notes 草稿：**`docs/evidence/release-notes-1.0.58-draft.md`**

**四个已知风险**（清单里有详细说明）：
1. **`dist/win-unpacked` 是 v1.0.57 旧产物** —— 不重打包就跑 `verify-artifact` 是**假绿灯**
2. **`release-notes.md` 现在仍是 v1.0.57 已发布内容** —— 不能提前改，要**整份替换**成 1.0.58
3. **`npm run publish` 会 `gh release create`（不可逆）** —— 只能由**用户授权**触发，编排者不自行跑
4. **`noProxyList` 漏同步 → 重启死循环**（v1.0.37 加 zen 真实发生过）

**证据文件目录 `docs/evidence/`**（6 份）：
`gate-baseline-5providers.txt`（13 闸门基线）· `regression-baseline-5providers.txt`（回归计数）
· `zen-freelimit-2026-10-07.md`（Zen 调研）· `openrouter-free-tier-2026-10-07.md`（OpenRouter 调研）
· `release-checklist-1.0.58.md` · `release-notes-1.0.58-draft.md`
