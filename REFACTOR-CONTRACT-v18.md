# REFACTOR-CONTRACT v18 · WorkBuddy 双版拆分 + 模型目录动态化 + 倍率可见

**修订来源**：用户要求"全面深度吸取 `dsh-workbuddy-connect` 项目的优点"。该插件（corrinehu，MIT，npm 上 v0.7.2）把 WorkBuddy 桌面 App 的模型接进 DeepSeek Harness。

**吸取范围**：用户明确「不一定全盘吸取，只吸取对咱们项目确实有借鉴或者帮助的」。经逐条评估，**采纳 6 项，明确不采纳 1 项**（见 §0）。

> **你是执行者，我是复验者**。规格与事实不符就**停下来报告**。每个里程碑做完先自检再往下做。

---

## 〇、采納与不采纳的清单（逐条给理由）

| # | 项目 | 采纳 | 理由 |
|---|---|---|---|
| 1 | **模型目录从上游动态拉**（替代写死） | ✅ | 我们 `server.mjs:2300-2303` 写着"WorkBuddy 没有公开的模型目录接口"，**实测证明有**。这是本次最大收益 |
| 2 | **倍率 `credits` + 免费判定** | ✅ | 实测拿到，且我们现有"免费三款"标签**不完整**（见 §1.4） |
| 3 | **国内版/国际版分开** | ✅ | 实测是**两套目录**（32 vs 22 个模型）、两套定价、两套凭据文件 |
| 4 | **请求头补齐**（`X-IDE-*`、`Origin`/`Referer`、UA 带真实版本） | ✅ | 我们发的 `B.AI-Router/x.y.z` 一眼不是客户端 |
| 5 | **CLI 侧显示倍率**（`ANTHROPIC_DEFAULT_*_MODEL_NAME`） | ✅ | 官方机制，且**我们自己把这条通道删掉了**（`server.mjs:3221`） |
| 6 | **国际版促销 `modelPromotions`** | ✅ 低优先 | 只有 App 形态 UA 才有，需额外一次请求 |
| 7 | **凭据解密**（注入 Electron 读 `loggerGet` + 解 `WBEV1`） | ❌ **不采纳** | 它把可靠性绑死在上游私有实现上（`_linkedBinding` 名、`loggerGet` 入口、AAD 拼法、suite 编号）。我们现有路线（抓客户端发出的请求头）不读那个文件，**上游怎么加密都不受影响**。本机实测：新版凭据已加密（`auth.accessToken` 是对象），我们仍正常（配置里是有效 JWT 1411 字符） |

---

## 一、已实测的事实（全部有据，非推断）

> 实测方式：用本机**真实令牌**（`%APPDATA%\bai-router\config.json` 的 `wb.accessToken`）请求上游 `/v3/config`。
> 样本存 `C:\Users\pc\AppData\Local\Temp\wbcat\v3-{intl,cn}-{cli,app}.json`（脱敏后）。
> **这些样本不在仓库里**，是临时数据。

### 1.1 `/v3/config` 确实存在，且返回真实目录

```
GET https://www.workbuddy.ai/v3/config   → 200, 21205 字节, models=22   （CLI 形态 UA）
GET https://www.workbuddy.ai/v3/config   → 200, 21625 字节, models=30   （App 形态 UA）
GET https://www.workbuddy.cn/v3/config   → 200, 13830 字节, models=32   （CLI 形态 UA）
GET https://www.workbuddy.cn/v3/config   → 200, 37025 字节, models=37   （App 形态 UA）
```

**反面证据（重要）**：不带 `Authorization` 或令牌无效时，上游返回 **200 + `{code:0, msg:"OK", models:null}`**——**成功码配空数据**，252 字节。
→ **实现必须把"空目录"当成失败**，不能显示成"0 个模型"。

