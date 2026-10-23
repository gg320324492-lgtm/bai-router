// src/server/clients/claude-code-edits.mjs —— Claude Code 的 env 键：**纯函数**
//
// ## 为什么抽出来
//
// 这批 env 键的取���规则里有一堆**有历史教训的讲究**（原实现是
// `src/server/server.mjs` 的 `applyToCli`）：
//   · 走本地中转的渠道写**占位符**、不写真凭据（免得在用户主目录留明文副本）
//   · 网关模式模型 id 必须是**档位**（`provider/档位`）而不是最终模型名
//     —— **那条写反过一次**，代价是「用户点 opus、转移后跑的是 fable 的模型」
//   · 出海渠道写代理 env、境内渠道**删掉**代理 env
//   · 显示名只写用户手填的 label，不掺倍率（倍率混进 label 会配错行）
//   · 用户自己设过 API_TIMEOUT_MS 就留着
//
// 原来的实现在 server.mjs 里，而 **server.mjs 一 import 就起服务** ⇒ 测试没法
// 直接用它的逻辑。抽成纯函数（外部事实全部当参数传进来）之后：
//   · server.mjs 照旧调它（行为逐字不变）
//   · clients/ 层（src/server/clients/claude-code.mjs）也能调它 ⇒ 走底座的
//     **路径级备份 + 可还原**流程（多一个能力：**能断开**；applyToCli 自己
//     只留指纹、还原不了）
//   · 测试也能调它（传假事实）⇒ 测的是**真的那段逻辑**，不是抄��一份
//
// ## 纪律
//
//   · 纯函数：零 IO、零时钟、不读全局。事实全从参数来。
//   · 键路径一律 `env.<KEY>` —— 底座按这个粒度备份与还原。

/**
 * claudeCodeEdits —— Claude Code 的 env 块要改哪几处。
 *
 * @param {object} f
 * @param {Array<{key:string, envKey:string, zh?:string}>} f.tiers 档位表
 * @param {boolean} f.gw                走统一网关吗
 * @param {string}  f.gatewayBaseUrl     网关地址
 * @param {string}  f.cliBaseUrl         不走网关时直连那家的地址
 * @param {boolean} f.viaLocalRelay      这一家走本地桥（协议桥）吗
 * @param {string}  f.proxyManagedToken  走本地桥时写的占位符
 * @param {string}  f.providerId         模型 id 的 provider 前缀（网关模式）
 * @param {string}  f.channelId          渠道 key（决定要不要写代理 env）
 * @param {string}  f.key                那一家的凭据（不走网关时写进 env）
 * @param {object}  f.mapping            档位 → {target, label}
 * @param {string}  f.defaultModel       那一家的默认模型
 * @param {string}  f.proxy              代理地址（出海渠道写进 env）
 * @returns {Array<{path:string, value?:string, delete?:boolean, onlyIfAbsent?:boolean}>}
 */
export function claudeCodeEdits(f) {
  const tiers = Array.isArray(f.tiers) ? f.tiers : [];
  const mapping = f.mapping || {};
  const gw = f.gw === true;
  const edits = [];
  const setEnv = (k, v) => edits.push({ path: "env." + k, value: v });
  const delEnv = (k) => edits.push({ path: "env." + k, delete: true });

  setEnv("ANTHROPIC_BASE_URL", gw ? f.gatewayBaseUrl : f.cliBaseUrl);
  /* ⚠ 网关模式**也要**有 token —— 但理由不是「网关需要它」。
   *
   *   原来的推理是：「请求先到统一网关，网关按模型 id 的 provider 前缀分流 ⇒
   *   客户端送来的这个 token 对网关**没有意义** ⇒ 保留用户自己那份」。
   *   ⚠ **那个推理漏了一步**：「网关不校验客户端的 token」**≠**「客户端可以没有 token」。
   *   Claude Code 自己**没有 token 就不发请求** —— 它直接报
   *   「Not logged in · Please run /login」，一个请求都不发出来。
   *   ⇒ 2026-10-23 的端到端实测（真 claude CLI + 假上游）抓到了这个洞：
   *   出厂默认是**网关模式**，而网关模式**不写**这个键 ⇒ **新接线的客户端
   *   一个请求都发不出去**（用户老配置里本来就有这个键，所以他自己没察觉）。
   *
   *   写**占位符**（不是真 key）：网关不校验它，真 key 留在用户主目录是
   *   「里程碑 4b」明确要避免的（明文副本）。
   *   ⚠ **用户自己已经设过就留着**（他可能有别的用途）⇒ onlyIfAbsent。 */
  if (!gw) {
    setEnv("ANTHROPIC_AUTH_TOKEN", f.viaLocalRelay ? f.proxyManagedToken : (f.key || "wb-local"));
  } else {
    edits.push({ path: "env.ANTHROPIC_AUTH_TOKEN", value: f.proxyManagedToken, onlyIfAbsent: true });
  }
  const modelId = (tier, target) => (gw ? `${f.providerId}/${tier}` : String(target));
  setEnv("ANTHROPIC_MODEL", modelId("claude-haiku-4-5",
    (mapping["claude-haiku-4-5"] || {}).target || f.defaultModel));

  /* 显示名：只写用户手填的 label，不掺倍率（v1.0.65 撤掉）。
   *
   * 仍然不 `delete`：以前是 `delete e[t.envKey + "_NAME"]` —— 我们自己把 Claude Code
   * 的显示名通道删掉了，于是 /model 里只能看到模型 id。契约 §1.6 实测：
   * ANTHROPIC_DEFAULT_*_MODEL_NAME 的 label 可塞任意文本，且与模型名是两个独立字段。
   * 曾经在这里拼过「label · x0.79」（路径 A），实测还有个更麻烦的问题：
   * 目录里 hy4-preview-f 是 x0.00 而 hy4-preview 是 x0.29，靠前缀回退很容易配错行，
   * 与其显示一个可能对不上的数字，不如不显示 —— 真实倍率在面板「刷新模型列表」里看。
   * 模型名（e[t.envKey]）保持上游真名不变，解析链零改动。 */
  for (const t of tiers) {
    const m = mapping[t.key] || {};
    const target = m.target || f.defaultModel;
    setEnv(t.envKey, modelId(t.key, target));
    // 用户没填 label 就不写这条（留空反而会让 Claude Code 回退显示模型 id，与旧行为一致）
    if (m.label) setEnv(t.envKey + "_NAME", m.label);
  }
  /* 用户自己设过 API_TIMEOUT_MS 就留着（旧写法 `e.API_TIMEOUT_MS = e.API_TIMEOUT_MS || "3000000"`）。
   * ⚠ 用 edits 的 `onlyIfAbsent` 表达 ⇒ 不必读 env。 */
  edits.push({ path: "env.API_TIMEOUT_MS", value: "3000000", onlyIfAbsent: true });
  setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
  setEnv("NODE_USE_ENV_PROXY", "1");
  if (f.channelId === "bai" || f.channelId === "or") {
    // 出海渠道（B.AI / OpenRouter）：CLI 直连上游时靠 proxy env 出海。
    // OpenRouter 走的是本地桥（127.0.0.1），但桥自己出海仍要代理——env 留着没坏处。
    setEnv("HTTPS_PROXY", f.proxy);
    setEnv("HTTP_PROXY", f.proxy);
  } else {
    // 境内提供方（SenseNova/WorkBuddy）直连、清空代理（WorkBuddy 桥在本机，NO_PROXY 已覆盖）
    delEnv("HTTPS_PROXY"); delEnv("HTTP_PROXY");
  }
  setEnv("NO_PROXY", "127.0.0.1,localhost");
  return edits;
}
