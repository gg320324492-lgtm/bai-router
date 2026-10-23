# 客户端接线 · 深度定制规划（模型元数据下发 + 保留用户手改过的值）

> 日期：2026-10-23　　状态：**设计稿**（本轮不改任何实现代码）
> 前提：客户端接线先做**薄适配器**（够用就行），深度定制列为后续规划 —— 本文是那份规划的落地设计。
> magpie 源码只读克隆在 `G:\tmp\magpie-study`；本文引的 `internal/…` 行号均指那份克隆。

---

## 〇、这一层要解决的两件事

| # | 缺口 | 一句话 |
| --- | --- | --- |
| ① | **模型元数据下发** | 我们写进客户端模型表的**只有 id 与名字**；magpie 还写**上下文窗口、输出上限、思考档位、模态、是否支持工具调用** |
| ② | **保留用户手改过的值** | 我们是**按键路径替换**；magpie 会**保留用户在模型条目里手改过的字段**（名字、思考档、窗口） |

两件事其实是同一件事的两面：**一旦我们开始写更多字段，就会开始覆盖用户在同一个条目里改过的东西** ——
所以 ① 的方案必须和 ② 的策略一起定，不能分开做。

---

## 一、现状与差距

### 1.1 我们现在写了什么

| 位置 | 事实 |
| --- | --- |
| `src/server/server.mjs`（`clientCtx`） | `models: gatewayModelEntries(c).map((e) => ({ id: e.id, label: e.displayName }))` —— **只有 id 与名字** |
| `src/server/clients/workbuddy.mjs:70-76` | 条目写 `supportsToolCall: true`、**`supportsImages: false`、`supportsReasoning: false`**，注释说「我们不知道这个档位支不支持 —— 说明『不支持』，宁可少给能力」 |
| `src/server/clients/workbuddy.mjs:101-117`（`buddyWrites`） | 模型清单写成 `[...kept, ...ours]`：`kept` = 用户**别的**条目（`vendor` 不是我们的 id）；**我们自己那一条整体替换** |
| `src/server/clients/base.mjs:202-341`（`applyClient`） | **按键路径替换**（`fmt.setPath`）：只动我们点名的那些键路径，块里我们没写到的键**原样不动** |
| `src/server/clients/base.mjs:285-307` / `:346-352`、`:373-379` | 备份记**每个键路径的原值 + 父路径原值**；`revertClient` 按备份逐条写回（原来有→写回，原来没有→删掉） |
| `src/server/clients/muse-models.mjs`（新） | Muse 的 `limit` 用的是 **magpie 的兜底值** 128000 / 32000，注释写明「**兜底，不是真实上限**」 |

⚠ **口径更正一**：任务书里说「我们是整块替换 provider 块」。准确说法是**按键路径替换** ——
块里我们没点名的键是保住的。真正丢的是**我们写的那一根键路径内部的内容**：
`models` 这条路径上的整份清单被换成我们的 ⇒ **用户在我们自己那条模型条目里手改过的字段，全丢**。

⚠ **口径更正二**：我们今天写 `supportsImages:false` / `supportsReasoning:false`，
**那不是「不支持」，是「不知道」**。客户端读到 false 就会**不给你这个能力**（不显示图片按钮、不给思考选项），
而真相是我们压根没查。这是**当前唯一一处「说谎」**，也是阶段 0 要先修的。

### 1.2 magpie 写了什么、数据从哪来

**写进客户端的形状**（`internal/agent/workbuddy.go:313-341` 的 `buddyModel`）：

```
maxInputTokens(=context)   context==0 时兜底 200000
maxOutputTokens            仅当 output>0 才写
supportsToolCall: true     supportsImages(=images)     supportsReasoning
reasoning: { supportedEfforts, canDisableThinking, defaultEffort }   有档位才写
vendor: magpieID
```

别的客户端各有一套键名（**每客户端一套**，这是 magpie 的成本）：
OpenCode 的 `variants`（`internal/agent/agents.go:384`）、Pi 的 `thinkingLevelMap`（同文件 `:551`）、
Alma 的 `capabilityOverrides`（`internal/agent/alma.go:275-300`：
`{reasoning, reasoningLevels, vision, contextWindow, maxOutputTokens}`）、
Muse 的 `limit`（`internal/agent/muse.go:42-48`，兜底 128000/32000）。

**数据来源**：

