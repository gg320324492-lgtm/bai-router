# REFACTOR-CONTRACT v5 — 更新时显示更新日志（v1.0.51）

给实施 agent 的边界契约。**两个工作项**，有严格的先后关系（B 依赖 A 的产出）。

---

## 需求

用户希望在**软件内更新时**能看到「本次更新了什么」。

## 现状（我已逐条查证，可采信，但关键点请自行复核）

数据链路现在**断在中间**：

1. `publish.cjs:11` 读命令行参数作 notes，`publish.cjs:111` 用
   `gh release create --notes "..."` 发到 GitHub。
2. 但 `dist/latest.yml` **没有 `releaseNotes` 字段**（已实测）。`electron-updater`
   读的就是 `latest.yml`，所以**它根本看不到更新日志**。
3. `src/main.js:519-523` 的 `update-available` 回调拿到了 `info`，
   但只取了 `info.version`，**把 `info.releaseNotes` 丢掉了**。
4. `updateState` 里因此没有 notes；`notifyWindow("app-event", {kind:"update",state})`
   发出去的 state 里也没有。
5. `panel-common.js:254` 的 `paintUpdate(st)` 渲染横幅，**没有任何地方显示更新日志**。

**结论：四段链路，中间三段都缺。要打通得改 4 个文件。**

## 关键约束（重要，别踩）

- **`#bnrUpdate` 及其子元素（`#bnrUpdTitle` / `#bnrUpdBar` / `#bnrUpdMsg` /
  `#bnrUpdRow` / `#bnrUpdGo` / `#bnrUpdLater` / `#bnrUpdSelf` / `#bnrUpdX`）
  是由 `panel-common.js` 动态注入的，不在 `provider.html` 里。**
  `scripts/check-manifest.cjs` 的 C4 只检查 `provider.html` 里的 52 个契约 id，
  并**显式注明**这些 bnrUpd* 不在其中。所以：
  - **不要**往 `provider.html` 加横幅元素（会破坏 C4 的"每 id 恰好一次"约定）
  - 新元素要加在 `panel-common.js` 注入横幅的那段 HTML 字符串里
- `scripts/check-manifest.cjs` 的 **C5** 做反向检查：`$()`、`onClick`、`applyText`、
  `has` 里引用的 id **必须都能解析**。你新加的 id 一定要有对应元素，否则 C5 报错。
- 这是**五页共用**的渲染层。改 `panel-common.js` 的横幅要确认**五个页面**都正常。

## 目标设计（推荐方案，你也可以提出更好的并说明理由）

用 electron-builder 的 `releaseInfo.releaseNotesFile`：

1. **写日志文件**：约定 `release-notes.md`（放仓库根，或 `build/` 下，你定），
   每次发布前由人填本次更新内容（markdown）。
2. **`package.json`** 加：
   ```json
   "build": { "releaseInfo": { "releaseNotesFile": "release-notes.md" } }
   ```
   → electron-builder 会把它写进 `latest.yml` 的 `releaseNotes` 字段。
3. **`src/main.js`**：在 `update-available` / `update-downloaded` 里把
   `info.releaseNotes` 存进 `updateState`。
   注意 `releaseNotes` 的类型是 `string | Array<ReleaseNoteInfo> | null`
   （见 `node_modules/builder-util-runtime/out/updateInfo.d.ts:52`）——**两种都要处理**。
4. **`src/server/panel-common.js`** 的 `paintUpdate`：在横幅里显示日志。
   建议做成**可折叠**（默认展开一小段，点「详情」看全部），
   因为日志可能很长，横幅在页面顶部不能撑太大。

---

## 工作项 A — 打通后端链路（agent A）

**文件边界：`publish.cjs`、`package.json`、`src/main.js`、新建 `release-notes.md`**

要求：
1. 新建 `release-notes.md`，内容写**本次（v1.0.51）**的更新说明，
   用**中文**，条目式。本次的实际改动见下面「v1.0.51 内容」。
2. `package.json` 加 `build.releaseInfo.releaseNotesFile`。
   **注意**：`package.json` 顶层已有 `"build"` 对象，要往里面加，别覆盖。
3. `src/main.js`：把 `info.releaseNotes` 接进 `updateState`（两种类型都处理，
   数组时取 `.note` 字段拼接）。
4. `publish.cjs`：现在 `gh release create --notes "<命令行参数>"`。
   打通后**日志文件是唯一来源**会更一致——但**不要贸然删掉命令行参数的支持**
   （那会破坏你已有的发布习惯）。建议：命令行参数仍优先，缺省时读
   `release-notes.md`。**你决定，并说明理由。**
5. **验证 `latest.yml` 真的带上了 `releaseNotes`**——这是本项的核心判据。
   你需要**实际打包一次**（不是只改配置就宣称完成）。

### v1.0.51 的更新内容（写进 release-notes.md）
本次要发的内容就是「更新时显示更新日志」这个功能本身。写清楚：
- 软件内更新时可以看到本次更新了什么
- 折叠式展示，不占地方
（你可以润色，但要如实。）

---

## 工作项 B — 面板显示（agent B）

**文件边界：`src/server/panel-common.js`（仅 `paintUpdate` 及注入横幅那段 HTML）**

要求：
1. 在横幅里加日志展示区。新元素加在 `panel-common.js` 注入的 HTML 字符串里
   （**不是** `provider.html`）。
2. `paintUpdate(st)` 里读 `st.releaseNotes` 并渲染。
   - **没有日志时要优雅降级**（老版本发的包没有这个字段）——不能显示空白框或报错
   - 长文本要能折叠，折叠状态**不要求**持久化
3. 保持现有四种 phase（`downloading` / `ready` / `error` / `latest`）的行为不变。
   **特别注意 `error` 分支**（约 269-290 行）有证书信任与重试逻辑，**不要动它**。
4. 文案用**中文**，风格与现有横幅一致（参考 `bnrUpdMsg` 的措辞口吻）。

---

## 通用要求

- 代码注释与文案**都是中文**，注释解释"为什么"。
- **不许写真实的 `%APPDATA%\bai-router\config.json`**。若需要起服务测试，
  复制配置到临时目录、端口挪到 17xxx/18xxx、`BAI_DATA_DIR` 指向它，
  测完 `taskkill //PID <pid> //F`。有一台正式实例在跑（占 15722/15723）。
- 打包需要代理：`export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`
  （不设会 `ETIMEDOUT` 到 GitHub）。
- 改完必须 `node scripts/check-manifest.cjs` → **0 error**。

## 文件边界（避免冲突）

- **agent A**：`publish.cjs`、`package.json`、`src/main.js`、`release-notes.md`（新建）
- **agent B**：`src/server/panel-common.js`
- **两者不重叠。** 但 **B 依赖 A 定义 `releaseNotes` 的字段名**——
  统一约定为 **`state.releaseNotes`**（字符串）。A 负责保证发出来的是这个字段名。

## 报告要求

分 A/B 两节。每节写：改了什么、**怎么验的**、**实际命令输出**、
以及**你不确定或没做到的地方**。含糊的地方我会当成缺陷。

A 尤其要给出 `latest.yml` **含 releaseNotes 字段的实际内容**（贴出来）。
B 尤其要说清：**没有日志时的降级行为**你是怎么处理的、怎么验的。
