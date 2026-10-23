# magpie 一比一复刻 · 任务队列

> 目标：把 bai-router 改造成 magpie 的同等形态 —— **一个网关端口**、**模型 id 决定供应商**、
> **账号级路由与配额感知**、**四协议互转**、**统一 agent 接入层**。
> 参照实现：`yetone/magpie`（Go，103k 行，~80 个 internal 包）。克隆在 `G:\tmp\magpie-study`（只读）。
> 研究报告：`docs/magpie-study.md`（差距分析 + 6 批清单）。

## 规模实话

magpie 是 10.3 万行 Go、5661 个文件。它自己的历史是首周每天 200+ commit、10+ 次发版，
走到 v1.0.92 花了约两个月。**「一比一」不是一次会话的交付物**，是若干轮盖楼。
本文件是排期与验收依据，每完成一项回来打勾。

---

## 状态总览

| # | 任务 | 状态 | magpie 出处 |
| --- | --- | --- | --- |
| T0 | 差距分析与复刻清单（研究） | ✅ 完成 | — |
| T1 | **地基三件套**：保格式 JSON 编辑器 / 路由策略内核 / 统一协议 IR | ✅ 完成 | `internal/edit/`、`internal/routes/`、`internal/gateway/ir.go` |
| T2 | **单网关化**：8 个中转端口 → 1 个 | 🟡 已落地（beta 默认开，旧端口留作回退） | `internal/gateway/gateway.go` |
| T3 | **候选层泛化**：provider 级 → 账号/密钥级 | ✅ 完成（`candidates.mjs` + 两级休息 + 归因冷却） | `internal/gateway/fallback.go` |
| T4 | **路由策略上板**：7 种策略 + 配额感知排序 | ✅ 完成（`routes.mjs` + 面板接线） | `internal/provider/routing.go` |
| T5 | **协议矩阵补全**：Responses / Gemini + 桥换 IR | ✅ 完成（两个协议入口已接进网关，活体用例覆盖流式/非流式/Gemini） | `internal/gateway/{responses,gemini}.go` |
| T6 | **会话身份与亲和**（通用层） | ✅ 完成（`session-id.mjs` + `session-store.mjs`，持久化） | `internal/gateway/sessionHeaders` |
| T7 | **用量账本** `usage.jsonl` + 面板 | ✅ 完成（`usage-ledger.mjs` + `usage-writer.mjs` + token 扫描） | `internal/usage/` |
| T8 | **账号发现改读登录态**（替代 hook 注入） | ✅ 完成（`account-discovery.mjs` + `GET /api/accounts` + 面板「账号」卡） | `internal/provider/account.go` |
| T9 | **配额探测与配额感知路由** | ✅ 完成（`quota-probe.mjs` 真探测 + `quota.mjs` 预算 + **上游真报的余额接进转移链排序** + 面板「额度」屏） | `internal/provider/quotas.go` |
| T10 | **脱敏与审计台账** | ✅ 完成（`redact.mjs` + `audit.mjs`，已接进转移链与面板） | `internal/redact/`、`internal/maskrec/` |
| T11 | **插件体系**（声明式 provider/agent/middleware） | ✅ provider 插件（一份 JSON 加一家渠道）、middleware（`middleware.mjs`，声明式改写）、**代码插件**（`pluginrt.mjs` + `plugin-worker.mjs`：子进程 + Node 权限模型 + 令牌窄协议 + 超时封顶）全部接进真实链路 | `internal/pluginrt/`、`internal/plugin/` |
| T12 | **并发 / RPM 限流通道** | ✅ 完成（`concurrency.mjs` + `rpm.mjs`，**默认不限**，面板可开） | `internal/gateway/{concurrency,rpm}.go` |
| T13 | **配置同步备份**（WebDAV/S3/GitHub）+ KeepOwn | ✅ 完成（本地目录 / WebDAV / GitHub 三种目标都已接进真实链路，口令加密、不静默覆盖） | `internal/backup/`、`internal/davsync/` |
| T14 | **面板改版**（插槽制 + 多页） | 🟡 P0–P3 ✅（额度屏 / 状态计算层 / 共享组件库 / 热力图 / 状态条 / **渠道主从**）；P5 收尾在做 | `internal/gui/assets/kernel.js` |
| T15 | **客户端接线**（harness 铺开） | 🟡 协议层 ✅（Chat 入向 = 一个模块换 40+ 客户端）；接线层薄适配器在做；深度定制列为后续 | `internal/agent/`（每客户端一个 `.go`） |
| T16 | **字体一轮升级**（参照 magpie，做减法） | 📋 后续规划（等宽只给代码本身 + 补中文回退 + 数字用 tabular-nums） | `internal/gui/assets/app.css` 的 `--font` / `--code` |