> **⚠ 更正（2026-10-11，由独立复验推翻）**：本节初稿曾写「缺 `Origin`/`Referer` 会拿到空目录」，**那是错的**。
> 真实原因是我第一轮探测脚本用了**无效令牌**（读错了凭据字段，发出的是 `Bearer undefined`），把「无鉴权」误判成了「缺某个头」。
> 独立复验做了隔离变量矩阵，结论如下：
>
> | 变量 | 实测结果 |
> |---|---|
> | `User-Agent` 是 `B.AI-Router/dev` | **HTTP 400**，`{"code":12403,"msg":"check ua, get coding copilot version error"}` |
> | 在旧 UA 上增删 `Origin`/`Referer`/`X-Requested-With`/`X-Product`/`X-IDE-*`（**八种组合**） | **响应 100% 不变**（全部 400/116 字节） |
> | UA 换成 `WorkBuddy/*` 形态，带不带 `Origin`/`Referer`（含把 Origin 指向 `evil.example`） | 全部 **200**，目录正常 |
> | `CodeBuddy/2.63.2` | 200 但 **`models:null`** |
>
> **结论：唯一闸门是 `User-Agent`，且必须带 `WorkBuddy` 前缀。`Origin`/`Referer` 对结果没有任何影响。**
>
> 另有两条**被证伪**的中间结论（勿采纳）：
> - 「真实 UA 是 `WorkBuddy/${v} WorkBuddy/${v}`（同版本重复两段）」——实测与 `WorkBuddy AI` 版**逐字节相同**；`WorkBuddy/1.0.0`、`WorkBuddy/x`、单段、`WorkBuddyAI` **全部返回同一份目录**。**闸门只认前缀，版本号与段数都不影响。**
> - 「`X-No-*` 的真实值是字符串 `"true"`」——该头对 `/v3/config` **完全无作用**（`"true"`/`1`/不带，三者逐字节相同），无法判定。
>
> **教训**：无鉴权的请求会被上游"成功码 + 空数据"地拒绝，这个形态**极易被误读成参数错误**。探测上游时必须先确认凭据有效。

### 1.2 UA 决定 roster，且倍率与促销互斥

| 请求形态 | 模型数 | 带倍率 | 免费 | `modelPromotions` |
|---|---|---|---|---|
| 国际版 + CLI UA | 22 | 21 | 2 | 无 |
| 国际版 + App UA | 30 | 27 | 3 | **有 3 条** |
| 国内版 + CLI UA | 32 | 30 | 1 | 无 |
| 国内版 + App UA | 37 | **0** | — | 无 |

- **要倍率 → 必须 CLI 形态 UA**（`CLI/2.63.2 CodeBuddy/2.63.2`）
- **要促销 → 必须 App 形态 UA**（`WorkBuddy/<版本> WorkBuddy AI/<版本>`）
- **两者互斥**，要两份数据得发**两次请求**（这是插件源码没明说、实测才发现的）

**国内版 App UA 那 37 个模型 `credits` 全为空**——App 形态打国内版拿到的是不含价格的内部 roster。**倍率只能走 CLI UA。**

### 1.3 倍率字符串有两种形态，必须都处理

```
"x0.79"           纯倍率
"x0.34 credits"   带 " credits" 后缀（国际版 CLI 大量出现）
"x0.00"           免费
""                空，无信息
```

**免费判定必须先把后缀剥掉**：`/^x?0\.0+$/` 直接匹配 `"x0.00 credits"` 会**失败**。
插件的 `normalizeCredits` 就是干这个的。

### 1.4 我们现有"免费三款"标签不完整

我们现在写死 `["deepseek-v4.1-flash", "hy4-preview-f", "hy3"]`（`server.mjs:141`，注释说"credits=x0.00"）。对照实测：

| 我们标的 | CLI roster | App roster |
|---|---|---|
| `deepseek-v4.1-flash` | `x0.00` ✔ | `x0.00` ✔ |
| `hy3` | `x0.00` ✔ | `x0.00` ✔ |
| **`hy4-preview-f`** | **不在里面** | `x0.00` ✔ |

`hy4-preview-f` **只在 App roster 出现**。同时 CLI roster 里有 `gpt-6-luna x0.07`、`glm-5.3-flash x0.06`、`deepseek-v4.1-flash-sg x0.03` 这些**极低倍率**模型，用户现在完全看不到。

### 1.5 国内版与国际版是两套东西

- 模型数：32 vs 22（CLI 形态）
- 定价分布完全不同：国内版 `x0.05~x0.80` 细分档，国际版 `x0.03~x6.67` 宽区间
- 凭据文件独立：`workbuddy-desktop.info`（cn）/ `workbuddy-desktop-ai.info`（intl）
- 上游域名：国内版 `copilot.tencent.com` 与 `www.workbuddy.cn` **返回完全一致**（均 13830 字节）

