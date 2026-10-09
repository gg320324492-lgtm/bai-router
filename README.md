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

1. **`node scripts/check-manifest.cjs` 必须 0 error** —— 13 道闸门（C1–C13，见 `scripts/check-manifest.cjs:816` 的 `ORDER`）；其中 C4 检查 `provider.html` 的契约 id **各出现且仅出现一次**，现有 52 个**只增不改**（`scripts/check-manifest.cjs:407-417`、`HANDOFF.md:66`）。
2. **新增提供方时两处 `NO_PROXY` 名单必须逐字同步** —— `src/main.js` 的 `noProxyList` 与 `src/server/server.mjs` 的 `computeNoProxy`（两边注释都写着"逐字同步、顺序一致"）。漏了会 `noProxyMismatch` → 自检重启被看门狗计成崩溃 → **无限重启**（`src/main.js:166`、`src/server/server.mjs:476`、`HANDOFF.md:59-63`）。
3. **密钥与本机路径绝不进仓库** —— `config.defaults.json` / `providers.js` / 任何会提交的文件都不行，C13 闸门直接拦（`scripts/check-manifest.cjs:717`、`HANDOFF.md:67`）。

## Release 资产

- `BARRouter-Setup-x.y.z.exe(+.blockmap)` — 安装包（差分包可选）
- `latest.yml` — electron-updater 清单
- `upgrade.ps1` — 一键升级脚本（方式 3）
