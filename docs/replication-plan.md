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
| T5 | **协议矩阵补全**：Responses / Gemini + 桥换 IR | 🟡 IR 底座已就位，编解码未做 | `internal/gateway/{responses,gemini}.go` |
| T6 | **会话身份与亲和**（通用层） | ✅ 完成（`session-id.mjs` + `session-store.mjs`，持久化） | `internal/gateway/sessionHeaders` |
| T7 | **用量账本** `usage.jsonl` + 面板 | ✅ 完成（`usage-ledger.mjs` + `usage-writer.mjs` + token 扫描） | `internal/usage/` |
| T8 | **账号发现改读登录态**（替代 hook 注入） | ⬜ 未开始 | `internal/provider/account.go` |
| T9 | **配额探测与配额感知路由** | ⬜ 未开始 | `internal/provider/quotas.go` |
| T10 | **脱敏与审计台账** | ⬜ 未开始 | `internal/redact/`、`internal/maskrec/` |
| T11 | **插件体系**（声明式 provider/agent/middleware） | ⬜ 未开始 | `internal/pluginrt/`、`internal/plugin/` |
| T12 | **并发 / RPM 限流通道** | ⬜ 未开始 | `internal/gateway/{concurrency,rpm}.go` |
| T13 | **配置同步备份**（WebDAV/S3/GitHub）+ KeepOwn | ⬜ 未开始 | `internal/backup/`、`internal/davsync/` |
| T14 | **面板改版**（插槽制 + 多页） | ⬜ 未开始 | `internal/gui/assets/kernel.js` |

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

## 每轮工作的纪律

来自 magpie 的 `LESSONS.md` 与本仓库的既有规矩：

- **一次一个目标**：一个提交只做一件事，冲突面小到能逐行看清
- **每个新模块自带反向对照测试**：把判定改坏，测试必须红
- **读失败 = unknown，绝不是 empty**（`edit-json.mjs` 的硬约束就是这条）
- **闸门 0 error 0 warn + `npm test` 全绿** 才算完成
- **合并上游优先**：本地落后就先合并，冲突面越小越好解
