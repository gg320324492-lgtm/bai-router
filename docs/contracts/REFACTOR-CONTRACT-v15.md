# REFACTOR-CONTRACT v15 — 公共功能主界面（总览页）+ 提供方页收敂为免费模型界面

**单 agent 任务，几乎独占面板层**：`src/server/providers.js`、`provider.html`、`panel-common.css`、`panel-common.js`、`server.mjs`（仅路由两处）、新建 `cards/overview.js`、`scripts/check-manifest.cjs`（仅三处硬约定同步）。
v1.0.60 已发布并复验，**绝不许回退**：清单驱动架构（一份模板 + 一份清单）、52 个模板契约 id 只增不改、渲染层不得出现提供方字面量（C11）、13 道闸门必须全绿。

> **你是执行者，我是复验者**。本契约已把全部侦察结论写成规格；若发现规格与事实不符，**停下来报告，不要闷头改错**。

---

## 一、目标（用户原话）

「自动故障转移、接回 CC Switch 这些类似的公共功能，单独做一个主界面；剩下的是这些提供方的免费模型界面。」

### 目标信息架构

| 页面 | 路径 | 内容 |
|---|---|---|
| **总览（新，主界面）** | `/` | 当前接线状态（CLI/桌面版各接哪家）+「接回 CC Switch」+ 自动故障转移卡 + 刷新全部模型卡 + 六家渠道状态卡（新） |
| B.AI | `/bai`（**路径变更**） | 路由表（模型映射）+ 本机设置 + Clash 灯 |
| SenseNova / WorkBuddy / Zen / Qoder / OpenRouter | `/sn` `/wb` `/zen` `/qd` `/or`（不变） | 各自的免费模型界面：引导卡、路由表、专属卡（令牌/目录/轮换）、设置 |

- `src/main.js:414` `win.loadURL(PANEL)` 不带路径 → 根路径 → **进应用第一眼就是总览页，main.js 零改动**。
- 公共功能从 provider 页**搬走**：`failover` 卡（现在挂在 bai 页）、`model-sync` 卡（现在六家全挂，收敂到总览一处）。
- 提供方页**保留**：路由表（免费模型选择）、引导、专属卡（`token-capture` / `model-catalog` / `or-rotation`）。

---

## 二、逐文件改动规格

### 1. `src/server/providers.js`

**(a) 新增 `home` 条目，放在对象最前面**（`window.BAI_PROVIDERS = {` 之后、bai 之前）。整条照抄，文案不许自由发挥：

```js
    /* ================= 总览（/）—— 公共功能主界面 =================
     * 定位（用户原话）：「故障转移、接回 CC Switch 这些公共功能单独做一个主界面」。
     * 本页没有任何「可接通的对象」，也没有模型映射——那些去各家页签。
     * hideApply / hideCards 是本页的清单开关：panel-common.js 按字段分支，
     * **不得**因此出现 provider 字面量（C11 会拦）。 */
    home: {
      key: "home",
      path: "/",
      tab: "总览",
      h1: "路由台总览",
      sub: "公共功能 · 六家免费渠道",
      title: "路由台总览 · B.AI 路由台",
      accentLabel: "",                    // 本页没有「接通」动作
      primaryBtn: "",                     // hideApply=true，渲染层不会用它
      targetName: null,
      relayHint: null,
      guide: [],                          // 无两步引导（C2 合法值：0 或 2）
      hint: null,
      settingsTitle: null, settingsAux: null, settingsEyebrow: null,
      foldKey: "bai.homesec3",
      lamps: ["clash", "relay", "cc"],    // 全局视角三盏：出海代理 / 中转服务 / CC Switch
      lampNames: { clash: "本机代理", relay: "中转服务", cc: "CC Switch" },
      lampSubs: { relay: ":15723 面板端口", cc: "配置接管状态" },
      extraCards: ["failover", "model-sync", "overview"],
      footNote: "本页管公共功能（故障转移 / 接回 CC Switch / 全部刷新）；改模型映射请去上方对应提供方页签",
      footNoteAlt: "数据保存在 %APPDATA%\\bai-router · 本页管公共功能，模型映射在各家页签",
      cardEyebrow: "状态",
      routeEyebrow: null, routeTitle: null,
      routeKey: null,
      wireHint: "这里显示 Claude Code（终端 + 桌面版）当前接在哪家；「接回 CC Switch」随时把配置还给 CC Switch。四档模型映射与免费模型选择，请去上方对应的提供方页签。",
      /* ---- 本页专属开关（清单驱动；C12 要求的字段仍在下方） ---- */
      hideApply: true,                    // 接线卡不显示「接通」按钮（本页没有可接通的对象）
      hideCards: ["route", "settings"],   // 本页不渲染路由表与本机设置卡
      /* ---- v1.0.48 清单化字段（C12 强制：全部必须存在且合形） ---- */
      brands: { free: "免费" },           // C12 要非空对象；本页无路由表，overview 卡实际读各家的 brands
      defaultModels: [],                  // 本页没有「恢复默认模型」按钮（[] 合法）
      applyInfoMsg: null, resetModelsMsg: null, step1Hint: null,
      keyMatch: "keyMatch",               // C12 要非空字符串；本页无凭据灯，该字段不会被读到
      shape: "flat",                      // 与 bai 同为顶层形状：灯/接线语义正是全局视角
      sys: {},                            // C12 要对象；本页无刷新/部署/保存按钮
      modelsEndpoint: null,
      settingsLabels: { relayPort: "中转端口" },
      notices: {
        stale: "当前有一端接在本路由台的某个渠道上。想换渠道去上方对应页签；想把配置还给 CC Switch，点下方「接回 CC Switch」。",
        ccSwitch: "CC Switch 正在运行——它可能随时把配置改回 15721。若某个渠道突然失效，去对应页签重新接通即可。",
      },
      // 别从灯名反推简称。
      shortName: "路由台",
```

