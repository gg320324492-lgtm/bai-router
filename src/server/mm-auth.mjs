/**
 * mm-auth.mjs —— MiniMax **会员托管**通道（渠道键 `mm`）的凭据与请求头。
 *
 * ## 这一格是什么
 *
 *   MiniMax 会员（MiniMax Code 桌面端登录的那份账号）自带的免费/会员额度，
 *   **不是**开放平台的按量计费 API Key。两回事，面板上必须分开说。
 *
 *   推理端点（Anthropic Messages 原生协议，上游直接吃 /v1/messages，不做协议翻译）：
 *       POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages
 *   续期端点（form-urlencoded）：
 *       POST https://account.minimax.cn/oauth2/token
 *
 *   端点/常量出处（不重新挖 asar）：
 *     - @mavis/oauth-core/dist/contracts.js
 *         MCODE_OAUTH_CLIENT_ID='mcode-public'、MCODE_OAUTH_SCOPES=['agent.default']、
 *         MCODE_OAUTH_AUDIENCE='agent-backend'
 *     - @mavis/config/dist/config.js
 *         PRESET_BASE_URLS['cn-prod']='https://agent.minimax.cn/mavis/api/v1/llm/v1'
 *         （Anthropic SDK 拼 baseURL + '/v1/messages'，故最终是 .../llm/v1/messages；
 *           本模块的 MM_INFER_BASE 存的是**去掉最后那段 /v1** 的基址，
 *           中转拼 `upstream + req.url` 时 req.url='/v1/messages'，两者正好对上。）
 *
 * ## 🔴 三条硬红线
 *
 *   ① **凭据只存本模块的内存**。启动时从
 *      `~/.minimax/auth/prod/cn/mcode-public/auth.json` 读 refresh token 放进本模块的
 *      内存态；进程退出即失效。**任何时候都不把令牌写进 B.AI Router 自己的
 *      config.json / 日志 / 面板 / 任何文件。**
 *      ⚠️ **唯一的例外**：续期轮换之后，把新令牌**写回 MiniMax Code 自己的那个
 *      登录态文件**（见 {@link writeBackAuth}）。这不是「把令牌落到别处」——
 *      那个文件本来就放着同一把令牌，MiniMax Code 每次续期也自己写回去；
 *      不写回的话，路由台一续期就把 MiniMax Code 那把**一次性**令牌作废掉
 *      （invalid_grant），两边都完蛋（2026-10-19 实测，见下）。
 *   ② **日志、错误消息、状态快照里都不许出现令牌值**。只许出现「长度 / 是否有效 / 前缀形状」。
 *      scrub() 是兜底：任何要往外说的字符串都先过它一遍。
 *   ③ **refresh token 是一次性轮换的**：刷新成功后旧的立即作废
 *      （invalid_grant: this refresh token can no longer be used, start a new authorization）。
 *      所以**每次刷新成功后必须立刻把返回的新 refresh_token 存进内存**，
 *      否则下一次续期必然 invalid_grant，整条凭据链就断了。
 *
 * ## 🔴 与 MiniMax Code 共用同一把一次性令牌（2026-10-19 实测）
 *
 *   登录态文件是 **MiniMax Code 的凭据库**（它自己写，`generation` 每次续期 +1：
 *   实测 39 → 41 → 42），而本模块也从同一个文件取刷新令牌。刷新令牌一次性 ⇒
 *   **本模块一续期，MiniMax Code 手里那把就死了。**
 *
 *   实测到的真实事故：
 *   ```
 *   15:19:02  路由台续期成功（日志：刷新令牌已轮换）
 *             文件仍是 generation 42、mtime 没变   ← 没写回
 *             拿文件里那把去续期 → 400 invalid_grant
 *             "this refresh token can no longer be used, start a new authorization"
 *   ```
 *   后果有两层：MiniMax Code 掉线要重新登录；**路由台自己重启后也救不回来**
 *   （重启会读到那把已死的令牌）。
 *
 *   所以两件事必须同时做：
 *   ① **写回**（{@link writeBackAuth}）：续期后把新令牌原子写回那个文件；
 *   ② **按 `generation` 判「谁更新」**（{@link readAuthFile}）：
 *      文件的 generation 更大 → 那是 MiniMax Code 刚续出来的，**跟着换**；
 *      内存里的更大 → 那是本模块自己续出来的，**保留**（文件还没跟上）。
 *
 * ## 为什么单独成文件
 *
 *   server.mjs 一 import 就起服务（抢单实例锁、开两个监听端口），没法被测试直接 import 求值。
 *   凭据轮换是本渠道最容易出错的一环（续期、轮换、失败处置），
 *   所以把它放进一个**零副作用、可注入假 fetch** 的纯模块，由 scripts/mm-auth-test.mjs 直接求值。
 *
 * ## 头的事（2026-10-19 实测，MiniMax Code 3.1.4）
 *
 *   实测了 9 种头组合，结论和最初的猜测**不一样**，以这里为准：
 *
 *   | 头 | 必需？ | 证据 |
 *   |---|---|---|
 *   | `authorization: Bearer <accessToken>` | **必需** | 去掉 → 401 `auth failed` |
 *   | `content-type: application/json` | **必需** | 去掉 → 400 `invalid params` |
 *   | `x-api-key` | 可选 | 去掉仍然 200 |
 *   | `origin` / `referer` | 可选 | 去掉仍然 200 |
 *   | `anthropic-version` | 可选 | 去掉仍然 200 |
 *   | `user-agent` | 可选 | 去掉仍然 200（换任何 UA 也都 200） |
 *   | `token` 头（代替 authorization） | 无效 | 401 `auth failed` |
 *
 *   ⚠️ **UA / Origin / Referer 都不是校验对象**——我照样全套发出去，是为了
 *   和真客户端保持一致、也留一手，但**它们不是「缺了就 401」的原因**。
 *   真正的两处硬要求是：**鉴权令牌** 与 **content-type**。
 *
 *   ⚠️ 同理，**system prompt 的内容与形状也不参与校验**（Claude Code 的原文 /
 *   一句普通提示 / 完全不写 / 数组多块形状，四种都 200）。
 *   真正被上游挑刺的是**工具定义的形状**（见 {@link mmNormalizeTools}）：
 *   嵌套形状 → 400 `invalid params, function name is empty (2013)`。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/* ---------- 端点与常量（出处见文件头） ---------- */