**本机实测两个都装了、都有凭据**——而我们只用了一个。

### 1.6 Claude Code 的显示机制（官方支持，非 hack）

从 `claude.exe`（2.1.216）内嵌 JS 读出四档构造器，结构一致：

```js
function v0c(){ let e = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
  if (Bqn() && e) return { value:"fable",
    label: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME ?? e,
    description: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION ?? "Custom Fable model" } }
```

- **`label` 可塞任意文本**，与模型名是两个独立字段
- 门控 `Bqn()` 成立：我们的 `ANTHROPIC_BASE_URL` 是 `http://127.0.0.1:<relayPort>`，非 anthropic.com
- **`/v1/models` 的 `display_name` 对 CLI 无效**（CLI 不探测该端点，它只服务桌面版）

### 1.7 我们主动删掉了 CLI 的 label 通道（现存 bug）

```js
// server.mjs:3219-3221
for (const t of TIERS) {
  e[t.envKey] = S.mapping[t.key]?.target || S.defaultModel;
  delete e[t.envKey + "_NAME"];      // ← 把 label 通道删掉了
}
```

桌面版没这问题（`labelOverride` 写进 `inferenceModels`，`server.mjs:3251-3255`）。

---

## 二、里程碑

### 里程碑 1：WorkBuddy 拆成两个渠道（国内版 / 国际版）

**动机**：实测是两套目录、两套定价、两套凭据，现在只用了其中一个。

> **⚠ 工作量评估（实测发现，先读这条）**：`server.mjs` 里「六个渠道」是**到处硬编码**的，至少 8 处：
>
> ```
> 1833  RELAY_LABELS = { bai, sn, wb, zen, qd, or }
> 3123  PROVIDERS    = { bai, sn, wb, zen, qd, or }
> 3124  isOurs       = mode === "bai" || … || mode === "or"
> 3129  cliMode(cfg, cfgKey, snKey, wbKey, zenKey, qdKey, orKey)     ← 六个**位置参数**
> 3158  desktopMode(同上)
> 3418  两处调用，逐个传六个值
> 3627  三元链 `pRaw === "sn" ? "sn" : … : "bai"`
> 3640  ALL_PKEYS
> 3845  failover.chain 过滤数组
> ```
>
> **所以这不是"往清单加一条"，是把渠道集合从硬编码改成数据驱动。** 加第七个渠道会牵动全部 8 处，`cliMode`/`desktopMode` 的签名与所有调用点都要改。
>
> → **本里程碑拆成两步做**：先做 1a（数据驱动化，不加渠道，行为不变），跑通再加 1b（真加 `wbai`）。**1a 单独可交付、可验证、不改变任何用户可见行为**，这是降低风险的关键。

- 清单 `providers.js` 里增加 `wbai`（国内版 `wb` 保留）
- 两条各自的：`path`、`name`、`tagline`、`credential`、`models`、`mappingDefaults`、`settingsLabels`
- 上游：`wb` → `copilot.tencent.com`；`wbai` → `www.workbuddy.ai`
- 凭据：`wb` → `workbuddy-desktop.info`；`wbai` → `workbuddy-desktop-ai.info`
- `server.mjs` 的 `WB_AUTH_IDS` / `wbAuthDir` 已能读两个文件（`server.mjs:205`），但**取 mtime 最新的那个**（`:247`）——要改成按版别各取各的
- **auth 目录探测补上 `%APPDATA%`（Roaming）**：插件实测旧版客户端写那里（我们只探 `%LOCALAPPDATA%`，`server.mjs:209-214`）

**红线**：故障转移链、矩阵格数会变。**这是产品决策，开工前必须与用户确认**（见 §4）。

### 里程碑 2：模型目录改为从上游动态拉