---

## T1 · 地基三件套

三块都是**独立模块、零依赖、可单测**，且是 T2–T5 的前置。

### T1-a `src/edit-json.mjs` —— 保格式 JSON/JSONC 编辑器

magpie 的 `internal/edit/json.go`：**不反序列化、不重新序列化**，用 gjson 只定位字节区间，
再对原始字节 splice，于是注释、键顺序、缩进天然全保留。

- API：`parseJsonc` / `getPath` / `setPath` / `delPath` / `applyEdits` / `detectFormat`
- 必须容忍 `//`、`/* */` 注释、尾逗号、UTF-8 BOM
- 必须保持：注释、键顺序、缩进风格（tab / 2 / 4 空格）、CRLF、末尾换行
- **读失败 ≠ 空**：解析失败返回 `{ ok:false }`，绝不返回 `{}`

**顺带修两个数据丢失缺口**（见 `docs/magpie-study.md` §4 的 A、B）：

| | 位置 | 现状 |
| --- | --- | --- |
| A | `src/server/server.mjs` `applyToCli` 的 `catch { s = {} }` | 读失败被当空并写回，**抹掉用户其余全部配置** |
| B | 同函数 `writeAtomic(SETTINGS, JSON.stringify(s, null, 2))` | 全量重写，抹掉注释 / 键序 / 缩进 |

**验收**：`npm test` 全绿；闸门 0 error；新增用例覆盖「带注释的文件被接线后注释还在」
与「文件读不懂时接线中止且不写盘」。

### T1-b `src/routes.mjs` —— 路由策略内核

magpie 的 `internal/routes/`：`Seat` / `Strategy` / 注册表 / 7 种策略
（smart、order、rotate、usage、pace、weight、free）。

- 策略必须是**纯函数**（时间由参数传入，不许内部调 `Date.now()`）
- 语义照抄 Go，包括那些看着奇怪的规则（Smart 按配额窗口**最早续期**排序、时间截断到整点、
  大窗口优先、`learns` 优先、同分比 `used` 升序）

**验收**：每种策略一组用例；分档边界（0.90 / 0.98）、半衰期、0.9 倍同档、加权轮询比例、
注册表覆盖与回落，全部有断言。

### T1-c `src/ir.mjs` —— 统一协议中间表示

magpie 的 `internal/gateway/ir.go` + 四×四矩阵。`Part.kind` 这一个枚举收敛全部协议差异。

- `parseAnthropic` / `buildChat` / `parseChat` / `buildAnthropic`
- `chatDecoder`（上游 SSE → Event）/ `anthropicEncoder`（Event → 客户端 SSE）
- `pairToolMessages`（工具调用配对完整性）
- **签名（signature）与密封推理（sealed）必须逐字节保留** —— 上游会校验，丢了就 400
- 流式与非流式**共用一条事件管道**

**验收**：thinking 带签名的往返；SSE 任意切分后事件序列与整块一致；孤儿 tool 结果与未配对
pending call 的处理。

---

## T2 · 单网关化（最大的一刀）

**现状**：8 个中转端口（15722 bai / 15732 sn / 15742 wb / 15752 zen / 15762 qd / 15772 or /
15782 wbai / 15792 mm）+ 面板 15723。客户端连**某一个** provider 的端口，故障转移在中转内部跨
provider 跳。模型寻址靠本地四档映射表（`TIERS` + `resolveModelTarget`）。

**magpie 形态**：**一个** 端口（3425）。写进 agent 配置的模型 id 是 `provider/model`，
客户端原样发过来，网关自己解析前缀 → 定位 provider → 定位账号/密钥 → 路由。

**为什么这一步最难也最关键**：它把「provider」从「连接目标」降格成「路由维度」，
后面 T3（账号级候选）、T4（策略）、T5（协议矩阵）全都建立在「一个入口」之上。

**动点**：
- `makeRelay` / `relaySpec` / 每 provider 的 `createServer` → 收敛成单一 handler
- `ANTHROPIC_BASE_URL` 恒指向那一个端口；模型 id 改写 `provider/档位`
- `attemptWithFailover` 的「provider 链」概念整体作废（它就是 magpie 的候选循环）
- `noProxyList` 两处同步的老坑随端口收敛一并消失
- 面板的「每家一个端口」字段要改