/** 续期端点：POST form-urlencoded。 */
export const MM_TOKEN_ENDPOINT = "https://account.minimax.cn/oauth2/token";
/** 推理基址：中转拼 `base + req.url`（req.url = /v1/messages）。 */
export const MM_INFER_BASE = "https://agent.minimax.cn/mavis/api/v1/llm";
/** 会员通道当前唯一可选的模型。 */
export const MM_MODEL = "MiniMax-M3.1-Flash";
/** OAuth 客户端 / 作用域 / 受众（mcode-public 是公开客户端，勿改）。 */
export const MM_CLIENT_ID = "mcode-public";
export const MM_SCOPE = "agent.default";
export const MM_AUDIENCE = "agent-backend";
/** 上游要的浏览器指纹三件套。 */
export const MM_ORIGIN = "https://agent.minimax.cn";
export const MM_REFERER = "https://agent.minimax.cn/";

/* ---------- 模型 id 的大小写 ----------
 *
 * ⚠ 上游的模型 id 是**大小写敏感**的，官方写法是 "MiniMax-M3.1-Flash"（带大小写）。
 *   而面板「保存映射」走 /api/config 时，既有行为会把目标模型名**转成小写**
 *   （那一行对六家全是小写 id 的渠道是等价的，可 MiniMax 不是）。
 *   转小写的结果就是**发出去的名字被改了** —— 上游要么 400「模型不存在」，
 *   要么更糟：悄悄按另一个模型计费/扣额度。
 *
 *   所以这一格统一走 {@link mmCanonicalModel}：认得出来的（不分大小写）还原成官方写法，
 *   认不出来的原样返回（那是用户自己填的自定义模型名，由用户负责）。
 *   下拉里显示的、存进 config.json 的、发给上游的，三处因此永远是同一个写法。 */
export const MM_CANONICAL_MODELS = [MM_MODEL];

/**
 * 把一个模型 id 归一成上游的官方写法。
 *
 * @param {string} id
 * @returns {string} 认得出来就给官方写法；认不出来原样返回（去空白）
 */
export function mmCanonicalModel(id) {
  const s = String(id == null ? "" : id).trim();
  if (!s) return s;
  const low = s.toLowerCase();
  const hit = MM_CANONICAL_MODELS.find((m) => m.toLowerCase() === low);
  return hit || s;
}
export const MM_USER_AGENT =
  "MiniMaxAgent Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MiniMax/3.1.1 Chrome/148.0.7778.280 Safari/537.36";
/** 上游要求带 x-api-key，但值是占位符（真实鉴权走 authorization: Bearer）。 */
export const MM_PLACEHOLDER_KEY = "sk-xxx";
/** 剩不到 5 分钟就提前续期（access token 有效期 60 分钟）。 */
export const MM_RENEW_WINDOW_MS = 5 * 60 * 1000;
/** 登录态失效时的**唯一**说法。别的地方不许另编一句。 */
export const MM_LOGIN_INVALID_MSG = "MiniMax 登录态已失效，请在 MiniMax Code 里重新登录";
/** 续期请求的默认超时。 */
export const MM_TOKEN_TIMEOUT_MS = 15000;
/** 「这一格能不能用」的判据去重读登录态文件的节流间隔（本地读文件很便宜，
 *  但每条请求都读没必要；15 秒足够让用户登录后 15 秒内生效）。 */
export const MM_RECHECK_MS = 15000;
/** 临时性失败后的冷却：这段时间内不再打续期端点（不刷上游）。 */
export const MM_RETRY_COOLDOWN_MS = 60 * 1000;

