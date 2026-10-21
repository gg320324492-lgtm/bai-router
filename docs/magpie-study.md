# magpie 深度学习报告 → bai-router 复刻清单

> 研究对象：[`yetone/magpie`](https://github.com/yetone/magpie)（Go，18.7k stars，103k 行，约 80 个 internal 包）
> 克隆位置：`G:\tmp\magpie-study`（浅克隆，只读研究用）
> 研究日期：2026-10-21
> 对照对象：`G:\bai-router`（Electron + Node）

## ⚠ 基线说明（必读）

本文对 bai-router 侧的**行号与规模描述，取自本地 checkout 的 v1.0.87**（commit `1ba94db`）。
写作时本地落后 `origin/main` 14 个提交（上游已到 v1.0.92），其中包含一个新增渠道
（MiniMax 会员通道）与故障转移面板的改动。已就以下几条**对着 origin/main v1.0.92 复核过**，
结论不变：

| 缺口 | v1.0.87（本文行号） | v1.0.92 复核 |
| --- | --- | --- |
| **A** 读 `settings.json` 失败被当空 → 写回 | `server.mjs:6159-6160` | **仍在**（`server.mjs:6487` 附近） |
| **B** `JSON.stringify` 全量重写 `settings.json` | `server.mjs:6212` | **仍在**（`server.mjs:6539`） |
| **C** 通用故障转移只看状态码 | `failover.mjs:149-153` | **仍在**（`shouldFailover(status)` 未变） |
| **D** 通用冷却只有 2 档、无退避 | `failover.mjs:19,27` | **仍在**（`FAILOVER_COOLDOWN_MS`/`FAILOVER_QUOTA_COOLDOWN_MS` 未变） |
| **E** 冷却粒度只到 provider | `failover.mjs:29` | **仍在**（`failoverState` 仍以 provider 为键） |
| **M** 无会话身份概念 | — | **仍在**（全仓无 session 头处理） |
| **N** 无用量账本 | `server.mjs:6353` 附近 | **仍在**（无 `usage.jsonl`） |

**已随上游变化的**（本文相应描述按 v1.0.87 记）：

- 渠道数：v1.0.87 是 7 家 + CC Switch；v1.0.92 是 **8 家**（新增 MiniMax 会员通道）+ CC Switch。
- `failover.mjs` 行数：v1.0.87 是 152 行；v1.0.92 是 **309 行**——但涨上去的是「静默换人」的
  面板显式化（`noteSilentJump` / `silentJumpSnapshot`），**冷却内核一行未动**，故缺口 C/D/E 照旧。
- Zen 免费档的结论：v1.0.87 面板写的是「会话衰减」（2026-10-14 实测）；
  v1.0.92 换成了「约四分之三请求随机挂起」（2026-10-15 实测）；
  再往后（2026-10-17 起）实测为免费档**外部调用一律 403**，见本文 §3.2 与相关提交。

**第 5 节「复刻清单」按上述缺口编号编制，结论对 v1.0.92 仍然成立**，
只是动手前请以当时的 `origin/main` 为准重取行号。

---

## 0. 一句话结论

**bai-router 的差距不在能力，在抽象层级。**

magpie 和 bai-router 做的是同一件事（本地网关 + 桌面菜单栏 + 多供应商切换 + 配额耗尽自动换号），
但 magpie 把「账号级路由」做成了**所有供应商共用的底层**（`routes.Seat` / `routes.Strategy` /
`restKey` / `restID`），bai-router 把同一套逻辑**写在了 WorkBuddy 一个供应商里**（`wb-pool.mjs` 1003 行）。

结果：

- bai-router 的 **WorkBuddy 账号池**（`wb-pool.mjs`）已经独立实现了 magpie 的失败分类器 ——
  五类失败（transient/quota/rate_limit/auth_dead/content）、account vs account_model 两种冷却粒度、
  Retry-After 解析、中文额度正则、会话粘性。**这块不用抄，已经有了。**
- bai-router 的 **通用故障转移**（v1.0.87 的 `failover.mjs` 152 行）却只有两档冷却、只看状态码、粒度只到 provider。
- bai-router 的**协议桥**是单向的 Anthropic→OpenAI Chat，magpie 是 4×4 协议矩阵。

所以正确路线不是「照抄 magpie 的 Go 实现」，而是 **把 `wb-pool.mjs` 里已经写对的东西提到共享层**，
再按需补 magpie 有而 bai-router 没有的少数几块（详见第 5 节分批清单）。

---

## 1. magpie 是什么

**「Every agent's model. One place.」** —— 一个本地网关（默认 `127.0.0.1:3425`），
同时讲 OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini 四种协议并互相翻译，
把 70+ 个编码 agent（Claude Code、Codex、Gemini CLI、OpenCode、Cline、Goose、Zed…）的
配置统一改写过来指向自己，供应商配额耗尽时在背后悄悄换账号或换模型。

形态：菜单栏 app + 窗口 + TUI + Web UI + CLI + Docker + Termux，跨 macOS/Windows/Linux。

### 关键定位差异

| | bai-router | magpie |
|---|---|---|
| 网关端口 | **7 个**（15722/15732/15742/15752/15762/15772 + 面板 15723），一provider 一端口（v1.0.92 起 8 个渠道） | **1 个**（3425），模型 id 决定走哪 |
| 模型寻址 | 本地四档映射表（fable/sonnet/opus/haiku → 各家 target） | `provider/model` 写进 agent 配置，网关自己解析 |
| 客户端连接 | Claude Code 连某个 provider 的端口，故障转移在中转内部跨 provider 跳 | Claude Code 只连 3425，故障转移在网关内跨账号/模型跳 |
| 供应商协议 | bai/sn 原样透传；wb/wbai/qd/or/zen 共用**一个** Anthropic→OpenAI 单向桥 | 4×4 全矩阵，双向，流式 + 非流式 |

> magpie 的「任意模型给任意 agent」来自 `provider/model` id 体系；
> bai-router 的来自四档映射表。两者解决的问题不同，不能简单说谁更好。

---

## 2. 架构总览

### 2.1 包地图（按体量）

```
internal/gateway      878 文件   ← 四协议翻译 + 路由 + 故障转移 + 限流 + 会话
internal/provider     616 文件   ← provider/账号/密钥/分组/配额
internal/agent        379 文件   ← 72 个 agent 的接入（改配置/插件/环境变量）
internal/gui          357 文件   ← 菜单栏 + 窗口 + 面板 + Web UI
internal/sessions     195 文件   ← 会话聚合
internal/library      146 文件   ← 指令/MCP/skills 写进 agent
internal/cli          122 文件   ← magpie <agent> <provider/model> 命令树
internal/usage         96 文件   ← 用量账本
internal/plugin        83 文件   ← 外部插件宿主（Bun 子进程）
internal/edit          ~8 文件   ← ★ 保格式配置编辑器（本次最重要发现）
```

### 2.2 一次请求的完整路径

```
agent 请求 → 127.0.0.1:3425
  → Handler 路由到 /v1/messages | /v1/chat/completions | /v1/responses | /v1beta/models/*
  → serveAgent：建会话身份 → 跑 JS 中间件链 → serve
  → serve：脱敏(redact) → 解析模型 → 候选规划(plan/planGroup)
       → 循环每个候选(账号/密钥)：lane.take(并发) → rpms.wait(RPM) → forwardOnce
            → 协议翻译：parse(入向→IR) → build(IR→上游 body)
            → 传输层 upstreamTransport (HTTP/2)
       → holdWriter 扣住响应 → 首字节/首内容块到达才放行
       → 出错 → failure(status, body) 分类 → 休息该候选 → 下一个候选
  → decode(上游 SSE→Event) → encode(Event→客户端 SSE)
  → 出口脱敏还原 → 客户端
```

**不变式**（和 bai-router 已有的完全一致）：**故障转移只发生在首个响应字节写给客户端之前**。
bai-router 的 `CaptureRes` 影子 res 就是 magpie `holdWriter` 的简化版 —— 这层不用重写。

---

## 3. 五个维度逐一对照

### 3.1 网关与协议翻译

**magpie 怎么做**：不是逐字段硬翻译，而是先解析成**统一中间表示（IR）**，再从 IR 构造目标协议。

`internal/gateway/ir.go`：

```go
type Kind string   // Text | Image | File | ToolCall | ToolResult | Thinking | Search
type Part struct { Kind Kind; Text string; MediaType, Data, URL string
    ID, Name string; Args json.RawMessage      // tool_call
    CallID string; IsError bool                 // tool_result
    Signature string; Sealed json.RawMessage; SealedBy string }
type Message struct { Role string; Parts []Part }
type Tool struct { Name, Description string; Schema json.RawMessage; Strict, Deferred bool }
```

流式侧同样收敛成一个事件模型（`ir.go:279-339`）：

```go
const (KStart, KText, KThink, KSig, KToolStart, KToolArgs, KStop, KUsage,
       KError, KSearch, KImage, KThinkStart, KSealed, KTextSig, KAlive)
type Event struct { Kind EventKind; Status int; Text, ID, Name, MsgID, Model, Stop string
    Code, RequestID string; Usage Usage; Hits []Hit; Wait time.Duration; Said json.RawMessage }
```

**四×四矩阵**（全在 `gateway.go`）：

| 方向 | Anthropic | Chat | Responses | Gemini |
|---|---|---|---|---|
| 解析→IR | `parseAnthropic` (anthropic.go:117) | `parseChat` (chat.go:76) | `parseResponses` (responses.go:310) | `parseGemini` (gemini.go:215) |
| IR→上游 body | `anthropicBody` (anthropic.go:818) | `buildChat` (chat.go:268) | `buildResponses` (responses.go:1089) | `buildGemini` (gemini.go:113) |
| 上游 SSE→Event | `decodeAnthropic` (anthropic.go:1164) | `chatDecoder.decode` (chat.go:1188) | `responsesDecoder.decode` (responses.go:1482) | `codeAssistDecoder` |
| Event→客户端 SSE | `anthropicEncoder` (anthropic.go:1406) | `chatEncoder` (chat.go:1391) | `responsesEncoder` (responses.go:1730) | `geminiEncoder` (gemini.go:600) |

四个调度函数各一行 switch：`parse` `gateway.go:6054`、`build` `:6109`、`decoder` `:6145`、`encoder` `:6206`。

**流式与非流式共用一条事件管道** —— 非流式由 `collector`（`ir.go:474`）把 Event 流装配成 `Result`，
再 `renderChat`/`renderResponses`/`renderGemini`/`renderAnthropic` 渲染成整包 JSON。这是 magpie 少写一半代码的关键。

**思考块是最难的部分**，magpie 用三个独立通道承载：

- `Part.Signature` —— Anthropic `thinking.signature` / Gemini `thoughtSignature`，**必须原样回传**，否则上游拒绝
- `Part.Sealed` + `SealedBy` —— 上游密封的推理，只有原 API 能写回
- 事件层 `KThink`/`KSig`/`KSealed`/`KTextSig`/`KThinkStart` 五个事件分开

**错误映射** `writeErrorSaid`（`gateway.go:6912`）：一个状态码映射成三种协议的错误体，
`429`→`rate_limit_error`、`413`→`request_too_large`（Anthropic 私有类型，Claude Code 靠它触发 compact）、
上下文超长统一改写成 `400 + context_length_exceeded`。

**传输层** `internal/gateway/upstream_transport.go`：
`ForceAttemptHTTP2: true`、`MaxIdleConnsPerHost: 8`、`IdleConnTimeout: 90s`、
`ResponseHeaderTimeout` 默认 10 分钟（绘图单独一个 transport 等 60 分钟）。
`replayable` 给请求打空 `X-Idempotency-Key`，让 Go 允许对**被复用的死连接**上的 POST 自动重投一次。

**bai-router 现状**（`src/server/server.mjs` 7736 行）：
- 5 个 provider（wb/wbai/qd/or/zen）共用**一个** Anthropic→OpenAI Chat Completions 单向桥（`server.mjs:3655` 起）
- bai/sn 是 Anthropic 原样透传
- **没有 IR**：请求侧手写字段映射，响应侧手写 SSE 事件翻译
- **thinking 块含签名直接丢弃**（`server.mjs:3580` 注释：「thinking 块（含签名）对 OpenAI 上游无意义，丢弃」）
- 只支持流式上游，非流式靠 `wbPipe` 的 `clientStream=false` 分支聚合

### 3.2 路由、故障转移与配额

**magpie 的候选模型**：

```
候选 = 账号 / 密钥 级别（不是 provider 级别）
休息粒度 = restKey (provider@user 或 provider)  + restID (restKey + "/" + model)
          → 一个模型额度耗尽，只让那个模型休息，同账号其它模型照常可用
```

**失败分类器** `gateway/routing.go:350` `failure(status, body)`：
看状态码**和响应体**，十几条正则，含中文（`余额|额度|欠费|限流|频率|套餐|用量|上限`）。

错误枚举 `gateway/routing.go:245-301`：
`failCredit failQuota failRate failOther failAuth failCanceled failForeign failFloor
 failUpdate failVerify failRefused failShape failPrompt failEffort failProxy failOverflow
 failRoom failSlow failLoop failRestricted`

**冷却时长表** `gateway/routing.go:154-186`：

```go
fallbackCooldown = 1*time.Minute;   creditRest     = 30*time.Minute
quotaRest       = 15*time.Minute;   longestWait    = 1*time.Hour
longestQuota    = 8*24*time.Hour;   longestRetry   = 10*time.Minute
longestRateRest = 30*time.Minute;   rateForget     = 30*time.Minute
verifyRest      = 30*time.Minute;   restrictedRest = 2*time.Hour
```

**退避公式** `gateway/routing.go:930`：
`d = min(fallbackCooldown << min(n-1,10), longestRetry)` → **1m, 2m, 4m… 封顶 10m**，n = 连续失败次数。

冷却时长优先级：**厂商明说重置时间 > 配额窗口续期 > Retry-After（>1h 不可信）> quotaRest 15m**。

**路由策略** `internal/routes/`，7 种，注册表可叠加（插件也能注册）：

| 策略 | 算法 |
|---|---|
| `""`=smart | tier 按 `LowShare=90`/`SpentShare=98` 切 0/1/2；tier 内按配额窗口**最早续期**排序（时间截断到整点，大窗口优先）；`Learns`（未知但会自报剩余）排最前；同分按 `Used` 升序 |
| `order` | 原序 |
| `rotate` | 轮转 |
| `usage` | `Used` 升序，再按 `Tokens`（1 小时半衰期衰减） |
| `pace` | `(100-used)/距重置小时` 最大；0.9 倍以内算同一档 |
| `weight` | NGINX 平滑加权轮询 |
| `free` | 免费模型优先（按目录里的 free 标记或 $0 价） |

**会话亲和（affinity）** `internal/gateway/affinity.go`：
模式 `auto / session / turn / off / strict`，存 `affinity.json`。
判定依据不只是「谁回答过」，还看**缓存价值**：上一轮读写缓存 ≥ `cacheWorth`(1024) token 且缓存未冷（5 分钟）就续住；
供应商声明保留 1 小时缓存时可突破 5 分钟限制。

**并发与 RPM 限流** `internal/gateway/concurrency.go` + `rpm.go`：
每个账号最多 `MaxConcurrency` 个在途请求，多余的进队列（`QueueLimit`/`QueueWait` 封顶，超了 429）；
`MaxRPM` 限滚动 60 秒窗口，等待超过 2 分钟直接 429 并带 `Retry-After`。

**配额探测** `provider/subscription_usage.go`：
统一成 `QuotaWindow{Used, ResetsAt, ResetSecs, Span, Model, Amount, Limit, Unit, RunsOutAt, Aside, Pool}`，
缓存进 `quotas.json`。调度 `provider/routing.go:484` `Allowances(agent)`：超过 1 分钟算过期，
**首次最多等 3 秒**，之后不等。**还能从响应里学**：Claude Code 的 `rate_limit_event` 让 `Learns=true` 的 seat 优先。

**bai-router 现状**：

| 能力 | bai-router 位置 | 状态 |
|---|---|---|
| 失败分类（五类） | `wb-pool.mjs:386-468` `classifyFailure` | ✅ **已有**，且粒度分 none/account/account_model |
| 中文额度正则 | `wb-pool.mjs:165` `积分不足\|额度不足\|额度用尽\|余额不足\|配额不足\|超出配额` | ✅ 已有 |
| Retry-After 解析 | `wb-pool.mjs:253-269`（含 `X-RateLimit-Reset`、body 里的 `resetsIn` 等） | ✅ 已有 |
| 模型级冷却 | `wb-pool.mjs:955` `acct.modelCooldowns[m]` | ✅ 已有 |
| 会话粘性 | `wb-pool.mjs` 首条 user 消息 sha256 + 200 条 LRU | ✅ 已有 |
| **通用故障转移** | `failover.mjs`（v1.0.87 152 行 / v1.0.92 309 行，涨的是「静默换人」面板） | ❌ 只 2 档冷却（90s/30min），`shouldFailover(status)` **只看状态码**，粒度只到 provider |
| **路由策略** | 固定链序 `["qd","bai","sn","zen","wb","wbai","or"]` | ❌ 无策略概念 |
| **并发/RPM 限流** | 无 | ❌ |
| **亲和（网关级）** | 仅 WorkBuddy 池有 | ❌ 不通用 |
| 冷却持久化 | 纯内存，重启即失 | ❌ |

> **重要**：上表前五行说明 `wb-pool.mjs` 已经**独立重新发明了 magpie 的失败分类器**，
> 且概念一一对应（transient↔failOther、quota↔failQuota、rate_limit↔failRate、
> auth_dead↔failAuth、content↔failPrompt、account_model↔restID）。
> **不要重写它，要把它抬到共享层。**

### 3.3 凭据、账号与插件

**magpie 的核心原则**（`internal/provider/account.go` 文件头）：

> **"Nothing is stored twice: sign out of the agent and the provider is gone."**

magpie **读** agent 自己的登录态（`~/.claude/.credentials.json`、`$CODEX_HOME/auth.json`、macOS Keychain），
不复制；额外账号才存自己的 `logins.json` / `plugin-auth.json`。

**磁盘形态（重要事实）**：

| 内容 | 位置 | 加密 |
|---|---|---|
| provider API key | `~/.config/magpie/providers.json` | **无，明文**，文件 0o600 |
| LAN key / GitHub token | `settings.json` | **无，明文** |
| 网关调用方 key | `caller-keys.json` | **无，明文**（`Masked` 字段只是显示遮罩） |
| 订阅登录态 | agent 自己的文件 / macOS Keychain | 跟 agent 一样 |

**magpie 不用系统钥匙串存 key**，钥匙串只在**读订阅登录态**时用（macOS `security` CLI）。

**刷新令牌的关键设计** `internal/provider/account.go:1070` `codexRefresh`：
refresh token 会轮换，**一旦发出必须等它回来**，哪怕调用方已放弃 ——
用 `context.WithoutCancel(ctx)` + 30s 超时。否则手里只剩用过的 refresh token，
下次被拒（`refresh_token_reused`），账号会「看起来已登出」。

**凭据指纹** `internal/provider/claude_auth.go:44`：
`version() = sha256(accessToken + "\x00" + refreshToken)` —— 用指纹判断「这次刷新到底换没换凭据」。

**插件系统两套**：

- **内置插件** `internal/pluginrt` + `plugins/*`（Go 包，编译进二进制）
  Manifest 字段：`ID / API / Requires,Provides / Essential / Name,Sub / One,Many /
  InUse / Apply / Parts / Defaults / Settings / Client`。
  服务注册 `ctx.Provide("router.strategy/groups", v)`，撤销 `ctx.OnDispose(f)` **反序**执行。
  设置项靠 struct tag 生成 JSON Schema（`SchemaOf(v)`），`SetConfig` 只接受 schema 允许的键，
  所以「表单 / plugins.yml / CLI dump」三方不可能不一致。
  **隔离 = 没有**，同进程 Go 代码，靠 recover 兜 panic。

- **外部插件** `internal/plugin/`（社区 npm 包，**Bun 子进程**）
  形态 = OpenCode v1 server plugin 兼容包。协议 = stdin/stdout **每行一个 JSON**。
  插件拿到的能力：`client.auth.set`（写凭据文件）、`Bun.$`（任意 shell）、
  `gateway.onRequest/onResponse`（全量改写流量）。
  **隔离 = 进程隔离，不是沙箱** —— 插件是完全可信代码。

**脱敏四件套分工**（容易混）：

- `internal/redact` —— **出站**脱敏引擎。密钥换成占位符 `{{API_KEY_k3v9x2mq}}`，厂商回来再换回去。
  占位符**同一值恒定**（keyed hash），所以对话历史前后一致、thinking block 签名仍对得上
- `internal/masking` —— 把 Settings→Privacy 开关接到网关 masker
- `internal/maskrec` —— **脱敏审计台账**。一天一文件，`~/.config/magpie/masking/`，
  留 30 天 / 100MB。**只记占位符、种类、来源、首字符、长度，绝不记值**
- `internal/pii` —— 本地模型（OpenAI Privacy Filter GGUF q8 1.6GB + `pf-serve`），
  跑在**独立进程**（不链进网关：1.7GB 常驻 + GPU 驱动崩了会带死网关）

**隐私开关** 三态合一：`MAGPIE_NO_ACCOUNTS` 环境变量 **或** `settings.json` 的 `NoAccountDiscovery` 字段。
闸门落在**每个源**（`readAccountFile`、Keychain 读、问 CLI）和**每个 sink**（切换、忘记、登录、导入）。

**bai-router 现状**：
- `wb-token.mjs` 66 行：解 JWT 载荷取 `exp`，**无凭据指纹**
- `cards/token-capture.js` + `qoder-patch.mjs`：**从运行中的客户端里抠 token**
  （钩子抓 Authorization、改 worker 字节码）—— 与 magpie 的「读文件 + 读钥匙串」方向相反
- 无脱敏台账、无统一凭据读取闸门、无插件体系

### 3.4 Agent 接入与配置编辑

**magpie 三条接入路线**：

| 路线 | 适用 | 机制 |
|---|---|---|
| 改配置文件 | ~60 个 agent | `internal/edit` 保格式编辑器 |
| 插件声明 | 第三方 agent | `internal/agentplug/` + `moejs`（Go 写的 JS 引擎） |
| 环境变量 / 启动器 | Qoder、Cline 等 | `internal/appdir` + `internal/shortcut` |

**★ 最值得抄的一块：`internal/edit` 保格式编辑器**

公开 API：

```go
// internal/edit/json.go:47
func SetJSON(path string, kvs ...KV) error   // 保注释、保键序、保缩进
// internal/edit/json.go:79
func PatchJSON(raw []byte, set []KV, del []string) ([]byte, error)  // 只算不写
```

实现要点（`json.go:106` `setJSONBytes`）：

```go
// 注释被等长空白替换，所以 gjson 的 offset 能 1:1 映射回原始字节
stripped := jsonc.ToJSONInPlace(append([]byte(nil), raw...))
r := gjson.GetBytes(stripped, keyPath)   // 拿到原文件里的字节区间
return splice(raw, r.Index, len(r.Raw), newValue)  // 直接在原字节上切片拼接
```

**不反序列化、不重新序列化**。gjson 只用来「定位」，真正写回是对**原始字节**做 splice。
于是注释、键顺序、缩进天然全保留。

配套：
- `keepCRLF()` —— 原文件全 CRLF 才转 CRLF，混合换行原样不动
- `keepBOM()` —— PowerShell/记事本写的 UTF-8 BOM 保留
- `indentUnit()` / `lineIndent()` —— 从下一行猜缩进单位
- `WriteAtomic()` —— 临时文件 → fsync → rename
- `Target()` —— 路径是 symlink 时写**链接目标**（rename 覆盖会把 dotfiles 仓库的链接变成实体文件）
- `writeInPlace()` —— 有其他硬链接时原地写 + truncate
- `Atomically(fn, paths...)` —— 多文件事务，失败全部回滚
- TOML / YAML / env 各有对应编辑器

**Claude Code 的完整落地路径**：

```
internal/agent/claude.go:599   path = at.claudeDir() + "/settings.json"
internal/agent/claude.go:1520  writeTiers(main, tiers)
internal/agent/claude.go:1560  kvs := []edit.KV{
                                  {Path:"env.ANTHROPIC_BASE_URL",   Value: gw},
                                  {Path:"env.ANTHROPIC_AUTH_TOKEN", Value: tok},
                                  {Path:"env.ANTHROPIC_SMALL_FAST_MODEL", Value: spell(tiers["haiku"])},
                                  {Path:"model",                   Value: spell(main)}}
```

**记忆与漂移检测**（magpie 独有）：
- `internal/agent/stash.go` —— `stash.json` 记住用户**改动前的原值**，`Unwire` 时原样还回去
- `internal/agent/applied.go` —— `applied.json` 记住 magpie 最后写了什么；
  别人（另一个 switcher）改了 settings.json 就报 "Drift"，并给出改回来的方法
- `internal/lastgood/` —— 自己的状态文件写坏时保留 `.bak` / `.bad-<time>`，读回上次好的版本

**bai-router 现状（★ 已验证的真实缺口）**：

`src/server/server.mjs:6158-6214` `applyToCli(S)`：

```js
let s = {};
try { s = readJson(SETTINGS); } catch { s = {}; }   // ← 读失败 = 当空
...
s.env = s.env || {};
...
writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + "\n");  // ← :6212 全量重写
```

两个问题，**都已在本机代码核实**：

1. **每次切模型都抹掉用户 `~/.claude/settings.json` 的注释、键顺序、缩进**
   （`JSON.stringify(s, null, 2)`）。用户手动加的注释，每切一次就消失一次。
2. **读失败会被当成空文件并写回去** —— `readJson`（`server.mjs:5737`）是裸 `JSON.parse`，
   读不了就抛。`applyToCli` 的 `catch { s = {}; }` 把「解析失败」和「文件不存在」混为一谈，
   然后把只有 `env` 的新对象**写回用户的 settings.json** —— 用户其余全部配置当场丢失。

第 2 条正是 magpie `docs/code-standards.md` 明令禁止的：

> **A failed read, parse or hash means "unknown".** It never means "empty", "none" or "equal".
> …… readLogins wrote a parse error back as "no accounts" (b363327d), and agent/stash.go had
> the same bug two days later (270b5257).

magpie `LESSONS.md` 里也有对应的实案（`#1928` 的 `models.json` 半写读取）。

### 3.5 面板、会话与统计

**GUI 技术栈（一句话）**：

**Wails v3**（系统 WKWebView / WebView2 / WebKitGTK）+ **纯手写 JS 前端**
（`internal/gui/assets/`：`app.js` `app.css` `i18n.js` `kernel.js` `layout.js` `theme.js`，
**零框架零打包器**）+ **同源 JSON REST API** 作 Go↔前端 IPC（无绑定生成器）。
TUI 用 charmbracelet bubbletea/lipgloss。

- 静态资源与 API 同源：`internal/gui/api.go:805`
- `GET /api/state`（`api.go:852`）是页面唯一的状态通道，每次写回带新 state
- `POST /api/set`（`api.go:871`）+ 60+ 条 `POST /api/settings/…`，每项设置一条
- 脚本按**内容 hash** 命名（`?v=`），避免缓存把旧 `app.js` 配新页面
- 图表是**手搓 SVG**（`assets/app.js:221` `svg()`），无图表库
- `magpie.call(view, "render", …)` **不是 Go IPC**，是 `assets/kernel.js` 的插件页内调用总线
- `-tags nogui` → `hasGUI` false，改跑 TUI（`internal/cli/gui_off.go`）

**会话身份（Session Aggregation）**：

身份 = `AgentOf(record.Agent) + record.Session`。
session id 来自客户端头 `X-Magpie-Session`，或 agent 原生头
（WorkBuddy/CodeBuddy 的 `X-Conversation-ID`、DSH 的 `x-deepseek-harness-session-id`）。

**铁律：magpie 从不为没有 session id 的请求编造 id** ——
那种请求的文本根本不记录。提示词文本、调用方 key、网络地址**绝不用于猜测会话归属**。

两条腿：
- **文件原生会话**：读各 agent 自己的会话文件（Claude Code JSONL、Codex rollouts…），
  `internal/sessions/calls.go` + 每 agent 一个 `calls_<agent>.go`
- **网关投影**：从 usage ledger 算的**只读投影，不持久化**

同 id 时**原生会话优先**，网关投影被省略（`sessions.NativeIDs` / `Deletable`）。
删除是**移入回收站**而非抹除（`sessions/manage.go:258` `TrashDir()`）。

> 注意：**配额耗尽自动切账号不在会话层，在网关 routing 层**。会话只是身份与聚合的边界。

**用量统计 —— magpie 自己都不用 SQLite**：

`internal/sqlitedb/sqlitedb.go` 只是个**垫片**（修 modernc sqlite 的 libc `getenv` 崩溃，#2327）。
真用 SQLite 的只有 3 处，且都是**读别人 app 的会话库**。

真账本是 **JSONL 追加日志** `usage.jsonl`（`internal/usage/usage.go:217,227,266`）。
`usage.Record` 字段（照抄 json tag）：

```go
t, agent, provider, host, providerKeyId, providerKeyName, providerAccount,
callerKeyId, callerKeyName, session_provider, session_account, session_official_login,
model, req, served, upstream,
in, out, cache_read, cache_write, cache_write_1h, reasoning, effort,
tier_asked, tier_sent, tier_served, status, error, tries, ms, ttft_ms,
source, kind, rejected, handed_on
```

**三个设计值得抄**：
- `req`（agent 问的）vs `served`（vendor 说答的）
- `tier_asked` / `tier_sent` / `tier_served` —— **`tier_served` 只从回复取，不从请求猜**
- `handed_on` —— 失败但已转交下一候选的 try 仍写自己的记录（记它计费了什么、为什么失败），
  但**不计入失败数**

**双源账本**：网关写的 `Record` + 从 agent 会话文件读的 `sessions.Call`
（`Source = "log"` 表示「网关没看见的调用」），`ledgerWith` 合并二者。

**Library**（`internal/library`）：管 instructions / MCP servers / skills / hooks / subagents / RTK
的统一库，写进每个 agent 自己的文件、**只撤自己写的**（`Applied` 记录）。
所有变更走 `change` 锁：加锁→加载→应用一个编辑→保存→同步所有 agent→再保存。

**同步备份**：`internal/backup` 打**口令密封（passphrase-sealed）bundle**，
`internal/davsync` 放 WebDAV / S3 / GitHub。**是合并不是克隆**，分 providers / settings / profiles /
agents / library 五段，各带开关。远端用 ETag（WebDAV/S3）或 blob SHA（GitHub）。

最值得抄的一条：**`Settings.KeepOwn` + `hashes`** —— 每台机器专属的值永远不推送
（窗口大小/最大化、字体、代理、网关端口、LAN 共享、AllowIPs、私有主机、账号发现、
何时读配额、菜单栏显示什么…）。秘密只在本地，不进 status 响应。

**插件运行时：两个 JS 运行时**

| 插件类型 | 运行时 | 隔离 |
|---|---|---|
| Provider 插件（OpenCode 形态） | **Bun 子进程**（`internal/plugin/bun.go`，Bun 1.4.2，自下载并校验 sha256） | 进程边界 |
| 网关中间件（每请求/每流事件） | **moejs**（Go 写的 JS 引擎，`internal/jsmod`） | 进程内 |
| 窗口插件页 | `assets/kernel.js` 插槽制 | 页面级 error boundary |

Go ↔ Bun 是 **stdin/stdout 的 JSON-lines 协议**（`internal/plugin/host.go:44`）：

```go
type message struct {
  ID int64 `json:"id"`; Result json.RawMessage `json:"result"`
  Error *struct{ Message string `json:"message"` } `json:"error"`
  Event string `json:"event"`; Status int `json:"status"`
  Headers map[string]string `json:"headers"`; Data string `json:"data"`
  Provider string `json:"provider"`; Account string `json:"account"`
  Said string `json:"said"`; Level string `json:"level"`
}
```

中间件限 250ms/请求钩子、50ms/事件钩子、1s 加载，**失败开放**
（抛出即原样放行，计数并限 60 行/分钟日志）。

**插件配置四层合成**（`Compose`）：① default（全开）② preset（Essentials 关掉非 Essential）
③ user（`plugins.yml` 行）④ **in use**（`InUse > 0` 强制开，`InUse` 报错也算在用）。
边界由 `TestPluginsImportOnlyCore` 守着：插件之间不互相 import，只能经 service 通信。

`assets/kernel.js` 提供 `ctx.ui.form`（用 Go 侧 `pluginrt.SchemaOf(Settings)` 生成的 JSON Schema
画设置表单）、`ctx.slots.add(slot, part)`、`ctx.broke()`（页面出错显示 Try again，别的页照走）。

**bai-router 现状**：
- **无 session 身份概念**（已核实：全仓无 `X-Conversation-ID` 处理，网关不识别会话头；
  `sessionId` 的命中是 WorkBuddy 侧车 RPC 的另一回事）。WB 池用「首条 user 消息 sha256」
  在本地合成会话 key，但只在 WorkBuddy 一个供应商内有效
- 面板只有 `relayLast`（每 provider 一条「最后一次中转」快照），且**成功后不刷新**
  （HANDOFF 已记录），不是账本
- 无用量统计、无同步/备份（换机要手搬 `%APPDATA%\bai-router`）
- 面板六页共用 `panel-common.js` 2445 行，加页面必须改核心

---

## 4. bai-router 已验证的真实缺口（按严重度）

| # | 缺口 | 位置 | 后果 |
|---|---|---|---|
| **A** | 读 `settings.json` 失败 → 当空 → 写回，**抹掉用户全部配置** | `server.mjs:6489`（旧） | ✅ **已修**：读不懂 → 另存备份 + 中止接线 + 一个字都不改 |
| **B** | 每次切模型 `JSON.stringify` 全量重写 `settings.json` | `server.mjs:6541`（旧） | ✅ **已修**：保格式字节 splice，且只在真变了才写盘 |
| **C** | 通用故障转移只看状态码，429 一律同一种 | `failover.mjs:149-153` `shouldFailover(status)` | 额度耗尽与瞬时限流混为一谈；且 403/401 无论原因都转移 |
| **D** | 通用冷却只有 2 档（90s / 30min），无退避 | `failover.mjs:19,27` | 反复失败每次都只等 90s |
| **E** | 冷却粒度只到 provider，不到账号/模型 | `failover.mjs:29` `Map<provider, ...>` | 一个模型额度用尽 → 整个渠道被踢出 |
| **F** | 无路由策略概念，链序固定 | `server.mjs:5375-5378` | Zen 额度第 5 分钟恢复了也得等满 30 分钟 |
| **G** | 协议桥单向、单上游协议 | `server.mjs:3655` 起 | 接 Gemini / Responses 要再写一遍 |
| **H** | thinking 块签名直接丢弃 | `server.mjs:3580` | 遇会校验签名的上游会 400 |
| **I** | 无并发/RPM 限流 | — | 单账号被打爆，无排队无 429 保护 |
| **J** | 冷却纯内存，重启即失 | `failover.mjs:29` | 重启后立刻重撞已知坏渠道 |
| **K** | 凭据无指纹、无「等刷新回来」保证 | `wb-token.mjs` | 刷新中途取消 → 只剩用过的 refresh token |
| **L** | 从客户端抠 token（钩子/补丁）而非读文件 | `cards/token-capture.js`、`qoder-patch.mjs` | 客户端一升级就失效 |
| **M** | **无会话身份概念**（已核实：全仓无 `X-Conversation-ID` 处理，网关不识别会话头） | 全仓 | 无法按会话聚合、无法做网关级亲和、无法归因用量 |
| **N** | 无用量账本，只有 `relayLast` 单条快照且成功后不刷新 | `server.mjs:6353` 等 | 面板只能看最后一条，看不了历史/趋势/成本 |
| **O** | 无配置同步/备份 | — | 换机要手搬 `%APPDATA%\bai-router` |
| **P** | 出厂种子 `config.defaults.json` 可能覆盖用户改过的值 | `config.defaults.json` | 与 magpie「magpie 的默认值永不覆盖用户设的值」直接冲突 |

---

## 5. 复刻清单（分批，按「性价比」排序）

### 第 1 批 —— 立刻可做，低风险高回报（1–2 天）

| 项 | 做什么 | magpie 出处 | bai-router 动哪里 |
|---|---|---|---|
| 1.1 | **写 settings.json 改成保格式** | `internal/edit/json.go` `SetJSON(path, kvs...)` | 新建 `src/server/edit/json.mjs`；`applyToCli`（`server.mjs:6212`）改用它 |
| 1.2 | **读失败不再当空** | `docs/code-standards.md` 「failed read means unknown」 | `applyToCli` 的 `catch { s = {} }` 改为「读不了就中止接线并报错，不写」 |
| 1.3 | **写前备份** | `internal/lastgood/` `.bak` / `.bad-<time>` | 新建 `src/server/lastgood.mjs`；至少 `settings.json` 写前留 `.bak` |
| 1.4 | **保留 BOM / CRLF** | `internal/edit/json.go` `keepBOM`/`keepCRLF` | 同 1.1 的模块 |
| 1.5 | **符号链接安全写** | `internal/edit/file.go` `Target()` | `writeAtomic`（`server.mjs:612`）加 `realpath` + `nlink` 判断 |

> 1.1–1.5 一起做，是一次「用户体感提升最大」的改动：
> 用户改 `settings.json` 加的注释不再消失，配置也不再被误抹。

### 第 2 批 —— 把 `wb-pool.mjs` 抬到共享层（3–5 天，**最高价值**）

| 项 | 做什么 | magpie 出处 | bai-router 动哪里 |
|---|---|---|---|
| 2.1 | **抽出通用 `classifyFailure(status, body, headers)`** | `gateway/routing.go:350` `failure()` | 新建 `src/server/failure-classifier.mjs`；直接搬 `wb-pool.mjs:386-468` 的五类分类 + 中文正则 |
| 2.2 | **冷却按账号+模型两维** | `restKey` / `restID`（`gateway/routing.go`） | `failover.mjs` 的 Map key 从 `provider` 改成 `provider@account` 和 `provider@account/model` |
| 2.3 | **退避公式** | `gateway/routing.go:930` `d = min(1m << min(n-1,10), 10m)` | `failoverState` 加 `failures` 计数 |
| 2.4 | **完整冷却表** | `gateway/routing.go:154-186` | 替换 `failover.mjs:19,27` 的两档 |
| 2.5 | **冷却持久化** | `quotas.json` / `affinity.json` 落盘 | 冷却并进 `config.json` |
| 2.6 | **`probeOne` 探活** | `fallback.go:865` —— 冷却中的候选只探**最先恢复**的那个 | `attemptWithFailover`（`server.mjs:5369`）跳过冷却渠道时，先探最近恢复的那个（`zen-probe.mjs` 已有 `isProbe`） |

### 第 3 批 —— 路由策略与配额感知（1–2 周，**工作量最大但价值最高**）

| 项 | 做什么 | magpie 出处 |
|---|---|---|
| 3.1 | `routes.Seat` / `routes.Strategy` 两件套 + 策略注册表 | `internal/routes/routes.go:21,52` |
| 3.2 | 7 种策略（smart/order/rotate/usage/pace/weight/free） | `internal/routes/strategies.go` |
| 3.3 | 每渠道「剩余额度 + 重置时间」探测 | `provider/subscription_usage.go` + `provider/routing.go:484` `Allowances` |
| 3.4 | **链序按配额动态排**（替代固定链序） | `smart` 策略：选配额窗口最早续期的账号 |
| 3.5 | 从响应里学配额（`rate_limit_event` → `Learns`） | `provider/routing.go` |

### 第 4 批 —— 协议层（2–3 周）

| 项 | 做什么 | magpie 出处 |
|---|---|---|
| 4.1 | **IR + 四×四矩阵**（`ir.mjs` + `parse/build/decode/encode`） | `internal/gateway/ir.go` + `gateway.go:6054-6251` |
| 4.2 | 统一错误映射（413→`request_too_large`、上下文超长→`400 context_length_exceeded`） | `gateway.go:6912` `writeErrorSaid` |
| 4.3 | thinking 签名原样回传（`Part.Signature`） | `internal/gateway/ir.go` |
| 4.4 | 工具调用配对完整性（`pairToolMessages`） | `internal/gateway/chat.go:562` |
| 4.5 | keepalive 注释保活（**注释后不加空行**） | `internal/gateway/sse.go:109` |
| 4.6 | 死循环熔断（`loopGuard`） | `internal/gateway/loop_guard.go` |

### 第 5 批 —— 面板与数据（1–2 周，**面板价值提升最快**）

| 项 | 做什么 | magpie 出处 | bai-router 动哪里 |
|---|---|---|---|
| 5.1 | **`usage.jsonl` 追加账本** + `Record` 三段式字段 | `internal/usage/usage.go:26` | 新建 `src/server/usage-ledger.mjs`；`server.mjs` 写账本；`panel-common.js` 读 |
| 5.2 | `req` vs `served`（问的 vs 答的） | 同上 | 同 5.1 |
| 5.3 | `tier_asked`/`tier_sent`/`tier_served`（**served 只从回复取**） | 同上 | 同 5.1 |
| 5.4 | `handed_on`（失败但已转交的 try 也写记录，不计失败数） | `internal/usage/usage.go:26` | 同 5.1 |
| 5.5 | `cache_read`/`cache_write`/`cache_write_1h` 分开记 | 同上 | 同 5.1 |
| 5.6 | 双源账本（网关 Record + agent 会话文件读出的 `sessions.Call`，`Source="log"`） | `internal/sessions/calls.go` | 同 5.1 |
| 5.7 | **会话身份** = `AgentOf + Session`，头 `X-Magpie-Session` 优先、agent 原生头兜底；**无 id 不编造** | `internal/gateway/sessionHeaders` | `server.mjs` + `failover.mjs` |
| 5.8 | 面板插件插槽制（`kernel.js` 的 `ctx.slots.add` + `ctx.broke()` error boundary） | `internal/gui/assets/kernel.js` | `panel-common.js` |
| 5.9 | `/api/usage/heatmap`、`/api/sessions/overview`、`/api/sessions/trash` 的 API 形状 | `internal/gui/usage.go:100-180` | `server.mjs` |

### 第 6 批 —— 长期（可选）

- 网关级会话亲和（把 WB 池的粘性抽到通用层）
- 并发/RPM 限流通道（`lanes.take` / `rpms.wait`）
- 脱敏台账（`maskrec`）与出站脱敏（`redact`）
- 插件体系（`pluginrt` 的 `Requires/Provides/OnDispose` 三件套）
- 配置同步备份（WebDAV / S3 / GitHub）+ `Settings.KeepOwn` 本机专属字段清单
- **四层配置合成**（default → preset → user → in use）—— 直接堵住 bai-router 已经踩过的
  `noProxyList` 两处不同步→重启死循环那类事故

---

## 6. 不该照抄的

| magpie 的做法 | 为什么不抄 |
|---|---|
| 密钥明文存 `providers.json` / `caller-keys.json`（只靠 0o600） | Windows 上应该用 **DPAPI**（`CryptProtectData`, CurrentUser）。magpie 没用不是因为这样更好，是没做 |
| 外部插件给 `Bun.$`（任意 shell）+ `client.auth.set`（写凭据）+ `onRequest/onResponse`（全量改写流量） | 「进程隔离」不是沙箱，是**完全可信代码**。要开放扩展必须比这严：收掉凭据写权限、限制可执行命令，或只允许声明式中间件 |
| 从运行中的客户端抠 token（钩子/字节码补丁） | magpie 走「读文件 + 读钥匙串」，稳定得多也更好向用户解释。客户端一升级钩子就失效，且等于在用户机器上做进程注入。**bai-router 现有做法方向相反，别继续加码** |
| 内置插件无隔离（同进程 Go 代码） | bai-router 是 Node，同进程插件等于给了 `require('fs')` |
| 协议翻译用手写 IR 而非现成 SDK | 抄 IR 结构即可，别抄 Go 的实现 |
| `moejs`（Go 写的 JS 引擎）/ `netproxy` 代理层 / `fastjson` 的 unsafe 手写解析 | Go 生态特有的解法。Node 侧对应物是 `undici` 的 proxy agent、`JSON.parse` reviver、`node:worker_threads` |
| **Wails v3 → 换 Electron** | bai-router 已是 Electron。Wails 的价值在「Go 单二进制无 JS 运行时」，对 Electron 项目无意义，换壳纯亏 |
| **自下载 Bun + sha256 校验 + 9 个平台包**（插件宿主） | 纯运维负担。Node 生态用 `node:worker_threads` 或 `child_process` 即可 |
| **SQLite** | magpie 自己都不用（只用来读别人 app 的库），账本是 JSONL |
| **`SchemaOf` 自动生成设置表单** | bai-router 面板是手写表单，引入 schema 生成器要重写整个面板，收益不抵成本 |
| 插件市场 / 伙伴位 / 社区 plugin 生态 | 那是生态规模，不是工程能力 |

---

## 7. 方法论迁移（`LESSONS.md` + `docs/code-standards.md`）

magpie 的 `LESSONS.md` 是连续 809 行的每日复盘，`docs/code-standards.md` 是从「三天以上反复出现」提炼的硬规则。
**下面几条和 bai-router 直接相关，且都已在 bai-router 身上找到对应病症**：

| 规则 | magpie 的证据 | bai-router 的对应 |
|---|---|---|
| **A failed read, parse or hash means "unknown". It never means "empty".** | `readLogins` 把解析错误写回成「无账号」(b363327d)；`agent/stash.go` 两天后犯同样的错 (270b5257) | ★ 缺口 A：`applyToCli` 的 `catch { s = {} }` |
| **A fix reaches every sibling of the bug** | 2026-10-05 有 6 个修复因为只覆盖了报告里的那一个case，需要二次发版 | bai-router 加 provider 时的 `noProxyList` 两处同步坑（`HANDOFF.md` 历史事故 #1）——**同一个病** |
| **A test named for a guarantee fails without it**（把旧代码放回去，测试必须红） | bbe8825c0 / e21b1dbc1 的测试在旧代码上也是绿的 | bai-router 的 C11 正则闸门「必须用负样本测」已是同一实践 |
| **A change re-derives everything built on what it changes** | 12cba74a 改了 max_tokens 却留着旧的 clamp | 改 `failover.mjs` 冷却语义要同时改 `server.mjs:5215/5263/5433` 三处 `quota:true` 调用点 |
| **Never let magpie's default override a value the user set** | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 覆盖了用户自己的 `autoCompactWindow` 约 150 个版本 | ★ 缺口 B：bai-router 写 `settings.json` 会覆盖用户自己加的字段 |
| **Another app's values come from that app**（读上游源码/文档，别猜） | `84554e57` 写了毫秒时间戳，挂掉 Claude Desktop 的 skills 页 | `qoder-patch.mjs` 靠字节级补丁逆向客户端 —— 客户端升级即失效 |
| **A test that fails on `main` is a bug to fix now** | 「和 main 一样失败」不是基线 | bai-router `HANDOFF.md`「报故障前先重测」已是同一纪律 |
| **Text magpie adds to a prompt that goes to a vendor names neither magpie nor the vendor's limits** | `5d33f060b` 往 `spawn_agent` 描述里加了 "magpie serves these too" | bai-router 若加模型目录注入，注意别把品牌词送进上游 prompt |

magpie 还有一条**发布纪律**值得抄：

> **A tag is not a release.** v0.1.1192/1193 tagged one commit; v0.1.1213 and v0.1.1218 never published (#1846).
> **A rerun's green hides the first try.** a1f7b8c13's run is green on attempt 2, its attempt 1 red (#2390).
> Read `attempt` before calling a run green.

对应 bai-router `HANDOFF.md` 第四节的「四个已知风险」——`dist/win-unpacked` 是旧产物时
`verify-artifact` 是**假绿灯**，这条已经踩过。

---

## 8. 源码索引（`G:\tmp\magpie-study`）

| 主题 | 文件 |
|---|---|
| **★ 保格式配置编辑器** | `internal/edit/json.go` `SetJSON` / `PatchJSON`；`internal/edit/file.go` `WriteAtomic` / `Target` |
| 统一 IR | `internal/gateway/ir.go` |
| 四×四协议矩阵 | `internal/gateway/gateway.go:6054-6251`（四个调度 switch） |
| 协议实现 | `internal/gateway/{anthropic,chat,responses,gemini}.go` |
| 故障转移核心 | `internal/gateway/fallback.go`（`holdWriter:1568`）；`internal/gateway/routing.go:350` `failure()` |
| 路由策略 | `internal/routes/routes.go`、`strategies.go`、`round.go` |
| 错误映射 | `internal/gateway/gateway.go:6912` `writeErrorSaid` |
| 传输层 | `internal/gateway/upstream_transport.go` |
| 脱敏 | `internal/redact/`、`internal/masking/`、`internal/maskrec/`、`internal/pii/` |
| Agent 接入 | `internal/agent/agent.go`（`Agent`/`Field`/`Option`）、`claude.go`、`codex.go`、`applied.go`、`stash.go` |
| 账号与凭据 | `internal/provider/account.go`、`codex_store.go`、`logins.go`、`discovery.go` |
| 插件 | `internal/pluginrt/pluginrt.go`（内置）、`internal/plugin/host.go`（外部/Bun） |
| 设计文档（**最高性价比入口**） | `docs/subsystems/` 共 14 份，`gateway-routing.md` 789 行是路由契约 |
| 工程纪律 | `LESSONS.md`（809 行）、`docs/code-standards.md`（224 行）、`AGENTS.md` |

---

## 9. 下一步建议

1. **先做第 1 批**（settings.json 保格式 + 读失败不当空 + 写前备份）——
   改动小、风险低、用户体感最强，且修掉的是**数据丢失级**问题。
2. **再做第 2 批**（把 `wb-pool.mjs` 的 `classifyFailure` 抽成共享模块，
   `failover.mjs` 改成按「账号+模型」两维冷却 + 退避 + 探活）——
   这是把 bai-router 已有的好代码用对地方，不是引入新概念。
3. **第 5 批前半（usage.jsonl 账本 + 会话身份）**可以与第 2 批并行 ——
   它不碰故障转移路径，风险独立，且立刻改变面板的信息量。
4. **第 3 批（配额感知的动态链序）是 magpie 真正的护城河**，
   但需要先有第 2 批的候选抽象，值得单独开一份契约文档。
5. 协议层（第 4 批）等上面稳定后再动 —— 那是 `server.mjs` 里最大的一块，
   现在它虽然大，但**跑得稳**，动它风险最高。

### 本轮研究的边界

已读完：magpie 的 `LESSONS.md`（809 行）、`docs/code-standards.md`（224 行）、`AGENTS.md`、
`docs/subsystems/` 下的 `gateway-routing.md`（789 行）、`agent-wiring.md`（173 行）、
`gateway-middleware.md`（69 行）、`providers-accounts.md`（280 行），
以及 `internal/gateway/{ir,anthropic,chat,responses,gemini,fallback,routing,upstream_transport}.go`、
`internal/routes/`、`internal/edit/`、`internal/pluginrt/`、`internal/usage/` 的核心文件。

未读完：`internal/gateway/` 剩余约 800 文件、`internal/provider/` 剩余约 600 文件、
`internal/agent/` 剩余约 350 文件、`internal/gui/` 全部 357 文件、
`internal/sessions/`、`internal/backup/`、`internal/davsync/` 源码。

下一步若要继续深挖，**优先读 `docs/subsystems/` 剩下那 10 份**
（`gateway-sessions.md` / `gui-shell.md` / `plugin-runtime.md` / `sync-backup.md` /
`library.md` / `plugin-tools.md` / `gateway-request-hooks.md` / `claude-subscription-bridge.md` /
`provider-plugins.md`）—— 那是作者自己写的架构真相来源，比漫无目的地读 10 万行代码高效得多。
