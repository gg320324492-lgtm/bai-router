# REFACTOR-CONTRACT v9 — WorkBuddy 一键获取令牌失效 + Qoder 新机接入（v1.0.57）

两个独立工作项，**互不冲突，可并行**。

---

## 工作项 A — WorkBuddy「一键获取令牌」两分半超时

### 用户现象
在另一台电脑上，WorkBuddy 开着，点「一键获取令牌」，**等了两分半也无法接入**。

### 我已经实测定位到根因（可采信，但关键处请自行复核）

**超时值对得上**：`server.mjs:1097` `wbCaptureToken(timeoutMs = 150000)` = **150 秒 = 两分半**。

**钩子机制本身是有效的**。我在本机实测：把探针注入
`<WorkBuddy>/resources/app.asar.unpacked/cli/bin/codebuddy`（shebang 之后），
跑 `node codebuddy -p "say hi"`，探针**成功抓到**：
```
[https.request] www.workbuddy.ai 命中头: Authorization
```
所以「注入位置」和「挂 `https.request`」这两件事都没问题。

**真因：钩子的判定条件太严。** `server.mjs:1011`：
```js
if (tok && tok.indexOf(".") > 0 && ref) __grab(JSON.stringify({...}));
```
`ref` 来自 `X-Refresh-Token`，`tok` 来自 `Authorization`。**要求两者同时出现**。

但实测证明：**普通业务请求只带 `Authorization`**，
`X-Refresh-Token` **只在令牌续期请求**（`/v2/plugin/auth/token/refresh`）里出现，
而续期只在**令牌过期时**才发生。

→ 于是：**令牌没过期时点「一键获取令牌」，钩子永远等不到同时带两个头的请求，
必然超时。** 用户看到的「两分半过去也无法接入」就是这么来的。

**还需确认一件事**（我没做完）：用户那台电脑上，WorkBuddy 的令牌是**存在本地文件里**
还是**只在内存**。如果本地有持久化的令牌文件，可能根本不需要「捕获」——
直接读文件更可靠。**请你去查证**：`<WorkBuddy>` 安装目录 / `%APPDATA%` / `%LOCALAPPDATA%`
下有没有存令牌的 json（关键词 `token` / `credential` / `auth` / `session`）。
**如果找到了，优先改成读文件**——那是最稳的方案，不用注入、不用等。

### 要做的

1. **放宽捕获条件**（如果仍需保留注入方案）：只要拿到带 `Authorization` 的
   合法 Bearer（含 `.`，像 JWT）就应该记下来；`X-Refresh-Token` 有则更好、没有也别丢。
   注意：**写入 config 的逻辑要求 accessToken + refreshToken 两者都有**
   （`server.mjs:1128` 附近）——放宽捕获后要想清楚 refreshToken 从哪来：
   - 从磁盘上已有的配置继承？还是
   - 只在两个头都抓到时才写、但**先把 accessToken 存下来**以免白跑？
   **你判断并说明理由。**

2. **给出更有用的失败提示**。现在超时只说「请在 WorkBuddy 客户端里随便发一条消息」，
   但实测证明**发了消息也未必够**（消息走的是 Authorization-only 路径）。
   提示要如实告诉用户当前卡在哪一步。

3. **缩短无效等待**。150 秒纯等很折磨人。如果能在等待期间**给用户实时反馈**
   （例如已捕获到 accessToken、还差 refreshToken），体验会好很多。

### 文件边界
- `src/server/server.mjs` —— 钩子、捕获逻辑、提示文案
- 若需要暴露进度给前端：`src/server/cards/token-capture.js`（它接 `#btnCapture`）

---

## 工作项 B — Qoder 在新电脑上「即使开着也检测不到」

### 用户现象
在其他电脑上，**即使 Qoder 开着**，Qoder 页仍显示「访问令牌 未读到 / 请启动 Qoder 桌面端」。

### 原因（显而易见但要说清）
Qoder 的令牌靠 **`qoder-patch/patch_worker.py` 给 Qoder 的 worker 打补丁**才能实时落盘。
**新电脑上没跑过这个补丁**，所以 `%TEMP%\qoder-token.json` 不存在 → 中转读不到 → 显示「未读到」。

### 要做的

**核心诉求：让用户在新电脑上不用手动跑 Python 脚本就能接入。**

先**调研现状**（别急着写代码）：
1. `qoder-patch/patch_worker.py` 现在怎么用？需要什么前提（Python？管理员权限？）？
2. 它是**每次 Qoder 升级后都要重跑**的（版本目录会变）——这个负担能不能消掉？
3. 有没有**不依赖补丁**的方案？例如：
   - Qoder 的令牌是否在某处有磁盘持久化（内存 dump / 配置文件 / localStorage）？
   - 能否在**中转侧**直接调 Qoder 的某个接口拿令牌（若有 refresh 机制）？
   - Qoder 是否支持 `QODER_MODEL_TRANSPORT=http` 之类的环境变量让我们换个获取方式？

**把你的调研结论和推荐方案写进报告**，然后**先实现你能确定可用的那部分**。

如果结论是「必须跑补丁」，那至少要做到：
- 面板上**给出一键式指引**（哪下载 Python、跑什么命令、点哪里）
- 或者**把补丁能力内置**（Node 也能读写文件、改 asar.unpacked，不一定非要 Python）

**注意**：Qoder 装在 **D 盘**（`D:\Users\admin\AppData\Local\Programs\Qoder\`），
多版本并存于 `.qoder-versions\{0.3.3,0.4.2,0.4.3}\resources\`。
新电脑的路径可能不同，**脚本必须自己找**（现有脚本已有跨盘查找逻辑，可参考
`server.mjs` 的 `findWbCliScript()`）。

### 文件边界
- `qoder-patch/patch_worker.py`、`qoder-patch/` 下的其它文件
- 必要时 `src/server/server.mjs` 的 Qoder 相关错误提示
- `src/server/providers.js` / `cards/model-catalog.js` 的 Qoder 文案

---

## 通用要求

- 代码注释与文案**都是中文**
- **不许写真实的 `%APPDATA%\bai-router\config.json`**；起服务测试用 `BAI_DATA_DIR` 指临时目录 +
  端口挪 17xxx/18xxx，测完 `taskkill //PID <pid> //F`
- **绝对不要用 `taskkill /IM node.exe`**——之前有 agent 那样做误杀了正式实例
- 打包/联网需 `export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`
- **不要发** GitHub release，**不要改** `package.json` 的 version
- 改完 `node scripts/check-manifest.cjs` → **0 error**

## 报告要求

分 A/B 两节。写：改了什么、**怎么验的**（实际输出）、**不确定或没做到的地方**。
B 尤其要写清**调研结论**——如果发现我说的原因不对，直接说。
**不要假装验过自己没验的东西。**