/* ---------- 登录态文件 ---------- */

/**
 * 登录态文件路径。**用 os.homedir() 拼**——源码里不许出现任何本机绝对路径
 * （契约红线；config.defaults.json 还会被 C13 扫）。
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function mmAuthFilePath(homeDir) {
  const h = homeDir || os.homedir();
  return path.join(h, ".minimax", "auth", "prod", "cn", "mcode-public", "auth.json");
}

/**
 * 从登录态文件里挑一条带 refreshToken 的记录。
 *
 * `records` 可能有多个（多个账号/多次登录），取**任意一个带 refreshToken 的**即可。
 * 读不到 / 解析失败 / 一条都没有 → 返回 null（调用方据此说「没登录」，不许瞎猜）。
 *
 * @param {string} file
 * @returns {{accessToken:string, refreshToken:string, expiresAtMs:number, clientId:string, scopes:string, audience:string, recordKey:string, generation:number}|null}
 */
export function readMmAuthRecord(file) {
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const records = (doc && doc.records) || {};
  if (!records || typeof records !== "object") return null;
  for (const k of Object.keys(records)) {
    const r = records[k];
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const rt = typeof r.refreshToken === "string" ? r.refreshToken.trim() : "";
    if (!rt) continue;
    return {
      accessToken: typeof r.accessToken === "string" ? r.accessToken : "",
      refreshToken: rt,
      expiresAtMs: Number(r.expiresAtMs) || 0,
      clientId: typeof r.clientId === "string" && r.clientId ? r.clientId : MM_CLIENT_ID,
      scopes: typeof r.scopes === "string" && r.scopes ? r.scopes : MM_SCOPE,
      audience: typeof r.audience === "string" && r.audience ? r.audience : MM_AUDIENCE,
      recordKey: String(k),
      /* 🔴 `generation` 是**判断「谁的令牌更新」的唯一依据**。
       *   刷新令牌是一次性轮换的：MiniMax Code 续一次期，文件里的 generation +1，
       *   而**旧的那把刷新令牌当场作废**。本模块和 MiniMax Code 用的是同一把，
       *   谁先续谁就把对方的作废掉 —— 所以必须能分清「文件里的是新轮换出来的」
         还是「我内存里的是新轮换出来的（文件还没跟上）」，否则两边会互相把对方作废。 */
      generation: Number(r.generation) || 0,
    };
  }
  return null;
}

/* ---------- 写回登录态文件（只写 MiniMax Code 自己的凭据库） ---------- */

/**
 * 把续期轮换出来的新令牌**写回**登录态文件。
 *
 * ## 为什么必须写回
 *
 *   刷新令牌是**一次性**的，而本模块与 MiniMax Code 共用同一个文件里的**同一把**。
 *   路由台一续期，MiniMax Code 手里那把就作废（invalid_grant）——
 *   实测 2026-10-19 15:19：路由台续期成功、文件没更新，
 *   拿文件里那把去续期立刻 `400 invalid_grant: this refresh token can no longer be used`。
 *   后果：MiniMax Code 掉线要重新登录，**路由台自己重启后也救不回来**。
 *
 *   写回之后，文件里的令牌始终是**最新那把**，两边都接着用。
 *
 * ## 这不是「把令牌落到 B.AI Router 的文件里」
 *
 *   写的是 **MiniMax Code 自己的凭据库** —— 令牌本来就在那儿，
 *   MiniMax Code 每次续期也自己写回去。本模块不写 config.json / 日志 / 面板。
 *
 * ## 安全措施（每一道都是为了「绝不把用户的登录态写坏」）
 *
 *   ① **原子写**：先写同目录的临时文件，再 rename 覆盖 ——
 *      崩溃 / 断电 / 写一半都不会留下半个文件（rename 在同一文件系统上是原子的）。
 *   ② **并发保护**：写之前重新读一遍原文；与我们读到的**不一致**（说明
 *      MiniMax Code 刚写过）就**放弃这次写入**，绝不覆盖别人的更新。
 *   ③ **结构保持**：只改目标记录的 4 个字段
 *      （accessToken / refreshToken / expiresAtMs / generation），
 *      其余字段与其余记录**原样保留**。
 *   ④ **失败不动原文件**：任何一步出错就放弃写入并记日志，绝不写出一个坏文件。
 *   ⑤ **只写自己刚续出来的那把**：写的是刚刚从上游拿到的令牌，不掺别的东西。
 *
 * @param {string} file     登录态文件路径
 * @param {string} recordKey 目标记录的键（账号标识）
 * @param {object} token    { accessToken, refreshToken, expiresAtMs, generation }
 * @param {string} expectRaw 我们**读到时**的原文；与写之前的原文不一致就放弃写入
 * @returns {{ok:boolean, reason:string}}
 */
