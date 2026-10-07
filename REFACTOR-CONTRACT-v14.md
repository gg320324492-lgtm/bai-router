# REFACTOR-CONTRACT v14 — WorkBuddy 国内版支持（v1.0.59）

**单 agent 任务，独占 `src/server/server.mjs`**（+ `src/main.js` 如需 + 面板 card 如需）。
v1.0.58 已发布并复验，**绝不许回退**：`FreeUsageLimitError`/`upstream_500`/`dumpUpstreamBody`/404·405 准入门/`wbCaptureSelfHeal`/`WB_HOST_SESSION_PREFIX` 踢会话/`FAILOVER_QUOTA_COOLDOWN_MS`/第 6 家 `or` 全套。

---

## 背景

WorkBuddy 分**两版**（用户 2026-10-07 提出，我已逆向实测确证）：

| | 国际版 | 国内版 |
|---|---|---|
| 名称 | WorkBuddy **AI** | WorkBuddy（**不带 AI**） |
| `authentication.id` | `workbuddy-desktop-ai` | `workbuddy-desktop` |
| 登录域名 | **`www.workbuddy.ai`** | **`www.workbuddy.cn`** |
| 配置目录 | `~/.workbuddy-ai` | `~/.workbuddy` |

**判定机制**（bundle 逆向，可信）：CLI/桌面端读
`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authentication.id>.info`
的 `auth.domain`，对照 `product.json` 的 `internalDomain`（国内）/`externalDomain`（国际）分流。

**本机实测**（`ls` + 解析，可复现）：
- `workbuddy-desktop-ai.info`（活跃，今天还在写）→ `domain = www.workbuddy.ai`，`tokenType=Bearer`，`expiresAt=1821628708618`（约 1 年）
- `workbuddy-desktop.info.logged-out` → `domain = www.workbuddy.cn`（国内版登录过、9-19 登出）
- **token 落盘但加密**：`accessToken = {$wbEncrypted: 1, envelope: <2656 chars>}` → 直接读盘取明文**此路不通**（`~/.workbuddy-key-fallback` 是 connector 密钥，非 auth 解密钥），**注入捕获仍是主路径**。

---

## 三个要修的问题

### 问题 1（🔴 核心）：中转上游写死国际版域名

`server.mjs:137` / `config.defaults.json:176`：`wb.upstream = "https://www.workbuddy.ai"`。
**国内版令牌打国际端点必然 401** —— 捕获成功也「接不上」。

**要做：按登录域名自动选上游**
- 新增检测函数（**抽成可单测的纯函数**，如 `wbDetectAuthDir()` / `wbReadAuthDomain(authDir)`）：扫
  `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`，取**活跃**的 `.info`（**排除 `.logged-out`**、排除带时间戳的历史快照——取 `workbuddy-desktop*.info` 中不带时间戳的那个，两版 id 都试），读 `auth.domain`。
- 域名 → 上游映射：
  - `www.workbuddy.cn`（或含 `.cn`）→ **`https://www.workbuddy.cn`**
  - `www.workbuddy.ai` / 其它 → **`https://www.workbuddy.ai`**
- **落点（重要设计约束）**：在 `loadCfg()` 里做**自愈式覆盖**——**仅当当前 `cfg.wb.upstream` 恰好等于「另一版的默认值」时才翻转**；用户显式改成过别的地址就**不碰**（与 `fixQdFile` 的「尊重用户设置」同一哲学）。
- `x-domain` 头已由 `hostOf(base)` 动态派生（`server.mjs:796/2200`），**上游切对它就自动对**，别再写死。
- `main.js:164` 的 `addNoProxyHost(cfg.wb?.upstream || …)` 会跟随上游值，确认即可，**无需改逻辑**（若你改了 `server.mjs` 的默认值，两处注释保持同步）。

### 问题 2（🟡）：`findWbCliScript` 候选目录缺国内版常见位置

