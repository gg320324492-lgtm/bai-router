/**
 * middleware.mjs —— 声明式 middleware 插件的**解析、校验与应用层**
 * （纯逻辑、零依赖、零 IO、零时钟）
 *
 * ── 它补的是哪个洞 ──────────────────────────────────────────────────────
 * 中转（`src/server/server.mjs`）把客户端的请求转给上游、再把上游的应答转回
 * 客户端，中间只有**写死在代码里**的几处改写（`mmPrepareHeaders` /
 * `mmPrepareBody` 那种按渠道硬编码的钩子）。用户想让「sn 这一档加个头」、
 * 「wb 的应答带个标记」、「某家的 temperature 压到 0.2」，现在只能改代码 ——
 * 而改代码改的是**热路径**，且每个人的需求都得进仓库。
 *
 * magpie 的答案是**网关中间件插件**：一段 JS 挂在网关上，在请求去上游的路上、
 * 在应答回客户端的路上改东西。
 *
 * 本模块是那条路上的**声明式一档**：一份 JSON 声明描述若干条规则（什么时候、
 * 对哪个请求、改什么），由本模块解析、校验、应用。接线（把它挂进 `server.mjs`
 * 的中转链）不在本模块里 —— 本模块只管两件事：「这份声明说得对不对」，
 * 以及「照它改完之后，这份请求还合不合法」。
 *
 * ── magpie 对应哪个文件 ────────────────────────────────────────────────
 *   · `internal/middleware/middleware.go` —— 中间件插件的发现、加载与钩子调度
 *     （onRequest / onProvider / onEvent / onResponse）。这里是同一件事的
 *     **纯数据**版。
 *   · `internal/middleware/run.go` —— 一条请求上的钩子链：谁先谁后、一个钩子
 *     抛错了怎么办、应答怎么逐事件过一遍。这里对应 {@link applyRequest} 与
 *     {@link applyResponse}。
 *   · `internal/gwmw/gwmw.go` —— 「中间件这个点」的接口（Agent / Run / To），
 *     也就是中间件被告知「这次是发给哪一家」的形状。对应这里的请求上下文
 *     （provider / tier / model / protocol / path / stream / headers / params）。
 *   · `plugins/middleware/` —— magpie 内置的 JS 中间件插件本体（本仓没有对应物，
 *     见下面第 1 条）。
 *
 * ── 与 magpie 有意不同的点（以及原因）──────────────────────────────────
 *   1. **magpie 的中间件是代码，本仓的中间件是数据。**
 *      magpie 的中间件是一段真的 JS，在网关进程内的 moejs 里跑（`internal/
 *      middleware`）—— 能读能写能发网络请求，能力无限的代价是**分发物的权力
 *      也无限**。本仓的中间件**只有一份 JSON 声明**：它能描述「改什么」，
 *      **不能执行代码**。这是我们自己的取舍 —— 能跑任意代码的分发物是另一个
 *      量级的风险（那个量级要另配沙箱、权限模型与审计），不做；分发物的权力
 *      越小，审它的人越敢点「装」。
 *   2. **失败策略相反：magpie fail open，本仓 fail closed。**
 *      magpie 的钩子抛错就「原样放行」（请求不变）。本仓在**改写结果不合法**
 *      （比如把模型改成这家根本没有的）时**拒绝这次改写并说清原因**。理由：
 *      magpie 是代码插件，没有「声明写得对不对」这一层，钩子出错多半是意外，
 *      原样放行对；这里是**声明写错了**，原样放行等于把「我以为改了」藏起来
 *      —— 用户永远不知道规则没生效，下次还会踩。改写失败时**不给半改的结果**
 *      （`request` 是 null），让接线层决定怎么答。
 *   3. **改不了应答正文。**
 *      magpie 有 `onEvent` / `onResponse`，能在 SSE 流里逐事件改、也能改整包
 *      JSON。本仓这一层**只改应答头**：应答到这层时可能已经是一个字节流
 *      （SSE），要改正文就得把整份应答缓冲下来再拆事件重切 —— 那是接线层的
 *      事件管道该干的事，不该塞进纯逻辑层。
 *   4. **不许碰凭据。**
 *      magpie 的中间件能读能改整个请求体与请求头（包括 authorization）。本仓
 *      **明确拒绝**在声明里设置/删除凭据头，也不许拿凭据头当匹配条件 ——
 *      能改凭据的插件 = 能把你的 key 发到别处的插件。同理，凭据也不许作为
 *      顶层字段或参数名出现在声明里：声明是要分发给别人的东西，里面带 key
 *      等于把你的 key 发给所有装这个插件的人。
 *   5. **没有时间预算，没有钩子状态。**
 *      magpie 给每个钩子 250ms（事件 50ms）的预算，超时就打断。本仓是纯函数，
 *      没有「跑多久」这回事：一次改写要么产出合法结果，要么报错。
 *   6. **校验不用 JSON Schema，用手写的人话**（与 `plugin.mjs` 同口径）。
 *   7. **只吃 JSON，不吃 YAML**（与 `plugin.mjs` 同口径：YAML 解析器是外部依赖，
 *      而本仓不引新依赖；要 YAML 就先在解析前转成 JSON）。
 *
 * ── 声明格式（完整例子）────────────────────────────────────────────────
 *   {
 *     "manifestVersion": 1,
 *     "id": "my-rules",
 *     "name": "我的规则",
 *     "rules": [
 *       {
 *         "when": { "provider": "sn", "tier": "claude-opus-5" },
 *         "request": {
 *           "setHeaders": { "X-Foo": "bar" },
 *           "model": "glm-5.2",
 *           "setParams": { "temperature": 0.2 }
 *         }
 *       },
 *       {
 *         "when": { "provider": "wb" },
 *         "response": { "setHeaders": { "X-Budget": "on" } }
 *       }
 *     ]
 *   }
 *
 * 字段说明：
 *   · `manifestVersion` —— 格式版本，现在只认 1；不认识就报错（别猜着解析）。
 *   · `id` —— 这份声明的键（小写字母 / 数字 / 短横线），注册表按它认领。
 *   · `name` —— 面板上显示的名字；不给就是 `id`。
 *   · `rules` —— 规则清单，**按声明顺序依次作用**（见下）。
 *
 * `when`（什么时候这条规则管用）—— 各个条件之间是**与**，同一个条件写成数组
 *   是**或**；**不写某个条件就是不管它**：
 *   · `provider` —— 渠道键（"sn" / "wb" / 插件渠道的键），字符串或数组。
 *   · `tier` —— Claude 档位（"claude-opus-5" 等四档），字符串或数组。
 *   · `model` —— **发给上游的那个模型 id**（如 "glm-5.2"），字符串或数组。
 *   · `protocol` —— 客户端的协议（"anthropic" / "responses" / "gemini"）。
 *   · `path` —— 请求路径（精确匹配），字符串或数组。
 *   · `stream` —— 是不是流式请求（true / false）。
 *   · `header` —— 请求头条件：`{"x-client": "claude-code"}`；值也可以是数组。
 *     头名大小写不敏感；**凭据头不许当条件**（见差异第 4 条）。
 *
 * `request`（改请求）—— 可以同时写多项：
 *   · `model` —— 换模型。**必须落在这一家能用的模型清单里**，否则拒绝并说清
 *     能用的是哪几个（改坏了上游只会回一句「不认识这个模型」）。
 *   · `setParams` —— 设参数（temperature / max_tokens …）。已知的几个会做
 *     类型与范围检查。
 *   · `removeParams` —— 删参数。
 *   · `setHeaders` —— 设请求头。头名一律小写化；值不许带换行（那是头注入）。
 *   · `removeHeaders` —— 删请求头（**凭据头不许删**）。
 *
 * `response`（改应答）—— 只能改头：
 *   · `setHeaders` / `removeHeaders`。
 *
 * ── 顺序（说清楚，别猜）────────────────────────────────────────────────
 *   · **规则之间**：按 `rules` 里的声明顺序依次作用，**后面的覆盖前面的**。
 *   · **规则之间是渐进的**：后一条规则看到的是**前面规则改过之后**的请求
 *     （magpie 的钩子链也是这个语义：后一个钩子拿到的是前一个留下的）。
 *   · **一条规则内部**的固定次序：`model` → 参数 → 头（先定「改什么」，再贴
 *     「怎么带」）。
 *   · **多条声明之间**：按注册表里的登记顺序依次作用，后面的覆盖前面的。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────
 *   · **零依赖**：本文件不 import 仓库里任何模块，也不用任何三方包。
 *   · **零 IO / 零时钟**：不读盘、不联网、不取 `Date.now()`（时间由
 *     `opts.now` 传进来）。
 *   · **不写盘、不记日志**：怎么落盘、怎么上报，交给调用方。
 */

