/**
 * plugin.mjs —— 声明式 provider 插件的**解析与校验层**
 * （纯逻辑、零依赖、零 IO、零时钟）
 *
 * ── 它补的是哪个洞 ──────────────────────────────────────────────────────
 * 本仓的渠道清单写死在 `src/server/server.mjs` 的 `CHANNELS` 常量里
 * （bai / sn / wb / wbai / zen / qd / mm / or 八家）。加第九家要改代码：
 * 加常量、加 `sliceOf` 的分支、加 `relaySpec` 的分支、加面板卡片、加默认配置——
 * 每加一家就是一轮「记得改全」的排查（本仓 `scripts/check-manifest.cjs` 的
 * 十三类检查就是为这个而存在的）。
 *
 * magpie 的答案是**插件**：一份声明描述一家渠道，加一家不用改代码。
 * 本模块是那条路上的**第一段**：把一份声明读进来、验明白、转成本仓内部的渠道形状。
 * 接线（并进 `sliceOf` 的视野、给面板出卡片）不在本模块里 —— 本模块只管
 * 「这份声明说的是不是一家合法的渠道」以及「它该长成配置里的什么样子」。
 *
 * ── magpie 对应哪个文件 ────────────────────────────────────────────────
 *   · `internal/plugin/providers.go` —— magpie 的 Provider 结构（一家渠道声明成
 *     什么样：id / name / api / methods（怎么登录）/ models）。这里是同一件事的
 *     **纯数据**版。
 *   · `internal/pluginrt/pluginrt.go` —— magpie 的插件注册表（Register /
 *     Registered，「两个插件一个 id 就 panic」）。对应本模块的 {@link createRegistry}。
 *   · `internal/pluginrt/schema.go` —— magpie 用 JSON Schema 校验插件设置。
 *     对应本模块的 {@link validateManifest}。
 *   · `internal/plugin/host.js` —— magpie 真正加载并**执行**插件代码的地方。
 *     本模块**刻意没有对应物**（见下面的差异第 1 条）。
 *
 * ── 与 magpie 有意不同的点（以及原因）──────────────────────────────────
 *   1. **magpie 的插件是代码，本仓的插件是数据。**
 *      magpie 的插件是 npm 包，在 Bun 宿主里跑真正的 JS（host.js）——能力无限，
 *      代价是插件能读用户配置、能往外发数据。本仓的插件**只有一份 JSON 声明**：
 *      它能描述一家渠道，但**做不了别的事**。这是我们自己的取舍 —— 分发物的权力
 *      越小，审它的人越敢点「装」。
 *   2. **凭据不进清单。**
 *      magpie 的 provider 声明里带登录钩子（OAuth / 浏览器登录 / 账号列表）。
 *      本仓的清单只声明**认证方式**（apikey / bearer / none），凭据一律由用户在
 *      面板里填。清单里出现 `apiKey` 之类的字段是**明确拒绝**的（见
 *      {@link validateManifest} 的凭据检查）—— 插件是要分发给别人的东西，
 *      里面带 key 等于把你的 key 发给所有装这个插件的人。
 *   3. **校验不用 JSON Schema，用手写的人话。**
 *      magpie 的 schema.go 从 Go 结构体生成 JSON Schema。本仓不引新依赖、也没有
 *      生成器，所以校验是手写的，每条错都写成人能读的话（不是 "invalid schema"）。
 *   4. **只吃 JSON，不吃 YAML。**
 *      magpie 的插件运行时读的是 `plugins.yml`（Go 那边有 yaml 库）。本仓是零依赖
 *      的 Node 工程，**YAML 解析器是外部依赖，而本仓不引新依赖**；要 YAML 就先在
 *      解析前转成 JSON。
 *   5. **冲突直接拒绝，不做「两个插件抢一个 id」的提示。**
 *      magpie 允许两个插件服务同一个 provider id，然后在面板上标出 clash。本仓
 *      一个渠道键只对应一家 —— 抢键等于让一个插件改掉用户的既有配置，直接报错。
 *
 * ── 清单格式（完整例子）────────────────────────────────────────────────
 *   {
 *     "manifestVersion": 1,
 *     "id": "acme",
 *     "name": "Acme LLM",
 *     "upstream": "https://api.acme.example/v1",
 *     "protocol": "openai",
 *     "auth": "apikey",
 *     "models": ["acme-pro", "acme-lite"],
 *     "defaultModel": "acme-pro",
 *     "relayPort": 15802,
 *     "useProxy": false,
 *     "mapping": {
 *       "claude-fable-5": "acme-lite",
 *       "claude-sonnet-5": "acme-pro",
 *       "claude-opus-5": "acme-pro",
 *       "claude-haiku-4-5": { "target": "acme-lite", "label": "Acme Lite" }
 *     }
 *   }
 *
 * 字段说明：
 *   · `manifestVersion` —— 格式版本，现在只认 1；不认识就报错（别猜着解析）。
 *   · `id` —— 渠道键：小写字母 / 数字 / 短横线，且**不能与出厂八家撞**。
 *   · `name` —— 面板上显示的名字。
 *   · `upstream` —— 上游地址，只许 http / https。
 *   · `protocol` —— `anthropic`（上游原生吃 /v1/messages）或 `openai`（要走协议桥）。
 *   · `auth` —— `apikey`（x-api-key）/ `bearer`（authorization: Bearer）/ `none`。
 *   · `models` —— 这家能用的模型 id 清单。
 *   · `mapping` —— Claude 四档各指向哪个模型；指向的模型**必须在 models 里**
 *     （中转按「模型名 → 可用清单」认它，清单里没有的模型会被当不认识）。
 *   · `relayPort` —— 可选；不给就是 0（待分配），由接线层分。
 *   · `useProxy` —— 可选，默认 false。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────
 *   · **零依赖**：本文件不 import 仓库里任何模块，也不用任何三方包。
 *   · **零 IO / 零时钟**：不读盘、不联网、不取 `Date.now()`（时间由 `opts.now` 传进来）。
 *   · **不写盘、不记日志**：怎么落盘、怎么上报，交给调用方。
 */

