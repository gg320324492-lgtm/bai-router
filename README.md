# bai-router

B.AI 路由台 —— Claude Code / Claude 桌面版 外接模型的一键切换与本地中转（Electron + 独立 Node 服务）。

## 升级方式（按推荐顺序）

1. **应用内自动更新**：启动 8 秒后与每 12 小时检查一次，就绪后面板右下角横幅点「重启安装」。
2. **面板「备用升级」按钮**（v1.0.24+）：不依赖内置更新器，由路由台自己从 GitHub 下载最新安装包、校验 sha512 + 数字签名后静默升级。内置更新器出问题时用它。
3. **一行命令救砖**（任何版本，包括更新器损坏的 ≤1.0.19 老版）——在目标电脑 PowerShell 里执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/upgrade.ps1 -UseBasicParsing | iex"
```

跨版本升级均原地覆盖安装，`%APPDATA%\bai-router` 里的配置/映射/备份自动保留。

## 更新通道：稳定版 / 测试版（v1.0.93+）

托盘菜单 →「更新通道」可切：

| 通道 | 读哪份清单 | 谁会拿到 |
| --- | --- | --- |
| 稳定版（默认） | `latest.yml` | 所有人 |
| 测试版（beta） | `beta.yml` | 主动切过去的人 |

- 切到测试版后**只**会收到 beta 版本，稳定版用户完全不受影响——这就是「选择性升级」。
- 预发布版本在 GitHub 上标成 prerelease，**不会**占住 Latest（Latest 是人从
  releases 页面点下载时的默认落点，测试版占了它就等于推给了所有人）。
- 通道选择存在 `%APPDATA%\bai-router\config.json` 的 `updateChannel` 字段。
- `allowPrerelease` **两条通道不一样**（稳定版 false / 测试版 true）：读
  electron-updater 的源码，四种组合里只有两种是对的。稳定版也设成 true 的话，
  要么「检查更新失败」，要么**稳定版用户意外拿到测试版**——那就不是选择性升级了。

## 统一网关：一个端口，按模型 id 分流（v1.0.94-beta.1 起默认走这条）

以前是**一个提供方一个中转端口**（bai 15722 / sn 15732 / wb 15742 / zen 15752 /
qd 15762 / or 15772 / wbai 15782 / mm 15792），Claude Code 连的是某一家，换一家要改接线。

现在是**一个统一网关**（默认 15799），模型 id 写成 `provider/档位`：

| 模型 id | 走哪一家 | 那家的哪一档 |
| --- | --- | --- |
| `sn/claude-opus-5` | SenseNova | opus 档（sn 那边是 glm-5.2） |
| `wb/claude-haiku-4-5` | WorkBuddy | haiku 档（wb 那边是 deepseek-v4.1-flash） |

- **「档位」与厂商无关，「最终模型名」与厂商有关。** 写档位才不丢信息：
  出厂默认里 zen/qd/or/mm 的**四档全都指向同一个模型**，从模型名反推档位是
  **反推不出来的**（四个答案，挑哪个都是瞎猜）。而转移必须知道是哪一档 ——
  否则「用户点 opus，转移后跑的是 fable 档的模型」，**计费档位被悄悄换掉，
  面板上什么都看不出来**。
- 档位换算由**那家自己的映射表**决定（`mapping[档位].target`），换算不了就落到
  那家的默认模型 —— 绝不会把上一家的模型名硬发给下一家。
- 8 个旧中转端口**仍然在跑**：面板「统一网关」卡上一关开关就回到老路，等于内置了
  回退路径。切开关会**自动重新接线**（不重接的话，你以为切了而实际请求还走老路）。
- 面板「故障转移」视图里有一张「统一网关」卡：当前模式、请求去向、网关端口、
  开关，以及各家能分到哪些档位。

## 入口协议：Anthropic / Responses / Chat / Gemini（v1.0.95-beta.1 起，Chat 自 v1.0.102-beta.1）

统一网关不只听得懂 Anthropic 的话。客户端说哪种话，网关就把它翻成 Anthropic 形状
交给那家的中转 —— **翻完之后与 Anthropic 那条路完全一样**（一样的模型解析、一样的
故障转移、一样的冷却、一样的账本）。

| 客户端 | 说的协议 | 端点 |
| --- | --- | --- |
| Claude Code / Claude 桌面版 | Anthropic Messages | `POST /v1/messages` |
| Codex / 新版 OpenAI SDK | OpenAI **Responses** | `POST /v1/responses` |
| **Qoder / ZCode / Kimi Code / MiniMax Code / Cline / Droid / OpenCode / 大部分 CLI** | **OpenAI Chat Completions** | `POST /v1/chat/completions`（**不带 `/v1` 的 `/chat/completions` 也答**） |
| Gemini CLI / Google SDK | Gemini `generateContent` | `POST /v1beta/models/{model}:generateContent` |

**模型 id 四条路一样**：`provider/档位`（如 `sn/claude-opus-5`）。
Gemini 的模型名在路径里，所以那一段要 URL 编码（`sn%2Fclaude-opus-5`）。

明确不支持的字段一律**报错**（Responses 的 `previous_response_id` / `store`、
Chat 的 `n>1` / `logprobs` / `audio`、Gemini 的 `cachedContent` / `safetySettings` 等）
—— 静默丢字段会让模型看不到上一轮，还答得像模像样。

## 客户端接线：把 B.AI 接进装好的 CLI（v1.0.102-beta.1 起）

面板新增「**客户端**」一屏：列出能接 B.AI 的客户端（ZCode、Qoder、Kimi Code、
Qwen Code、MiniMax Code、CodeBuddy、WorkBuddy、Codex、Gemini CLI、Cline、Droid、
Goose、jcode、Hermes、omp… 共 25 个），每一条写清它的配置文件在哪、说哪种方言、
现在接上了没有。点「**接上**」就替你把配置写好，点「**断开**」就把它摘掉。

- **断开只还原我们写过的那几处** —— 你文件里其它内容一个字不动（写之前先备份
  那几个键的原值）。
- **读不懂就不写**：配置文件存在但解析失败 ⇒ 报错、中止，**绝不**把它当空配置
  覆盖掉。
- 模型清单在 `GET /v1/models`（`provider/档位`），客户端从那里抄 id 就能用。
- 客户端**没装**也会列出来（标「没装这个客户端」）—— 装了再点「接上」就行。

## 插件渠道：一份 JSON 声明加一家渠道（v1.0.95-beta.1 起）

把一份声明放进 `<数据目录>\plugins\*.json`，重启或在面板上点「重新扫描目录」：

```json
{
  "manifestVersion": 1, "id": "acme", "name": "Acme",
  "upstream": "https://api.acme.example/v1", "protocol": "openai", "auth": "apikey",
  "models": ["acme-pro"], "relayPort": 15802,
  "mapping": { "claude-fable-5": "acme-lite", "claude-sonnet-5": "acme-pro",
               "claude-opus-5": "acme-pro", "claude-haiku-4-5": "acme-lite" }
}
```

- **声明里不许带凭据** —— 插件是要分发给别人的东西，带 key 等于把你的 key 发给所有
  装它的人。凭据在面板的「插件渠道」卡里填。
- 撞出厂渠道的键**报错不覆盖**；装不上的插件**不拖垮启动**，且面板说清为什么。
- 面板「凭据」页有「插件渠道」卡；「控制台」页有「审计台账」卡；
  「故障转移」页有「限流」卡；「设置」页有「配置备份」卡与「远端同步」卡。

## 额度预算 / middleware 插件 / 远端同步（v1.0.96-beta.1 起）

- **额度预算**（故障转移页「限流」卡）：每家可设**每小时 / 每天的 token 上限**，
  超了就自动歇到窗口重置。单位是 token 不是钱（账本里没有价格字段，价格表会随
  调价漂移）；**不计缓存读取**（读缓存是折扣档，计进去一次长对话就打满）。
- **声明式 middleware 插件**（`<数据目录>/middleware/*.json`）：不改代码就能改请求 ——
  加头、改参数、改模型、改应答头。**只做数据不做代码**（magpie 那套「插件里跑真代码」
  要另配沙箱与权限模型）；改写不合法就**明确拒绝**（400，不半改着发）；
  **不许碰凭据**。
- **远端同步**（设置页「远端同步」卡）：把配置快照用**口令加密**推到本地目录 /
  WebDAV / GitHub，远端更新了再拉回来。远端存的是**密文**；**加密口令每次都要输入**
  （绝不落盘）；**冲突不静默覆盖**。

## 回退：装回旧版本

一行命令（列出可用版本让你选）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/rollback.ps1 -UseBasicParsing | iex"
```

流程是：下载 → 校验 sha512 与数字签名 → 关程序 → 静默装旧版 → 重新启动。
**任何一步失败都不会动当前安装**——下载与校验都排在关程序之前。

直接指定版本：

```powershell
iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/rollback.ps1 -UseBasicParsing -OutFile "$env:TEMP\rollback.ps1"
& "$env:TEMP\rollback.ps1" 1.0.92
```

## 三提供方路由（v1.0.31+）

面板顶部三个页签，各自独立的映射/密钥/中转端口，互不干扰，随时一键切换、一键接回 CC Switch：

| 提供方 | 上游 | 中转端口 | 协议 | 说明 |
| --- | --- | --- | --- | --- |
| B.AI | https://api.b.ai | 15722 | Anthropic 透传 | 默认页 |
| SenseNova | https://token.sensenova.cn | 15732 | Anthropic 透传 | 境内直连 |
| WorkBuddy | https://www.workbuddy.ai | 15742 | **内置 Anthropic↔OpenAI 协议桥** | 三款 0 积分免费模型，直连 |

WorkBuddy 说明：

- 免费模型（随版本推送默认）：`deepseek-v4.1-flash`（1M ctx）、`hy4-preview-f`（1M ctx）、`hy3`（192k ctx）。
- 上游只支持 OpenAI Chat Completions 且仅流式，本地协议桥负责请求/响应双向翻译（含工具调用、思考块、非流式聚合）。
- 认证为 WorkBuddy 客户端的 JWT（访问/刷新/设备令牌 + 用户 ID），访问令牌过期前自动用刷新令牌续期并写回配置。
- 桌面版与终端 CLI 都接到 `127.0.0.1:15742`，模型菜单四档即点即换；切换前自动快照，可一键接回。

## 仓库结构

接手的人先读 `HANDOFF.md`（当前工作状态、待办、实测血泪），本文只讲仓库里有什么、去哪找。

| 路径 | 是什么 | 备注 |
| --- | --- | --- |
| `HANDOFF.md` | 当前工作状态，接手必读 | 面向接手的 agent：已完成任务、复验记录、历史事故清单。**不是**配置说明 |
| `README.md` | 项目是什么 + 怎么用 | 面向使用者（本文） |
| `release-notes.md` | 本次发布说明 | 唯一权威来源，`package.json:92` 的 `releaseInfo.releaseNotesFile` 会把它整份写进 `latest.yml`；**发布时整份替换，别提前改** |
| `package.json` / `package-lock.json` | 依赖 + 构建/发布配置 | `npm run publish` = `node scripts/publish.cjs`；`npm start` = `electron .` |
| `.gitignore` | 排除提交 | `cert/`、`dist/`、`src/server/config.json`（本机配置），仓库里不留这些 |
| `build/` | 构建资源 | 目前只有 `icon.ico` |
| `docs/contracts/` | 历史任务契约档案 v1–v14 | 只作追溯、不再更新，索引见同目录 `README.md`；进行中的契约放仓库根 |
| `docs/evidence/` | 调研证据 / 闸门与回归基线 / 发布清单 | `gate-baseline-5providers.txt`、`regression-baseline-5providers.txt`、`release-checklist-1.0.58.md` 等 |
| `scripts/check-manifest.cjs` | 构建期一致性闸门 | `node scripts/check-manifest.cjs`，必须 0 error 才算过 |
| `scripts/publish.cjs` | 一键发布 | **已从根目录移入**；`npm run publish` 会 `gh release create`，**对外不可逆** |
| `scripts/patch-updater.cjs` | electron-updater Windows 签名验证补丁 | `npm install` 后由 `postinstall` 自动执行，别手删 |
| `scripts/sandbox-launch.cjs` | 沙箱预检启动器 | 复制到临时目录、改 `USERPROFILE` 再起 `server.mjs`，不碰 `%APPDATA%\bai-router` |
| `scripts/upgrade.ps1` | 救砖 / 一键升级脚本 | 发布时拷进 `dist/` 当 release 资产（升级方式 3） |
| `scripts/verify-artifact.cjs` | 产物体检 | 列出 asar 模块 + `resources/server` 文件清单 |
| `src/main.js` | Electron 壳 | 托盘、窗口、看门狗、内置更新器；`noProxyList` 在这 |
| `src/preload.js` | 渲染进程桥 | `contextBridge` 暴露 `baiDesktop` |
| `src/install-consistency.js` | 双重安装一致性 | 注册表版本 vs 实际版本，防「装在绿、数据在蓝」 |
| `src/server/` | 后端 + 面板的全部代码 | `server.mjs` 是**双 HTTP server**：6 个中转端口（15722/15732/15742/15752/15762/15772）+ 面板端口 15723 |
| `src/server/failover.mjs` | 故障转移内核 | 影子 res + 冷却队列；被 `server.mjs` 静态 import，缺了整个服务起不来 |
| `src/server/qoder-patch.mjs` | Qoder worker 补丁（Node 重写） | 运行时抓 `jt-` jobToken，零外部依赖；`/api/qd/patch/apply` 打补丁 |
| `src/server/panel-common.css` / `panel-common.js` | 面板公共样式 / 渲染逻辑 | 六页共用；`panel-common.js` 不许硬编码提供方名（C11 闸门） |
| `src/server/diag.html` | 诊断页 | 排查中转/上游时看 |
| `src/server/cards/` | 面板插件卡 | `failover.js`、`model-catalog.js`、`model-sync.js`、`or-rotation.js`、`token-capture.js` |
| `src/server/providers.js` | 面板清单数据 | 每家的模型/标签/映射，与 `provider.html` 一一对应 |
| `src/server/provider.html` | 所有提供方共用的唯一模板 | 清单驱动，改版面前先跑闸门 |
| `src/server/config.defaults.json` | 种子配置 | 随安装包下发，`apiKey` 必须为空（C13） |

改代码前的三条硬规矩：

1. **`node scripts/check-manifest.cjs` 必须 0 error** —— 14 道闸门（C1–C14，见 `scripts/check-manifest.cjs` 的 `ORDER`）；其中 C4 检查 `provider.html` 的契约 id **各出现且仅出现一次**，现有 52 个**只增不改**（`scripts/check-manifest.cjs:407-417`、`HANDOFF.md:66`）。
2. **新增提供方时两处 `NO_PROXY` 名单必须逐字同步** —— `src/main.js` 的 `noProxyList` 与 `src/server/server.mjs` 的 `computeNoProxy`（两边注释都写着"逐字同步、顺序一致"）。漏了会 `noProxyMismatch` → 自检重启被看门狗计成崩溃 → **无限重启**（`src/main.js:166`、`src/server/server.mjs:476`、`HANDOFF.md:59-63`）。
3. **密钥与本机路径绝不进仓库** —— `config.defaults.json` / `providers.js` / 任何会提交的文件都不行。该文件随安装包发给每一台机器，里面任何非空的凭据就是公开泄露：C13 拦本机路径与用户名，**C14 拦凭据**（按字段名 + 按形态两条腿走，`scripts/check-manifest.cjs`、`HANDOFF.md:67`）。

## Release 资产

- `BARRouter-Setup-x.y.z.exe(+.blockmap)` — 安装包（差分包可选）
- `latest.yml` — electron-updater 清单
- `upgrade.ps1` — 一键升级脚本（方式 3）