/* ====================================================================== *
 * 常量
 * ====================================================================== */

/** 声明格式版本。现在只认 1 —— 版本不认识时**报错**，不猜着解析。 */
export const MIDDLEWARE_MANIFEST_VERSION = 1;

/**
 * Claude 的四档（与 `server.mjs` 的 TIERS、`plugin.mjs` 的 TIER_KEYS 同步；
 * 三处都有防漂移断言）。
 *
 * 为什么单独抄一份：校验声明里写的档位得知道这四个名字，而本模块零依赖、
 * 不许 import 仓库里任何模块，只能把名单搬过来。
 */
export const TIER_KEYS = Object.freeze([
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5",
]);

/** 客户端能说的协议（本仓的入向协议：Anthropic 原生 + Responses + Gemini）。 */
export const PROTOCOLS = Object.freeze(["anthropic", "responses", "gemini"]);

/**
 * 渠道键的形状：小写字母、数字、短横线；首字符必须是字母或数字；总长 ≤ 40。
 *
 * 与 `plugin.mjs` 的 CHANNEL_KEY_RE 同形（那边另有防漂移断言）。
 */
export const CHANNEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * 凭据头的名字（小写）。声明里不许设置、不许删除，也不许拿它当匹配条件。
 *
 * 为什么连 cookie / set-cookie 也在内：cookie 里带的就是会话凭据，
 * 「改名绕过检查」这种门是留不住的 —— 名单只能越写越宽，不能指望作者自觉。
 */
export const CREDENTIAL_HEADERS = Object.freeze([
  "authorization", "proxy-authorization", "x-api-key", "api-key", "apikey",
  "x-auth-token", "x-access-token", "x-goog-api-key", "openai-api-key",
  "x-amz-security-token", "cookie", "set-cookie",
]);

/**
 * 声明里**不许**出现的字段名 / 参数名（凭据）。
 *
 * 与 `plugin.mjs` 的 CREDENTIAL_FIELDS 同一份名单 —— 理由也一样：声明是要
 * 分发给别人的东西，一份带 key 的声明装到十台机器上，就是一把 key 摊给十个
 * 不相干的人（还多半进了 git）。凭据由用户在面板里填，所以这里做成**明确
 * 拒绝**而不是「忽略这个字段」—— 静默忽略会让作者以为 key 已经带上了。
 */
const CREDENTIAL_FIELDS = Object.freeze([
  "apiKey", "api_key", "apikey", "key", "token", "accessToken", "access_token",
  "refreshToken", "refresh_token", "secret", "secretKey", "secret_key",
  "password", "credential", "credentials", "authorization", "bearer",
  "sessionToken", "session_token", "cookie",
]);

/** 声明顶层允许出现的字段（其余一律当「不认识的字段」报错）。 */
const KNOWN_FIELDS = Object.freeze(["manifestVersion", "id", "name", "rules"]);

/** `when` 里允许出现的条件。 */
const KNOWN_WHEN_FIELDS = Object.freeze([
  "provider", "tier", "model", "protocol", "path", "stream", "header",
]);

/** `request` 里允许出现的改写动作。 */
const KNOWN_REQUEST_FIELDS = Object.freeze([
  "model", "setParams", "removeParams", "setHeaders", "removeHeaders",
]);