export function writeBackAuth(file, recordKey, token, expectRaw) {
  try {
    const raw = readFileSync(file, "utf8");
    /* ② 并发保护：文件在我们读之后被别人改过 → 放弃，绝不覆盖。 */
    if (typeof expectRaw === "string" && raw !== expectRaw) {
      return { ok: false, reason: "登录态文件在我们读取之后被改过（MiniMax Code 刚续过？）—— 放弃写入，避免覆盖它的更新" };
    }
    const doc = JSON.parse(raw);
    const records = doc && doc.records;
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      return { ok: false, reason: "登录态文件结构不认识（没有 records）—— 放弃写入" };
    }
    const rec = records[recordKey];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      return { ok: false, reason: "登录态文件里找不到对应的账号记录 —— 放弃写入" };
    }
    /* ③ 结构保持：只动这 4 个字段。 */
    rec.accessToken = String(token.accessToken || "");
    rec.refreshToken = String(token.refreshToken || "");
    rec.expiresAtMs = Number(token.expiresAtMs) || 0;
    rec.generation = Number(token.generation) || 0;
    const out = JSON.stringify(doc, null, 2);

    /* ① 原子写：同目录临时文件 → rename 覆盖。 */
    const tmp = file + ".bai-router.tmp";
    writeFileSync(tmp, out, "utf8");
    try {
      renameSync(tmp, file);
    } catch (e) {
      /* rename 失败：把临时文件清掉，原文件一个字节都没动。 */
      try { unlinkSync(tmp); } catch { /* 清理失败就算了，临时文件里也是同一份令牌 */ }
      return { ok: false, reason: "写回失败（rename 报错）：" + String((e && e.message) || e).slice(0, 120) };
    }
    return { ok: true, reason: "", raw: out };
  } catch (e) {
    /* ④ 任何异常都不动原文件。 */
    return { ok: false, reason: "写回失败：" + String((e && e.message) || e).slice(0, 120) };
  }
}

/* ---------- 请求头 ---------- */

/**
 * 造转发用的**整份**请求头。
 *
 * 为什么是「整份重建」而不是「在客户端头的基础上补几个」：
 * 客户端送来的 authorization / x-api-key / user-agent / origin / referer
 * **一律作废**（客户端的 base URL 上游根本不认，UA 也不是 MiniMaxAgent 的），
 * 由我们自己的顶上。只保留两个无害的协议头：anthropic-beta（Beta 特性开关）
 * 与 accept（流式协商）。
 *
 * ⚠️ 实测（2026-10-19，MiniMax Code 3.1.4）：**只有 `authorization: Bearer` 与
 *   `content-type: application/json` 是硬要求**，其余（x-api-key / origin /
 *   referer / anthropic-version / user-agent）**去掉仍然 200**。
 *   全套照发是为了与真客户端一致、也留一手；**不是**因为缺了会 401。
 *
 * @param {string} accessToken 本渠道自己的访问令牌
 * @param {object} [clientHeaders] 客户端送来的头（只取 anthropic-beta / accept / content-type / anthropic-version）
 * @returns {object} 小写键名的请求头
 */
export function mmBuildHeaders(accessToken, clientHeaders) {
  const c = clientHeaders || {};
  const h = {
    "content-type": c["content-type"] || "application/json",
    "anthropic-version": c["anthropic-version"] || "2023-06-01",
    "x-api-key": MM_PLACEHOLDER_KEY,
    "authorization": "Bearer " + String(accessToken == null ? "" : accessToken),
    "user-agent": MM_USER_AGENT,
    "origin": MM_ORIGIN,
    "referer": MM_REFERER,
  };
  if (c["anthropic-beta"]) h["anthropic-beta"] = String(c["anthropic-beta"]);
  if (c["accept"]) h["accept"] = String(c["accept"]);
  return h;
}

/* ---------- 请求体的工具定义（形状转换） ---------- */

/**
 * 把 Anthropic 的**嵌套**工具定义转成 MiniMax 托管端点认的**扁平**形状。
 *
 * ## 为什么必须转（实测，2026-10-19）
 *
 *   Claude Code 发的是 Anthropic 形状：
 *       { "type": "function", "function": { "name": "Read", "description": …, "input_schema": {…} } }
 *   而 MiniMax 托管端点只认**扁平**形状：
 *       { "type": "function", "name": "Read", "description": …, "input_schema": {…} }
 *
 *   原样透传嵌套形状，上游回：
 *       HTTP 400 {"type":"error","error":{"type":"invalid_request_error",
 *                "message":"invalid params, function name is empty (2013)"}}
 *
 *   ⚠ 这个错**极具误导性**：没有工具的请求一切正常（上游没东西可挑），
 *     一旦带上工具就整条对话失败。而 400 的正文常常是空的（被网关吞掉），
 *     面板上看不出是「工具定义形状不对」。
 *
 *   实测：嵌套 → 400；扁平 → 200；扁平 + 顶层 type:function → 200。
 *   所以转换后**保留顶层的 `type:"function"`**（上游认）。
 *
 * ## 只动 tools，不动别的
 *
 *   响应方向**不用**转：上游返回的 tool_use 本来就是标准 Anthropic 形状
 *   （`{"type":"tool_use","id":…,"name":…,"input":{…}}`），原样透传即可。
 *
 * @param {Array} tools Anthropic 形状的工具定义
 * @returns {Array} 扁平形状；已经是扁平的**原样保留**（用户可能自己填了扁平形状）
 */