/* ====================================================================== *
 * 常量
 * ====================================================================== */

/** 清单格式版本。现在只认 1 —— 版本不认识时**报错**，不猜着解析。 */
export const MANIFEST_VERSION = 1;

/**
 * 出厂八家渠道键。
 *
 * ⚠ 这是 `src/server/server.mjs` 里 `CHANNELS` 的一份**镜像**：本模块不许 import
 *   仓库任何其它模块（零依赖），所以只能把这份名单搬过来。`scripts/plugin-test.mjs`
 *   里有**防漂移断言**（对着 server.mjs 的 CHANNELS 原文比），名单变了会红。
 */
export const FACTORY_CHANNELS = Object.freeze(["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"]);

/**
 * Claude 的四档（与 `server.mjs` 的 `TIERS` 同步，同样有防漂移断言）。
 *
 * 为什么单独抄一份：档位映射的校验（「四档都得有」）得知道这四个名字，
 * 而 server.mjs 是热路径且不许被本模块依赖。
 */
export const TIER_KEYS = Object.freeze([
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5",
]);

/** 上游协议：`anthropic` 原生吃 /v1/messages；`openai` 走通用协议桥。 */
export const PROTOCOLS = Object.freeze(["anthropic", "openai"]);

/** 认证方式：apikey / bearer / none。 */
export const AUTH_SCHEMES = Object.freeze(["apikey", "bearer", "none"]);

/**
 * 渠道键的形状：小写字母、数字、短横线；首字符必须是字母或数字；总长 ≤ 40。
 *
 * 为什么这么窄：渠道键会进配置文件、当 URL 的一段、也是面板上「是哪一家」的
 * 唯一标识。放开大小写会造出 "Bai" 与 "bai" 两个看着一样、行为不同的家；
 * 放开别的字符会让它进 URL 时要转义。
 */
export const CHANNEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * 出厂渠道与本机服务占着的端口（`config.defaults.json` 里有同一份；测试防漂移）。
 *
 * 为什么插件不能要这些端口：撞了就是「两个中转抢同一个监听口」——表现是请求
 * 随机地打到另一家，比直接报错难查得多。
 */
export const RESERVED_PORTS = Object.freeze([
  15722, 15723, 15732, 15742, 15752, 15762, 15772, 15782, 15792, 15799,
]);

/**
 * 清单里**不许**出现的字段名（凭据）。
 *
 * 插件是要分发给别人的东西：一份带 key 的清单装到十台机器上，就是一把 key
 * 摊给十个不相干的人（还多半进了 git）。凭据由用户在面板里填，所以这里做成
 * **明确拒绝**而不是「忽略这个字段」—— 静默忽略会让作者以为 key 已经带上了。
 */