/** `response` 里允许出现的改写动作（只许改头）。 */
const KNOWN_RESPONSE_FIELDS = Object.freeze(["setHeaders", "removeHeaders"]);

/**
 * 已知参数的类型与范围。
 *
 * 温度上限取 1（本仓的请求体一律是 Anthropic 形状，Anthropic 的上限是 1）：
 * 放宽到 OpenAI 的 2 会让 Anthropic 上游直接 400 —— 声明期报错比运行时被上游
 * 拒掉好。
 */
const PARAM_CHECKS = Object.freeze({
  temperature: { type: "number", min: 0, max: 1 },
  top_p: { type: "number", min: 0, max: 1 },
  max_tokens: { type: "integer", min: 1 },
  top_k: { type: "integer", min: 0 },
  seed: { type: "integer" },
  stream: { type: "boolean" },
  stop: { type: "stringArray" },
  stop_sequences: { type: "stringArray" },
});

/* ====================================================================== *
 * 小工具（纯函数）
 * ====================================================================== */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function cloneJson(v) {
  if (Array.isArray(v)) return v.map(cloneJson);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = cloneJson(v[k]);
    return out;
  }
  return v;
}

/**
 * jsonSafe —— 这个值能不能原样放进请求体。
 *
 * JSON 里没有 undefined / 函数 / NaN，放进去会被悄悄丢掉或变成 null：那样的
 * 改写是「静默改坏」，正是这一层要挡掉的。
 */
function isJsonSafe(v) {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJsonSafe);
  if (isPlainObject(v)) return Object.values(v).every(isJsonSafe);
  return false;
}

/** 头名的形状：HTTP 的 token 字符集（不含空格与控制字符）。 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 头值不许带 CR/LF —— 那是头注入 / 应答分裂。 */
const HEADER_VALUE_BAD_RE = /[\r\n]/;

/** 把一组错误压成一句人话（面板与命令行都用它）。 */
export function formatErrors(errors) {
  const list = Array.isArray(errors) ? errors : [];
  return list
    .map((e) => (e && e.field ? `${e.field}：${e.message}` : String((e && e.message) || e)))
    .join("\n");
}

/** JSON.parse 的报错是英文的机器话，这里翻成「第几行第几列附近」。 */
function jsonErrText(e, text) {
  const raw = String((e && e.message) || e);
  const m = /at position (\d+)/i.exec(raw);
  let where = "";
  if (m) {
    const pos = Number(m[1]);
    const line = text.slice(0, pos).split("\n").length;
    const col = pos - (text.lastIndexOf("\n", pos - 1) + 1) + 1;
    where = `第 ${line} 行第 ${col} 列`;
  }
  const tail = where ? `（${where}）` : "";
  /* Node 各版本的措辞不一样（20 之后从 "Unexpected token" 改成了 "Expected …"），
     所以按**语义**分派，不按原文。 */
  if (/Unexpected end of JSON input/i.test(raw)) {
    return `内容提前结束了${tail}：多半是少了一个 } 或一个引号。`;
  }
  if (/after property value/i.test(raw)) {
    return `某个值后面少了逗号或 }${tail}。`;
  }
  if (/double-quoted property name/i.test(raw)) {
    return `多了一个逗号${tail}：JSON 里属性名得带双引号，末尾不能多逗号。`;
  }
  if (/Unexpected token/i.test(raw)) {
    return `这里多（或少）了一个不该有的符号${tail}：${raw}`;
  }
  if (/^Expected /i.test(raw)) {
    return `JSON 语法不对${tail}：${raw}`;
  }
  return where ? `${where}：${raw}` : raw;
}

/* ====================================================================== *
 * ① 解析
 * ====================================================================== */

/**
 * 把一份声明文本读成对象。
 *
 * ⚠ **只吃 JSON**：YAML 的解析器是外部依赖，而本仓不引新依赖；要 YAML 就先在
 *   解析前转成 JSON。
 *
 * 失败时**抛错**（消息是人话）：JSON 语法错、顶层不是对象、空文件。
 *
 * @param {string} text 声明文本
 * @returns {object} 解析出来的普通对象
 */
export function parseMiddlewareManifest(text) {
  if (typeof text !== "string") {
    throw new Error(`声明必须是一段文本（字符串），拿到的是 ${text === null ? "null" : typeof text}。`);
  }
  if (!text.trim()) {
    throw new Error("声明是空的 —— 没有内容可解析。");
  }
  if (!/^\s*\{/.test(text)) {
    throw new Error(
      "声明的顶层得是一个 JSON 对象（以 { 开头）。"
      + "本程序只吃 JSON —— YAML 解析器是外部依赖，而本仓不引新依赖；"
      + "要 YAML 就先在解析前转成 JSON。"
    );
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`声明不是合法的 JSON：${jsonErrText(e, text)}`);
  }
  if (!isPlainObject(obj)) {
    throw new Error("声明的顶层必须是一个 JSON 对象（{ … }），不是数组或标量。");
  }
  return obj;
}

/* ====================================================================== *
 * ② 校验
 * ====================================================================== */

/**
 * 逐项校验一份声明，并给出**人话**错误。
 *
 * 返回 `{ ok, errors, manifest }`：
 *   · `ok` —— 全过才为 true；
 *   · `errors` —— 每条 `{ field, message }`，`message` 是**给人看的中文**；
 *   · `manifest` —— 过了之后的**归一化 + 编译好**的声明（没过就是 null）。
 *     归一化把「字符串或数组」统一成数组、把头名小写化；编译后可以直接喂给
 *     {@link applyRequest} / {@link applyResponse}，不用再验一遍。
 *
 * @param {object} obj 待校验的声明（一般是 {@link parseMiddlewareManifest} 的产物）
 * @returns {{ok:boolean, errors:{field:string,message:string}[], manifest:object|null}}
 */