export function mmNormalizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (!t || typeof t !== "object") return t;
    const fn = t.function;
    // 已经是扁平的（有顶层 name、没有 function 包装）→ 原样保留
    if (!fn || typeof fn !== "object") return t;
    if (typeof fn.name !== "string" || !fn.name) return t;
    return {
      type: typeof t.type === "string" ? t.type : "function",
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      input_schema: fn.input_schema || fn.parameters || { type: "object", properties: {} },
    };
  });
}

/**
 * 就地把请求体里的 tools 换成扁平形状，返回**新的** body Buffer（不改原对象）。
 *
 * 解析失败 / 没有 tools / body 不是对象 → 原样返回，**不做任何猜测**。
 *
 * @param {Buffer|string} body
 * @returns {Buffer}
 */
export function mmNormalizeBodyTools(body) {
  if (!body || !body.length) return body;
  let text = "";
  try { text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body); } catch { return body; }
  let j = null;
  try { j = JSON.parse(text); } catch { return body; }
  if (!j || typeof j !== "object" || Array.isArray(j) || !Array.isArray(j.tools)) return body;
  const next = mmNormalizeTools(j.tools);
  let out = "";
  try { out = JSON.stringify({ ...j, tools: next }); } catch { return body; }
  return Buffer.from(out, "utf8");
}

/* ---------- 令牌仓库（只存内存） ---------- */

/**
 * 造一个**只存内存**的令牌仓库。
 *
 * 内存里放三样：accessToken、refreshToken、expiresAtMs。
 * 除此之外什么都不落——不落 config.json、不落日志、不落面板。
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 注入用的 fetch（测试塞假实现）
 * @param {Function} [opts.now] 取当前 epoch 毫秒
 * @param {Function} [opts.readAuth] (file) => 记录|null
 * @param {string}   [opts.authPath] 登录态文件路径
 * @param {Function} [opts.log] 只接受**已经脱敏**的字符串
 * @param {number}   [opts.timeoutMs]
 */
