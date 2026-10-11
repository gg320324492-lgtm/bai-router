# REFACTOR-CONTRACT v17 · 阶段一：单页控制台改版（A 版落地，先壳后数据）

**单 agent 独占任务，五个里程碑串行。** 主战场：`src/server/provider.html`、`panel-common.css`、`panel-common.js`、`providers.js`、`cards/*.js`、`scripts/check-manifest.cjs`。

v1.0.62 已发布并复验，**绝不许回退**：`server.mjs` 的 count_tokens/models 修复与日志留痕、七家清单架构（C1–C13）、故障转移、5 张现有卡片的功能。

> **你是执行者，我是复验者**。规格与事实不符就**停下来报告**。这个任务很大，按下面的里程碑做，**每个里程碑做完先自检再往下做**，别攒到最后一起崩。

---

## 〇、视觉基准与范围

**设计稿（你的实现基准，必须先读）**：`C:\Users\pc\Desktop\UI重设计三版\a-console.html`（75KB 单文件）。它是用户**已采纳**的方案，CSS 与 DOM 结构可直接借鉴——你的任务不是"重新设计"，而是把它**产品化**：翻译成清单驱动 + 接真实数据 + 满足 13 道闸门。截图在同目录 `shots\a-*.png`。

**这一步（阶段一）交付什么**：单页四视图的真实骨架 + 真实状态数据 + 5 张卡适配 + 闸门适配。
**这一步不交付**（留给阶段二，**不许造假实现**）：错误历史与额度余量的真实数据源——现在 API 没有。第一步里这两处**如实显示"暂无数据 / 上游不提供"**，不许编数字。

**已定的两个产品决策**（用户拍板）：
1. **七个 URL 全部保留**：`/`、`/bai`、`/sn`、`/wb`、`/zen`、`/qd`、`/or` 都能打开单页，并**自动选中对应渠道**（滚动到该渠道卡片并高亮）。`/` 打开默认选中当前接线的那家，没有就选中转移链首位。
2. **四个视图分段**（设计稿顶部那一排）：`控制台`（默认）/ `凭据` / `故障转移` / `设置`。视图切换用 **URL hash**（`#/console`、`#/cred`、`#/fo`、`#/settings`），刷新后保持；配合路径就是深链：`/workbuddy#/fo`。

---

## 一、里程碑 1：清单语义改造（providers.js）

清单从「页面清单」变成「**渠道清单**」。每家条目保留 `key / path / tab / h1 / title / shortName / brands / defaultModels / settingsLabels`，**删除**这些页面级字段（它们在单页里没有意义）：`accentLabel / targetName / relayHint / guide / guideEyebrow / guideTitle / hint / notices / lamps / lampNames / lampSubs / cred / extraCards / routeKey / sys / modelsEndpoint / wireHint / hideApply / hideCards / applyInfoMsg / resetModelsMsg / step1Hint / eventTitles / modelsRefreshMsg / testNote / cardEyebrow / routeEyebrow / routeTitle / footNote / footNoteAlt / modelsRefreshMsg / labelSuffix / noCallHint / defaultModels?（保留）`。

**新增**这些渠道级字段（字段名可微调，但语义与数量按此，最终要与里程碑 4 的闸门一致）：

| 字段 | 类型 | 含义 | 例（Qoder） |
|---|---|---|---|
| `letter` | 2 字 | 卡片左上角字母徽标 | `"QD"` |
| `name` | 字符串 | 中文/展示名 | `"Qoder"` |
| `tagline` | 字符串 | 一行副标题 | `"账号额度 · 免费档 + 付费档"` |
| `badge` | `{text, kind}` | 徽章：kind ∈ `free`/`paid`/`cn`/`intl`/`neutral` | `{text:"免费", kind:"free"}` |
| `chainable` | bool | 是否进故障转移链 | `true` |
| `credential` | `{kind, label, hint}` | kind ∈ `apiKey`/`jwt`/`jobToken`/`keys3`/`none` | `{kind:"jobToken", label:"访问令牌", hint:"补丁从 Qoder 客户端抓取，启动即轮换"}` |
| `models` | 字符串数组 | 该渠道当前可选模型（与 `config.defaults.json` 的 `availableModels` 对齐；**C8 会校验两边一致**） | `["lite","auto","performance",…]` |
| `mappingDefaults` | `{档位: 标签}` | 四档映射的**默认**目标标签（面板"恢复默认"用；真实值以 config 为准） | 见 qd |