export function validateMiddlewareManifest(obj) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (!isPlainObject(obj)) {
    return {
      ok: false,
      errors: [{ field: "", message: "声明的顶层必须是一个 JSON 对象（{ … }），不是数组或标量。" }],
      manifest: null,
    };
  }

  /* ① 凭据字段 —— 先查，因为它比「不认识的字段」更该被单独点名：
   *    作者以为带上了 key，实际被拒时若只说「不认识的字段」，他多半会改成
   *    随便一个别的名字再试一遍。 */
  for (const k of Object.keys(obj)) {
    if (CREDENTIAL_FIELDS.includes(k)) {
      fail(k, `声明里不许带凭据字段「${k}」：声明是要分发给别人的东西，`
        + "里面带 key 等于把你的 key 发给所有装这个声明的人。凭据请在面板里填。");
    }
  }

  /* ② 不认识的字段 —— 报错而不是忽略：`setHeders` 这种手误若被静默忽略，
   *    这份声明会以「没改头」的样子通过，用户看到的是另一种错，绕远路。 */
  for (const k of Object.keys(obj)) {
    if (!KNOWN_FIELDS.includes(k) && !CREDENTIAL_FIELDS.includes(k)) {
      fail(k, `声明里有不认识的字段「${k}」：可用的字段只有 ${KNOWN_FIELDS.join("、")}。`);
    }
  }

  /* ③ 格式版本 */
  const mv = obj.manifestVersion;
  if (mv === undefined) {
    fail("manifestVersion", `声明缺少「manifestVersion」：这是声明的格式版本，本程序只认 ${MIDDLEWARE_MANIFEST_VERSION}。`);
  } else if (typeof mv !== "number" || !Number.isInteger(mv)) {
    fail("manifestVersion", `格式版本得是整数（现在认 ${MIDDLEWARE_MANIFEST_VERSION}），拿到的是 ${JSON.stringify(mv)}。`);
  } else if (mv !== MIDDLEWARE_MANIFEST_VERSION) {
    fail("manifestVersion", `这份声明的格式版本是 ${mv}，本程序只认 ${MIDDLEWARE_MANIFEST_VERSION}：`
      + "新版本写的东西旧程序读不了，别猜着解析。");
  }

  /* ④ 声明的键 */
  let id = null;
  if (obj.id === undefined) {
    fail("id", "声明缺少「id」：这是这份声明的键（注册表按它认领），"
      + "只许小写字母、数字和短横线。");
  } else if (typeof obj.id !== "string" || !obj.id.trim()) {
    fail("id", "声明的键得是一段非空的文字。");
  } else {
    id = obj.id.trim();
    if (!CHANNEL_KEY_RE.test(id)) {
      fail("id", `声明的键「${id}」不合法：只许小写字母、数字和短横线（像 my-rules、rule2），`
        + "而且第一个字符得是字母或数字。");
    }
  }

  /* ⑤ 显示名（不给就是 id） */
  let name = null;
  if (obj.name !== undefined && obj.name !== null) {
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      fail("name", "显示名不能为空。");
    } else if (obj.name.trim().length > 60) {
      fail("name", "显示名太长了（60 个字以内）。");
    } else {
      name = obj.name.trim();
    }
  }

  /* ⑥ 规则清单 */
  const rules = [];
  if (obj.rules === undefined) {
    fail("rules", "声明缺少「rules」：规则清单（什么时候、对哪个请求、改什么）。");
  } else if (!Array.isArray(obj.rules)) {
    fail("rules", "规则清单得是一个数组（[{…}, {…}] 这样）。");
  } else if (!obj.rules.length) {
    fail("rules", "规则清单是空的：一份什么都不改的声明没有装的理由。");
  } else {
    obj.rules.forEach((r, i) => {
      const rule = validateRule(r, i, fail);
      if (rule) rules.push(rule);
    });
  }

  if (errors.length) return { ok: false, errors, manifest: null };

  return {
    ok: true,
    errors: [],
    manifest: {
      compiled: true,
      manifestVersion: MIDDLEWARE_MANIFEST_VERSION,
      id,
      name: name || id,
      rules,
    },
  };
}

/**
 * 校验一条规则，并把它归一化成「每个条件都是数组」的形状。
 *
 * 归一化是为了热路径：匹配时不用再判「这是字符串还是数组」。
 */