**(b) bai 条目**：`path: "/"` → `path: "/bai"`。其余一字不动。

**(c) 各家 extraCards 收敂**：`failover` 从 bai 移除（bai 变 `[]`）；`model-sync` 从**全部六家**移除（bai→`[]`、sn→`[]`、wb→`["token-capture"]`、zen→`["model-catalog"]`、qd→`["model-catalog"]`、or→`["or-rotation"]`）。卡文件本身**不删**（C6 反向只 warn）。注释同步更新 `extraCards` 行的说明。

### 2. `src/server/provider.html`

- **nav**（43-50 行）：第一个 tab 改为总览、bai 改路径，共 7 个 tab：
  ```html
  <a href="/" class="prov-tab" data-key="home">总览</a>
  <a href="/bai" class="prov-tab" data-key="bai">B.AI</a>
  …（其余五个原样）
  ```
  C9 会双向校验：每个 manifest key 有 tab 且 `href === path`；tab 的 data-key 必须存在于清单。
- **head 引导脚本**（30-33 行）：`seg || "bai"` → `seg || "home"`（根路径现在属于 home；`/bai` 的 seg 本就是 "bai"）。注释里那句「从路径推出当前 provider key」同步改为能表达空路径 = home。
- 其余（含 52 个契约 id）**一字不动**。

### 3. `src/server/panel-common.css`

- 新增 `html[data-provider="home"] { … }` 配色块（**必须定义 `--accent`**，C7）与 `html[data-theme="light"][data-provider="home"] { … }` 亮色块。色值风格与现有各家块一致（从 `html[data-provider="bai"]` 块的结构复制再换色；避免与现有 6 家雷同）。

### 4. `src/server/panel-common.js`（三个字段驱动分支；**全文不得出现 `home`/`bai` 等 provider 字面量**，C11 抓 `===`/`!==` 两侧、`["x"]` 下标、字面量数组三种形态）

- **`relocateApplyRow()`（688-706）**：新增分支——`P.hideApply` 为真时，**不搬** btnApply/checks，只把 guide 卡隐藏（`if (HAS_GUIDE) return` 之后按字段判断；无引导 + hideApply 的页 = 接线卡只保留原生的「接回 CC Switch」）。
- **`applyManifest()`（4.5/4.6 附近，755-784）**：`P.hideCards` 数组驱动——含 `"route"` 时把路由表整卡 `style.display = "none"`；含 `"settings"` 时把本机设置卡隐藏。参照现有 `showEl()` / `ph.style.display = "none"` 的既有写法，不要新造机制。
- **`lampList()`（805）不动**——`home.lamps` 给的是三盏非空子集，兜底逻辑天然不触发。
- 其余渲染逻辑**不碰**。renderSys/renderRoute 照常跑（卡被隐藏，填值无人看见；确保不抛错即可）。

### 5. `src/server/server.mjs`

- **只在两处动**：
  1. 3425-3431 的显式路径比较：`u.pathname === "/" ||` 之后加 `u.pathname === "/bai" ||`（顺序随意，保持既有排版）。
  2. `PROVIDER_ALIAS`（3410-3417）：**不变**——`"/index.html": "/"`、`"/ui.html": "/"` 现在指向总览，语义正确（老书签进主页）。
- `statusPayload` / `/api/config` / `/api/apply` / `/api/restore` / `/api/models*` **一律不动**：overview 与各卡读的都是全量 status/config；接回按钮走既有 `/api/restore`。

