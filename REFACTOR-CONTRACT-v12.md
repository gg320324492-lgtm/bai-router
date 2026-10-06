# REFACTOR-CONTRACT v12 — OpenCode Zen 429 归因修正（v1.0.58）

**单 agent 任务，独占 `src/server/server.mjs`。** 与 v10（Qoder Bug A/B）、v11（WorkBuddy）**互斥**，三个任务都改同一文件，必须串行，由编排者依次派发。本契约是**当前唯一被授权修改 server.mjs 的任务**。

---

## 用户现象

用户报告：**本机和其他电脑上 OpenCode Zen 接入失效**，但去 OpenCode 官网看，**免费档仍然显示有效**。

---

## 我已实测确证的事实（**别重新验证，直接用**）

我**绕过中转、直连** `https://opencode.ai/zen/v1/chat/completions`，拿到决定性对比：

| 测试 | 结果 |
|---|---|
| `space-bunny-free`（我们实际用的） | **429 `FreeUsageLimitError`**，**连打 3 次全 429** |
| `fledge-alpha-free` | **403 `FreeTierError`**（只能在 OpenCode 客户端内用） |
| `longcat-2.5-preview-free` | **403 `FreeTierError`**（同上） |
| `GET /zen/v1/models` | **200** ← **key 完全有效** |

**三个结论：**

1. **key 没失效**（`/models` 返回 200，能列 84 个模型）。
2. **`space-bunny-free` 是唯一能从外部调用的免费模型**——代码里 `ZEN_EXTERNAL_OK = new Set(["space-bunny-free"])` 早写明了，其余 `-free` 全是 `FreeTierError` 产品级封锁，**换模型没用**。
3. **现在 429 的真实含义是「这个 key 的免费额度用完了」**，**持续性**（非瞬时），**等 30 秒不会好**。

**关键**：`FreeUsageLimitError` 这个字符串在**整个代码库 0 次出现**——完全没被处理过。

**关于「官网显示免费仍有效」**：官网显示的是「该模型仍在免费列表里」（**模型存在性**），**不等于**「这个 key 的用量额度还没满」。两件事不同，所以用户看到的和实际报错**并不矛盾**。

---

## 根因：归因代码把两种完全不同的 429 混成一种

**位置**：`server.mjs` 的 `openaiExchange` 上游错误归因段（约 1729–1734 行，`if (p === "zen")` 分支）：

```js
if (r.status === 429 || (r.status === 500 && /internal server error/i.test(txt))) {
  why = " —— OpenCode Zen 限流很严（连发几次探测就会被顶掉）。等 30 秒左右再试，或只测当前档位别勾「测全部四档」。";
  noteRelayError(p, "rate_limit", `${NAME} 触发上游限流`);
}
```

**问题**：Zen 的 **所有 429** 被无条件当成「瞬时限流」，但真实错误 body 是：

```json
{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}
```

**`FreeUsageLimitError` = 免费额度用完**，和「连发几次被顶掉」是**两回事**，等 30 秒**没用**。当前提示**误导用户白等**。

> 对比：403 的 `FreeTierError` 分支（约 1732 行）**已经**单独处理了——说明这套「按 error.type 归因」的思路代码里本来就有，只是漏了 `FreeUsageLimitError`。

---

## 要做的（用户已选 **A + B 合并**）

### A. 归因改准确（**核心，必须做**）

在 Zen 的 429 分支里，**先按响应体的 `error.type` 细分**：

| error.type | 判定 | 提示要点（措辞你定，但必须如实） |
|---|---|---|
| `FreeUsageLimitError` | **额度用完** | 明确说「免费额度已用尽，**等多久都不会恢复**」；给出**可操作**的出路：换/重置 key、等官方重置（若你知道周期就写，**不知道就别编**）、或走故障转移链的其他渠道（qd/bai） |
| 无 type 或其他 | 真·瞬时限流 | 保留现有「等 30 秒」提示 |