function validateRule(raw, index, fail) {
  const at = `rules[${index}]`;
  if (!isPlainObject(raw)) {
    fail(at, `第 ${index + 1} 条规则得是一个对象（{"when": …, "request": …} 这样）。`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (!["when", "request", "response"].includes(k)) {
      fail(`${at}.${k}`, `第 ${index + 1} 条规则里多了不认识的字段「${k}」：只许 when、request、response。`);
    }
  }
  if (raw.request === undefined && raw.response === undefined) {
    fail(at, `第 ${index + 1} 条规则既没有 request 也没有 response：它什么也不做，`
      + "留着只会让人以为规则生效了。");
    return null;
  }

  const when = validateWhen(raw.when, at, fail);
  const request = raw.request === undefined || raw.request === null
    ? null : validateRequest(raw.request, `${at}.request`, fail);
  const response = raw.response === undefined || raw.response === null
    ? null : validateResponse(raw.response, `${at}.response`, fail);
  if (!when && !request && !response) return null;
  return { when: when || emptyWhen(), request, response };
}

function emptyWhen() {
  return {
    provider: [], tier: [], model: [], protocol: [], path: [], stream: null, header: {},
  };
}

/** 校验并归一化 `when`。 */
function validateWhen(raw, at, fail) {
  if (raw === undefined || raw === null) return null;
  const field = `${at}.when`;
  if (!isPlainObject(raw)) {
    fail(field, "when 得是一个对象（{\"provider\": \"sn\"} 这样）。");
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (!KNOWN_WHEN_FIELDS.includes(k)) {
      fail(`${field}.${k}`, `when 里有不认识的字段「${k}」：只许 ${KNOWN_WHEN_FIELDS.join("、")}。`);
    }
  }

  const out = emptyWhen();

  out.provider = stringList(raw.provider, `${field}.provider`, fail, "渠道键");
  out.tier = stringList(raw.tier, `${field}.tier`, fail, "档位");
  out.model = stringList(raw.model, `${field}.model`, fail, "模型 id");
  out.protocol = stringList(raw.protocol, `${field}.protocol`, fail, "协议");
  out.path = stringList(raw.path, `${field}.path`, fail, "路径");

  /* 档位与协议是有限集合：写错一个字母的档位名，规则会**永远不命中**，
     而作者以为它在生效 —— 这种错必须在声明期就被点名。 */
  for (const t of out.tier) {
    if (!TIER_KEYS.includes(t)) {
      fail(`${field}.tier`, `档位「${t}」不认：只认 ${TIER_KEYS.join(" / ")}。`);
    }
  }
  for (const p of out.protocol) {
    if (!PROTOCOLS.includes(p)) {
      fail(`${field}.protocol`, `协议「${p}」不认：只认 ${PROTOCOLS.join(" / ")}。`);
    }
  }
  for (const pv of out.provider) {
    if (!CHANNEL_KEY_RE.test(pv)) {
      fail(`${field}.provider`, `渠道键「${pv}」不合法：只许小写字母、数字和短横线。`);
    }
  }

  if (raw.stream !== undefined && raw.stream !== null) {
    if (typeof raw.stream !== "boolean") {
      fail(`${field}.stream`, "stream 得是 true 或 false（这次请求是不是流式）。");
    } else {
      out.stream = raw.stream;
    }
  }

  if (raw.header !== undefined && raw.header !== null) {
    if (!isPlainObject(raw.header)) {
      fail(`${field}.header`, "header 得是一个对象（{\"x-client\": \"claude-code\"} 这样）。");
    } else {
      for (const [name, want] of Object.entries(raw.header)) {
        const lname = String(name).trim().toLowerCase();
        if (!HEADER_NAME_RE.test(lname)) {
          fail(`${field}.header.${name}`, `头名「${name}」不合法：请求头名只许 HTTP 的 token 字符（字母、数字与 !#$%&'*+-.^_\`|~）。`);
          continue;
        }
        if (CREDENTIAL_HEADERS.includes(lname)) {
          fail(`${field}.header.${name}`, `不许拿凭据头「${lname}」当匹配条件：`
            + "条件是要分发给别人看的，等于把凭据写进了声明。");
          continue;
        }
        const vals = stringList(want, `${field}.header.${name}`, fail, "头值");
        out.header[lname] = vals;
      }
    }
  }

  return out;
}

/**
 * 一个「字符串或数组」的清单：字符串 → 单元素数组；数组 → 原样。
 * 空数组 = 不约束这个维度。
 */
function stringList(raw, field, fail, what) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const v of list) {
    if (typeof v !== "string" || !v.trim()) {
      fail(field, `${what}得是非空的文字。`);
      continue;
    }
    out.push(v.trim());
  }
  return out;
}

/** 校验并归一化 `request`。 */
function validateRequest(raw, field, fail) {
  if (!isPlainObject(raw)) {
    fail(field, "request 得是一个对象（{\"setHeaders\": …} 这样）。");
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (!KNOWN_REQUEST_FIELDS.includes(k)) {
      fail(`${field}.${k}`, `request 里有不认识的字段「${k}」：只许 ${KNOWN_REQUEST_FIELDS.join("、")}。`);
    }
  }
  const out = { model: undefined, setParams: {}, removeParams: [], setHeaders: {}, removeHeaders: [] };

  if (raw.model !== undefined && raw.model !== null) {
    if (typeof raw.model !== "string" || !raw.model.trim()) {
      fail(`${field}.model`, "模型名得是非空的文字。");
    } else {
      out.model = raw.model.trim();
    }
  }

  const params = stringMap(raw.setParams, `${field}.setParams`, fail);
  for (const [k, v] of Object.entries(params)) {
    if (CREDENTIAL_FIELDS.includes(k)) {
      fail(`${field}.setParams.${k}`, `参数名「${k}」像凭据：声明是要分发给别人的东西，`
        + "里面带 key 等于把你的 key 发给所有装这个声明的人。");
      continue;
    }
    const check = checkParam(k, v);
    if (check) fail(`${field}.setParams.${k}`, check);
  }
  out.setParams = params;

  const removes = stringList(raw.removeParams, `${field}.removeParams`, fail, "参数名");
  for (const k of removes) {
    if (CREDENTIAL_FIELDS.includes(k)) {
      fail(`${field}.removeParams.${k}`, `参数名「${k}」像凭据：middleware 不许碰凭据。`);
    }
    if (Object.prototype.hasOwnProperty.call(params, k)) {
      fail(field, `参数「${k}」又删又设：同一份声明里两种说法打架，说明作者自己也不确定要哪个。`);
    }
  }
  out.removeParams = removes;

  const setH = headerMap(raw.setHeaders, `${field}.setHeaders`, fail, "设");
  const remH = headerNameList(raw.removeHeaders, `${field}.removeHeaders`, fail);
  for (const k of Object.keys(setH)) {
    if (remH.includes(k)) {
      fail(`${field}`, `头「${k}」又删又设：同一份声明里两种说法打架，说明作者自己也不确定要哪个。`);
    }
  }
  out.setHeaders = setH;
  out.removeHeaders = remH;

  return out;
}

/** 校验并归一化 `response`（只许改头）。 */
function validateResponse(raw, field, fail) {
  if (!isPlainObject(raw)) {
    fail(field, "response 得是一个对象（{\"setHeaders\": …} 这样）。");
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (!KNOWN_RESPONSE_FIELDS.includes(k)) {
      fail(`${field}.${k}`, `response 里有不认识的字段「${k}」：只许 ${KNOWN_RESPONSE_FIELDS.join("、")}。`);
    }
  }
  const out = { setHeaders: {}, removeHeaders: [] };
  const setH = headerMap(raw.setHeaders, `${field}.setHeaders`, fail, "设");
  const remH = headerNameList(raw.removeHeaders, `${field}.removeHeaders`, fail);
  for (const k of Object.keys(setH)) {
    if (remH.includes(k)) {
      fail(`${field}`, `头「${k}」又删又设：同一份声明里两种说法打架，说明作者自己也不确定要哪个。`);
    }
  }
  out.setHeaders = setH;
  out.removeHeaders = remH;
  return out;
}

