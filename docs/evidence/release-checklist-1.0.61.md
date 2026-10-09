# 发布检查清单 — v1.0.61

> **谁执行**：编排者准备**内容与验证**；**`npm run dist` 打包与 `npm run publish`（内含 `gh release create`）由编排者亲自执行**。
> 准备阶段（本次已完成）：bump version、起草 release notes、本清单、只读预检。
> `gh release create` 是不可逆的对外动作——本次已获用户授权，但**执行者必须是编排者**，准备方不得代跑。

---

## A. 版本与一致性闸门

- [x] `package.json` `version` → `1.0.61`（只改这一个字段；`build.signtoolOptions` 证书路径/口令、`files` / `extraResources` 白名单原样不动）
- [x] `node -e "JSON.parse(...)"` 解析 package.json 合法
- [x] `node scripts/check-manifest.cjs` → **0 error, 0 warn**
- [x] `git diff -- package.json` 只有一行 version 变化

## B. 产物（**关键：现有 dist 是旧产物，必须重打包**）

- [ ] ⚠️ **`dist/win-unpacked` 是 v1.0.60 的旧产物**——不重打包就核验会得到**假绿灯**：
      任何对 `dist/` 跑的校验/手工试运行，验的都不是这次要发的代码
- [ ] 打包前确认 `dist/` 里没有本次新增/改名但未被收进安装包的文件（新增总览页卡 `src/server/cards/overview.js` 已在 `extraResources` 的 `from: src/server/cards` 整目录内，随包走）
- [ ] `npm run dist` 成功，产物文件名 `BARRouter-Setup-1.0.61.exe`（artifactName 用 `${version}`）

## C. 签名与凭证

- [ ] 签名证书 `cert/bai-router.pfx` 存在（本次预检：`Test-Path` 结果见下方记录）
- [ ] 打包日志出现签名成功、无 self-signed 降级警告

## D. 发布内容

- [ ] **仓库根 `release-notes.md` 整份替换为 v1.0.61**（草稿在同目录
      `docs/evidence/release-notes-1.0.61-draft.md`）
      ⚠️ 替换前该文件仍是 **v1.0.60 已发布内容**；替换**必须发生在打包之前**，
      因为它会被 electron-builder 写进 `latest.yml`
- [ ] 替换后 notes 里不含任何密钥、哪怕前缀
- [ ] notes 内容与本次改动一致（对照 `git log db6e237..HEAD`）

## E. 网络

- [ ] **必须走代理**，否则 GitHub 直连 ETIMEDOUT：
      ```bash
      export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"
      ```
- [ ] 代理 7897 探活通过（本次预检已通过，见下方记录）
- [ ] `gh auth status` 已登录 `gg320324492-lgtm`

## F. 发布（需授权，本次已授权，执行者是编排者）

- [ ] `npm run publish` → 内部跑 `check-manifest` → `gh release create v1.0.61 …`
- [ ] **该命令不可逆**，发布前必须确认 B/C/D/E 全部通过
- [ ] 推送：未推提交需先 push 到 main；**准备方不自行 commit / push**

---

## 发布后核验

- [ ] GitHub release 页面资产齐全：`.exe` + `.blockmap` + `latest.yml` + `upgrade.ps1`
- [ ] `latest.yml` 带 `releaseNotes` 字段（v1.0.58 起才有；缺失说明 release-notes.md 替换时机不对）
- [ ] 软件内「检查更新」能看到 **1.0.61**（版本号来自 package.json，notes 来自 latest.yml）
- [ ] 一键升级能下完并装上
- [ ] **本机正式实例升级后打开，第一屏是「总览」**，顶部页签顺序为：总览 / B.AI / SenseNova / WorkBuddy / OpenCode Zen / Qoder / OpenRouter
- [ ] 总览页三盏灯有状态；点「六家免费渠道」表任意一行能进对应页签
- [ ] B.AI 页签里没有「自动故障转移」「刷新全部模型」两张卡（应在总览页）

---

## 本次特有已知风险

1. **总览页尚未在正式安装版上由用户人工点验**
   目前只做过两类验证：闸门 / HTTP 静态路径验证，以及（另路并行的）Electron 真实渲染验证。
   **没有**在已安装的正式版本上由用户亲手点过一遍。发布后第一件事请人工确认第一屏与两个公共卡。

2. **`/bai` 路径变更的影响面**
   B.AI 从根路径迁到 `/bai` 后，任何**直接访问旧路径 `/` 想看 B.AI** 的用户会先落到总览页——**这是有意为之**
   （总览页底部有指引指向 B.AI 页签），但如果有人靠浏览器书签直达 B.AI，他看到的会变成总览，需手动切一次页签。

3. **`publish.cjs` 会同步本机配置快照，发布后可能产生 diff**
   `publish.cjs` 开头会拿本机 `%APPDATA%\bai-router\config.json` 同步脱敏快照到 `src/server/config.defaults.json`。
   发布后该文件可能产生 diff，**须人工逐行确认**：只应包含模型列表 / 模型映射的变化，
   **`apiKey` 与本机路径必须仍为空**，确认后**再决定是否提交**。没看过 diff 不要提交。

---

## 附：本次预检真实输出

- 闸门：`--- 0 error(s), 0 warn(s) ---` / `check-manifest OK`
- `gh auth status`：见汇报正文
- `Test-Path cert/bai-router.pfx` / `Get-ChildItem dist`：见汇报正文（产物时间戳为 v1.0.60 时期）
- 代理探活：`https://api.github.com` 经 `127.0.0.1:7897` → 200
- `git status --short`：仅 package.json（version bump）+ 本目录下两个新 md
- `git log --oneline db6e237..HEAD`：仅 `6a97b1b`（面板重构）；CI 闸门、仓库整理、密钥清除三条见 `db6e237..v1.0.60` 区间提交