- `noteRelayError` 的 kind 要区分开（例如额度用尽用 `rate_limit_quota` 或类似，**别再和瞬时限流共用 `rate_limit`**），否则状态面板分不出来。
- **不要编造不存在的重置周期**。我实测时没找到官方公布的免费额度重置时间——**如果文档里查不到就写「官方未公布重置时间」**，不要猜。

### B. 故障转移优先级随状态调整（**用户选的，要做**）

**意图**：Zen 额度用完时，让链路**主动让位**给能用的渠道，而不是继续把请求往一个已知不可用的渠道上送。

**当前链路**（`config.failover.chain`）：`["qd","bai","sn","zen","wb"]` —— Zen 本来就排第 4，但**在 `attemptWithFailover` 的循环里，`fo.provider`（入口）永远被放在最前**：

```js
const chain = [fo.provider, ...order.filter((x) => x !== fo.provider)];
```

**所以从 zen 入口进来的请求，zen 永远第一个试**——哪怕它额度已经用尽。

**要做**：
- 当某渠道被判定为**额度用尽（非瞬时）**时，`failoverCooldown` 要用**明显更长的冷却**（瞬时限流是 90 秒，额度用尽应该长得多——**你定一个合理值并说明理由**，比如 30 分钟，因为额度不会在 90 秒内回来）。
- 或者（更符合「优先级随状态调整」的意图）：**入口提供方若已知额度用尽，不应再排第一**，应让位给 chain 里下一个可用的。
- **两种做法你选一个，并说明为什么选它。** 我倾向**第一种 + 让入口判断结合**：短冷却对额度用尽无效，长冷却才能真正让位。**但如果你认为第二种更对，直接说。**

**注意**：`FAILOVER_COOLDOWN_MS` 是 `export const`（`failover.mjs` 第 19 行，90 秒），改它会**影响所有渠道**——不要为了 Zen 一个 case 把全局冷却改大。**要按渠道/按错误类型分别设定**，就需要改 `failover.mjs` 的 API。

**`failover.mjs` 允许你改**（这是本契约唯一的例外）。但**改 API 时必须同步所有调用方**，别留下不兼容。

---

## 验证要求（硬性，不许假装验过）

1. **隔离实例**：`BAI_DATA_DIR=%TEMP%/bvb12` + 端口 17xxx/18xxx，测完 `taskkill //PID <pid> //F`
2. **绝对禁止** `taskkill /IM node.exe`（会杀掉用户的正式实例，真实发生过）
3. **必须实测 429 归因**——我已给出真实响应体：
   ```json
   {"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}
   ```
   起隔离实例后，**用构造的响应**或**打真实 Zen 上游**（429 现在是持续的，可复现）验证：新提示**明确说了额度用完且等也没用**，**不再**说「等 30 秒」。**把真实输出贴进报告。**
4. **回归**：改完确认 zen 的 403 `FreeTierError` 分支、402 分支**仍正常**（别把已有的归因改坏）。
5. `node scripts/check-manifest.cjs` → **0 error**（C13 种子配置闸门已生效）

---

## 文件边界

- `src/server/server.mjs` —— 主要改动
- `src/server/failover.mjs` —— **允许**，若你选「按错误类型分别冷却」的方案
- **不许改**：`scripts/check-manifest.cjs`、`src/server/providers.js`、`provider.html`、`package.json`

## 通用要求

- 注释与文案**中文**
- **不跑** `gh release create`、**不改** `package.json` 的 `version`（编排者负责）
- 联网需 `export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`

---

## 报告要求

分 **A/B** 两节。写：改了什么、**怎么验的（贴真实输出）**、**你选了 B 的哪个方案及理由**、**不确定的地方**。

**如果我上面的根因判断错了，直接说**——我在这次会话里已经错过两次（先说用户跑旧版、再怀疑注入位置错）。**不要顺着我写。不要假装验过没验的东西。**

报告 800 字以内。