`wbCandidateBases()` 现有：`Programs/WorkBuddyAI`、`Programs/workbuddy`、`Programs/WorkBuddy AI`、`Program Files/WorkBuddyAI`、`Program Files/WorkBuddy AI`…
**缺纯 `Program Files\WorkBuddy`、`Program Files\CodeBuddy`、`Programs\CodeBuddy`**。
注册表 regex `'WorkBuddy'` 两版都能中（✅ 别动）；`Programs` 扫描 `/workbuddy/i`（✅ 别动）。
**风险场景**（本机真实教训）：注册表 `InstallLocation` 可以是**空的**——此时全靠候选目录，漏一个位置就直接「未找到 WorkBuddy 程序」。
→ 把三处补进 `wbCandidateBases()`（跨盘符逻辑复用现有的）。

### 问题 3（🟡）：错误提示与状态只提国际版

- `throw new Error("未找到 WorkBuddy 程序（请确认本机已安装 WorkBuddy AI 客户端）")` → 改成**两版都提**（国内版 WorkBuddy / 国际版 WorkBuddy AI）。
- `statusPayload` 的 wb 段**新增 `edition` 字段**：`"cn"` / `"intl"` / `null`（读不到 auth 文件时），附 `authDomain`。面板 card（`cards/token-capture.js` 或 wb 状态卡）**如实显示检测到的版别与实际上游**——用户要在面板上一眼看出「现在配的是哪版的通道」。

---

## 验证要求（硬性）

1. **隔离实例**：`BAI_DATA_DIR=%TEMP%/bvb14` + 端口 17xxx，测完 `taskkill //PID <pid> //F` + 清目录。
2. **绝对禁止 `taskkill /IM node.exe`**（正式实例 PID 54032 + 用户 4 个 OpsPilot 进程）。
3. **版别检测必须两向实测**（本机材料齐全）：
   - 真实 auth 目录（活跃的是 `-ai.info`）→ 断言 `edition=intl`、`domain=www.workbuddy.ai`、**上游不被翻转**（当前配置就是 .ai 默认）
   - **伪造 auth 目录**（临时目录放一个 `workbuddy-desktop.info`，`auth.domain=www.workbuddy.cn`）→ 断言 `edition=cn`、上游翻转为 `https://www.workbuddy.cn`
   - **绝不能写**真实的 `%LOCALAPPDATA%\CodeBuddyExtension`——检测函数必须接受**注入的 authDir 参数**（这就是抽纯函数的原因），单测用临时目录。
4. **自愈不覆盖用户设置**：配置里 upstream 手改成 `https://custom.example.com` → 断言**不被翻转**（贴 JSON）。
5. **域名单测**：`www.workbuddy.cn`→cn、`www.workbuddy.ai`→intl、`copilot.tencent.com`→cn（按 internalDomain 语义）、空/缺失→null。
6. `node scripts/check-manifest.cjs` → **0 error**。
7. **诚实标注**：`www.workbuddy.cn` 的**聊天 API 路径**（`/v2/chat/completions`）**没有真实国内版机器可验**——本机只能验到「域名判定+上游切换」这层。报告里**必须明确写**「.cn 上游未真机验证」，不许含糊。

## 文件边界

- `src/server/server.mjs`（主）、`src/main.js`（如需，仅注释/默认值同步）
- `src/server/cards/token-capture.js`（显示版别，如需）
- **不许改**：`scripts/check-manifest.cjs`、`providers.js`、`provider.html`、`failover.mjs`、`package.json`
- **不跑** `gh release create`、**不改** version（编排者做）

## 通用要求

- 注释与文案**中文**；联网需 `export HTTPS_PROXY=…7897 …`；别在源码目录留 `*.log`。

## 报告要求

分 1/2/3 节 + 验证输出。**贴真实 JSON**。写清：伪 auth 目录测试怎么做、**.cn 上游哪里没验到**、不确定处。**我上面的判断不对就直接说**。1000 字内。