- `server.mjs:2300-2303` 的"无目录接口"结论作废，改为 `GET {base}/v3/config`
- **CLI 形态 UA** 取倍率；**App 形态 UA** 取 `modelPromotions`（两次请求，互斥）
- 解析 `data.models[]`，字段：`id / name / credits / tags / disabled / maxInputTokens / maxOutputTokens / supportsImages / supportsReasoning / contextWindow`
- **过滤**：`disabled===true` 或 `maxInputTokens<=0` 或 `maxOutputTokens<=0` 丢弃
- **空目录必须当失败**（§1.1 的 252 字节陷阱），报"上游没给目录"，不能显示 0 个模型
- 降级链：实时 → 上次成功（落盘）→ 内置兜底，**并在界面标注来源**（学自插件）
- 缓存：目录变化慢，缓存 30 分钟（与现有 `zenReadCatalog` 同策略，`server.mjs:1015-1017`）

### 里程碑 3：倍率的解析与持久化

- `normalizeCredits(raw)`：剥 `\s*credits\s*$` → 返回 `"x0.79"` 或 `undefined`
- `isFree`：剥离后再匹配 `/^x?0\.0+$/`
- 存进清单/配置的模型条目：`{ id, name, credits, free }`
- **不要**新造一套并行数据结构——复用现有 `availableModels` 的位置，加字段

### 里程碑 4：倍率在客户端可见（含修复现存 bug）

**用户已拍板：走「路径 A」——保留用户手填的 label，程序在其后追加倍率。**

- **CLI**：`applyToCli` 不再 `delete ..._NAME`，改为写入 `用户 label · 倍率`
  ```
  ANTHROPIC_DEFAULT_SONNET_MODEL        = hy4-preview-f        （保持上游真名，解析链不变）
  ANTHROPIC_DEFAULT_SONNET_MODEL_NAME   = Hy4-Preview-F · 免费  （用户 label + 程序追加）
  ```
- **模型名与显示名分离**：`id` 仍是真名 → `resolveModel` 的 `availableModels.includes(base)` 分支原样透传 → **零解析改动**

#### 为什么必须"合并"而不是直接用上游显示名

配置里的 `mapping[tier].label` 是**用户手填的静态值**，而倍率来自**实时目录**，两套数据原本不相通：

```
配置（静态）  claude-sonnet-5 → target=hy4-preview-f   label="Hy4-Preview-F"
实时目录      hy4-preview-f   → "Hy4-Preview-F · 免费"
```

只删 `delete` 而不合并 → Claude Code 里显示 `Hy4-Preview-F`，**没有倍率**。
直接用上游显示名（路径 B）→ 会**覆盖用户手填的 label**，与本项目「尊重用户显式设置」的哲学相悖（参见 `wbHealUpstream` 的注释）。

#### 实现要点（已验证可行）

- `applyToCli(S)` 是**同步函数**（4 个调用点全在同步上下文），**不要为它引入异步**
- `wbCatCache`（`server.mjs:1051`）是**进程内变量、同步可读**——直接取 `.val` 即可，无需 await
- **边界**：缓存可能为空（服务刚起、还没拉过目录）。此时**退化为只写用户 label、不追加倍率**——不阻塞、不报错、不编造
- 查倍率用 `target` 精确匹配目录里的 `id`；匹配不到就不追加

- **桌面版**：`relayModelsPayload` 的 `display_name` 已带 label（`server.mjs:709`），补倍率即可
- **面板**：矩阵/映射下拉里显示倍率与免费标记

### 里程碑 4b：`ANTHROPIC_AUTH_TOKEN` 改为占位符（用户已拍板）

**现状（安全隐患）**：`applyToCli` 把**真实的 WorkBuddy JWT** 写进 `~/.claude/settings.json` 的 `ANTHROPIC_AUTH_TOKEN`。实测确认它就是我们 `config.json` 里那一份（1411 字符，同一字符串），**明文躺在用户主目录**。

**为什么可以改**：中转**不信任**客户端送来的这个 token——`wb` 分支用 `wbEnsureToken(cfg)` 从配置自行取（`server.mjs:2634`），`fo.opts.openai` 的协议桥走自己的 `mkHeaders`。`PASS_HEADERS` 虽然在 3157 行收集 `authorization`，但只对**非协议桥**的渠道生效。

**改法**：`e.ANTHROPIC_AUTH_TOKEN = S.key || "wb-local"` → 对 wb/wbai 及所有走本地桥的渠道统一写占位符（如 `PROXY_MANAGED`），与桌面版已有的做法一致（`server.mjs:3548` 就写着 `ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED"`）。