### 6. 新建 `src/server/cards/overview.js`（六家渠道状态卡，挂总览页）

- 契约（C6 强制）：`window.BAI_CARDS["overview"] = { mount(ctx) { … return { update } } }`；`mount` 只注册 DOM/事件、**不做网络**（数据走 `ctx.status`/`ctx.cfg` 与 `update()`）；文件名/注册键/卡名同名且小写 kebab；注释中文。
- `ctx` 契约见 `panel-common.js:1481-1491`（`key / P / cfg / status / slice / st / slot / $ / q / api / postJSON / showInfo / showResult / setLed / withBusy / esc / poll / refreshConfig / renderStatus / renderRoute / renderSys / renderSteps / fold / loadScript / TIERS / MODE_TXT / SHORT / fill`）。
- 内容（一张卡）：
  - 标题行：`eyebrow`「渠道」`title`「六家免费渠道」`aux` 显示当前接线概要（如 `CLI → B.AI · 桌面版 → WorkBuddy`，从 `ctx.status.cli?.mode` / `desktop?.mode` + `ctx.MODE_TXT` 取）。
  - 网格六行（`window.BAI_PROVIDERS` 里除 home 外的每家，**遍历清单生成，不写死名单**）：
    - 左：tab 名（点击整行 → `location.href = P.path`，用 `<a>` 或 button，别用 `onclick` 字符串拼接）；
    - 中：凭据状态（就绪/未配置——判据用该家 status 切片里与 `keyMatch*` 对应的字段或凭据灯的既有判读方式，**照抄各家页面 renderStatus 里对 `keyMatch*` 的用法**；Qoder 看令牌文件状态 `st().token`/补丁状态，**如实显示读到的字段**，不许编字段名）；
    - 右：默认映射目标（`cfg` 对应 slice 的 `mapping["claude-sonnet-5"]?.target` 之类）与最近上游探测（`st()` 里 last 探测时间/结果字段，照抄灯渲染所用字段）。
  - 底部一行小字：提示「模型映射与免费模型选择去各家页面；公共设置（故障转移/顺序）在上方卡片」。
  - `update(status)` 每轮 poll 被调用：重绘上表；`status` 里数据缺失的单元格显示「—」，**不许抛错**（overview 是主页第一屏，抛错比丑更糟）。
- 视觉：`<div class="card foldable">` 结构、`grid2`/`fld`/`hint` 类名、CSS 变量配色——**全部复用现有类**，不新增 CSS（overview 块色跟随 `html[data-provider="home"]`）。折叠交互照抄 `cards/failover.js` 的 `fold()` 用法（ctx.fold）。
- 卡内部元素 id（如 `cardOv`/`ovGrid`）不与模板 52 个契约 id 冲突（自查一遍）。

### 7. `scripts/check-manifest.cjs`（**仅三处，跟着契约同步改**；这就是文件头「改这里 = 改契约，两边一起改」的机制）

| 行 | 现状 | 改为 | 原因 |
|---|---|---|---|
| 196 | `const EXPECTED_PATHS = { bai: "/", sn: "/sn", wb: "/wb", zen: "/zen", qd: "/qd" };` | `const EXPECTED_PATHS = { home: "/", bai: "/bai", sn: "/sn", wb: "/wb", zen: "/zen", qd: "/qd", or: "/or" };` | 路径硬约定更新；顺手补上 or（v13 漏的，加上无害） |
| 269-274 | `const want = key === "bai" ? "/" : "/" + key;` | 形状规则改为：`home` → `"/"`、其余（含 bai）→ `"/" + key`。即 `want = key === "home" ? "/" : "/" + key`（bai 不再例外） | bai 迁到 `/bai` 后新规则 |
| 614 | `const canonical = new Set(["/", "/sn", "/wb", "/zen", "/qd"]);` | 加上 `"/bai"` 与 `"/or"` | C10 canonical 集合与 7 个规范路径对齐 |

- **先实测再改**：`node -e` 复现 606 行的 `renderBlock` 正则，确认它当前是否匹配到 server.mjs 的路由块（我侦察时判断它匹配失败、`served` 为空数组——这解释了为什么 /or 不在 canonical 也没报错）。**把你的实测结论贴进报告**；若你改 server.mjs 后正则开始命中，确认 7 个路径全部在 canonical 里。

---

## 三、验证要求（硬性，全部贴真实输出）

### A. 闸门
1. `node scripts/check-manifest.cjs` → **0 error**（重点盯 C1/C2/C6/C7/C9/C10/C11/C12；C7 要出现 home 的 ok 行；C9 要出现 7 个 tab 的 ok 行）。