/** 一张「名字 → 值」的表；值得是 JSON 里放得下的东西。 */
function stringMap(raw, field, fail) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    fail(field, "得是一个对象（{\"temperature\": 0.2} 这样）。");
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    if (!key) {
      fail(field, "有个参数的键是空的。");
      continue;
    }
    if (!isJsonSafe(v)) {
      fail(`${field}.${key}`, `参数「${key}」的值放不进请求体：JSON 里没有 undefined、函数或 NaN。`);
      continue;
    }
    out[key] = v;
  }
  return out;
}

/** 一张「头名 → 头值」的表；头名与头值都要过关。 */
function headerMap(raw, field, fail, verb) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    fail(field, "得是一个对象（{\"X-Foo\": \"bar\"} 这样）。");
    return {};
  }
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    const lname = String(name).trim().toLowerCase();
    if (!HEADER_NAME_RE.test(lname)) {
      fail(`${field}.${name}`, `头名「${name}」不合法：请求头名只许 HTTP 的 token 字符（字母、数字与 !#$%&'*+-.^_\`|~）。`);
      continue;
    }
    if (CREDENTIAL_HEADERS.includes(lname)) {
      fail(`${field}.${name}`, `middleware 不许${verb}凭据头「${lname}」：`
        + "能改凭据的插件 = 能把你的 key 发到别处的插件。");
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      out[lname] = String(value);
      continue;
    }
    if (typeof value !== "string") {
      fail(`${field}.${name}`, `头「${lname}」的值得是一段文字（或一个数）。`);
      continue;
    }
    if (HEADER_VALUE_BAD_RE.test(value)) {
      fail(`${field}.${name}`, `头「${lname}」的值里带了换行：`
        + "带换行的头值能把请求拆开（头注入），不许这么写。");
      continue;
    }
    out[lname] = value;
  }
  return out;
}

/**
 * 一张「要删的头名」的清单：头名小写化，并查凭据。
 *
 * 凭据头不许**删** —— 删掉 authorization 看着像「不送凭据」，实际是把请求变成
 * 匿名（或者让别的凭据顶上来）。middleware 不许碰凭据，删也是碰。
 */
function headerNameList(raw, field, fail) {
  const list = stringList(raw, field, fail, "头名");
  const out = [];
  for (const name of list) {
    const lname = name.toLowerCase();
    if (!HEADER_NAME_RE.test(lname)) {
      fail(field, `头名「${name}」不合法：请求头名只许 HTTP 的 token 字符（字母、数字与 !#$%&'*+-.^_\`|~）。`);
      continue;
    }
    if (CREDENTIAL_HEADERS.includes(lname)) {
      fail(field, `middleware 不许删凭据头「${lname}」：`
        + "能改凭据的插件 = 能把你的 key 发到别处的插件。");
      continue;
    }
    out.push(lname);
  }
  return out;
}

/** 已知参数的类型与范围检查；没问题就返回 null。 */
function checkParam(key, value) {
  const rule = PARAM_CHECKS[key];
  if (!rule) {
    if (!isJsonSafe(value)) return `参数「${key}」的值放不进请求体。`;
    return null;
  }
  switch (rule.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `参数「${key}」得是一个数。`;
      }
      if (value < rule.min || value > rule.max) {
        return `参数「${key}」的值 ${value} 不在 ${rule.min}~${rule.max} 之间。`;
      }
      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `参数「${key}」得是一个整数。`;
      }
      if (rule.min !== undefined && value < rule.min) {
        return `参数「${key}」的值 ${value} 不得小于 ${rule.min}。`;
      }
      return null;
    case "boolean":
      if (typeof value !== "boolean") return `参数「${key}」得是 true 或 false。`;
      return null;
    case "stringArray":
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
        return `参数「${key}」得是一个字符串数组。`;
      }
      return null;
    default:
      return null;
  }
}

/* ====================================================================== *
 * ③ 编译
 * ====================================================================== */

/**
 * 把一份声明编译成可直接执行的形态。
 *
 * 传进来的可以是：声明原文、{@link validateMiddlewareManifest} 的返回值、
 * 或者已经编译好的形态（再编译一次是幂等的）。**没验过的声明会先验一遍** ——
 * 错的声明要在这里就炸，而不是变成一次错的改写。
 *
 * @param {object} manifest 声明
 * @returns {object} 编译好的声明（`compiled: true`）
 */
export function compileRules(manifest) {
  let m = manifest;
  if (isPlainObject(m) && typeof m.ok === "boolean") {
    if (!m.ok) {
      const e = new Error(`这份声明没通过校验：\n${formatErrors(m.errors)}`);
      e.errors = m.errors;
      e.code = "MIDDLEWARE_INVALID";
      throw e;
    }
    m = m.manifest;
  }
  if (isPlainObject(m) && m.compiled === true) return m;
  const v = validateMiddlewareManifest(m);
  if (!v.ok) {
    const e = new Error(`这份声明没通过校验：\n${formatErrors(v.errors)}`);
    e.errors = v.errors;
    e.code = "MIDDLEWARE_INVALID";
    throw e;
  }
  return v.manifest;
}

/* ====================================================================== *
 * ④ 应用
 * ====================================================================== */

/** 把调用方给上下文归一化（头名小写化、参数拷贝一份）。 */
function normalizeCtx(ctx) {
  const src = isPlainObject(ctx) ? ctx : {};
  const headers = {};
  const raw = isPlainObject(src.headers) ? src.headers : {};
  for (const [k, v] of Object.entries(raw)) {
    headers[String(k).trim().toLowerCase()] = String(v == null ? "" : v);
  }
  return {
    provider: String(src.provider == null ? "" : src.provider),
    tier: String(src.tier == null ? "" : src.tier),
    model: String(src.model == null ? "" : src.model),
    protocol: String(src.protocol == null ? "" : src.protocol),
    path: String(src.path == null ? "" : src.path),
    stream: !!src.stream,
    headers,
    params: isPlainObject(src.params) ? cloneJson(src.params) : {},
    availableModels: Array.isArray(src.availableModels) ? src.availableModels.map(String) : [],
  };
}