export function createMmTokenStore(opts = {}) {
  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : (...a) => fetch(...a);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const readAuth = typeof opts.readAuth === "function" ? opts.readAuth : readMmAuthRecord;
  /* 读原文（写回的并发保护要用）与写回，都做成可注入的：
   * 测试里不碰真实文件，生产里用真的那套（原子写 + 结构保持）。 */
  const readRaw = typeof opts.readRaw === "function"
    ? opts.readRaw
    : (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
  const writeBack = typeof opts.writeBack === "function" ? opts.writeBack : writeBackAuth;
  const authPath = opts.authPath || mmAuthFilePath(opts.home);
  const log = typeof opts.log === "function" ? opts.log : () => { };
  const timeoutMs = Number(opts.timeoutMs) || MM_TOKEN_TIMEOUT_MS;

  /* 🔴 内存态。**只有这一处**放令牌值，别的任何地方都拿不到明文。 */
  const st = {
    accessToken: "",
    refreshToken: "",
    expiresAtMs: 0,
    recordKey: "",
    /** 我们手上这把刷新令牌是第几代（= 文件里 `generation` 的同口径）。
     *  用来分清「文件里的更新」与「我们内存里的更新」—— 刷新令牌一次性轮换，
     *  认错了就会把 MiniMax Code 的那把作废掉（或者反过来把自己的扔掉）。 */
    generation: 0,
    /** 已知这把刷新令牌被上游作废了（值本身）。
     *  记下来是为了**不重复去撞**：明知它死了还拿它去续期，就是拿上游当靶子刷。 */
    deadRefresh: "",
    /** 我们读到登录态文件时的**原文** —— 写回时的并发保护就靠它
     *  （文件在我们读之后被 MiniMax Code 改过 → 放弃写入，不覆盖它的更新）。 */
    authRaw: "",
    loaded: false,
    invalid: false,      // invalid_grant 之后为真：不再自动重试，等用户重新登录
    error: null,
    lastRenewAt: 0,
    renewCount: 0,
    nextAttemptAt: 0,    // 临时性失败后的冷却
    lastRecheckAt: 0,    // recheck() 的节流时刻
  };
  /** 并发去重：同一时刻只允许一次续期在飞（否则十个并发请求打十次上游，
   *  而 refresh token 是一次性轮换的——十次并发会前九次直接 invalid_grant）。 */
  let inflight = null;

  /** 把任何可能要往外说的字符串里的令牌值抹掉。兜底用，不是主要防线。 */
  function scrub(s) {
    let out = String(s == null ? "" : s);
    for (const t of [st.accessToken, st.refreshToken]) {
      if (t && t.length >= 8) out = out.split(t).join("«令牌已隐藏»");
    }
    return out;
  }

  /**
   * 重新读一遍登录态文件，灌进内存。
   *
   * @param {object} [o]
   * @param {boolean} [o.force] true = 无条件用文件里的刷新令牌覆盖内存里的。
   *   默认（false）只在「内存里还没有刷新令牌」「文件里是**另一个账号**」
   *   「文件里的是**更新的一代**」或「文件明显比我们内存里的新」时才覆盖。
   * @returns {{ok:boolean, reason:string|null, changed:boolean}}
   */
  function readAuthFile(o = {}) {
    const rec = readAuth(authPath);
    if (!rec) {
      st.loaded = true;
      st.error = "本机没读到 MiniMax 登录态——请先在 MiniMax Code 里登录";
      log(`MiniMax：没读到登录态（${scrub(authPath)}）`);
      return { ok: false, reason: st.error, changed: false };
    }
    const sameAccount = st.recordKey && st.recordKey === rec.recordKey;
    const incExp = Number(rec.expiresAtMs) || 0;
    const fileGen = Number(rec.generation) || 0;
    const fileAccessLive = incExp > now();                       // 文件里的访问令牌还有效
    const fileNewer = fileGen > (Number(st.generation) || 0);    // 文件是 MiniMax Code 续出来的
    const changed = st.refreshToken !== rec.refreshToken || st.accessToken !== rec.accessToken;
    /* 记下原文：写回时用它做并发保护（文件在我们读之后被改过就别写）。 */
    const raw = readRaw(authPath);
    if (typeof raw === "string") st.authRaw = raw;

    /* 🔴 该不该采用文件里那份？
     *
     *   刷新令牌是**一次性**的：MiniMax Code 续一次期，旧的当场作废。
     *   本模块和 MiniMax Code 用的是**同一把**，所以：
     *     · 文件里的更新（generation 更大 / 访问令牌还有效）→ 它是 MiniMax Code
     *       刚续出来的，**必须跟着换**，否则我们拿着已作废的那把去续期，
     *       只会得到 invalid_grant，然后**误报「登录态已失效」**——
     *       而用户明明好好地登录着 MiniMax Code。
     *     · 我们内存里的更新（我们续过、文件还没跟上）→ 保留内存里那份，
     *       否则会把我们自己的好令牌换成一把已经作废的。
     */
    const fileIsStale = !o.force && st.refreshToken && sameAccount && !fileAccessLive && !fileNewer;
    if (!fileIsStale) {
      st.accessToken = rec.accessToken || "";
      st.expiresAtMs = incExp;
      st.refreshToken = rec.refreshToken;
      st.recordKey = rec.recordKey;
      st.generation = fileGen;
      st.invalid = false;
      st.error = null;
      st.nextAttemptAt = 0;
      /* 文件给的是一把**没被我们撞死过**的令牌 → 死令牌那笔账可以清了 */
      if (st.deadRefresh && st.deadRefresh !== rec.refreshToken) st.deadRefresh = "";
    } else {
      log("MiniMax：登录态文件比我们内存里的旧（我们续过、文件还没跟上）——保留内存里那份");
    }
    st.loaded = true;
    log(`MiniMax：已从本机登录态读到凭据（账号键 ${scrub(rec.recordKey)}，刷新令牌长度 ${rec.refreshToken.length}，第 ${fileGen} 代）`);
    return { ok: true, reason: null, changed: changed && !fileIsStale };
  }

  /** 发一次续期请求。**只在这里**出现 refresh token 的明文。 */
  async function renew() {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: st.refreshToken,
      client_id: MM_CLIENT_ID,
      scope: MM_SCOPE,
      audience: MM_AUDIENCE,
    }).toString();

    let res = null, text = "";
    try {
      res = await fetchImpl(MM_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      st.error = "MiniMax 续期请求失败：" + scrub(String((e && e.message) || e)).slice(0, 120);
      st.nextAttemptAt = now() + MM_RETRY_COOLDOWN_MS;
      log(`MiniMax：续期请求失败（${st.error}）`);
      throw new Error(st.error);
    }

    let j = null;
    try { j = JSON.parse(text); } catch { /* 不是 JSON，按 HTTP 状态处理 */ }

    if (!res || !res.ok) {
      /* invalid_grant 的判据要**四处都看**：上游把它放在 error（"invalid_grant"）
       * 或 error_description（"this refresh token can no longer be used,
       * start a new authorization"）里，两处都出现过——只认一处就会漏判，
       * 漏判的后果是拿一句「续期失败」糊弄用户，而真相是「登录态没了，重试没用」。 */
      const code = String((j && j.error) || "");
      const desc = String((j && j.error_description) || "");
      const raw = desc || code || (res ? `HTTP ${res.status}` : "无响应");
      const invalidGrant = code.includes("invalid_grant")
        || desc.includes("invalid_grant")
        || desc.includes("can no longer be used")
        || desc.includes("start a new authorization");
      if (invalidGrant) {
        /* 刷新令牌已作废（被人用过，或换了账号）。**不再重试**——
         * 再刷多少次都是同一句 invalid_grant，只会把上游的失败计数推高。
         * 唯一的出路是用户去 MiniMax Code 重新登录。 */
        st.invalid = true;
        st.accessToken = "";
        /* 记下这把已经死了的刷新令牌：下一次 ensure() 见到它还握在手上，
         * 就不再去撞上游（换句话说：**文件换了新令牌才允许再试**）。 */
        st.deadRefresh = st.refreshToken;
        st.error = MM_LOGIN_INVALID_MSG;
        log(`MiniMax：续期被拒（invalid_grant）——登录态已失效，等待用户重新登录`);
        throw new Error(MM_LOGIN_INVALID_MSG);
      }
      st.error = "MiniMax 续期失败：" + scrub(raw).slice(0, 120);
      st.nextAttemptAt = now() + MM_RETRY_COOLDOWN_MS;
      log(`MiniMax：续期失败（${st.error}）`);
      throw new Error(st.error);
    }

    const at = j && j.access_token;
    if (!at || typeof at !== "string" || !at.trim()) {
      st.error = "MiniMax 续期返回里没有 access_token";
      st.nextAttemptAt = now() + MM_RETRY_COOLDOWN_MS;
      log(`MiniMax：续期返回里没有 access_token`);
      throw new Error(st.error);
    }

    st.accessToken = at;
    /* 🔴🔴 轮换：刷新成功后**立刻**把返回的新 refresh_token 存进内存。
     * 旧的那份已经作废（一次性令牌），不换就等于把凭据链打断。 */
    if (j.refresh_token && typeof j.refresh_token === "string" && j.refresh_token.trim()) {
      st.refreshToken = j.refresh_token.trim();
    }
    /* 我们这把比文件里那份新了一代 → 文件里那把已经作废（我们把它用了）。
     * 记下来是为了下次读文件时**不**把已作废的那把换回来。 */
    st.generation = (Number(st.generation) || 0) + 1;
    const exp = Number(j.expires_in) || 3600;
    st.expiresAtMs = now() + exp * 1000;
    st.invalid = false;
    st.error = null;
    st.nextAttemptAt = 0;
    st.lastRenewAt = now();
    st.renewCount += 1;
    log(`MiniMax：续期成功（访问令牌长度 ${st.accessToken.length}，有效期 ${exp} 秒，刷新令牌已轮换）`);

    /* 🔴 写回登录态文件（MiniMax Code 自己的凭据库）。
     *
     *   刷新令牌是一次性的：我们刚把旧的那把用掉了，**文件里那份已经是死的**。
     *   不写回的话：MiniMax Code 下次要发请求时撞 invalid_grant → 要重新登录；
     *   **本模块自己重启后也救不回来**（重启会读到那把已死的令牌）。
     *   写回之后，文件里始终是最新那把，两边都接着用。
     *
     *   写失败**不影响本模块继续工作**（内存里那把是好的）—— 只记日志。 */
    try {
      const wr = writeBack(authPath, st.recordKey, {
        accessToken: st.accessToken,
        refreshToken: st.refreshToken,
        expiresAtMs: st.expiresAtMs,
        generation: st.generation,
      }, st.authRaw);
      if (wr && wr.ok) {
        if (typeof wr.raw === "string") st.authRaw = wr.raw;
        log(`MiniMax：已把轮换后的令牌写回登录态文件（第 ${st.generation} 代）`);
      } else {
        log(`MiniMax：写回登录态文件未成功（${scrub((wr && wr.reason) || "未知原因")}）—— `
          + "本模块仍可继续用，但 MiniMax Code 可能需要重新登录一次");
      }
    } catch (e) {
      log(`MiniMax：写回登录态文件出错（${scrub(String((e && e.message) || e)).slice(0, 100)}）`);
    }
    return st.accessToken;
  }

  /**
   * 拿一个可用的访问令牌：够新就直接给，快到期（或没有）就续期。
   *
   * @returns {Promise<string>} 访问令牌
   * @throws {Error} 消息里**不含**令牌值
   */
  async function ensure() {
    /* 手上这把还够新 → 直接用（不碰文件、不碰网络）。 */
    if (st.accessToken && st.expiresAtMs && st.expiresAtMs - now() > MM_RENEW_WINDOW_MS) {
      return st.accessToken;
    }
    if (!st.loaded) readAuthFile();

    /* 到期了（或此前被判过失效）→ **先读一遍文件**：MiniMax Code 可能刚续过。
     * 登录态文件是它的凭据库，它续了期我们这边就该跟着换；抱着已经被它
     * 轮换掉的那把刷新令牌去续期，只会拿到 invalid_grant，然后**误报
     * 「登录态已失效」**——而用户明明好好地登录着 MiniMax Code。 */
    readAuthFile();
    if (st.accessToken && st.expiresAtMs && st.expiresAtMs - now() > MM_RENEW_WINDOW_MS) {
      /* 文件里那把是活的 → 跟着换了，作废状态一并清掉（不必打扰用户）。 */
      st.invalid = false;
      st.error = null;
      st.nextAttemptAt = 0;
      return st.accessToken;
    }

    if (st.invalid) {
      /* 已知这把刷新令牌被上游作废，而文件也没给出新的 →
       * 再撞一次只会得到同一句 invalid_grant（拿上游当靶子刷）。
       * 文件一旦换了新令牌，readAuthFile() 会清掉 deadRefresh，续期才被允许。 */
      st.error = MM_LOGIN_INVALID_MSG;
      throw new Error(MM_LOGIN_INVALID_MSG);
    }
    if (!st.refreshToken) {
      /* 文件里没有 / 没读到 → 只有一条出路：去 MiniMax Code 登录。 */
      st.error = "本机没读到 MiniMax 登录态——请先在 MiniMax Code 里登录";
      throw new Error(st.error);
    }
    if (st.deadRefresh && st.deadRefresh === st.refreshToken) {
      /* 这把已经死过一次，文件也没换新的 → 不再撞上游。 */
      st.error = MM_LOGIN_INVALID_MSG;
      throw new Error(MM_LOGIN_INVALID_MSG);
    }
    if (st.nextAttemptAt && now() < st.nextAttemptAt) {
      throw new Error("MiniMax 续期刚刚失败过，稍后再试（不会反复重试）");
    }
    if (inflight) return inflight;
    const p = renew();
    inflight = p;
    try {
      return await p;
    } finally {
      if (inflight === p) inflight = null;
    }
  }

  /**
   * 「这一格能不能用」的判据 —— 内存里没有可用令牌时，**再去读一遍登录态文件**。
   *
   * 🔴 为什么这是承重的：登录态文件是 MiniMax Code 的凭据库，用户完全可能
   *   **在路由台启动之后**才登录 MiniMax Code（先装路由台、后来才登录，
   *   这是最常见的顺序）。此时内存里没有令牌，而转移链的判据只问内存
   *   → mm 被**永久跳过** → 请求落到链上的下一家 → 用户以为在用 MiniMax，
   *   实际用的是别家。2026-10-19 实测：登录态文件出现后再请求，mm 仍报
   *   「未配置」，只有点「重新读取登录态」才恢复 —— 那是死锁。
   *
   * 节流：本地读一个 JSON 很便宜，但每条请求都读没必要；默认 15 秒一次，
   *   所以用户登录后最多 15 秒这一格就生效，不需要用户做任何操作。
   */
  function recheck() {
    const s0 = snapshot();
    if (s0.configured && !s0.invalid) return s0;
    const t = now();
    if (st.lastRecheckAt && t - st.lastRecheckAt < MM_RECHECK_MS) return s0;
    st.lastRecheckAt = t;
    try { readAuthFile(); } catch { /* 读不到就按「未配置」处理，不抛 */ }
    return snapshot();
  }

  /**
   * 状态快照。**不含任何令牌值**——只有长度、有效期、是否有效。
   * 这个对象会原样进 /api/status（面板能看见），所以它必须先经过审查。
   */
  function snapshot() {
    const exp = st.expiresAtMs;
    const remain = exp ? exp - now() : 0;
    return {
      /* 「有一把**能用**的令牌」：登录态作废（invalid）之后，那把刷新令牌虽然还在
       * 内存里（留着好说清"是哪一把作废了"），但它已经不能换出访问令牌了——
       * 所以这里算**没配置**。转移链据此跳过这一格，面板则走 invalid 分支报红。 */
      configured: !!(st.accessToken || (st.refreshToken && !st.invalid)),
      hasAccess: !!st.accessToken,
      hasRefresh: !!st.refreshToken,
      /** 自动续期型凭据：面板据此不报「剩 N 天」的黄色提醒（它会自己续）。 */
      autoRenew: true,
      /** 登录态作废（invalid_grant 之后）：面板据此报红并给出「重新登录」的指引。 */
      invalid: st.invalid,
      error: st.error,
      expAt: exp ? new Date(exp).toISOString() : null,
      expiresInDays: exp ? Math.max(0, Math.ceil(remain / 86400000)) : null,
      expiresInSec: exp ? Math.max(0, Math.round(remain / 1000)) : null,
      /** 访问令牌**长度**（不是内容）。面板要显示"手上有一把多长的令牌"时用。 */
      accessLen: st.accessToken ? st.accessToken.length : 0,
      renewCount: st.renewCount,
      lastRenewAt: st.lastRenewAt ? new Date(st.lastRenewAt).toISOString() : null,
      /** 登录态文件路径（只读来源，面板要显示"从哪读的"）。 */
      authPath,
      /** 账号键（不是令牌；只用于让用户分辨"读的是哪个账号"）。 */
      recordKey: st.recordKey || null,
    };
  }

  return { ensure, renew, readAuthFile, recheck, snapshot, get state() { return st; } };
}