`home` 条目**删除**（它现在只是"不选中任何渠道的视图"，不再是清单实体）；`ccswitch` 作为**第八个渠道**加进清单：`path: null`（不对应独立 URL）、`chainable: false`、`credential.kind:"none"`、`tagline:"你已有的第三方配置管理器 · 配置交还的去处"`、`badge:{text:"非本台渠道",kind:"neutral"}`。故障转移链作为**全局配置**（`config.failover.chain`），不进清单条目。

**红线**：映射的真实值只来自 `%APPDATA%\bai-router\config.json`（`cfg[channel].mapping`），清单里的 `mappingDefaults` 只是"恢复默认"的种子。**一个真实密钥都不许进清单。**

---

## 二、里程碑 2：模板重排（provider.html）

按设计稿重排。**只放外壳 + 容器 + 插槽**，文案与数据一律来自清单（保持现有架构约定：模板里不许出现提供方名）。

结构（从上到下）：
1. `<header>`：品牌 + **视图分段导航**（4 个 `data-view`，不是 7 个页签）+ 版本 + 主题按钮 + 窗控三键
2. **状态带** `#statusBand`：5 个单元（服务 / 出海代理 / 终端 Claude Code / 桌面版 Claude / 可用渠道）+ 一句 `#statusSentence` 人话总结 + 三个主动作（`#btnBest` 一键最优 / `#btnRestore2` 接回 CC Switch / `#btnDiag` 诊断抽屉）
3. `#viewConsole`：
   - `#matrixGrid` 渠道矩阵 4×2（八格：六家 + CC Switch 交还区 + 故障转移链格。**格序 = 转移链顺序**，`ccswitch` 固定在链尾之后）
   - 每格：字母徽标 / 名称 / tagline / 凭据徽章 / 四档映射摘要 / 中转链路行 / 主按钮（用清单里的既有文案，如"一键接入 Qoder"/"接通 B.AI"）
   - `#mapPanel` 映射编辑区（当前选中渠道）：四行（档位 / 下拉 / 显示名）+ `#btnSave` `#btnTest` `#btnResetModels` `#btnModels` + `#ckAllTiers` + `#testResult`
   - `#diagBar` + `#diagList` 诊断抽屉（默认折叠）
4. `#viewCred` 凭据视图：八行（每渠道一行：凭据类型徽章 / 状态 / 操作区，`apiKey` 给输入框、`jwt`/`jobToken` 给状态+重取按钮、`keys3` 给三行指纹）
5. `#viewFo` 故障转移视图：开关 + 顺序（↑↓）+ 每渠道冷却倒计时 + "什么情况不会转移"说明
6. `#viewSettings` 设置视图：代理 / 面板端口 / 各渠道中转端口 / 更新（检查更新 / 备用升级 / 停止服务）+ 数据目录路径
7. `<footer>` `#footPaths` `#verTxt`；`#bnrInfo` 横幅族；`#slot-extra`（**保留这个 id**，全局卡片插槽）

**契约 id 处置表**（红线是"只增不改"，本表是逐个论证后的处置；**必须逐条落实并同步里程碑 4 的 `CONTRACT_IDS`**）：