/** 一条规则管不管这次请求。 */
function matchWhen(when, ctx) {
  if (when.provider.length && !when.provider.includes(ctx.provider)) return false;
  if (when.tier.length && !when.tier.includes(ctx.tier)) return false;
  if (when.model.length && !when.model.includes(ctx.model)) return false;
  if (when.protocol.length && !when.protocol.includes(ctx.protocol)) return false;
  if (when.path.length && !when.path.includes(ctx.path)) return false;
  if (when.stream !== null && when.stream !== ctx.stream) return false;
  for (const [name, vals] of Object.entries(when.header)) {
    const got = ctx.headers[name];
    if (got === undefined) return false;
    /* 头值比的是**去空白后**的原文：HTTP 的头值两头的空白本来就没有意义，
       而 Node 收进来的头已经去过空白 —— 不去就永远比不中。 */
    if (!vals.includes(String(got).trim())) return false;
  }
  return true;
}

/**
 * 改模型之前先问一句「这家能用吗」。
 *
 * 不问就是**静默改坏**：改出来的模型名上游不认识，表现是一句含糊的 400，
 * 用户看到的是「模型用不了」，而不是「你的规则写错了」。
 */
function checkModel(model, cur) {
  const m = String(model == null ? "" : model).trim();
  if (!m) return { ok: false, message: "模型名不能为空。" };
  if (!cur.provider) {
    return {
      ok: false,
      message: "不知道这次请求走的是哪一家（provider 是空的），就不敢改模型："
        + "改错了上游只会回一句「不认识这个模型」。",
    };
  }
  const list = cur.availableModels;
  if (!list.length) {
    return {
      ok: false,
      message: `没有渠道「${cur.provider}」能用的模型清单，就不敢改模型：`
        + "改错了上游只会回一句「不认识这个模型」。",
    };
  }
  if (list.includes(m)) return { ok: true, model: m };
  /* 大小写不一致时归一到**清单里的写法**：上游的模型 id 大小写敏感
     （mm 的官方写法是 MiniMax-M3.1-Flash），发错大小写上游只当不认识。 */
  const lower = m.toLowerCase();
  const hit = list.find((x) => x.toLowerCase() === lower);
  if (hit) return { ok: true, model: hit };
  return {
    ok: false,
    message: `模型「${m}」不在渠道「${cur.provider}」能用的清单里`
      + `（能用的是：${list.join("、")}）：改成清单外的模型，上游只会回一句「不认识这个模型」。`,
  };
}

/**
 * 照着一份（已编译的）声明改请求。
 *
 * 规则按声明顺序依次作用，后面的覆盖前面的；每条规则看到的是**前面规则改过
 * 之后**的请求。改写结果不合法时**不给半改的结果**（`request` 是 null），
 * 让接线层决定怎么答 —— 静默放行等于把「规则没生效」藏起来。
 *
 * @param {object} compiled 编译好的声明（{@link compileRules} 的产物）
 * @param {object} ctx 请求上下文
 * @returns {{ok:boolean, request:object|null, applied:object[], errors:object[]}}
 */
export function applyRequest(compiled, ctx) {
  const c = compileRules(compiled);
  return applyRequestOn(c, ctx);
}

function applyRequestOn(c, ctx) {
  const cur = normalizeCtx(ctx);
  const applied = [];
  for (let i = 0; i < c.rules.length; i++) {
    const rule = c.rules[i];
    if (!rule.request) continue;
    if (!matchWhen(rule.when, cur)) continue;
    const r = rule.request;

    /* ① 模型 —— 先定「改哪个模型」，后面的参数与头都围着它。 */
    if (r.model !== undefined) {
      const chk = checkModel(r.model, cur);
      if (!chk.ok) {
        return {
          ok: false,
          request: null,
          applied,
          errors: [{ field: `rules[${i}].request.model`, message: chk.message }],
        };
      }
      cur.model = chk.model;
      applied.push({ id: c.id, rule: i, action: "model", value: chk.model });
    }

    /* ② 参数 */
    for (const k of r.removeParams) {
      delete cur.params[k];
      applied.push({ id: c.id, rule: i, action: "removeParams", key: k });
    }
    for (const [k, v] of Object.entries(r.setParams)) {
      cur.params[k] = cloneJson(v);
      applied.push({ id: c.id, rule: i, action: "setParams", key: k, value: v });
    }

    /* ③ 头 —— 最后贴：里面的（模型、参数）定好了，外层才贴。 */
    for (const k of r.removeHeaders) {
      delete cur.headers[k];
      applied.push({ id: c.id, rule: i, action: "removeHeaders", key: k });
    }
    for (const [k, v] of Object.entries(r.setHeaders)) {
      cur.headers[k] = v;
      applied.push({ id: c.id, rule: i, action: "setHeaders", key: k, value: v });
    }
  }
  return { ok: true, request: cur, applied, errors: [] };
}

/**
 * 照着一份（已编译的）声明改应答 —— 只改头。
 *
 * 为什么不许改正文：应答到这层时可能已经是一个字节流（SSE），要改正文就得
 * 把整份应答缓冲下来再拆事件重切 —— 那是接线层的事件管道该干的事。
 *
 * @param {object} compiled 编译好的声明
 * @param {object} ctx 应答上下文
 * @returns {{ok:boolean, response:object|null, applied:object[], errors:object[]}}
 */