**⚠ 模型 id 的后半段写什么 —— 这一条踩过坑，值得单独记**
（2026-10-22 实现时的发现，与复审 agent 的独立复审对上）

一开始写的是 `provider/最终模型`（如 `sn/glm-5.2`，即最终模型名），
靠**反查**（哪个档位的 target 等于这个模型）把档位找回来。这条路**在数学上不可逆**：

- **档位**（claude-opus-5）是 provider 无关的抽象；**最终模型名**（glm-5.2）是
  provider 相关的具体值。写具体值 = 在链路上丢掉了 provider 无关的那一半。
- 出厂默认里 zen/qd/or/mm 的**四档全指向同一个模型** → 反查必然命中四个 →
  挑哪个都是瞎猜。挑错的后果是「用户点 opus，转移后跑的是 fable 的模型」——
  **计费档位被悄悄换掉，面板上什么都看不出来**。
- 目标家按**档位**解析出的模型是不同的（sn 的 opus 档是 glm-5.2，wb 的是 hy3），
  所以「两档映射到同一模型时选哪档都一样」这个假设从根上就是错的。

**正确形态是 `provider/档位`**（magpie 同款语义：id 里带的是槽位，每家自己的表
把槽位翻成真实模型名）。这样：

- 网关只做**前缀剥离**，档位原样透传给中转 → **档位无损、无歧义**；
- 中转沿用老路径那套「档位 → 本家模型」解析，**一个字都不用改**；
- 故障转移时按**目标家**重解析这一档，也就自动正确了。

旧写法（`provider/最终模型`，用户手写或升级前的遗留接线）仍然认，但那时档位
只能反查、**多档同模型时必然歧义 → 返回 null**，转移时用**目标家自己的默认模型**，
绝不再把入口家的模型硬发给下一家。

对应实现：`src/server/gateway.mjs`（前缀剥离 + 档位识别）、
`src/server/gateway-failover.mjs`（`tierKeyFor` / `tierOfModel`）、
`src/server/server.mjs` 的 `applyToCli` / `applyToDesktop`（写 `provider/档位`）。

**风险**：这是请求主路径。必须分小步：先加新入口（模型 id 带前缀时走新逻辑），与旧路径并存，
用端到端用例证明等价，再切默认，最后拆旧的。

---

## T3 · 候选层泛化

**现状**：`failover.mjs` 的候选粒度只到 **provider**（`failoverState` 是 `Map<provider, …>`），
冷却两档（90s / 30min），`shouldFailover(status)` 只看状态码。
而 `wb-pool.mjs` **已经**实现了 magpie 那套账号级机制（`classifyFailure` 五类失败、
`account` vs `account_model` 冷却粒度、`Retry-After` 解析、中文额度正则、`stickyBind` 会话粘性）。

**magpie 形态**：候选 = 账号/密钥级。休息粒度 `restKey`（`provider@user`）+ `restID`
（`restKey + "/" + model`）—— 一个模型额度耗尽只让那个模型休息。

**要做**：把 `wb-pool.mjs` 里那套**抬到共享层**（新模块，如 `src/candidates.mjs`），
所有 provider 骑在同一套上；`failover.mjs` 的 provider 级逻辑退成它的特例。

**这是「差距不在能力，在抽象层级」的落点。**

---

## T15 · 客户端接线（harness 铺开）

**为什么要做**：magpie 支持 **66 个**客户端（它内部叫 agent，`internal/agent/agents.go`
的 `builtins()`），而本仓原来只接 Claude Code + Claude Desktop + OpenCode 三个。
用户装一个 CLI 就想用它 —— 这个洞比「少一个模型」大得多。

**关键判断：这些客户端只说 4 种方言。**

| 方言 | magpie 入向路径 | 覆盖的客户端（摘） |
| --- | --- | --- |
| Anthropic | `/v1/messages` | Claude Code、Claude Desktop、Zed、VS Code Chat、JetBrains Air、Raycast、Pencil… |
| OpenAI Responses | `/v1/responses` | Codex、Mister Morph |
| **OpenAI Chat** | `/v1/chat/completions` | **40 多个**：Qoder、ZCode、Kimi Code、Qwen Code、MiniMax Code、CodeBuddy、WorkBuddy、Droid、Cline、jcode、Goose、Crush、Pi、omp、OpenCode、Cursor CLI、Grok、AtomCode… |
| Gemini | `/v1beta/models/*` | Gemini CLI |

