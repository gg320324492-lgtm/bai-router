# REFACTOR-CONTRACT v8 — Qoder 付费模型接入（v1.0.56）

给实施 agent 的边界契约。单工作项，但**探测结论都已实测**，不必重新试错。

---

## 需求

用户有 Qoder 积分，希望把 Qoder 的**付费模型**也接进 Claude Code。

## 我已经实测完的结论（**直接采信，不必重试**）

用 `%TEMP%\qoder-token.json` 的令牌直连 `https://api2-v2.qoder.sh/model/v1/chat/completions`
逐个探测，**每个模型连测 3 次**：

| 模型别名 | 实际落到 | price_factor | 结果 |
|---|---|---|---|
| `lite` | Qwen3.8-Flash | 0 | 3/3 ✔ 免费 |
| `qmodel` | Qwen3.7-Plus | 0.1 | 3/3 ✔ |
| `mmodel` | MiniMax-M3 | 0.2 | 3/3 ✔ |
| `auto` | — | 0.5 | ✔ |
| `dmodel` | DeepSeek-V4-Pro | 0.5 | 3/3 ✔ |
| `kmodel` | Kimi-K2.8 | 0.8 | 3/3 ✔（usage 显示实际是 `bailian-kimi-k2.7-code`） |
| `gmodel` | GLM-5.3 | 0.8 | 3/3 ✔（usage 显示 `glm-5`）**← 记忆里没有，是新发现** |
| `performance` | — | 1.1 | 3/3 ✔（实际 `qwen3-coder-plus`） |
| `ultimate` | — | 2 | ⚠ **不稳定**：第一次成功，第二次 `All models failed` |

被拒的：
- `smodel`(8×) / `cmodel`(4×) / `qmodel_38max` / `gfmodel` / `dfmodel`
  → `invalid_model_error: Unsupported model`（**服务端根本不认这些名字**，不是权限问题）
- `efficient`(0.3×) → `provider_error: All backends failed`

**`ultimate` 的失败细节值得注意**：
```
details: {"Message":"User: arn:aws:iam::052717076359:user/bedrock-test is not
authorized to perform: bedrock:InvokeModel ..."}
```
��是 **Qoder 服务端自己的 AWS 权限问题**，不是用户账号/积分问题。
→ **付费档会间歇性失败**，中转侧的故障转移（`failover.mjs`）必须能兜住。

## 与现有代码的差距

`src/server/server.mjs` 的 `QD_EXTERNAL_OK` 只列了 8 个，**缺 `gmodel`**。
而且面板**没有告诉用户哪些是付费、要花多少积分**——用户是"盲选"的。

---

## 工作项

### 1. 补全 `QD_EXTERNAL_OK`（server.mjs）

加入 `gmodel`。**只加实测通过的**。不要加 `smodel`/`cmodel`/`efficient`。
加完在注释里写明「实测 2026-10-03」与来源，便于日后复核。

### 2. 模型目录带上价格信息（server.mjs + 面板）

`/api/models?p=qd` 的返回里，目前有 `free: boolean` / `external: boolean` / `price`。
请检查现状并确保：
- 每个模型带 `priceFactor`（来自 `qoder-models.json` 的 `price_factor`）
- 面板下拉里**付费档要有视觉区分**（如标注 `0.8×`），让用户知道哪个在花积分

先读现有代码确认它已经返回了什么，**不要凭我这句话假设字段名**。

### 3. 路由表默认值要合理（providers.js / config.defaults.json）

现在 `qd.mapping` 四个档位默认指向 `lite`（免费）。
**保持默认免费**——不能默认让用户烧积分。
但可以新增档位映射，让用户能主动选付费模型（如 haiku 档 → `gmodel`）。
**你判断该新增哪些映射并说明理由**，注意四个档位语义：
`claude-fable-5`(最强) / `claude-sonnet-5`(均衡) / `claude-opus-5`(最强) / `claude-haiku-4-5`(最快最省)。
**别把付费档挂到 fable/opus 这两个默认档上**——那会让用户不知不觉烧积分。

### 4. 付费档失败要能兜底

`ultimate` 实测会间歇性报 `All models failed`。确认现有 `failover` 链
（`chain: ["qd","bai","sn","zen","wb"]`）在这个场景下能转移。
**若 failover 对 `provider_error` 不转移，判断是否该转**——
一个后端挂了就该换一家，而不是让用户卡住。

---

## 硬性要求

- **默认必须是免费档**。用户没主动选付费时，绝不能让他烧积分。
- **不许把付费模型当"免费"展示**。价格标注要如实。
- 令牌**绝不落 config.json / settings.json**（现有约束，别破坏）。
- 面板文案与代码注释**都是中文**。
- **不要发** GitHub release，**不要改** `package.json` 的 version。
- 不要碰 `panel-common.css`（除非第 2 项确有必要，改了要说明）。
- 不要碰 `provider.html`（C4：52 个契约 id 各出现且仅出现一次）。

## 文件边界

- `src/server/server.mjs` —— 第 1、2、4 项
- `src/server/providers.js`、`src/server/config.defaults.json` —— 第 3 项
- `src/server/panel-common.js` —— 第 2 项的视觉区分（若需要）

**不要碰 `src/main.js`**（正在被别的工作流占用）。

## 验证

- `node --check src/server/server.mjs` 等所有改动的文件
- `node scripts/check-manifest.cjs` → **0 error**（C8 会检查模型列表，Qoder 部分尤其注意）
- **起隔离实例实测**：复制 `%APPDATA%\bai-router\config.json` 到临时目录、端口挪到 17xxx/18xxx、
  `BAI_DATA_DIR` 指过去。**绝对不许写真实配置**。测完 `taskkill //PID <pid> //F`
  （**不要用 `taskkill /IM node.exe`**）。正式实例在跑（占 15722/15723）。
- 实测至少证明：`/api/models?p=qd` 里**付费档带正确价格**、默认映射仍是 `lite`（免费）。
- Qoder 客户端必须保持运行（否则令牌不刷新）。

## 报告要求

写清：改了什么、**你新增了哪些路由表映射及理由**、怎么验的、实际输出、
**不确定或没做到的地方**。特别是——如果你发现我的实测结论有错，**直接说**。