**注意**：B.AI / SenseNova 是**直连上游**（`ANTHROPIC_BASE_URL` 指向上游本体），它们**必须**带真 key，**不能**改成占位符。改动只针对走本地中转的渠道。

### 里程碑 5：请求头对齐（低风险，可独立做）

按插件实测的契约补齐（**每一项都要实测确认上游反应，不许照抄**）：

| 头 | 值 |
|---|---|
| `X-IDE-Type` / `X-IDE-Name` | `WorkBuddy` |
| `X-IDE-Version` | 从安装目录读的真实客户端版本 |
| `Origin` / `Referer` | 上游 origin |
| `User-Agent` | `WorkBuddy/<版本> WorkBuddy AI/<版本>` |
| `X-No-User-Id: 1` | **无 userId 时带这个，而不是省略 `X-User-Id`** |
| `X-No-Enterprise-Id: 1` | 同上 |
| `X-No-Department-Info: 1` | 同上 |

另：发往国内版前删 `reasoning_effort: "off"`（插件实测国内版拒该值）。

**注意**：§1.1 已证明**缺 `Origin`/`Referer` 会拿到空目录**——所以这不是可选项。

---

## 三、红线

- **不 commit、不 push、不改 version、不跑任何发布命令**（要发版必须用户明确指示）
- `server.mjs`、`main.js`、`preload.js`、`config.defaults.json`、`package.json` **可以改**（用户已授权本次），但**每次改动要单独说明理由**
- **不许实现凭据解密**（§0 第 7 项）。这条是明确的技术选择，不是能力问题
- 不许把真实令牌写进任何文件/日志/提交
- 测试一律隔离实例 + 17xxx；**绝不 `taskkill /IM node.exe`**，只按 PID
- 注释与文案中文

---

## 四、产品决策（**已由用户拍板，2026-10-11**）

1. **矩阵格数**：**扩成九格**（六家 + wbai + 交还区 + 转移链格）。
   → 布局重排为 3 列 × 3 行。窄屏断点要相应调整（现有 `.matrix` 的 4/3/2/1 列断点在 `panel-common.css`）。

2. **转移链**：**两版各占一位**，链长 6 → 7。
   → `config.defaults.json` 的 `failover.chain` 要加 `wbai`；`server.mjs` 写分支里过滤链成员的数组也要加（搜 `["bai","sn","wb","zen","qd","or"]`）。
   → 面板的转移链格与故障转移视图都会多一项。

3. **倍率文案**：`GLM-5.3 · x0.79`，免费标 `Hy3 · x0.00 · 免费`。
   → 格式：`<显示名> · <credits>`，`isFree` 时再追加 ` · 免费`。

4. **极低倍率不特殊标注**：**只把 `x0.00` 标为「免费」**，`x0.03`~`x0.07` 照常显示倍率数字，由用户自己判断。
   → 不做「极低」这类主观分档——阈值没有客观依据，标了反而误导。

5. **两个版别的显示名**（我按插件惯例定，如有异议请说）：`WorkBuddy`（国内版，`/wb`）+ `WorkBuddy AI`（国际版，`/wbai`）。

---

## 五、验证要求（硬性，全部贴真实输出）

1. `node scripts/check-manifest.cjs` → **0 error**
2. **负样本矩阵**：对本次改动的每道闸门注入错误，确认真的报错
3. **隔离实例**：七（或八）个路径全 200；`/api/models?p=wb` 与 `?p=wbai` 返回**真实的、带倍率的**目录
4. **实测上游**：证明目录来自 `/v3/config` 而非写死——改一次上游数据，看面板是否跟随
5. **Claude Code 真机验证**：`/model` 选择器里**肉眼看到**倍率文本（这是本次的核心目标，必须截图）
6. `node --check` 全部 JS
7. `git status --short` 只有允许改动的文件

---

## 六、诚实边界（报告必须单列）

- 倍率与免费标记**来自上游非公开接口**（`/v3/config`），上游改动可能使其失效——按里程碑 2 的降级链处理，但要如实说明
- `modelPromotions`（促销徽章）只有 App 形态 UA 才有，且**与倍率互斥**，需要两次请求
- 国内版企业账号的计费接口未验证（插件也承认这点）
- 里程碑 1 改变了产品形态（渠道数、矩阵布局），**用户没见过的形态要先看截图再上线**