**所以 T15 分两层，第二层是第一层的十倍价钱。**

### T15-a 协议层（✅ 已完成）

统一网关现在认 `POST /v1/chat/completions` **与** `/chat/completions`（magpie 也是两个
都答 —— 客户端的 base_url 常是不带 `/v1` 的根地址，它自己拼 `/chat/completions`）。
顺带补了统一网关的 `GET /v1/models`（Chat 客户端启动第一件事就是拉清单，
早先一律 405 ⇒「协议通了但连不上」）。

零件其实**早就在**：`ir.mjs` 里的 `parseChat` / `chatDecoder` / `chatEncoder` /
`renderChat` 是「上游说 chat」那一侧用得着的，只是从没有人给它们配一个**入向**。
补协议不是写新模块，是给现成的零件接一根线。

### T15-b 接线层 · 薄适配器（🟡 在做）

`src/server/clients/`：`base.mjs`（备份 → 写 → 还原，**断开时只还原我们写过的那几处**，
用户文件里其它内容一个字不动）+ `registry.mjs`（扫目录，加客户端不改表）+
每个客户端一份声明。面板接口 `GET/POST /api/clients*`。

**这一层只做三件事**：客户端的配置文件在哪、provider 块长什么样、把 B.AI 的
地址与模型清单写进去。上下文窗口、输出上限、reasoning 档位这些**先不管** ——
客户端自己会用默认值。

### T15-c 接线层 · 深度定制（📋 后续规划，**未做**）

magpie 的每个客户端是**深度定制**的 —— `internal/agent/zcode.go` 就 600 多行：
两个配置文件（`config.json` 的 provider 形状 + 3.14 起的 `provider_config.json`
的 rules 形状）、模型的上下文窗口与输出上限、reasoning 档位与变体、原生联网
开关（还要一个 stash 记「我们开过哪些」）、**用户在客户端里手改过的值要保留**。

本仓的薄适配器**做不到**这些。后续要做的是：

1. **模型元数据下发**：把 B.AI 已有的上下文窗口 / 输出上限 / reasoning 档位写进
   客户端的模型表（magpie 的 `magpieModels()` → 各客户端的模型条目）。
2. **保留用户手改的值**：magpie 有 `mergeKept` / `keptEffort` 那套「用户在客户端里
   改过的东西我们不动」。本仓的 `base.mjs` 目前是**整块替换** provider 块
   （只保住了键路径级别的原值，不保 provider 块内部的细分字段）。
3. **每个客户端的第二份文件**：ZCode 的 `provider_config.json`、Qwen Code 的
   `MAGPIE_QWEN_API_KEY` 环境变量、MothX 的 `providers` 对象…

**取舍**：T15-c 是几十个客户端 × 每个 100–600 行 = 数月的量。
先按 T15-b 铺完（几十个客户端一次能铺完），再挑用户真在用的那几个做深。

### 本机现状（2026-10-23）

已装 **8 个**客户端（`~/.minimax`、`~/.cline`、`~/.zcode`、`~/.codebuddy`、
`~/.workbuddy`、`~/.workbuddy-ai`、`~/.hermes`、`~/.config/opencode`）——
薄适配器一轮就能全接上。**Cursor CLI 没装**（`~/.cursor` 是编辑器的目录，
不是 CLI 的 `cli-config.json`）。

### T15-d 网关侧要补的三个端点（📋 待做）

接线写好了 ≠ 客户端真的会走到 B.AI。三个「接上了但没真打通」里，**两个归网关这一侧**：

| 客户端 | 它要什么 | 网关现在 | magpie 怎么答 |
| --- | --- | --- | --- |
| **Empryo** | 只列「baseURL 有应答」的 provider ⇒ 它打 `GET /`（或 baseURL 带 `/v1` 时的 `GET /v1`） | 两个都 **405**（非 POST 一律 405） | `GET /{$}` 与 `GET /v1` **都**答 info（name/version/models/apis） |
| **Muse Code** | 模型清单从 `<base_url 主机>/muse-code/models` 拉 | 404 | `GET /muse-code/models` 答一份带 `limit` 的清单（它隐藏没有 limit 的模型 ⇒ 得给窗口/输出上限；magpie 从 catalog 拿，我们没有 ⇒ 只能给它的兜底值并在注释里说明） |
| **Cursor CLI** | 要它自己认自定义端点 | —— | magpie 在这一行也只写模型 id、**不改 base URL** ⇒ 要真打通得找 Cursor CLI 的自定义端点字段名（**没找到**） |