| 来源 | 出处 | 事实 |
| --- | --- | --- |
| **models.dev** | `internal/catalog/catalog.go:433` | `modelsDevURL = "https://models.dev/api.json"`；拉取在 `:646-694`（GET、UA=magpie、**限 64MB**；非 200 或解析失败 ⇒ **报错且不动旧缓存**；成功后写 `CachePath()` 并 `Reset()`+`Touched()`，注释说「names, reasoning levels and context windows may be others」） |
| models.dev 的新鲜度 | `internal/catalog/fresh.go:17-26` | `staleAfter = 24h`（缓存多旧才重拉）、`missingAfter = 6h`（某个模型没价格时多久再试）、`freshEvery = 1h`（`KeepFresh` 每小时看一眼） |
| models.dev 给什么 | `internal/catalog/canonical_test.go:14` 起（抓下来的 api.json 原文） | 每个模型带 `limit{context,output}`、`reasoning` + `reasoning_options[{type:"effort",values:[…]}]`、`attachment`、`tool_call`、`modalities`、`canonical_model_id` |
| magpie 的目录结构 | `internal/catalog/catalog.go:27-67`（`Model`） | `Efforts` / `Images` / `InputModalities` / `OutputModalities` / `Context` / `MaxContext` / `Output`；`Window(n)`（`:425-431`）把**小于 `LeastWindow` 的当作 0 = 不知道** |
| **渠道自己的 /v1/models** | `internal/catalog/live.go:668-690` | 有些厂商的清单带 `context_length` / `max_output_tokens` / `supported_reasoning_levels`（OpenRouter、Command Code），**不是所有都带** |

### 1.3 magpie 怎么保留用户手改过的值

三套机制，用途不同：

| 机制 | 出处 | 做什么 |
| --- | --- | --- |
| `theirsKept` / `mergeTheirs` | `internal/agent/sync.go:92-130` | **我们没写的键保留用户的**；两边都是对象的**递归合并**；`whole` 里点名的键用我们的（整块用我们的） |
| `mergeKept` | `internal/agent/sync.go:222-250` | 同上 + `own`（网关自己的 key 槽）里用户填的**真 key**保留（`keyHolds`） |
| `openCodeKept` | `internal/agent/agents.go:459-493` | **逐个 variant 比对**：与我们**现在**会写的那个 variant **逐字相同**的跳过（那是我们自己写的），**不同的**就是用户改过的 ⇒ **用户的版本赢**；用户新增的 variant 也留着 |
| `keptEffort` | `internal/agent/workbuddy.go:347-352` | 用户设的思考档**只要模型还提供**就留着，否则用我们的默认；「magpie's default never overrides the user's own」 |

**关键的机制细节**：magpie **不记录「上次写了什么」**来分辨用户改没改 ——
它把**用户文件里的现值**读回来，和**它现在会写的值**比（`sameJSON`）：

- 相同 ⇒ 那是我们上次写的（或者用户写成了同一个值）⇒ 不用动；
- 不同 ⇒ 用户改过 ⇒ 用户的赢。

（`theirsKept`/`mergeKept` 那一层是「我们没写的键根本不看」，属于**弱版本**；
`openCodeKept` 才是**逐值比对**的强版本。）

模型清单整体的处置见 `internal/agent/workbuddy.go:207-238`：magpie 的条目从文件里挑出来**重建**，
**别人的条目原样保留**，magpie 的条目**插回原来的位置**（`:281` 的 `slices.Concat(kept[:at], add, kept[at:])`）；
magpie 不再有的模型被拿掉。

「断开时原样还原」是 magpie 的**硬判据**：
`internal/agent/agent.go:150-162` 的 `Unwire`（把 stash 里的端点/provider/模型放回去）与
`Restore`（首次写之前把文件复制一份，断开时若状态一致就**整份还原**）。

---

## 二、推荐的方案

### 2.1 ① 模型元数据的数据来源

**推荐：内置表为主 + 渠道自己的目录接口为辅；models.dev 不进关键路径（只作可选的后台补充）。**

理由（按分量排序）：

1. **我们的模型 id 不是厂商的模型 id。** 我们的是**档位**（`claude-opus-5`），
   models.dev 的是 `deepseek/deepseek-v4.1-flash` 这种**带别名与 `canonical_model_id`** 的
   （`internal/catalog/canonical_test.go:8-16` 抓下来的原文可见）——
   magpie 为此专门写了一层归一（`internal/catalog/catalog.go:795` 的 `canonicallyPriced`）。
   我们只有 **8 家 × 4 档 ≈ 三十来条**（`gatewayModelEntries` 的规模），人工核对一张表更便宜也更准；
   而**映射错了会写错窗口** —— 那比不写更坏（用户以为模型只能吃 128K）。