const CREDENTIAL_FIELDS = Object.freeze([
  "apiKey", "api_key", "apikey", "key", "token", "accessToken", "access_token",
  "refreshToken", "refresh_token", "secret", "secretKey", "secret_key",
  "password", "credential", "credentials", "authorization", "bearer",
  "sessionToken", "session_token",
]);

/** 清单里允许出现的字段（其余一律当「不认识的字段」报错）。 */
const KNOWN_FIELDS = Object.freeze([
  "manifestVersion", "id", "name", "upstream", "protocol", "auth",
  "models", "defaultModel", "mapping", "relayPort", "useProxy",
]);

/** 档位映射的值的对象形态里允许出现的字段。 */
const MAPPING_FIELDS = Object.freeze(["target", "label"]);

/* ====================================================================== *
 * 小工具（纯函数）
 * ====================================================================== */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 深拷贝档位映射 —— 免得调用方改了返回值就改坏注册表里的原件。 */
function cloneMapping(map) {
  const out = {};
  for (const k of Object.keys(map || {})) {
    const v = map[k] || {};
    out[k] = { target: v.target, label: v.label };
  }
  return out;
}

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
 *   解析前转成 JSON（magpie 那边读 `plugins.yml` 是因为 Go 自带 yaml 库）。
 *
 * 失败时**抛错**（消息是人话）：JSON 语法错、顶层不是对象、空文件。
 * 语法错与「声明不合法」是两回事 —— 后者由 {@link validateManifest} 负责。
 *
 * @param {string} text 清单文本
 * @returns {object} 解析出来的普通对象
 */