**要补的端点（通用改动，不是给某个客户端开后门）**：
`GET /` 与 `GET /v1` → 网关信息（照 magpie 的 info）；`GET /models` → 模型清单
（`/v1/models` 的别名）。`/muse-code/models` 较复杂（要伪造 limit），放后面。

### T15-e 形状要按「用户本机这一版」核（📋 纪律，2026-10-23 核出两个坑）

**照抄 magpie 的字段路径是不够的** —— magpie 是「它自己支持的客户端版本」的权威，
**不等于用户装的那一版**。2026-10-23 核出两个会**弄坏用户配置**的坑：

1. **Hermes 的键名有版本差异**：magpie 写 `providers:`（映射），
   **用户这版是 `custom_providers:`（数组，元素里还自带 `model:` 字段）**
   ⇒ 照抄 ⇒ 用户的 Hermes 读不到我们写的那块。
   ⇒ **按用户文件里已有的形状走**（WorkBuddy 那边 magpie 自己就「保留原形状」）。
2. **TOML 里同一张表不能被定义两次**：写嵌套对象会产出 `[model_providers]` + 内联表；
   而用户的 `config.toml` 里往往已有 `[model_providers.other]`（它**隐式定义**了
   表 `model_providers`）⇒ 重复定义 = **非法 TOML** ⇒ **Codex 读不了整个配置文件**
   （连他的 MCP 配置一起废掉）。
   ⇒ **写嵌套对象要逐键写**（产出 `[model_providers.bai]` 子表段）。

**怎么核**：接一个客户端，除了读 `internal/agent/<name>.go`，还要看**用户本机那个
客户端的真实配置文件** —— 但**只取键名与层级**（写个只提键名的脚本），
**绝不 `cat` 整个文件**（那些文件里常有真凭据，抄进夹具或提交就是泄漏）。
核出来的差异写进那个客户端的注释里：哪个是 magpie 的、哪个是用户这版的、我们按哪个来。

**本机装了哪些客户端**：权威来源是 **CC Switch 的 `~/.cc-switch/settings.json` 的
`visibleApps`**（它专门做多客户端切换，它认的就是本机这些）——
Claude Code / Claude Desktop / Codex / MiniMax Code / OpenCode 五个是启用的，
Hermes 装了但它没启用。**`~/.cursor` 是编辑器不是 CLI**（CLI 的配置是
`~/.cursor/cli-config.json`）；`~/.mimocode/`、`~/.copilot/` **只有空目录** ⇒ 没装。

### T15-f 面板那一屏还差三个最常用的（📋 下一批）

「客户端」屏现在列 25 个（`src/server/clients/` 下的声明），但**用户最常用的三个
不在列表里**：Claude Code、Claude Desktop、OpenCode —— 它们走的是老路
（`server.mjs` 的 `applyToCli` / `applyToDesktop` / `oc-wiring`），不在 `clients/` 层。

**为什么不直接照抄成声明**：
- Claude Code 写 `~/.claude/settings.json` 的 **`env` 块**（`ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_DEFAULT_*_MODEL`）+ 权限、hooks ⇒ 点分路径能写，
  但细节多。
- Claude Desktop 写 `configLibrary/<id>.json` 的 **`inferenceModels[]`（数组）**
  ⇒ 要等 JSON 的**数组级**读写能力（`formats-json-list` 那条线）。

**下一批怎么做**（二选一，或都做）：
1. **把它们也做成 `clients/` 里的声明**（形状对、路径级备份统一）—— 更干净，但要搬
   `applyToCli` 的全部细节。
2. **在「客户端」屏里给它们三行**，「接上/断开」**转调**现有的 `applyToCli` /
   `applyToDesktop` / `oc-wiring` —— 不重复实现、用户先能看到。



---

## T16 · 字体一轮升级（📋 后续规划，**未做**）

**要什么**：全软件的字体做一轮升级优化，参照 magpie，**做减法**——
与用户关系不大的那部分字体（等宽字体泛滥到界面文字上）**不用再显示**，
目标：简单、直观、好用。

### 现在的问题（实测 2026-10-23）