2. **离我们最近的真源，我们已经在读了**：WorkBuddy 的 `/v3/config` 与 Qoder 的 `qoder-models.json`
   都带 `max_input_tokens`（实测，见 `docs/qd-quota-measured.md` 那一轮的实测记录）。
   那是**渠道自己说的**，零新增网络依赖 —— 比任何第三方目录都近。
3. **③（问上游）只能当补充，不能当主源**：magpie 的 `internal/catalog/live.go:668-690` 说明
   **有些**厂商的 /v1/models 带 `context_length`/`max_output_tokens`/`supported_reasoning_levels`，
   **不是所有都带**；我们八家里能问到的只有那两家目录接口。
4. **离线可用**：接线常常发生在网络不通的时候（内网、墙）。models.dev 是公网；
   magpie 为此写了一整套新鲜度管理（24h 缓存、拉不到就不动旧缓存），
   而那套机制在我们的规模上是**纯负担**。

**「怎么标过期了」**：

- 表里**每条带日期戳**（「记于 2026-10-23」），面板上写明来源与日期；
- 渠道目录能说真话时**以渠道为准**，并顺手刷新表里的那条与日期戳；
- 两边都拿不到 ⇒ 写**兜底值并明确标「未知」**（照 magpie 的两处先例：
  `internal/agent/muse.go:42-48` 的 128000/32000、`internal/agent/workbuddy.go:315-317` 的 context=0 → 200000），
  **兜底值必须带来源标注** —— 我们在 `clients/muse-models.mjs` 里已经这么做了（注释 + `source` 字段），
  别的客户端照它办；
- **绝不把兜底当真值**：`internal/catalog/catalog.go:425-431` 的 `Window(n)`（小于 `LeastWindow` 当 0 = 不知道）
  就是这条纪律在 magpie 那边的写法。

**代价**：表要人维护；渠道目录的字段名各家不同，要逐个适配；
上游改窗口时表会过时 ⇒ 由「渠道目录优先 + 日期戳可见」兜住。

### 2.2 ② 保留用户手改过的值

**推荐：逐值比对（magpie 的 `openCodeKept` 做法），不引入「上次写了什么」的新状态。**

**（a）什么算用户手改过**

对我们**每一个要写的字段**做一次比对：

```
我们现在会写的值  vs  文件里的现值
  相同 ⇒ 那是我们写的（或用户写成了同一个）⇒ 不用动
  不同 ⇒ 用户改过  ⇒ 用户的赢
```

- **只对「用户可能手改」的字段做**（模型名、思考档、窗口、上限）；
- **机器该管的字段不参与比对，照写**：`url`、`apiKey`、模型 id、`hasChangedDefaultModel` 这类 ——
  否则用户文件里残留的旧 url 会把我们接回旧网关（magpie 走的是同一条路：
  `internal/agent/sync.go:228-236` 的 `own` 分支）。
- **模型清单整体**照 magpie（`internal/agent/workbuddy.go:206-238`）：我们那几条**重建**，
  **用户的别的条目原样保留**，位置插回原处。

**（b）冲突时怎么办**

**用户赢 + 说一句**，不静默、不弹窗（接线是后台动作，弹窗会打断）：

> 「保留了你手改的窗口 128000（我们记的是 200000，2026-10-23）」

写进 `applyClient` 返回的 `detail` 与面板那一格 —— 用户改的东西被覆盖而没人说，是这类工作最容易
伤用户信任的地方。

**（c）怎么不破坏「断开时原样还原」**

**还原判据一个字都不改**：`base.mjs:285-307` 仍记**写入前**的原值（含父路径），
`base.mjs:373-379` 仍按备份逐条写回。

保留用户改动的逻辑只发生在**「算要写什么」这一步**（写盘之前）：

```
写盘前的现值（可能是用户改过的那个值） ──► 备份（还原用）
写盘前算出的值（比对后可能等于用户的值） ──► 写盘
```

⇒ 用户改过的值**既被保留在文件里，也被记进备份**，断开后原样写回。⚠ 这一处最容易搞坏，
必须有专门的反向测试：**改坏「保留」的判定后，`revert` 仍要还原到用户改过的那个值**
（不是还原到我们的值）。

**（d）已知的代价（第一版接受）**

上游数据变了（窗口 200k→400k）时，逐值比对会把它当成「用户改过」⇒ 保留旧值。
要消掉它就得**记下我们上次写的值**（多一份状态、多一处会过期的东西）。
第一版**不做**：写错窗口（让用户以为只能吃 128K）的后果比窗口过时更糟。
若将来要做，判据是「值的来源日期」—— 我们表里的日期戳正好能当那个依据。

