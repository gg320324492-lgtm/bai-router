# REFACTOR-CONTRACT v13 — OpenRouter 免费兜底区（第 6 个提供方）

> **前置**：必须等 v11（WorkBuddy + Zen 500 文案）完成并复验。
> **这是加第 6 个提供方** —— 架构在 v1.0.48 已清单化，加一家的路径是明确的，但**漏改一处会静默出错**（历史上加第五家时出过五处漂移）。**每一步都要用闸门验证。**

---

## 用户需求（原话要点）

> OpenRouter 上有很多免费模型。再开一个 **OpenRouter 专区**，能读取免费模型，**在免费模型过期时自动更换下一个**，保证一个持续可用的 OpenRouter 免费流水区。做**三个 key 的更换区**（用户不止一个 key）。OpenRouter 是**在没有任何模型可用时的兜底**。

测试 key（用户已给，完整值见对话历史）：`sk-or-v1-…（掩码）`
**安全红线：key 明文绝不写进 `config.defaults.json`（随包种子）、`providers.js`、`../../HANDOFF.md` 或任何会被提交/分发的文件。** 只能进 `%APPDATA%\bai-router\config.json`（本机，已 gitignore）。

---

## 我已实测的调研结论（**地基，别推翻**）

证据全文：`docs/evidence/openrouter-free-tier-2026-10-07.md`

### 1. 存在**两种不同的 429**，必须分流（**这是核心**）

| `limit_source` | 含义 | 换模型有用 | 换 key 有用 |
|---|---|---|---|
| **`openrouter_free_tier_daily`** | **账号级**：免费模型每日 50 次 | ❌ **没用** | ✅ **有用** |
| **`upstream_provider_shared_pool`** | **模型级**：该模型上游池子满 | ✅ **有用** | 通常没用 |

真实响应体（实测）：
```json
{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,
 "metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"1791331200000"},
             "limit_source":"openrouter_free_tier_daily",
             "remedy_hint":"Wait for the daily reset (see X-RateLimit-Reset), or purchase credits..."}}}
```

**所以轮换策略必须是两层**：
1. 遇 `upstream_provider_shared_pool` → **换下一个免费模型**
2. 换遍了都不行 / 或遇 `openrouter_free_tier_daily` → **换下一个 key**

### 2. 免费模型清单

`GET https://openrouter.ai/api/v1/models`（**无需鉴权也可拉，但带 key 更稳**）。
判据：`pricing.prompt == "0" && pricing.completion == "0"`（**实测 20 个**）。

**⚠️ 不能只靠 `:free` 后缀筛** —— 实测 `inclusionai/ling-3.1-flash` **没有后缀但 pricing 全 0**。**必须按 pricing 判。**

### 3. 额度真相接口

`GET https://openrouter.ai/api/v1/auth/key` → 实测返回：
```json
{"is_free_tier":true,
 "free_model_daily_requests":{"used":60,"limit":50,"remaining":0},
 "usage":0.04217109}
```
→ 面板可以**直接显示剩余次数**，比猜好。

### 4. 重置时间

429 的 `metadata.headers["X-RateLimit-Reset"]` 是 **epoch 毫秒**（实测 `1791331200000` = 当天 08:00 UTC+8）。**换 key 要用它判断何时轮回来**（不要写死「第二天」）。

---

## 要做的

### 一、清单层（`providers.js`）—— 加第 6 家

现有清单 key：`bai, sn, wb, zen, qd` → **加 `or`**（或你认为更合适的命名，但**要与 server.mjs、端口表、C1/C7/C9/C10/C12 闸门全部一致**）。

必须补齐（C12 会强制）：`shape / keyMatch / sys / brands / defaultModels / settingsLabels / path / label / …`
**照抄一家现有 openai 类的（推荐 `zen` 或 `qd`）当模板**，逐字段替换。

**`provider.html` 的 52 个契约 id 一个都不能改**（红线）。加新区块时**新增 id**，不动已有的。

### 二、服务端（`server.mjs`）