| 现象 | 证据 |
| --- | --- |
| **等宽字体几乎无处不在** | `panel-common.css` 里 `var(--mono)` 28 处、卡片里 `.mono` 44 处；而 `var(--sans)` 只有 1 处（body）。`.fpline .v` 是**通用值格** ⇒ 说明文字、状态词、描述全被迫等宽 |
| **`--mono` 没有中文回退** | `"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace` —— 等宽字体没有中文字形时，浏览器落到默认中文字体，长中文串会与英文段落**不是一套字** |
| **`--sans` 少了 Windows 11 的可变字体** | magpie 的 Windows 首选 `"Segoe UI Variable Text"`，我们只有 `"Segoe UI"` |
| 字号阶梯碎 | 10.5 / 11 / 11.5 / 12 / 13 混用，同一屏里字号差半档 |

### magpie 的判据（照它做）

magpie 有两个字体变量，**界线很清楚**：

- `--font` / `--ui-font`（**界面文字**）：说明、状态、按钮、标签 —— 即便内容长得像代码
  （`.key.free` 那个「免费」标签、`.call-body code.empty` 那个空代码块，都用 UI 字体）
- `--code` / `--code-font`（**代码本身**）：模型 id、路径、密钥**值**、JSON、版本号

Windows 上它还给了中文回退：`--code: "Cascadia Mono", Consolas, "Microsoft YaHei UI",
"Microsoft YaHei", monospace`；`--font: "Segoe UI Variable Text", "Segoe UI",
"Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif`。

**数字对齐另有更省的办法**：magpie 用 `font-variant-numeric: tabular-nums`
（`.led-chart svg`）—— 计数/金额**对齐**靠等宽数字，不必把整行都换成等宽字体。

### 要做的四件事

1. **两个字体变量补齐**：加 `--ui-font`（Windows 首选 `"Segoe UI Variable Text"`）、
   给 `--mono` 补 `"Microsoft YaHei UI"` 中文回退。
2. **收窄等宽使用面（做减法）**：`.fpline .v` 从「一律等宽」改成「默认 UI 字体，
   `.v.mono` 才等宽」；逐处审那 28 + 44 处，把**其实不是代码**的（说明、状态词、
   描述、按钮文字）换成 UI 字体；**只给**模型 id / 路径 / 密钥值 / JSON / 版本号留等宽。
3. **数字对齐改用 `tabular-nums`**：计数、金额、token 数用等宽数字，不换整行字体。
4. **字号阶梯收成一套**（比如 10.5 / 11.5 / 13 三档 + 行高与字重），去掉半档混用。

**取舍**：这轮是**减法**，不是加法 —— 目标不是「更好看的字体」，是**该等宽的地方等宽、
不该的地方别等宽**。做完要让用户一眼看出：哪些是「机器读的东西」（可复制、对齐）、
哪些是「人读的话」。

---

## T10 / T12 / T13 · 三个新模块（2026-10-22 一轮做完）

这三个是**并行 agent 各做一个模块、我接线与复验**的一轮。记下三件不该被忘的事：

**① 脱敏（`redact.mjs`）用「等长掩码」而不是「换占位符」。**
magpie 靠进程内的值表往返还原（同一个值还原成同一个占位符），我们要的是
「**落盘那份看不出真值**」——所以头尾留几个字符（认得出是 Anthropic 的 key），
中间填 `*`，**长度逐字不变**。不做 Restore/known：不记值也是「明文不外落」的前提。
边界刻意收窄：`sk-` 紧贴其它词字符时不认（否则 `risk-` / `task-` 会被误伤）。

**② 并发/RPM 闸门默认「不限」，而且释放写在 `finally` 里。**
释放漏一次 = **永久占一个坑** = 那家的请求从此全排队 —— 用户看到的是「卡住」，
不是「并发上限」，那种 bug 极难查。所以：`dispatchGated()` 把「拿名额 → 发请求 →
还名额」收在一处，调用方只给一个发请求的回调，异常照常往外抛而名额**一定**还。
实测把释放去掉，那条活体用例会**挂满 180 秒**而不是快速失败 —— 那正是它在防的故障。

**③ 备份用「二进制容器」而不是 JSON 信封。**
magpie 只能靠「像不像备份」的启发式区分「不是备份」与「备份被截断」，为此多写了一整套
缓存副本比对；固定 magic 头一次字节比较就分开了。口令走 PBKDF2-HMAC-SHA256
（60 万次，与 magpie 同值）+ AES-256-GCM，**盐与 IV 全进 AAD**。

