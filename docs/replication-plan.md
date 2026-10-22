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
| T11 | **插件体系**（声明式 provider/agent/middleware） | 🟡 provider 插件 ✅、middleware ✅（`middleware.mjs`，声明式改写）；**代码插件运行时**（`pluginrt.mjs`，子进程 + 权限模型 + 超时封顶）已接线，待子进程与用例交付 | `internal/pluginrt/`、`internal/plugin/` |
| T12 | **并发 / RPM 限流通道** | ✅ 完成（`concurrency.mjs` + `rpm.mjs`，**默认不限**，面板可开） | `internal/gateway/{concurrency,rpm}.go` |
| T13 | **配置同步备份**（WebDAV/S3/GitHub）+ KeepOwn | ✅ 完成（本地目录 / WebDAV / GitHub 三种目标都已接进真实链路，口令加密、不静默覆盖） | `internal/backup/`、`internal/davsync/` |
| T14 | **面板改版**（插槽制 + 多页） | 🟡 P0–P2 ✅（额度屏 / 状态计算层 / 共享组件库 / 热力图 / 状态条）；**P3 渠道主从**在做 | `internal/gui/assets/kernel.js` |

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