| 处置 | id | 理由 |
|---|---|---|
| **保留原样** | `svc` `themeBtn` `themeIcon` `themeText` `winMin` `winMax` `winClose` `patchTime` `patchCli` `cliBadge` `patchDesk` `deskBadge` `btnRestore` `footPaths` `verTxt` `bnrInfo` `bnrInfoTitle` `bnrInfoMsg` `bnrInfoX` `slot-extra` `routeBody` `btnSave` `btnTest` `ckAllTiers` `testResult` `cardSys` `headSys` `sysResult` | 语义不变或换位置仍在 |
| **保留但换语义** | `ledRelay` `txtRelay` `subRelay` → 状态带"服务"单元；`ledUp` `txtUp` `subUp` → 状态带"可用渠道"单元；`ledTok` `txtTok` `subTok` → 状态带"接线"单元；`btnSaveSys` `btnDeploy` `btnResetModels` `fUpstream` `fRelayPort` `lblUpstream` `lblRelayPort` `ckUseProxy` → 设置视图与映射区；`applyResult` → 状态带下方的结果行 | 仍被读取，位置变了 |
| **删除** | `step1` `state1` `step2` `state2` `guideAux` `btnApply` `ckCli` `ckDesk` `auxRoute` `thTarget` `routeHint` `slot-route` `slot-lamps` `slot-step1` `eyebPatch` `ttlPatch` `fModels` `eyebRoute` `ttlRoute` `eyebSys` `ttlSys` `sysAux` `useProxyRow` `useProxyText` | **单页取消了「两步引导卡」「一排信号灯」「接线卡独立编号」「可选模型 textarea」**；渲染层同步不再读这些 id，删除不会产生 null 读取（C5 反向闸门会自动验证无悬挂引用） |
| **新增** | `statusBand` `statusSentence` `btnBest` `btnRestore2` `btnDiag` `viewConsole` `viewCred` `viewFo` `viewSettings` `matrixGrid` `mapPanel` `diagBar` `diagList` `navViews` | 新骨架所需 |

**新增/删除后 `CONTRACT_IDS` 的数量会变**——这是本契约唯一一处「破红线」，论证是：红线保护的是"渲染层读取的 id 不得消失"，而删除的 25 个 id 渲染层同步不再读。**这个论证必须在你的报告里用证据说明**（对每个删除的 id，贴出「panel-common.js 中已无 `$("id")` / getElementById」的检索结果）。

---

## 三、里程碑 3：样式重建（panel-common.css）

**颜色体系整体重建**（三版共同的最有价值决定）：

- **状态语义色**：`--ok`（就绪）/ `--warn`（需留意）/ `--err`（故障）/ `--idle`（未配置）/ `--info`（中性提示）——**只承载状态**
- **品牌色** `--brand`：只承载「这是路由台自己」与「当前选中」
- **取消** `html[data-provider="x"]` 的**每家一套强调色**（现文件 41–95 行 + 对应浅色块全部删除）。`html[data-provider]` 属性本身**保留**（`provider.html` 引导脚本仍设它，用于微调底色温度），但不再定义 accent
- 深浅两套都要**单独调**（不许反色），从设计稿取色
- 其余视觉（间距刻度、字阶、圆角、卡片浮起、徽章、矩阵、抽屉、诊断条目、分段导航、表格）**照设计稿实现**

---

## 四、里程碑 4：渲染层重写（panel-common.js）