**接线时踩到的一个结构性问题**：限流闸门一开始写在故障转移的**候选循环里**，
而「不开故障转移」那条路（单家直连，最常见）根本不进那个循环 —— 等于
**最常见的场景反而没过闸**。抽成 `dispatchGated()` 给两条路共用才解决。
（这类毛病只有真读代码能发现：功能都在、单测都绿，但**接线**少了一条路。）

**还没接线的**：T13 的**远端同步**（WebDAV / GitHub）—— 模块（`sync.mjs`）已就位且
84 条断言全绿，但接线要远端目标与凭据的 UI，本轮没做。本地备份已接线并有活体用例。

### 额度探测：三条查证过、**决定不做**的事（2026-10-23）

记在这里是为了下轮不用再查一遍 —— 每一条都实测过，不是推测。

| 渠道 | 实测结果 | 为什么不接 |
| --- | --- | --- |
| **wb / wbai** | 候选端点 `/v3/user/quota`、`/v2/plugin/auth/quota` 都 **404** | 它们的额度**天然是模型级**的（账号池目录里每个模型有 `credits`），而状态层的 `used/limit` 是**渠道级**的。硬接进去就是「渠道级的数字装着模型级的含义」—— 那是错配，比「探不到」更坏。真要做，正确口径是「选中那家**当前档位**的 credits」，单开一格，不进渠道级数字。 |
| **qd** | 端点存在（401 = 缺凭据），但**令牌在客户端请求里**（`Authorization` + `x-gw-user-id`），不在配置里；且规格自己写着「字段名待实测」 | 即便注入令牌（令牌在客户端登录态文件里，形态与 `Authorization` 头怎么拼还没验过），**字段名仍是猜的** —— 探到了也读不出数。先把字段名验出来再接，否则只是把「没登录态」换成「读不到字段」。 |
| **mm** | 修好地址与凭据后，MiniMax 回 **503 `direct_route_not_configured`** | 这是**上游的事实**：会员档（agent.minimax.cn）没开这个额度接口（那是 Coding Plan 的接口，api.minimaxi.com）。magpie 的注释早就说过「两边不一定通用」。探测器的职责是**如实报出来**，不是替上游造一个数 —— 现在的面板上那格写的就是上游的原话。 |

对比：**其它渠道的探测现在给出的是真实原因**（B.AI 403、WorkBuddy 404、Qoder 401），
而不是一律「没有可用的登录态」—— 这本身就是这一轮最大的改进：
**探不到要说出「为什么探不到」**，否则用户只能猜。

---

## 2026-10-22 晚 · T8 / T9 / T14 一轮 + 两条真问题

这一轮并行跑了三个 agent（账号发现 / 价格表 / 渠道状态层 + 面板接线），
另有两个 agent 分别做「代码插件运行时」与「面板 P3 渠道主从」。

**① 查表要「逐级降级」，不许只认精确档位名**（真问题，用户侧真实影响）

客户端（Claude Code）送来的模型 id 带**小版本号**：`claude-sonnet-5-5`、
`claude-opus-5-5`；而映射表的 key 是**档位名**：`claude-sonnet-5`、`claude-opus-5`。
差最后一段就查不到 → **静默回落到本渠道默认模型** → 用户点 opus、跑的是默认那个。
实测中转日志里 `claude-sonnet-5-5` 回落过 41 次、`claude-opus-5-5` 7 次，
只有 haiku 侥幸对得上（`claude-haiku-4-5` 恰好逐字等于档位名）。

修法**不是**把映射表的 key 改成带小版本的写法（小版本会继续涨：5-5 → 5-6 → 6-0，
下次又对不上），而是**查表时逐级降级**：先精确，再去日期后缀，再去小版本。
`server.mjs` 的 `resolveModelTarget` 与 `gateway-failover.mjs` 的 `tierKeyFor`
**必须用同一套降级序列** —— 一边认得、另一边不认，就会出现「查表认得、转移不认」
的鬼故事（档位在入口解析对了，转移时又当成不知道的模型名）。

顺带修掉一个**优先级漂移**：降级最初写成「每一级里先查映射表再查清单」，
那会让**清单里的一条**（比如上游目录里正好有 `claude-opus-5-20251001`）
压过**用户在映射表里写死的对应关系**。降级前后的语义必须是「映射表整体优先于清单」。

**② 探测缓存那张「5 分钟」当时是写在注释里、没生效的**