export function parseManifest(text) {
  if (typeof text !== "string") {
    throw new Error(`清单必须是一段文本（字符串），拿到的是 ${text === null ? "null" : typeof text}。`);
  }
  if (!text.trim()) {
    throw new Error("清单是空的 —— 没有内容可解析。");
  }
  if (!/^\s*\{/.test(text)) {
    throw new Error(
      "清单的顶层得是一个 JSON 对象（以 { 开头）。"
      + "本程序只吃 JSON —— YAML 解析器是外部依赖，而本仓不引新依赖；"
      + "要 YAML 就先在解析前转成 JSON。"
    );
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`清单不是合法的 JSON：${jsonErrText(e, text)}`);
  }
  if (!isPlainObject(obj)) {
    throw new Error("清单的顶层必须是一个 JSON 对象（{ … }），不是数组或标量。");
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
 *   · `errors` —— 每条 `{ field, message }`，`field` 是出错的字段名（面板可以据此
 *     标出是哪一栏），`message` 是**给人看的中文**，不是 "invalid schema"；
 *   · `manifest` —— 过了之后的**归一化**声明（没过就是 null）。归一化会补上
 *     缺省的 `defaultModel`、把档位映射统一成 `{target, label}` 形状。
 *
 * 检查的项：格式版本、渠道键、显示名、上游地址、协议、认证方式、模型清单、
 * 档位映射、中转端口、代理开关，外加两条「不许」：**凭据字段**与**不认识的字段**。
 *
 * @param {object} obj 待校验的声明（一般是 {@link parseManifest} 的产物）
 * @param {{factoryChannels?:string[]}} [opts]
 *        `factoryChannels` 覆盖「出厂渠道」名单（默认 {@link FACTORY_CHANNELS}）；
 *        注册表会把它自己那份传进来。
 * @returns {{ok:boolean, errors:{field:string,message:string}[], manifest:object|null}}
 */
export function validateManifest(obj, opts = {}) {
  const errors = [];
  const factory = new Set(
    (Array.isArray(opts.factoryChannels) ? opts.factoryChannels : FACTORY_CHANNELS).map(String)
  );
  const fail = (field, message) => errors.push({ field, message });

  if (!isPlainObject(obj)) {
    return {
      ok: false,
      errors: [{ field: "", message: "清单的顶层必须是一个 JSON 对象（{ … }），不是数组或标量。" }],
      manifest: null,
    };
  }

  /* ① 凭据字段 —— 先查，因为它比「不认识的字段」更该被单独点名：
   *    作者以为带上了 key，实际被拒时若只说「不认识的字段」，他多半会改成
   *    随便一个别的名字再试一遍。 */
  for (const k of Object.keys(obj)) {
    if (CREDENTIAL_FIELDS.includes(k)) {
      fail(k, `清单里不许带凭据字段「${k}」：插件是要分发给别人的东西，`
        + "里面带 key 等于把你的 key 发给所有装这个插件的人。凭据请在面板里填。"
        + (k === "key" ? "（渠道键那个字段叫「id」。）" : ""));
    }
  }

  /* ② 不认识的字段 —— 报错而不是忽略：`uplstream` 这种手误若被静默忽略，
   *    这份清单会以「没写上游」的样子通过，用户看到的是另一种错，绕远路。 */
  for (const k of Object.keys(obj)) {
    if (!KNOWN_FIELDS.includes(k) && !CREDENTIAL_FIELDS.includes(k)) {
      fail(k, `清单里有不认识的字段「${k}」：可用的字段只有 ${KNOWN_FIELDS.join("、")}。`);
    }
  }

  /* ③ 格式版本 */
  const mv = obj.manifestVersion;
  if (mv === undefined) {
    fail("manifestVersion", `清单缺少「manifestVersion」：这是声明的格式版本，本程序只认 ${MANIFEST_VERSION}。`);
  } else if (typeof mv !== "number" || !Number.isInteger(mv)) {
    fail("manifestVersion", `格式版本得是整数（现在认 ${MANIFEST_VERSION}），拿到的是 ${JSON.stringify(mv)}。`);
  } else if (mv !== MANIFEST_VERSION) {
    fail("manifestVersion", `这份清单的格式版本是 ${mv}，本程序只认 ${MANIFEST_VERSION}：`
      + "新版本写的东西旧程序读不了，别猜着解析。");
  }

  /* ④ 渠道键 */
  let id = null;
  if (obj.id === undefined) {
    fail("id", "清单缺少「id」：这是渠道键（面板上那一家叫什么），"
      + "只许小写字母、数字和短横线，且不能与出厂渠道撞。");
  } else if (typeof obj.id !== "string" || !obj.id.trim()) {
    fail("id", "渠道键得是一段非空的文字。");
  } else {
    id = obj.id.trim();
    if (!CHANNEL_KEY_RE.test(id)) {
      fail("id", `渠道键「${id}」不合法：只许小写字母、数字和短横线（像 acme、my-provider），`
        + "而且第一个字符得是字母或数字。");
    } else if (factory.has(id)) {
      fail("id", `渠道键「${id}」跟出厂渠道撞了：插件不能占用出厂渠道的键 ——`
        + "那等于让一个插件改掉用户已有的配置（比如用户自己的 bai 凭据与上游）。");
    }
  }

  /* ⑤ 显示名 */
  let name = null;
  if (obj.name === undefined) {
    fail("name", "清单缺少「name」：这是面板上显示的名字。");
  } else if (typeof obj.name !== "string" || !obj.name.trim()) {
    fail("name", "显示名不能为空。");
  } else if (obj.name.trim().length > 60) {
    fail("name", "显示名太长了（60 个字以内）。");
  } else {
    name = obj.name.trim();
  }

  /* ⑥ 上游地址 */
  let upstream = null;
  if (obj.upstream === undefined) {
    fail("upstream", "清单缺少「upstream」：这家渠道的上游地址。");
  } else if (typeof obj.upstream !== "string" || !obj.upstream.trim()) {
    fail("upstream", "上游地址得是一段非空的文字。");
  } else {
    const raw = obj.upstream.trim();
    let u = null;
    try { u = new URL(raw); } catch { u = null; }
    if (!u) {
      fail("upstream", `上游地址「${raw}」不是一个网址：得写成 https://host/path 这样。`);
    } else if (u.protocol !== "http:" && u.protocol !== "https:") {
      fail("upstream", `上游地址「${raw}」的协议是 ${u.protocol.replace(":", "")}：只许 http 或 https。`);
    } else if (u.username || u.password) {
      fail("upstream", `上游地址「${raw}」里不许带用户名密码：凭据要由用户在面板里填。`);
    } else if (!u.hostname) {
      fail("upstream", `上游地址「${raw}」里没有主机名。`);
    } else {
      // 去掉末尾的斜杠：中转是 `upstream + req.url` 拼出来的，多一个斜杠就是两个。
      upstream = raw.replace(/\/+$/, "");
    }
  }

  /* ⑦ 协议 */
  let protocol = null;
  if (obj.protocol === undefined) {
    fail("protocol", "清单缺少「protocol」：上游讲的是哪套协议（anthropic 或 openai）。");
  } else if (typeof obj.protocol !== "string" || !PROTOCOLS.includes(obj.protocol)) {
    fail("protocol", `协议「${obj.protocol}」不认：只许 anthropic（上游原生吃 /v1/messages）`
      + "或 openai（要走通用协议桥）。");
  } else {
    protocol = obj.protocol;
  }

  /* ⑧ 认证方式 */
  let auth = null;
  if (obj.auth === undefined) {
    fail("auth", "清单缺少「auth」：认证方式（apikey / bearer / none）。");
  } else if (typeof obj.auth !== "string" || !AUTH_SCHEMES.includes(obj.auth)) {
    fail("auth", `认证方式「${obj.auth}」不认：只许 apikey（x-api-key）、`
      + "bearer（authorization: Bearer）、none（不要凭据）。");
  } else {
    auth = obj.auth;
  }

  /* ⑨ 模型清单 */
  let models = null;
  let modelsOk = false;
  if (obj.models === undefined) {
    fail("models", "清单缺少「models」：这家能用的模型 id 清单。");
  } else if (!Array.isArray(obj.models)) {
    fail("models", "模型清单得是一个数组（[\"m1\", \"m2\"] 这样）。");
  } else if (!obj.models.length) {
    fail("models", "模型清单是空的：这家得至少有一个模型，否则中转无从认它。");
  } else {
    const list = [];
    const seen = new Set();
    let bad = false;
    for (const m of obj.models) {
      if (typeof m !== "string" || !m.trim()) {
        fail("models", "模型 id 得是非空的文字。");
        bad = true;
        continue;
      }
      const mid = m.trim();
      if (seen.has(mid)) {
        fail("models", `模型清单里有重复的「${mid}」。`);
        bad = true;
        continue;
      }
      seen.add(mid);
      list.push(mid);
    }
    models = list;
    modelsOk = !bad;
  }

  /* ⑩ 默认模型 —— 缺省就取 fable 档的目标：出厂八家的 defaultModel 无一例外
   *    都等于 fable 档指向的那个模型，跟着这个约定走，两边才长得一样。 */
  let defaultModel = null;
  if (obj.defaultModel !== undefined && obj.defaultModel !== null) {
    if (typeof obj.defaultModel !== "string" || !obj.defaultModel.trim()) {
      fail("defaultModel", "默认模型得是非空的文字。");
    } else {
      defaultModel = obj.defaultModel.trim();
      if (modelsOk && !models.includes(defaultModel)) {
        fail("defaultModel", `默认模型「${defaultModel}」不在模型清单里：`
          + "清单里没有它，中转按「模型名 → 可用清单」认它时只当不认识。");
      }
    }
  }

  /* ⑪ 档位映射 —— 四档都得有，缺一档那档就会落到默认模型上（多半不是作者的意思）。 */
  let mapping = null;
  if (obj.mapping === undefined) {
    fail("mapping", `清单缺少「mapping」：Claude 的四档（${TIER_KEYS.join(" / ")}）各指向哪个模型。`);
  } else if (!isPlainObject(obj.mapping)) {
    fail("mapping", "档位映射得是一个对象（键是档位名，值是模型 id）。");
  } else {
    const map = {};
    let bad = false;
    for (const tier of TIER_KEYS) {
      if (!(tier in obj.mapping)) {
        fail(`mapping.${tier}`, `档位映射里少了「${tier}」这一档：四档都得写，`
          + "缺一档那档就会落到默认模型上（多半不是作者的意思）。");
        bad = true;
        continue;
      }
      const v = obj.mapping[tier];
      let target = null;
      let label = null;
      if (typeof v === "string") {
        target = v.trim();
        label = target;
      } else if (isPlainObject(v)) {
        for (const k of Object.keys(v)) {
          if (!MAPPING_FIELDS.includes(k)) {
            fail(`mapping.${tier}.${k}`, `档位「${tier}」里多了不认识的字段「${k}」：只许 target 与 label。`);
          }
        }
        if (typeof v.target !== "string" || !v.target.trim()) {
          fail(`mapping.${tier}`, `档位「${tier}」没写目标模型：`
            + "得是模型 id（\"acme-pro\"），或 {\"target\": \"...\", \"label\": \"...\"}。");
          bad = true;
          continue;
        }
        target = v.target.trim();
        if (v.label !== undefined) {
          if (typeof v.label !== "string" || !v.label.trim()) {
            fail(`mapping.${tier}.label`,
              `档位「${tier}」的显示名得是非空的文字（不想显示就整条省掉 label，别写成空串）。`);
            bad = true;
            continue;
          }
          label = v.label.trim();
        } else {
          // 没写显示名就用模型 id 当显示名：面板上至少认得出是哪家的哪个模型。
          label = target;
        }
      } else {
        fail(`mapping.${tier}`,
          `档位「${tier}」的值得是模型 id（"acme-pro"）或 {"target": "...", "label": "..."}。`);
        bad = true;
        continue;
      }
      if (modelsOk && !models.includes(target)) {
        fail(`mapping.${tier}`, `档位「${tier}」指向的模型「${target}」不在模型清单里：`
          + "清单里没有它，中转按「模型名 → 可用清单」认它时只当不认识。");
        bad = true;
        continue;
      }
      map[tier] = { target, label };
    }
    for (const k of Object.keys(obj.mapping)) {
      if (!TIER_KEYS.includes(k)) {
        fail(`mapping.${k}`, `档位映射里有不认识的档位「${k}」：只认 ${TIER_KEYS.join(" / ")}。`);
      }
    }
    if (!bad) mapping = map;
  }

  /* ⑫ 中转端口 —— 缺省 0，意思是「待分配」（接线层分）。 */
  let relayPort = 0;
  if (obj.relayPort !== undefined && obj.relayPort !== null) {
    if (typeof obj.relayPort !== "number" || !Number.isInteger(obj.relayPort)) {
      fail("relayPort", "中转端口得是整数。");
    } else if (obj.relayPort === 0) {
      /* 0 = 「没给」：归一化后的声明会带着一个 0 回来，再验一次也得过 ——
         否则「验过的声明再转一次」会自己炸自己。 */
      relayPort = 0;
    } else if (obj.relayPort < 1 || obj.relayPort > 65535) {
      fail("relayPort", `中转端口 ${obj.relayPort} 不在 1~65535 之间。`);
    } else if (RESERVED_PORTS.includes(obj.relayPort)) {
      fail("relayPort", `中转端口 ${obj.relayPort} 是出厂渠道或本机服务占着的：`
        + "换个端口，或者干脆不写（交给接线层分配）。");
    } else {
      relayPort = obj.relayPort;
    }
  }

  /* ⑬ 代理开关 */
  let useProxy = false;
  if (obj.useProxy !== undefined && obj.useProxy !== null) {
    if (typeof obj.useProxy !== "boolean") {
      fail("useProxy", "useProxy 得是 true 或 false（这家要不要走代理）。");
    } else {
      useProxy = obj.useProxy;
    }
  }

  if (errors.length) return { ok: false, errors, manifest: null };

  const finalDefault = defaultModel || mapping["claude-fable-5"].target;
  return {
    ok: true,
    errors: [],
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      id,
      name,
      upstream,
      protocol,
      auth,
      models: models.slice(),
      defaultModel: finalDefault,
      mapping: cloneMapping(mapping),
      relayPort,
      useProxy,
    },
  };
}

/* ====================================================================== *
 * ③ 转换
 * ====================================================================== */

/**
 * 把一份**通过校验**的声明转成本仓内部的渠道形状。
 *
 * 产出三样：
 *   · `config` —— **与 `config.defaults.json` 里的一家同构**的那一块，可以直接
 *     放进 `cfg[渠道键]`（凭据字段按认证方式给 `apiKey` / `accessToken` / 不给）。
 *   · `slice` —— `server.mjs` 里 `sliceOf(cfg, p)` 那种统一形状，接线层靠它把
 *     这家并进 `sliceOf` 的视野。
 *   · `relayOpts` —— 与 `server.mjs` 的 `relaySpec` 里那个 `opts` 同形
 *     （`{openai:true}` / `{}`），接线层不用再判断协议。
 *
 * ⚠ **本函数自己会先校验**：传一份没验过的声明进来会抛错，而不是把一份错的
 *   声明变成一份错的配置（错的配置要到运行时才炸，炸在别人家的上游上）。
 *
 * @param {object} manifest 声明对象，或 {@link validateManifest} 的返回值
 * @returns {object} 渠道规格
 */
export function toProviderSpec(manifest) {
  let m;
  if (isPlainObject(manifest) && typeof manifest.ok === "boolean" && isPlainObject(manifest.manifest)) {
    // 传进来的是校验结果 —— 没过的直接把它的错误抛出去；过的那份已经是归一化过的，
    // 不用再验一遍（验两遍不花钱，但两遍的判据一旦分叉就说不清是哪遍说了算）。
    if (!manifest.ok) {
      const e = new Error(`这份声明没通过校验：\n${formatErrors(manifest.errors)}`);
      e.errors = manifest.errors;
      e.code = "PLUGIN_MANIFEST_INVALID";
      throw e;
    }
    m = manifest.manifest;
  } else {
    const v = validateManifest(manifest);
    if (!v.ok) {
      const e = new Error(`这份声明没通过校验：\n${formatErrors(v.errors)}`);
      e.errors = v.errors;
      e.code = "PLUGIN_MANIFEST_INVALID";
      throw e;
    }
    m = v.manifest;
  }

  /* 凭据字段名与头名：认证方式说的是「怎么把凭据递给上游」，
   * 字段名说的是「用户填的凭据存在配置里的哪一格」。 */
  const credentialField = m.auth === "apikey" ? "apiKey" : m.auth === "bearer" ? "accessToken" : null;
  const authHeader = m.auth === "apikey" ? "x-api-key" : m.auth === "bearer" ? "authorization" : null;

  /* config：形状照着 config.defaults.json 里的一家伙子写（凭据字段在最前）。 */
  const config = {};
  if (credentialField) config[credentialField] = "";
  config.upstream = m.upstream;
  config.relayPort = m.relayPort;
  config.defaultModel = m.defaultModel;
  config.availableModels = m.models.slice();
  config.mapping = cloneMapping(m.mapping);
  config.useProxy = m.useProxy;

  /* slice：`sliceOf` 的统一形状。key 现在是空的 —— 凭据由用户在面板里填，
   * 填完才谈得上「这家配了凭据吗」。 */
  const slice = {
    p: m.id,
    zh: m.name,
    key: "",
    upstream: m.upstream,
    relayPort: m.relayPort,
    defaultModel: m.defaultModel,
    availableModels: m.models.slice(),
    mapping: cloneMapping(m.mapping),
    useProxy: m.useProxy,
  };

  return {
    id: m.id,
    name: m.name,
    protocol: m.protocol,
    auth: m.auth,
    upstream: m.upstream,
    relayPort: m.relayPort,
    defaultModel: m.defaultModel,
    availableModels: m.models.slice(),
    mapping: cloneMapping(m.mapping),
    useProxy: m.useProxy,
    credentialField,
    authHeader,
    relayOpts: m.protocol === "openai" ? { openai: true } : {},
    config,
    slice,
    manifest: m,
  };
}

/* ====================================================================== *
 * ④ 注册表
 * ====================================================================== */

/**
 * 一个已加载插件的注册表：记住装了的插件（按渠道键），能列、能取、能按名字查，
 * 并**检出与出厂渠道的冲突**。
 *
 * ⚠ **冲突一律报错，不许悄悄覆盖**：覆盖出厂渠道等于让一个插件改掉用户的 bai
 *   配置（凭据、上游、模型映射全被换掉），而插件是别人写的分发物 —— 这条线
 *   必须是硬的。同理，一个渠道键也不许有两个插件。
 *
 * 时间**由调用方传**（`register(manifest, { now })`）：本模块不取 `Date.now()`，
 * 所以没传时刻时 `loadedAt` 就是 null（不是「现在」）。
 *
 * @param {{factoryChannels?:string[]}} [opts] 覆盖出厂渠道名单
 */
export function createRegistry(opts = {}) {
  const factory = new Set(
    (Array.isArray(opts.factoryChannels) ? opts.factoryChannels : FACTORY_CHANNELS).map(String)
  );
  const byId = new Map();
  const byName = new Map();
  const nameKey = (n) => String(n == null ? "" : n).trim().toLowerCase();

  /**
   * 只查不写：这个声明能不能装。装不了就**为什么**说清楚。
   *
   * 面板要的是这个（「这个插件能不能装」），而不是先抛一个异常再让人猜。
   */
  function check(manifest) {
    const v = validateManifest(manifest, { factoryChannels: [...factory] });
    if (!v.ok) return { ok: false, errors: v.errors, spec: null };

    const spec = toProviderSpec(v.manifest);
    const errors = [];
    if (factory.has(spec.id)) {
      errors.push({
        field: "id",
        message: `渠道键「${spec.id}」跟出厂渠道撞了：插件不能占用出厂渠道的键 ——`
          + "那等于让一个插件改掉用户已有的配置（比如用户自己的 bai 凭据与上游）。",
      });
    } else if (byId.has(spec.id)) {
      errors.push({
        field: "id",
        message: `渠道键「${spec.id}」已经有一个插件了（${byId.get(spec.id).name}）：`
          + "一个渠道键只能对应一家 —— 覆盖会让后装的那个悄悄改掉先装的那个的配置。",
      });
    }
    const nk = nameKey(spec.name);
    if (byName.has(nk)) {
      errors.push({
        field: "name",
        message: `已经有插件叫「${spec.name}」了（渠道键 ${byName.get(nk).id}）：`
          + "显示名要能唯一认出是哪一家。",
      });
    }
    if (spec.relayPort) {
      const taken = [...byId.values()].find((e) => e.relayPort === spec.relayPort);
      if (taken) {
        errors.push({
          field: "relayPort",
          message: `中转端口 ${spec.relayPort} 已经被插件「${taken.name}」占了：`
            + "两个中转抢同一个监听口，表现是请求随机打到另一家。",
        });
      }
    }
    if (errors.length) return { ok: false, errors, spec: null };
    return { ok: true, errors: [], spec };
  }

  /**
   * 装一个插件（声明 → 规格 → 记住）。
   *
   * 装不上就**抛错**（消息是人话，`err.errors` 里是逐条的结构化错误）。
   *
   * @param {object} manifest 声明对象
   * @param {{now?:number, source?:string}} [options]
   *        `now` 是**调用方**给的时刻（epoch ms）；不给就是 null。
   *        `source` 是这份声明的出处（文件路径之类），只是记下来备查。
   * @returns {object} 装好的规格
   */
  function register(manifest, options = {}) {
    const res = check(manifest);
    if (!res.ok) {
      const e = new Error(`这份插件装不上：\n${formatErrors(res.errors)}`);
      e.errors = res.errors;
      e.code = "PLUGIN_CONFLICT";
      throw e;
    }
    const entry = {
      ...res.spec,
      loadedAt: options.now == null ? null : options.now,
      source: options.source == null ? null : String(options.source),
    };
    byId.set(entry.id, entry);
    byName.set(nameKey(entry.name), entry);
    return entry;
  }

  return {
    /** 装一个；装不上抛错。 */
    register,
    /** 装一批；有一个装不上就整体抛错（前面几个也会跟着抛出去，不会留下半份状态）。 */
    registerAll(manifests, options = {}) {
      const list = Array.isArray(manifests) ? manifests : [];
      const out = [];
      for (const m of list) out.push(register(m, options));
      return out;
    },
    /** 只查不装：这个声明能不能装（面板用）。 */
    check,
    /** 按渠道键取；没有就 null。 */
    get(id) {
      return byId.get(String(id == null ? "" : id)) || null;
    },
    /** 按显示名取（大小写与首尾空格都当没有）；没有就 null。 */
    findByName(name) {
      return byName.get(nameKey(name)) || null;
    },
    /** 有这个渠道键吗。 */
    has(id) {
      return byId.has(String(id == null ? "" : id));
    },
    /** 卸掉一个（按渠道键）；没装过就返回 null。 */
    unregister(id) {
      const k = String(id == null ? "" : id);
      const entry = byId.get(k);
      if (!entry) return null;
      byId.delete(k);
      byName.delete(nameKey(entry.name));
      return entry;
    },
    /** 已装的全部（按装上的先后）。 */
    list() {
      return [...byId.values()];
    },
    /** 已装的渠道键（按装上的先后）。 */
    keys() {
      return [...byId.keys()];
    },
    /** 出厂渠道名单（这份注册表认的）。 */
    factoryChannels() {
      return [...factory];
    },
    /** 清空（测试与「重载插件」用）。 */
    clear() {
      byId.clear();
      byName.clear();
    },
  };
}
