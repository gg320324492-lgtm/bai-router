# REFACTOR-CONTRACT v6 — 更新时弹出对话框（v1.0.52）

给实施 agent 的边界契约。**两个工作项**，有明确的接口约定。

---

## 需求（用户原话）

> 在检查更新的时候，如果有新版本，就会弹出一个弹框，里面有更新日志内容以及安装的按钮

**不是**右下角一闪而过的小横幅，是**主动弹出的对话框**，让用户停下来看到「这一版改了什么」。

## 为什么现在的横幅没被看到（我已查明，可采信）

v1.0.51 做的更新日志挂在了右下角的 `.banner` 上，而这个横幅：

1. **位置不显眼**：`panel-common.css:345`
   `.banner-wrap { position: fixed; right: 18px; bottom: 18px; ... max-width: 360px; }`
   —— 是右下角浮层，不是模态框。
2. **时机错过**：`src/main.js:528` 有 **`au.autoDownload = true`**。
   检测到新版后 electron-updater **立刻自动开始下载**，横幅瞬间进入「正在下载 3%」，
   用户还没看清就已经在下载了。

用户的实际经历（从 `%APPDATA%\bai-router\app.log` 查到）：
```
[2026-10-03T03:34:47.980Z] 手动检查更新完成: 远端最新 v1.0.51
```
检测**成功**了，但用户什么都没看到。

## 目标设计

检查更新 → 发现新版本 → **弹出模态对话框**：

- 标题：`发现新版本 v1.0.52`
- 正文：**更新日志全文**（可滚动，内容长时不能撑爆窗口）
- 按钮：**「立即安装」** / **「稍后」**（措辞可优化）
- 用户点「立即安装」→ 走现有安装流程

### 一个需要你判断的设计点

现在 `autoDownload = true`，检测到就自动下载。做弹框后有两种选择：

- **(a) 保持自动下载**：弹框只作告知，用户看到时可能已经下完了 → 「立即安装」直接可用
- **(b) 改成 `autoDownload = false`**：弹框出现 → 用户点「立即安装」才开始下载 → 有进度反馈

**推荐 (b)**，理由：用户明确表达想看日志再决定；(a) 的情况下弹框出现时下载已在进行，用户点「稍后」会浪费已下载的流量，且「立即安装」按钮的状态语义混乱（是开始下载还是重启？）。

**但你要自己评估**，特别是：改成 (b) 后**自动更新（启动 8 秒后那次静默检查）会怎样**——
现在的设计是静默自动更新，用户不用管。若 (b) 导致每次启动都弹框，那是**倒退**。
**必须保证：自动检查仍然静默**（后台下载、不弹框），只有**用户手动点「检查更新」**才弹框。
这是本契约最重要的约束。

---

## 现有代码结构（给你定位用）

- `src/main.js:617` `manualCheckUpdate()` —— 手动检查更新。**弹框的触发点在这里**。
  注意 `:628` 的 `autoUpdater.checkForUpdates()` 是**异步**的，返回值到手时
  `update-available` 事件可能已经先触发了。
- `src/main.js:519-560` `setupUpdater()` 里的各事件回调
  （`update-available` / `update-downloaded` / `error` / `checking-for-update`）
- `src/main.js:508` `manualCheckAt` —— 记录手动检查的时刻，**已存在**，
  正是用来区分「自动 / 手动」的。你多半会用到它。
- `src/preload.js` 用 `contextBridge` 暴露 `window.baiDesktop`，已有
  `checkUpdate` / `installUpdate` / `trustCert` 等。**新增 IPC 要走这里**。
- `src/server/panel-common.js` —— 面板渲染层（五页共用），右下角横幅在这里。
- **注意**：面板是**浏览器页面**，主进程的 `dialog.showMessageBox` 是**系统原生弹框**，
  两者观感完全不同。契约倾向**页面内自绘模态框**（与现有 UI 风格统一、能显示长日志、
  能跟随主题），但**你可以在报告里论证用原生弹框更好**。

---

## 工作项 A — 主进程侧（agent A）