`probeCache` 原来写成 `{ at: 0, map }`，而 `at` **从来没被赋过值** →
`now - probeCache.at` 恒等于 now → **缓存永远不命中** → 面板每 5 秒轮询一次
「额度」屏，就把八家上游各打一遍。现在逐条记时刻（谁先探到谁先过期）。

**③ 价格表的更新策略：不自动更新**（一条决定，不是疏漏）

价格是**漂移**的：厂商随时调价。所以价格表**必须**带快照日期（当前 2026-10-22），
面板要能显示「单价表是哪天的快照」。自动更新看着省事，实际后果是
「今天我花了多少钱」这句话的**含义**会在某天悄悄变掉 —— 而用户是拿它跟厂商账单
对账的。所以：`pricing.mjs` 是**纯逻辑、零联网**的（远端表由调用方显式拉来后
经 `fromModelsDev` 翻成同一张表），更新必须是**用户点了才发生**的事。

**④ 探不到 ≠ 0，也 ≠ 100**

上游真报的余额折进转移链的排序时，「探不到」必须**一个字节都不改**：
当成 0% → 那家显得「额度富余」被排到最前（真相可能是欠费了）；
当成 100% → 一家好渠道因为网络不通被踢到最后。**没有信号就是没有信号。**
同理，额度用完的那家**留在候选里**、只是排到最后 —— 直接踢掉的话，
「所有渠道都冷却」会变成「没有渠道」，用户看到的是一句没有出处的失败。

---

## 每轮工作的纪律

来自 magpie 的 `LESSONS.md` 与本仓库的既有规矩：

- **一次一个目标**：一个提交只做一件事，冲突面小到能逐行看清
- **每个新模块自带反向对照测试**：把判定改坏，测试必须红
- **读失败 = unknown，绝不是 empty**（`edit-json.mjs` 的硬约束就是这条）
- **闸门 0 error 0 warn + `npm test` 全绿** 才算完成
- **合并上游优先**：本地落后就先合并，冲突面越小越好解

---

## 并行会话的规矩（2026-10-23 定）

现在的工作是**多会话并行**的（一个负责人 + 几个 agent 会话各做一块），规矩要写下来，
不然每个会话都自己发明一套，最后合不拢。

### 一、**所有会话的思考过程文字一律用中文**

**不只是给用户看的回复 —— 内部的分析、权衡、推演（thinking）也一律中文。**
代码里的标识符仍然是英文（那是代码），但**写给人看的每一段文字**都是中文：
思考、注释、提交信息、报告。

**Why:** 这个仓库的判断力来自「把为什么写下来」—— 注释写的是「为什么这么判」，
提交信息写的是「为什么改」。思考过程是这些文字的**上游**：用英文推演再用中文落笔，
中间会掉一层 —— 那些「我先试 A 再试 B，因为 B 更像那条老路」的权衡，正是最该留
在纸面上的东西。中文推演时那些权衡会直接变成注释的措辞，不用二次翻译。

**How to apply:** 每个会话的开场 brief 里都带上这一条（负责人开新会话时写进去）；
已经在跑的会话，负责人补发一条消息通知（2026-10-23 已对三个在跑的会话补发过）。

### 二、文件归属：一个文件只有一个主人

并行改同一个文件，最后一定是「谁覆盖了谁」。所以：

| 文件 | 主人 |
| --- | --- |
| `src/server/server.mjs`（中转热路径） | **负责人**独占 |
| `src/server/panel-common.js` / `panel-common.css` / `provider.html` | 共享且脆 —— 同一时间只有**一个**会话碰 |
| `src/server/providers.js`（视图与卡片清单） | 负责人（agent 只报「需要挂到哪个视图」，不自己改） |
| `package.json`（测试清单一行） | 负责人统一登记 |
| 新建的模块 / 新建的卡片 / 新建的测试 | **谁建谁拥有**，会话之间不重叠 |

### 三、接线由负责人统一做

agent 交付的是**新文件**（模块 + 卡片 + 用例）；把它挂进视图、加上端点、登记测试，
由负责人做。理由与「为什么 8 个旧中转端口的行为一字不变」同源：
**接线是最容易漏、也最难看出漏了的地方**（功能都在、单测都绿，而接线少了一条路）。

### 四、每个 agent 的交付都要带**反向对照**

「改了哪一处 → 哪条断言红了」是硬要求。没有这一栏，报告里的「全绿」说明不了任何事。
