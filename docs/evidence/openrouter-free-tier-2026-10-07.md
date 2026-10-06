# 证据存档 — OpenRouter 免费兜底区 调研（2026-10-07）

**状态：规划阶段，尚未实现。** 目的：把实测事实固定下来，后续实现时不用重查。
本文档只存证据与复现命令，结论与设计见 `HANDOFF.md`。

---

## 0. 一句话目标（用户原话）

> 再开一个 OpenRouter 专区，读取免费模型，**在免费模型过期时自动更换下一个**，保证一个持续可用的 OpenRouter 免费流水区；做**三个 key 的更换区**；OpenRouter 是**没有任何模型可用时的兜底**。

测试 key（用户已给，**不落盘到任何配置**，实现时按安全红线处理）：
`sk-or-v1-…（掩码）`（完整值见对话，此处不复制）

---

## 1. 关键实测结论（**这是整个设计的地基**）

### 1.1 存在**两种不同的 429**，必须区分

| `limit_source` | 含义 | 换模型有用吗 | 换 key 有用吗 |
|---|---|---|---|
| **`openrouter_free_tier_daily`** | **账号级**：免费模型每日 50 次（本 key 已用 60，`remaining: 0`） | ❌ **没用**（同一账号池） | ✅ **有用**（3 个 key 正对症） |
| **`upstream_provider_shared_pool`** | **模型级**：该模型的上游提供方池子满 | ✅ **有用**（换下一个） | 通常没用（池子是共享的） |

> **这直接修正了「过期就换下一个模型」的原始设想**——对 `free_tier_daily` 换模型是**无效操作**，必须换 key。
> 两者都要做：**先换模型（治 upstream_pool），模型都不可用时换 key（治 daily）**。

### 1.2 真实响应体

```json
{
  "error": {
    "message": "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
    "code": 429,
    "metadata": {
      "headers": {
        "X-RateLimit-Limit": "50",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1791331200000"
      },
      "limit_source": "openrouter_free_tier_daily",
      "remedy_hint": "Wait for the daily reset (see X-RateLimit-Reset), or purchase credits to raise your free-model daily limit."
    }
  },
  "user_id": "user_3Iu0osHzQfBIVdTGgY6neQaGwwi"
}
```

### 1.3 `/auth/key` 返回（额度真相）

```json
{
  "is_free_tier": true,
  "usage": 0.04217109,
  "usage_daily": 0.00017109,
  "free_model_daily_requests": { "used": 60, "limit": 50, "remaining": 0 },
  "expires_at": null
}
```

- **`is_free_tier: true`**、`limit: null`（key 本身没设花费上限）
- **`free_model_daily_requests.used: 60 > limit: 50`** —— 用超了（可能有并发/统计延迟），`remaining: 0`
- 重置时间 `X-RateLimit-Reset` = **2026-10-07T08:00:00**（UTC+8），调研时距重置约 6.5 小时

---

## 2. 免费模型清单（`GET /api/v1/models`，466 个模型中 20 个免费）

判据：`pricing.prompt == "0" && pricing.completion == "0"`

```
inclusionai/ling-3.1-flash                    ctx 262144
apodex/apodex-1.1-mini:free                   ctx 262144
inclusionai/ling-3.0-flash-sante:free         ctx 262144
dots-studio/dots-3-note-preview:free          ctx 512000
liquid/lfm-2.5-2.6b:free                      ctx 65536
nvidia/nemotron-3.5-lightning:free            ctx 1000000
thinkingmachines/inkling-small:free           ctx 1048576
poolside/laguna-s-2.1:free                    ctx 262144
thinkingmachines/inkling:free                 ctx 1048576
poolside/laguna-xs-2.1:free                   ctx 262144
cohere/north-mini-code:free                   ctx 256000
nvidia/nemotron-3.5-content-safety:free       ctx 128000
…（共 20 个）
```

**注意**：`inclusionai/ling-3.1-flash` **没有 `:free` 后缀**但 pricing 全 0 —— 所以**不能只靠后缀筛**，必须按 pricing 判。

---

## 3. 复现命令

```bash
OK="<你的 key>"

# ① 拉免费模型清单
curl -s "https://openrouter.ai/api/v1/models" -H "Authorization: Bearer $OK" -o or_models.json
python -c "
import json
d=json.load(open('or_models.json'))
free=[m for m in d['data']
      if str(m.get('pricing',{}).get('prompt',''))=='0'
      and str(m.get('pricing',{}).get('completion',''))=='0']
print(len(free),'个免费模型')
"

# ② 打一个免费模型（当前必 429，因为 used>limit）
curl -s -X POST "https://openrouter.ai/api/v1/chat/completions" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $OK" \
  -d '{"model":"nvidia/nemotron-3.5-lightning:free","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'

# ③ 查额度真相
curl -s "https://openrouter.ai/api/v1/auth/key" -H "Authorization: Bearer $OK"
```

---

## 4. 一个更高效的选项（用户可能想知道）

429 的 `message` 原文写着：

> **`Add 10 credits to unlock 1000 free model requests per day`**

即：**充 10 美元 → 免费模型从 50 次/天 提到 1000 次/天**。

对比 3 个 key 轮换：`50 × 3 = 150 次/天` vs `1000 次/天`。
**充 10 美元的性价比远高于 3 key 轮换** —— 但这是付费决策，**归用户定，我不擅自做**。

---

## 5. 实现要点（给后续任务的契约预留）

1. **两种 429 必须分流**（见 1.1）—— 这是核心，做错整个轮换就白做。
2. **`limit_source` 要从 `metadata.limit_source` 读**，不能只看 status=429。
3. **换模型要排除已知不可用的**（`upstream_pool` 满的那些），而不是无脑顺序遍历。
4. **3 个 key 轮换** —— 但**任何配置文件都不许写 key 明文**（安全红线，见 `HANDOFF.md` 第六节）。
5. 兜底定位：OpenRouter 应排在故障转移链**最末**（用户原话「没有任何模型可用时的兜底」）。

---

## 6. 与既有工作的关系

- **`server.mjs` 正被 Qoder Bug A/B 的 agent 独占** → 本任务**必须等它完成**（串行，避免冲突）
- 契约顺序：`v12`(Zen，已完成) → `v10`(Qoder，进行中) → `v11`(WorkBuddy) → **OpenRouter(待写 v13)** → 推 GitHub