### B. 隔离实例（按项目铁律）
2. `BAI_DATA_DIR=%TEMP%\bvb15` + 端口保持默认（15722-15772/15723 本机没被占，直接起；**先 `Get-NetTCPConnection` 确认默认端口全空闲**，有占用就换 17xxx 并同步改 DATA_DIR 里的 config.json 端口），起 server：
   `node src/server/server.mjs`（env：`BAI_DATA_DIR`、`USERPROFILE` 指临时目录防污染——照抄 `scripts/sandbox-launch.cjs:10-21` 的隔离手法）。
3. `curl http://127.0.0.1:15723/`、`/bai`、`/sn`、`/wb`、`/zen`、`/qd`、`/or` **七个路径全部 200 + text/html + body 含 `prov-nav`**（证明模板发对了）；`/index.html` 与 `/ui.html` **302 → /**（alias）。
4. `curl http://127.0.0.1:15723/providers.js`、`/panel-common.js`、`/panel-common.css`、`/cards/overview.js`、`/cards/failover.js`、`/cards/model-sync.js` 全 200。
5. 测完 `taskkill //PID <pid> //F`（**只许按 PID**，绝不 `/IM node.exe`——正式实例在跑），删 `%TEMP%\bvb15`。

### C. 渲染逻辑静态断言（无浏览器环境的替代验证；**诚实标注这是静态验证，不是真实浏览器渲染**）
6. 写一次性 node 脚本放 `%TEMP%`（**不进仓库**）：
   - `evalInSandbox` providers.js（照抄 check-manifest.cjs 的 sandbox 手法，119 行附近），断言：
     `Object.keys(BAI_PROVIDERS)` 顺序 = home 在最前；`home.path === "/"`；`bai.path === "/bai"`；manifest 的 path 集合 **===** 模板 prov-tab href 集合（从 provider.html grep）**===** server.mjs `u.pathname === "X"` 集合；
     `home.extraCards === ["failover","model-sync","overview"]`；六家 extraCards 均不含 model-sync/failover；bai.extraCards === []；
     C12 NEEDED 七个字段 home 全部合形（直接从那 7 个 test 函数抄）。
   - grep panel-common.js 全文：`=== *"home"`、`!== *"home"`、`"home"===`、`\["home"\]`、`"bai"` 等 provider 字面量三形态 **0 命中**（剥注释后扫，照抄 C11 逻辑跑一遍）。
   - grep provider.html：52 个契约 id 仍各恰好一次（C4 已跑，复述结论即可）。
7. 启动日志无致命错：测 instance 的 stdout/stderr 落盘 grep `Error|throw|listenWithRetry` 相关，贴尾部。

### D. 诚实边界（报告里必须单独一节）
- **未做真实浏览器/DOM 渲染验证**（本机无 headless browser 环境）：所有交互结论均为「静态结构 + 字段驱动 + 闸门」推得，不是点出来的。列明哪些行为**必须由用户在正式机人工点验**：`/` 打开即总览、三盏灯有值、接回按钮可点且生效、overview 六行数据真实、点行能跳对应页签、bai 页 `/bai` 路由表可保存映射、`/index.html` 老书签 302 到总览。

---

## 四、红线（违反即任务失败）

- **不 commit、不 push、不改 version、不跑 `npm run publish/dist`**。
- 模板 52 个契约 id **一个都不许动**（只增也得先问——本任务不需要新增）；`provider.html` 除 nav 两个 tab 与引导脚本 `|| "home"` 外**一行不动**。
- `panel-common.js` 除规格里三个字段驱动分支外**一行不动**；且**全文不得出现 provider 字面量**。
- `server.mjs` 除规格两处外**一行不动**；`check-manifest.cjs` 除规格三处外**一行不动**。
- `config.defaults.json` / `providers.js` 各家现有文案 / `failover.mjs` / `cards/` 现有五个卡 / `main.js` / `preload.js` / `install-consistency.js` **一律不许动**。
- **绝不 taskkill `/IM node.exe`**；绝不写真实 `%APPDATA%\bai-router`；测试只许 `BAI_DATA_DIR` + 隔离 USERPROFILE + 17xxx/默认空闲端口。
- 不在仓库留 `*.log`/临时文件；注释与文案中文。

## 五、汇报要求

分节：① 每个文件改了什么（逐文件逐点，贴关键 diff）② A/B/C 全部验证的真实输出（不许省略、不许编造）③ 诚实边界（D 节原文 + 你补充的）④ 你发现我的规格哪里错了或漏了（直接说）⑤ 存疑处。报告控制在 1500 字内，验证输出不在此限。