**文件边界：`src/main.js`、`src/preload.js`**

要求：
1. 让「**手动**检查更新发现新版本」这条路径能触发弹框；**自动检查必须保持静默**
2. 把 `releaseNotes` 一并送到渲染层（v1.0.51 已有 `normalizeReleaseNotes`，
   在 `src/main.js:511`，**复用它**）
3. 若你决定改 `autoDownload`，**必须论证自动更新路径不受影响**
4. 新增的 IPC 要经 `preload.js` 的 `contextBridge` 暴露（`contextIsolation` 是开的，
   渲染层拿不到 ipcRenderer）

**判据**：
- `node --check src/main.js src/preload.js` 通过
- `node scripts/check-manifest.cjs` → 0 error
- 报告里说明：你怎么区分自动/手动、怎么保证自动路径静默

## 工作项 B — 渲染层弹框（agent B）

**文件边界：`src/server/panel-common.js`、`src/server/panel-common.css`**

要求：
1. 实现**模态对话框**：标题（含版本号）+ 更新日志（**长内容可滚动**）+ 两个按钮
2. 接收主进程的「有新版本」事件后弹出
3. **必须处理没有日志的情况**（老包不带 `releaseNotes`）——弹框仍要能用，
   只是不显示日志区（v1.0.51 的 `paintNotes` 已有降级逻辑，可参考其思路）
4. 与现有 UI 风格统一（用 `panel-common.css` 里的 CSS 变量 `--accent` / `--panel` /
   `--line` 等，**不要引入新配色**）
5. **五页共用**——确认五个 provider 页面都正常

**判据**：
- `node --check src/server/panel-common.js` 通过
- `node scripts/check-manifest.cjs` → 0 error（特别注意 **C5 的反向 id 检查**：
  `$()` / `onClick` / `applyText` / `has` 里引用的 id 必须都能解析）
- **不要动 `provider.html`**（C4 要求那 52 个契约 id 各出现且仅出现一次；
  v1.0.51 的 `#bnrUpdNotes` 就是加在 `panel-common.js` 的 HTML 串里的，照此办理）

---

## 接口约定（两个 agent 必须一致）

主进程 → 渲染层的事件：
```
{ kind: "update", state: { phase, version, percent?, releaseNotes, manual? } }
```
- 沿用现有 `kind: "update"` 通道（`main.js` 的 `notifyWindow("app-event", ...)`）
- 新增 `state.manual`（布尔）：**true = 用户手动检查触发的，该弹框**
- `releaseNotes` 是**字符串**（`normalizeReleaseNotes` 的产物）
- 弹框的显示条件由 **B** 决定（读 `manual`），A 负责把它填对

**若你认为这个接口需要改**（比如该用独立的 `kind`），**在报告里说明并确保两边一致**——
但注意：**你和另一个 agent 是并行工作的，改接口会让对方对不上**。
**除非有充分理由，否则沿用上面的约定。**

---

## 通用要求

- 代码注释与文案**都是中文**，注释解释"为什么"
- **不许写真实的 `%APPDATA%\bai-router\config.json`**。起服务测试要：
  复制配置到临时目录 → 端口挪到 17xxx/18xxx → `BAI_DATA_DIR` 指向它 → 测完 `taskkill`
  有一台正式实例在跑（占 15722/15723，PID 会变，用 netstat 确认）
- 打包/联网需 `export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`
- **不要发 GitHub release**（`gh release create`）——发布由协调者统一做
- **不要改 `package.json` 的 version**——协调者统一提版本
- **Electron 无头在这台机器上不稳定**（会 crashpad 崩溃、进程提前退出）。
  如果你因此无法做端到端验证，**如实说明**，并至少给出构造输入 + 预期输出的推演。
  **不要假装验过。**

## 报告要求

分 A/B 两节，写：改了什么、**怎么验的**、**实际输出**、**不确定或没做到的地方**。
A 要说清「自动检查仍然静默」是怎么保证的。
B 要说清「无日志时弹框什么样」「长日志怎么滚动」。
含糊的地方我会当成缺陷。