1. **`makeRelay("or", …, { openai: true })`** —— OpenRouter 是 OpenAI 兼容，走 openai 桥
2. **`listenWithRetry(orRelay, cfg0.or.relayPort, "OpenRouter中转")`** —— 端口建议 **15772**（现有：15722/32/42/52/62 + 面板 15723，**别撞**）
3. **`DEFAULTS.or`**（upstream=`https://openrouter.ai/api/v1`、`relayPort: 15772`、`defaultModel`、`availableModels`、`mapping`、`keys: []`）
4. **`providerConfigured("or", cfg)`** —— 判断依据：`keys` 数组里有可用 key
5. **`relaySpec("or", cfg)`** —— 加进那张 meta 表
6. **`noProxyList` / `computeNoProxy`**：⚠️ **`main.js` 与 `server.mjs` 两处必须同步**（不一致会导致**自重启被看门狗计成崩溃、陷入重启死循环** —— 历史真实事故，见 memory `bai-router-restart-loop.md`）。**这一条必须两处都改，并说明你怎么验证同步了。**

### 三、核心：**两层轮换**（用户的核心诉求）

实现一个 `orNextCandidate(state)` 之类的决策，输入是**当前 429 的 `limit_source`**，输出是**下一个该试的 (key, model)**：

- `upstream_provider_shared_pool` → 换模型（同 key 下一个免费模型）
- `openrouter_free_tier_daily` → 换 key（key 1 → 2 → 3 → 1，带 `X-RateLimit-Reset` 时间戳避免空转）
- 三种 key 全在 `free_tier_daily` 冷却中 → **如实失败**，文案说明「3 个 key 的每日免费额度都用完了，`X-RateLimit-Reset` 是 …」

**集成点**：复用 v10/v12 已建立的**冷却机制**（`failover.mjs` 的 `failoverCooldown(..., {quota:true})` 语义）——**但别改 `failover.mjs` 的导出**（那是别处已复验的），在 `server.mjs` 内维护 OpenRouter 自己的 (key,model) 轮换状态。

**兜底定位**：`config.failover.chain` 里 `or` **排最后**（用户原话「没有任何模型可用时的兜底」）。**改 chain 时注意别把现有 `["qd","bai","sn","zen","wb"]` 弄坏**——只追加 `or`。

### 四、面板（第 6 页）

- `path`：`/or`
- 显示：免费模型列表（**按 pricing 筛**）、当前用的 key 序号、**`free_model_daily_requests` 剩余次数**、`X-RateLimit-Reset` 倒计时
- 三个 key 的输入框（**存到 config.json，绝不回显明文**——照抄 `zen.apiKey` 的 `keyFp` 掩码做法）

---

## 验证要求（硬性）

1. **隔离实例**：`BAI_DATA_DIR=%TEMP%/bvb13` + 端口 17xxx/18xxx，测完 `taskkill //PID <pid> //F`，**清理临时目录**
2. **绝对禁止 `taskkill /IM node.exe`**（正式实例 PID 54032 + 用户 4 个 OpsPilot 进程）
3. **`node scripts/check-manifest.cjs` → 0 error** —— 加第 6 家时 **C1/C4/C7/C9/C10/C12 全会检查**，**必须全绿**（这是本任务最关键的闸门）
4. **两层轮换必须实测**：
   - 构造 `limit_source: "upstream_provider_shared_pool"` 的 429 → 断言它换了**模型**
   - 构造 `limit_source: "openrouter_free_tier_daily"` 的 429 → 断言它换了**key**
   - 用真实 429（当前 key `remaining: 0`，**必然复现**）→ 断言走了换 key / 如实失败
   - **贴真实 JSON/日志**
5. **别泄露 key**：改完 `git diff` 里**不能出现 `sk-or-v1-`**；`config.defaults.json` 必须仍为空/占位（C13 会查）
6. **端口不冲突**：确认 15772 未被占用，且 `noProxyList` 两处同步（**给出你的验证方法**）

## 文件边界

- `src/server/providers.js`、`src/server/server.mjs`、`src/server/provider.html`（只增不改）、`src/server/panel-common.js`（如需）、`src/main.js`（**noProxyList 同步**）
- **不许改**：`scripts/check-manifest.cjs`、`package.json`、`failover.mjs` 的导出
- **不跑** `gh release create`、**不改** `version`

## 通用要求

- 注释与文案**中文**
- 联网需 `export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`

---

## 报告要求

分节：清单层 / 服务端 / **两层轮换** / 面板 / 验证。
**贴真实输出**（闸门全文、轮换实测 JSON、`git diff` 里 `sk-or-v1-` 为零的证明）。
写清：**`noProxyList` 你怎么保证两处同步**、**不确定/没做到的地方**。

**我上面的判断不对就直接说**（我这次已经错过两次）。**不要假装验过没验的东西。**

报告 1200 字以内。