export function applyResponse(compiled, ctx) {
  const c = compileRules(compiled);
  const src = isPlainObject(ctx) ? ctx : {};
  const headers = {};
  const raw = isPlainObject(src.headers) ? src.headers : {};
  for (const [k, v] of Object.entries(raw)) {
    headers[String(k).trim().toLowerCase()] = String(v == null ? "" : v);
  }
  const cur = {
    provider: String(src.provider == null ? "" : src.provider),
    tier: String(src.tier == null ? "" : src.tier),
    model: String(src.model == null ? "" : src.model),
    protocol: String(src.protocol == null ? "" : src.protocol),
    status: src.status === undefined || src.status === null ? 200 : Number(src.status),
    headers,
  };

  const applied = [];
  for (let i = 0; i < c.rules.length; i++) {
    const rule = c.rules[i];
    if (!rule.response) continue;
    if (!matchWhen(rule.when, cur)) continue;
    const r = rule.response;
    for (const k of r.removeHeaders) {
      delete cur.headers[k];
      applied.push({ id: c.id, rule: i, action: "removeHeaders", key: k });
    }
    for (const [k, v] of Object.entries(r.setHeaders)) {
      cur.headers[k] = v;
      applied.push({ id: c.id, rule: i, action: "setHeaders", key: k, value: v });
    }
  }
  return { ok: true, response: cur, applied, errors: [] };
}

/**
 * 用改过的请求拼出一个应答上下文。
 *
 * 为什么要有这个函数：应答规则也要按 `when` 匹配（provider / 档位 / 模型），
 * 而模型可能被请求规则改过 —— 手拼容易漏掉「应答看到的是**改过之后**的模型」。
 */
export function responseContextOf(request, extra = {}) {
  const src = isPlainObject(request) ? request : {};
  return {
    provider: src.provider || "",
    tier: src.tier || "",
    model: src.model || "",
    protocol: src.protocol || "",
    status: extra.status === undefined || extra.status === null ? 200 : Number(extra.status),
    headers: isPlainObject(extra.headers) ? cloneJson(extra.headers) : {},
  };
}

/* ====================================================================== *
 * ⑤ 注册表
 * ====================================================================== */

/**
 * 一批已装声明的注册表：记住装了的声明（按 id），能列、能取、能卸，
 * 并**检出两个声明抢同一个 id**。
 *
 * 多个声明同时生效时按**登记顺序**依次作用，后面的覆盖前面的 ——
 * 与规则之间的顺序是同一套口径（「后写的赢」）。
 *
 * 时间**由调用方传**（`register(manifest, { now })`）：本模块不取
 * `Date.now()`，所以没传时刻时 `loadedAt` 就是 null（不是「现在」）。
 */
export function createMiddlewareRegistry() {
  const byId = new Map();

  /** 只查不写：这个声明能不能装。 */
  function check(manifest) {
    let compiled = null;
    try {
      compiled = compileRules(manifest);
    } catch (e) {
      return { ok: false, errors: e.errors || [{ field: "", message: String((e && e.message) || e) }], entry: null };
    }
    const errors = [];
    if (byId.has(compiled.id)) {
      errors.push({
        field: "id",
        message: `声明的键「${compiled.id}」已经装过了：`
          + "一个键只能对应一份声明 —— 覆盖会让后装的那份悄悄改掉先装的那份的规则。",
      });
    }
    if (errors.length) return { ok: false, errors, entry: null };
    return { ok: true, errors: [], entry: { id: compiled.id, name: compiled.name, compiled } };
  }

  /** 装一份声明（校验 → 记住）。装不上就**抛错**（消息是人话）。 */
  function register(manifest, options = {}) {
    const res = check(manifest);
    if (!res.ok) {
      const e = new Error(`这份声明装不上：\n${formatErrors(res.errors)}`);
      e.errors = res.errors;
      e.code = "MIDDLEWARE_CONFLICT";
      throw e;
    }
    const entry = {
      ...res.entry,
      loadedAt: options.now == null ? null : options.now,
      source: options.source == null ? null : String(options.source),
    };
    byId.set(entry.id, entry);
    return entry;
  }

  /** 按登记顺序把所有声明作用在一次请求上。 */
  function applyRequestAll(ctx) {
    let cur = ctx;
    const applied = [];
    for (const entry of byId.values()) {
      const r = applyRequestOn(entry.compiled, cur);
      if (!r.ok) {
        return {
          ok: false,
          request: null,
          applied: applied.concat(r.applied),
          errors: r.errors.map((e) => ({ ...e, field: `${entry.id}.${e.field}` })),
        };
      }
      cur = r.request;
      applied.push(...r.applied);
    }
    return { ok: true, request: cur, applied, errors: [] };
  }

  /** 按登记顺序把所有声明作用在一次应答上。 */
  function applyResponseAll(ctx) {
    const applied = [];
    let cur = ctx;
    for (const entry of byId.values()) {
      const r = applyResponse(entry.compiled, cur);
      if (!r.ok) {
        return {
          ok: false,
          response: null,
          applied: applied.concat(r.applied),
          errors: r.errors.map((e) => ({ ...e, field: `${entry.id}.${e.field}` })),
        };
      }
      cur = r.response;
      applied.push(...r.applied);
    }
    return { ok: true, response: cur, applied, errors: [] };
  }

  return {
    /** 装一份；装不上抛错。 */
    register,
    /** 装一批；有一个装不上就整体抛错。 */
    registerAll(manifests, options = {}) {
      const list = Array.isArray(manifests) ? manifests : [];
      const out = [];
      for (const m of list) out.push(register(m, options));
      return out;
    },
    /** 只查不装：这个声明能不能装（面板用）。 */
    check,
    /** 按 id 取；没有就 null。 */
    get(id) {
      return byId.get(String(id == null ? "" : id)) || null;
    },
    /** 有这个 id 吗。 */
    has(id) {
      return byId.has(String(id == null ? "" : id));
    },
    /** 卸掉一个（按 id）；没装过就返回 null。 */
    unregister(id) {
      const k = String(id == null ? "" : id);
      const entry = byId.get(k);
      if (!entry) return null;
      byId.delete(k);
      return entry;
    },
    /** 已装的全部（按登记顺序）。 */
    list() {
      return [...byId.values()];
    },
    /** 已装的 id（按登记顺序）。 */
    keys() {
      return [...byId.keys()];
    },
    /** 清空（测试与「重载声明」用）。 */
    clear() {
      byId.clear();
    },
    /** 把所有声明作用在一次请求上（按登记顺序）。 */
    applyRequest: applyRequestAll,
    /** 把所有声明作用在一次应答上（按登记顺序）。 */
    applyResponse: applyResponseAll,
  };
}