---

## 三、分阶段落地顺序

每阶段都能**独立交付**、独立验证。

| 阶段 | 做什么 | 交付物 | 依赖 |
| --- | --- | --- | --- |
| **0** ✅ **已完成**（2026-10-23） | **把「不知道」与「不支持」分开** | 我们不再写 `supportsImages:false` / `supportsReasoning:false` 这种「其实是不知道」的断言（改成不写这些键，让客户端按自己的默认走）。**零新数据源**，先止住「说谎」 | 无 |
| **1** | **内置表**（窗口 / 上限 / 思考档 / 是否收图），按**最终模型名**归一（档位 → 最终模型名的映射在 `cfg[渠道].mapping` 里，本来就有） | 一张带日期戳的表 + 一个查询函数；先在 **Muse** 上兑现（把 `clients/muse-models.mjs` 现在的 128000/32000 换成表里的值，并保留「兜底」的标注）；面板上标出来源与日期 | 阶段 0 |
| **2** | **保留用户手改**（逐值比对），先落在**有模型清单**的 2~3 个客户端（WorkBuddy、Qwen Code、OpenCode 形状那类） | 写盘前的比对逻辑 + 「我们记的是 X，保留了你改的 Y」那句话；**反向测试钉住还原判据不变** | 阶段 1 |
| **3** | **渠道目录接口作真源**：wb/wbai 的 `/v3/config`、qd 的 `qoder-models.json` 的 `max_input_tokens` | 拉得到就覆盖表里的值并更新日期戳；拉不到就用表里的 | 阶段 1 |
| **4**（可选） | **models.dev 后台补充**：离线、失败**不动旧缓存**、只作参考不作主源 | 一个后台任务 + 一张「models.dev 建议值」的对照表（人工采纳后才进内置表） | 阶段 1 |

**为什么阶段 0 排第一**：它不需要任何数据源，却是当前唯一一处**对用户说谎**的地方 ——
而且它做完之后，后面每个阶段新增的字段都有一个现成的「不知道」的表达方式。

---

## 四、明确不做的

| 不做 | 为什么 |
| --- | --- |
| magpie 那套「每个客户端一套 provider 块 + 目录一变就全量重写」（`internal/agent/sync.go:19-36` 的 `SyncCatalog`） | 我们的清单只有三十来条，全量重写会**踩掉用户自己在清单里加的条目**；我们只在**明确点名的键**上写 |
| 每个客户端一套 reasoning 档位映射（OpenCode 的 `variants` `internal/agent/agents.go:384`、Pi 的 `thinkingLevelMap` `:551`、Alma 的 `capabilityOverrides` `internal/agent/alma.go:275-300`） | 八家三十来条模型，不值得逐个客户端手写映射；第一版只给「支持思考 / 不支持」+ 档位集合 |
| 把 models.dev 拉进**关键路径** | 我们的 id 与它的 id 不同源（§2.1 第 1 条），映射错了比不写更坏；公网依赖在接线场景里常不可用 |
| 展示 models.dev 的**价格** | 我们的价格另有 `pricing.mjs` 一套口径（`config.defaults.json` 的 `availableModels` 与倍率表），不要引入第二份 |
| 把兜底值当**真值**写进客户端而不加标注 | magpie 的两处先例（`internal/agent/muse.go:42-48`、`internal/agent/workbuddy.go:315-317`）都把兜底与真值分开；我们 `clients/muse-models.mjs` 已经带了这个标注，其余照它办 |
| magpie 的 `Unwire`/`Restore` 全套（`internal/agent/agent.go:150-162`） | 我们「按键路径记原值 + 写回」的还原判据（`base.mjs:285-307`、`:373-379`）**更保守**且已经够用；换成整份文件快照会引入「文件被用户改过就别还原」那类分支 |
| 用「记录我们上次写了什么」来分辨用户改没改 | 会引入第二份会过期、且与真文件可能不一致的状态；逐值比对（`openCodeKept` 的做法）够用，代价见 §2.2(d) |

---

## 五、相关

- `docs/qd-quota-measured.md` —— Qoder 额度的实测记录（本轮另一条线的产出；
  其中「Qoder 的 `qoder-models.json` 带 `max_input_tokens`」是 §2.1 第 2 条的依据之一）
- `docs/client-wiring-deep-plan.md` ← 本文
- magpie 源码：`G:\tmp\magpie-study`（只读）