- **页面识别**：`normPath(location.pathname)` → 命中清单 path → `selectedChannel`；`/` → 无选中（显示当前接线那家）。`ccswitch` 无路径，不可通过 URL 选中。
- **视图切换**：hash → 切换 `.view` 的显隐 + 分段导航高亮；写 hash 用 `history.replaceState`。
- **状态带**：从 `/api/status` 取真实字段（`service`/`panel`/`clash`/`cli`/`desktop`/各 `relay.port`/`upstream`/`token.configured`）；`#statusSentence` 按真实状态生成一句话（照抄设计稿句式，数据缺失就如实说缺失，**不许乐观**）。
- **渠道矩阵**：遍历清单生成八格；每格从 `status[channel]` + `cfg[channel]` 取真实值；主按钮调既有 API（`POST /api/apply`、`/api/restore`）；点格 → 选中 + 映射区切换 + 该格高亮；`?`/URL 指定的渠道自动滚动到视野并高亮。
- **映射编辑区**：四档下拉取 `cfg[channel].availableModels`（C8 保证清单 `models` 与之一致），显示名取 `mapping[tier].label`；保存走既有 `POST /api/config`；测试走 `POST /api/test`；刷新模型走 `GET /api/models?p=<channel>`；恢复默认用清单 `mappingDefaults`。
- **凭据视图**：`apiKey` → 输入框（值永不回显，只显示指纹）；`jwt` → 状态 + 「一键获取令牌」（调既有 `/api/wb/capture`）；`jobToken` → 补丁状态 + 「一键装补丁」（`/api/qd/patch/apply`）；`keys3` → 三个指纹 + 「编辑」（`/api/or/keys`）。**凭据逻辑一律走清单 `credential.kind` 分派，panel-common.js 里不许出现渠道名**（C11）。
- **故障转移视图**：开关与顺序读写 `POST /api/config` 的 `failover` 段；冷却倒计时读 `status.failover.cooling`。
- **诊断抽屉**：**只呈现本机当前已知问题**——从 `status` 的 `relayLast`/`upstream.error`/`recent`/各 `token.configured`/`patch` 推出"结论 + 建议动作"；**没有错误就显示"没有观察到失败"**。**严禁编造历史错误、错误数、时间线**——那是阶段二的事。
- **五张卡的处置**（`cards/*.js`）：
  - `failover.js` → 移到**故障转移视图**（成为该视图主体）；删掉它自带的折叠壳（视图已提供）
  - `model-sync.js` → 保留「刷新全部模型」按钮，挂在**状态带**（设计稿里它就是顶栏一个按钮）
  - `token-capture.js` / `model-catalog.js` / `or-rotation.js` → 移到**凭据视图**对应渠道的行内
  - `overview.js` → **删除**（控制台矩阵取代了它；留着会被 C6 反向检查报 dead card）
  - 卡片仍走 `window.BAI_CARDS[name].mount(ctx)` 契约（C6 不变），但 `ctx` 要加新钩子（如 `ctx.channel`、`ctx.view`）
- **禁止**：在 panel-common.js 里出现任何渠道名字面量（`"bai"`/`"qd"`… 的等值比较、`["bai"]` 下标、字面量数组）——C11 会拦。

---

## 五、里程碑 5：闸门适配（check-manifest.cjs）

六道闸门建立在"七页同构"假设上，必须适配。**每条改动都要用负样本验证它仍会报错**（HANDOFF 血泪：正则闸门不测负样本就会变成永久绿灯）：

| 闸门 | 现状假设 | 新判据 |
|---|---|---|
| **C1** | `REQUIRED_FIELDS` 是页面字段（accentLabel/targetName/guide/notices/lamps/settingsTitle…） | 换成渠道字段：`key/path/tab/h1/title/shortName/letter/name/tagline/badge/chainable/credential/models/mappingDefaults/brands/defaultModels/settingsLabels`；`ccswitch` 的 `path` 允许 `null`（它是第八格不是独立页）；`path` 形状规则**恢复为**"key 即路径"（`/bai`…）并保留 `home` 的 `/`；server 路由注册检查**保留** |
| **C2** | guide 必须 0 或 2 项 | **退役**，检查点并入 C1（`credential` 结构：`kind` ∈ 五个枚举 + `label` 非空） |
| **C3** | notices 结构 | 改为检查**诊断结论文案**：`conclusion`（字符串，给当前渠道的"就绪/未就绪怎么判断"一句话）与 `remedy`（未就绪时给什么建议）两个必填字符串 |
| **C4** | 52 个 id 各一次 | 换成里程碑 2 的处置表结果（删 25、新增 15 → 42 个）。**顺序即数组顺序，逐个核对** |
| **C5** | 反向悬挂 id | 逻辑不变，自动跟随 C4 |
| **C6** | `extraCards` 引用 ↔ `cards/*.js` 文件 | 改为校验**视图级卡片表** `views: [{id, cards:[...]}]`（四视图各带哪些卡）与文件一一对应；`overview.js` 删除后不得再有引用 |
| **C7** | `html[data-provider="x"]` 配色块 per 渠道 | 改为校验**状态语义色**：`--ok/--warn/--err/--idle/--brand` 五者在深浅两套主题里都定义且都有值；并**反向断言**不再存在 per-provider 的 `--accent` 块 |
| **C8** | 每家 availableModels | 改为：清单 `models` 与 `config.defaults.json` 的 `availableModels` **逐项一致**（深浅与 qd 都不例外） |
| **C9** | 7 个 nav tab ↔ 清单 path | 改为校验**视图分段**：`navViews` 里的 4 个 `data-view` 与 `views[].id` 一一对应，且每个 `views[].id` 都有对应 DOM 容器 id |
| **C10** | 渲染路由 ↔ 清单 path | **不变**（七路径保留，天然成立） |
| **C11** | 渲染层不硬编码渠道名 | **不变**（本项目的核心防线） |
| **C12** | 渲染层必读字段 | 改为里程碑 1 的新增渠道字段（与 C1 求交集，防两处漂移） |
| **C13** | 种子配置无本机路径 | **不变** |

