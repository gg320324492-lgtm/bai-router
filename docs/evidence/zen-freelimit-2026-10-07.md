# 证据存档 — OpenCode Zen「免费档失效」调查（2026-10-07）

本文档只存**原始证据与复现命令**，不含结论分析（结论见 `HANDOFF.md` 第三·五节）。
目的：接手方**不用重新打上游**就能确认事实，也能独立复核我有没有说错。

---

## 1. 环境

- Zen 上游：`https://opencode.ai/zen/v1`
- 我们用的模型：`space-bunny-free`
- key 来源：`%APPDATA%\bai-router\config.json` → `zen.apiKey`（`oc_sk_…`，51 字节）
- `zen.useProxy = false`（直连，不走代理）

> **本文档不含 key 明文。** 复现时自己从 config.json 读。

---

## 2. 复现命令（我实际跑过的）

```bash
# 取 key（自己读，别外传）
ZKEY=$(python -c "
import json,os
print(json.load(open(os.path.join(os.environ['APPDATA'],'bai-router','config.json'),encoding='utf-8'))['zen']['apiKey'])
")

# ① 我们实际用的模型 → 429 FreeUsageLimitError（连打 3 次全 429）
for i in 1 2 3; do
  curl -s -o /tmp/zen_r$i.txt -w "HTTP %{http_code} time=%{time_total}s\n" \
    -X POST "https://opencode.ai/zen/v1/chat/completions" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $ZKEY" \
    -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"say hi"}],"max_tokens":32}' \
    --max-time 45
  sleep 6
done

# ② 另一个免费模型 → 403 FreeTierError（只能客户端内用）
curl -s -X POST "https://opencode.ai/zen/v1/chat/completions" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ZKEY" \
  -d '{"model":"fledge-alpha-free","messages":[{"role":"user","content":"say hi"}],"max_tokens":32}' --max-time 45

# ③ key 是否有效 → 200
curl -s -o /tmp/zen_models.txt -w "HTTP %{http_code}\n" \
  "https://opencode.ai/zen/v1/models" -H "Authorization: Bearer $ZKEY" --max-time 30
```

---

## 3. 实测结果（原样记录）

| # | 测试 | HTTP | 响应体 |
|---|---|---|---|
| ① | `space-bunny-free` 第 1 次 | **429** (1.12s) | `{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}` |
| ① | `space-bunny-free` 第 2 次 | **429** (0.87s) | 同上 |
| ① | `space-bunny-free` 第 3 次 | **429** (0.99s) | 同上 |
| ② | `fledge-alpha-free` | **403** | `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}` |
| ② | `longcat-2.5-preview-free` | **403** | 同 `FreeTierError` |
| ③ | `GET /zen/v1/models` | **200** | `{"object":"list","data":[{"id":"big-pickle",…},{"id":"ling-3.1-flash-free",…},…]}` |

**关键点**：① 是**连续 3 次全 429**，间隔 6 秒——证明是**持续性额度限制**，不是瞬时抖动。
③ 的 200 证明 **key 完全有效**（能列模型 ≠ 有额度，这是两件事）。

---

## 4. 中转侧的存证

中转会把**被拒的翻译后请求体**写到 `%APPDATA%\bai-router\wb-last-4xx.json`（仅 4xx，**5xx 不落盘**——这是 Qoder Bug A 要修的）。

我读到的 Zen 那份内容：

```
model      = space-bunny-free
stream     = True
max_tokens = 32000
messages   = 371 条
tools      = 114 个
系统首行   = You are a highly capable coding assistant operating in a developer's terminal.
mtime      = 2026-10-07T01:03:56.981014  (本地时间)
```

即：**真实 Claude Code 形状的大请求**（371 条消息 + 114 个 tool）被打到 Zen，被 429 拒。

---

## 5. 日志证据

`%APPDATA%\bai-router\server-child.log`：

```
Zen 429 相关行数      2701
最早一条              [2026-10-02T19:54:28.124Z]
最新一条              [2026-10-06T17:03:56.982Z]
日志时间范围          2026-08-30T20:40:51 → 2026-10-06T17:04:01
```

样例（最新的）：

```
[2026-10-06T17:03:56.981Z] OpenCode Zen 上游 429 拒绝了请求，翻译后请求体已存 wb-last-4xx.json：
  Rate limit exceeded. Please try again later.｜system 首行：You are a highly capable coding assistant…
[2026-10-06T17:03:56.982Z] 故障转移（入口 zen）→ zen:失败[st=429/[OpenCode Zen] Rate limit exceeded. Plea]；
  qd:冷却中；bai:冷却中；sn:未配置；wb:冷却中
```

**注意最后那行**：全链路同时失败（qd/bai/wb 全在冷却），说明 **Zen 失效时整条故障转移链会一起瘫**。

---

## 6. 官方文档

`https://opencode.ai/docs/zen/` —— 我抓到的原文片段：

- `Space Bunny Free space-bunny-free https://opencode.ai/zen/v1/chat/completions @ai-sdk/openai-compatible` → **模型确实在免费列表里**
- `The free models: … Space Bunny Free is a stealth model that's free on OpenCode for a limited time.` → **「for a limited time」= 限时活动**
- `Monthly limits: You can also set a monthly usage limit for the entire workspace…` → 这节讲的是**付费**月度限额，**与免费档无关**
- **没有**任何地方写明免费额度的具体数字（多少次/多少 token）或重置周期

> → 所以修复提示里**不要编造重置时间**。官方没公布就是没公布。

---

## 7. 代码侧定位（改之前先看这里）

| 位置 | 内容 |
|---|---|
| `server.mjs:775` | `const ZEN_EXTERNAL_OK = new Set(["space-bunny-free"]);` |
| `server.mjs:1729-1734` | **Bug 所在**：`if (r.status === 429)` 一律归因成「瞬时限流，等 30 秒」 |
| `server.mjs:1732` | 403 `FreeTierError` **已经**单独处理（思路对，但漏了 429 的细分） |
| `failover.mjs:19` | `export const FAILOVER_COOLDOWN_MS = 90 * 1000`（全局 90 秒，**别为 Zen 一个 case 改大**） |
| `server.mjs` `attemptWithFailover` | `const chain = [fo.provider, ...order.filter(…)]` —— **入口永远排第一**，所以从 zen 进来的请求即使额度用尽也第一个试 |