**每条改动的闸门都要跑正负样本**：先在全绿状态下过一遍；再故意制造该闸门对应的错误（如把某渠道的 `credential.kind` 写错、把 `--ok` 删掉、把清单 models 改一项、把视图分段删一个），确认对应闸门**报错**，然后改回。

---

## 六、验证要求（硬性，全部贴真实输出）

1. `node scripts/check-manifest.cjs` → **0 error**，且输出里能看到每道改动闸门的 ok 行。
2. **负样本矩阵**：按上面要求，对 C1/C2/C3/C4/C6/C7/C8/C9/C12 **逐条**制造错误并贴出"闸门确实报错"的输出，最后恢复全绿。贴一张表：错误注入 → 哪个闸门报错 → 报错原文。
3. **隔离实例**（`BAI_DATA_DIR` + 隔离 USERPROFILE + 17xxx 端口，`BAI_ENV_FIXED=1` + 预设完整 `NO_PROXY`——**照抄本项目已知能起实例的那套环境变量组合**，否则会卡在代理自检重启）：
   - 七个路径全 **200 text/html**
   - `/index.html`、`/ui.html` 仍 302 → `/`
   - `/providers.js`、`/panel-common.js`、`/panel-common.css`、`/cards/failover.js` 全 200；`/cards/overview.js` **404**（已删）
   - `/api/status` 正常返回
4. **Electron 截图**（用户要亲自看）：沿用验证 v16 时那套无头脚本，`loadFile` 指向隔离实例的 `http://127.0.0.1:17xxx/`：
   - 四视图 × 深浅 = 8 张（控制台/凭据/故障转移/设置）
   - `/workbuddy#/console` 自动选中 WorkBuddy 的高亮态 1 张
   - 1100 窄窗 1 张
   存 `C:\Users\pc\AppData\Local\Temp\opencode\ui-design\shots\v17-*.png`，**并逐张你自己看过**（不许交付你没看过的图）。
5. `node --check` 四个 JS 文件。
6. `git status --short` 只有允许改动的文件。

## 七、诚实边界（报告必须单列）

- **这一步没有真机验收**：新版要发 v1.0.63 用户才能看到。第一步交付的是"隔离实例 + Electron 截图"级别的验证。
- **诊断与额度是半成品**：只呈现当前已知问题，没有历史与配额真数据（阶段二）。
- **五张卡迁移后**功能是否与原先等价（例如令牌捕获的长流程体验变化），要如实说哪里可能退化。

## 八、红线

- **不 commit、不 push、不改 version、不跑任何发布/打包命令**。
- **不许碰 `src/server/server.mjs`、`src/main.js`、`src/preload.js`、`config.defaults.json`、`package.json`**（`server.mjs` 一步都不许动——它刚修完）。
- 52 个契约 id 的**删除**只许按里程碑 2 的表；**不许另删任何一个**。
- 不许在清单/模板/CSS 里写死真实密钥、真实用户名、本机绝对路径。
- 注释与文案中文；模板里不许出现渠道名字面量。
- 测试一律隔离实例 + 17xxx；不写真实 `%APPDATA%\bai-router`；taskkill 只按 PID；**绝不 `taskkill /IM node.exe`**（正式实例在跑，PID 会变，先 `Get-CimInstance` 查）。

## 九、汇报要求

① 五个里程碑各自的改动摘要（关键 diff 片段）② 验证 1–6 的真实输出，尤其**负样本矩阵那张表**③ 契约 id 删除论证（每个删除 id 的"已无引用"检索证据）④ **你亲自看过的截图**逐张说明（哪张有什么问题也要说）⑤ 存疑与建议。3000 字内，验证输出不限。**不许说"已完成"而不给证据。**