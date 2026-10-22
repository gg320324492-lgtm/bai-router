/**
 * pluginrt.mjs —— 代码插件运行时的**宿主侧**
 * （装载 / 校验 / 启动 / 监管 / 窄协议 / 超时与杀进程）
 *
 * ── 它补的是哪个洞 ──────────────────────────────────────────────────────
 * 本仓已经有两套「插件」，但两套都是**声明式**的：
 *   · `src/server/plugin.mjs` —— 声明式 provider 插件：一份 JSON 加一家渠道；
 *   · `src/server/middleware.mjs` —— 声明式 middleware：一份 JSON 改写请求。
 * 它们只说「改什么」，不说「怎么算」：条件一旦复杂起来（按响应内容判断、按多档
 * 组合、按用户自己的配置取值），就得把逻辑搬进代码 —— 而那是改**热路径**。
 * magpie 的答案是**插件里跑真 JS**（网关进程内的 moejs）。
 *
 * 本模块是那一段的**宿主侧**：把一份声明 + 一段插件代码变成一个**独立子进程**，
 * 用一条窄协议问它「这次请求你要怎么改」，再把它的回答**严格验一遍**才采用。
 * 子进程那一侧在 `src/server/plugin-worker.mjs`。
 *
 * ── magpie 对应哪个文件 ────────────────────────────────────────────────
 *   · `internal/pluginrt/pluginrt.go` —— magpie 的**注册表**（Register / Manifest /
 *     Requires / Provides / 生命周期 / 状态机）。对应本模块的 {@link createRuntime}
 *     （登记、装载、停掉、状态）。
 *   · `internal/middleware/run.go` —— 一条请求上的钩子链（onRequest 逐个跑、谁先谁后、
 *     失败怎么办）。对应本模块 {@link createRuntime} 返回值里的 `apply`。
 *   · `internal/plugin/host.js` —— magpie 在 Bun 里**真正执行**插件 JS 的地方。
 *     对应本模块的 `src/server/plugin-worker.mjs`。
 *   · `internal/jsmod/` —— magpie 编译插件模块的地方（把插件打成一个模块再加载）。
 *     本仓不做打包，插件自己带齐依赖。
 *
 * ── 与 magpie 有意不同的点（以及原因）──────────────────────────────────
 *   1. **magpie 的插件在网关进程内跑（moejs），本仓的插件在独立子进程里跑。**
 *      moejs 是 Go 写的 JS 引擎，与网关**共享进程**：插件能读能写能发网络请求，代价是
 *      插件和网关同生共死（一个死循环能把整个网关拖住），而且插件看得见网关内存里的
 *      一切。本仓的插件是要**分发给别人的代码**，必须假设它是恶意的：所以是
 *      子进程 + Node 权限模型 + 窄协议（见下面的「沙箱」一节）。
 *   2. **magpie 的插件能改凭据头，本仓的插件不能。**
 *      magpie 的钩子拿到整个请求（含 authorization），改它就是改「你的 key 去哪」。
 *      本仓的插件**看不到凭据、也改不了凭据头**（{@link validateDecision} 会拒）——
 *      能改凭据的插件 = 能把你的 key 发到别处的插件。
 *   3. **magpie 超时是「打断钩子」（moejs 能中断），本仓是「杀掉进程」。**
 *      JS 里没有安全的「打断一段正在跑的函数」：唯一的办法是把整个进程杀掉。杀掉之后
 *      这个插件要重装才能再用（{@link createRuntime} 的 `install` / `remove`）。
 *   4. **magpie fail open（钩子抛错就原样放行），本仓 fail closed。**
 *      插件出错/超时 → **这一次请求明确失败**（不是静悄悄按原样放行）：magpie 的钩子
 *      是「顺手改一下」，出错多半不影响主流程；本仓的插件是**决策者**（它能拒绝这次
 *      请求），它失灵时若还当没发生，用户永远不知道规则没生效。
 *      需要「插件坏了就放过」的话，`createRuntime({ onError: "pass" })` 可以改。
 *   5. **两套插件各管各的目录，不共用一个注册表。**
 *      provider 插件是「加一家渠道」（`DATA_DIR/plugins`），声明式 middleware 是
 *      「一份 JSON 改写请求」（`DATA_DIR/middleware`），代码插件是「跑真 JS 改写请求」
 *      （本仓约定 `DATA_DIR/code-plugins`，见 {@link PLUGINRT_DIRNAME}）。
 *      三套各有一个注册表；本模块**不 import** `plugin.mjs` / `middleware.mjs`，
 *      连 id 空间都是分开的（同一个 id 在两套里指两件不相干的事）。
 *   6. **零依赖、零时钟。**
 *      本文件不 import 仓库里任何模块（连 `plugin.mjs` 也不 import —— 只借它的
 *      **形状**：manifestVersion / id / name / 人话错误 / 未知字段报错），
 *      也不取 `Date.now()`：时刻由 `opts.now` 传进来，超时由 `opts.timeoutMs` 封顶。
 *
 * ── 沙箱与权限模型（以及它的边界）──────────────────────────────────────
 * **怎么做的**（三层，从外到内）：
 *   ① **进程隔离**：插件代码只在 `child_process.fork` 出来的**子进程**里跑。
 *      宿主进程**从不 eval 插件代码**（连 `vm` 都不用 —— `vm` 不是安全边界：它挡不住
 *      `process`，也挡不住原型链逃逸）。插件崩了/死循环了/发疯了，炸的也只是子进程。
 *   ② **Node 权限模型**：`--permission`（Node 23.5+；Node 20/22 上叫
 *      `--experimental-permission`；宿主会自己探测用哪个名字）。开了它以后，
 *      **默认**禁止：读写文件（除下面点名的路径）、`child_process`、
 *      `worker_threads`、inspector。这三条是**内核级**的（Node 自己在 C++ 里拦），
 *      插件绕不过去。
 *      权限模型是**按路径**授权的，所以「这个插件要读 D:\某目录」必须由**清单显式
 *      声明**，宿主在装之前把它**列出来给人看**（{@link describePermissions}）。
 *   ③ **我们自己补的那一层（网络）**：Node 的权限模型**不管网络**（没有
 *      `--allow-net`），所以「要不要联网」由子进程自己拦：用模块钩子
 *      （`module.registerHooks`）把 `node:http` / `node:net` / `node:tls` 这些
 *      模块入口封掉，再删掉 `fetch` / `WebSocket` 两个全局，以及
 *      `process.binding` / `process.getBuiltinModule` / `process.dlopen`
 *      三个能绕过模块入口的原生口子。
 *      ⚠ 这一层**不是内核级的**：它是「模块入口 + 全局对象」层面的封堵，
 *      理论上仍有未封到的出网路子。它比 magpie（moejs 里插件想发网络请求就发）严格，
 *      但**不等于**防火墙。
 *
 * **挡得住什么**：
 *   · 插件**看不到凭据**：请求摘要里只有白名单字段（渠道/档位/模型/参数/头**名**），
 *     凭据头的**值**根本不进子进程，凭据头的**名字**也被剔掉；
 *   · 插件**读不到没声明的路径**（Node 权限模型按路径拦，内核级）；
 *   · 插件**写不了任何文件**（权限模型默认禁写，我们从不开 `--allow-fs-write`）；
 *   · 插件**起不了子进程、起不了 worker、连不上 inspector**（权限模型默认禁）；
 *   · 插件**改不了凭据头**（{@link validateDecision} 明确拒绝）；
 *   · 插件**碰不到宿主内存、碰不到别的插件、碰不到别的请求**（进程隔离 + 每个插件
 *     一个子进程 + 一次只递一份摘要）；
 *   · 插件**挂住**时宿主要能超时杀掉它，这次请求**明确失败**（不挂住整个中转）。
 *
 * **挡不住什么（必须写下来的边界）**：
 *   · **挡不住「授权范围内」的读取**：清单写了 `fsRead: ["D:\\资料"]`，插件就能读
 *     那底下的一切 —— 这是授权，不是漏洞，但它意味着**清单就是权限**。
 *   · **挡不住同机同用户**：子进程和宿主跑在同一个用户下，操作系统层面的隔离
 *     （另一个用户 / 容器 / 虚拟机 / 商业沙箱）我们**没做**。子进程能看见宿主的
 *     进程列表、环境变量以外的本机公开信息。
 *   · **挡不住资源耗尽**：插件可以在自己的进程里吃满 CPU/内存。我们保证「超时之后
 *     杀掉它、这次请求明确失败」，**不保证**给它配资源上限（没有 cgroup / job object）。
 *   · **网络那一层不是内核级的**：模块入口 + 全局对象层面的封堵，见上面 ③。
 *   · **插件看得见自己经手的那一次请求摘要**（这是它工作必需的），也**能把自己记下的
 *     东西留在自己的进程里**（下一次请求还在那个进程里）。我们保证的是「不把别的
 *     请求/别的插件的数据递给它」，不是「它失忆」。
 *   · **协议是窄的，但不是防伪证的**：插件能决定自己那一次的答复（这是它的职责），
 *     它伪造不了**别的插件**的答复（各自一个子进程、各自一条通道）。
 *
 * ── 清单格式（完整例子）────────────────────────────────────────────────
 *   {
 *     "manifestVersion": 1,
 *     "id": "word-guard",
 *     "name": "敏感词拦截",
 *     "entry": "main.mjs",
 *     "timeoutMs": 500,
 *     "permissions": {
 *       "fsRead": ["D:\\资料\\词库"],
 *       "net": false
 *     }
 *   }
 *
 * 字段说明：
 *   · `manifestVersion` —— 格式版本，现在只认 1；不认识就报错（别猜着解析）。
 *   · `id` —— 这个插件的键（小写字母 / 数字 / 短横线）。**与 provider 插件的 id 空间
 *     是分开的**（不在同一个注册表里）。
 *   · `name` —— 面板上显示的名字。
 *   · `entry` —— 入口文件，**相对插件自己的目录**，只许 `.mjs`（ESM）或 `.cjs`
 *     （CommonJS）。不许 `..`、不许绝对路径。
 *   · `timeoutMs` —— 这一次调用最多给它多少毫秒（默认 1000，最长 60000）。
 *     实际生效的是 `min(清单里的, opts.timeoutMs)`：清单只能往小里改，不能突破宿主的
 *     封顶。
 *   · `permissions.fsRead` —— **显式**列出这个插件要读哪些路径（绝对路径）。
 *     不写 = 一个文件都不许读（除了它自己那点代码）。
 *   · `permissions.net` —— 要不要联网。**默认 false**（默认没有任何权限）。
 *
 * 插件入口长这样（`.mjs`）：
 *   export default function (request, api) {
 *     api.log(`看到 ${request.channel} 的 ${request.model}`);
 *     if (request.tier !== "claude-opus-5") return { action: "allow" };
 *     return { action: "modify", params: { temperature: 0.2 } };
 *   }
 *
 * `request` 是**摘要**（不是真请求）：{ channel, tier, model, protocol, path, stream,
 * headerNames, params }。`api` 只有两个成员：`log(msg)`（进宿主的面板日志）与
 * `now`（宿主给的时刻，插件不必自己取时钟）。
 * 返回值：{ action: "allow" } / { action: "deny", reason: "人话原因" } /
 * { action: "modify", headers?, params?, model? }。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────
 *   · **零依赖**：不 import 仓库里任何模块，不用任何三方包。
 *   · **零时钟**：不取 `Date.now()`（时刻由 `opts.now` 传进来）。
 *   · 宿主**不执行**插件代码（只编译检查 + 起子进程）；执行在子进程里。
 *   · 本模块不写盘、不落日志文件：怎么落盘、怎么上报，交给调用方（`opts.log`）。
 */

import { execFile, fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ====================================================================== *
 * 常量
 * ====================================================================== */

/** 清单格式版本。现在只认 1 —— 版本不认识时**报错**，不猜着解析。 */
export const MANIFEST_VERSION = 1;

/**
 * 代码插件的目录名（相对数据目录）。
 *
 * 为什么单独一个：provider 插件在 `DATA_DIR/plugins`（加一家渠道），声明式
 * middleware 在 `DATA_DIR/middleware`（一份 JSON 改写请求），代码插件是
 * `DATA_DIR/code-plugins`（跑真 JS 改写请求）。三套各管各的目录、各有各的
 * 注册表 —— 混在一起就会出现「provider 插件的清单被当代码插件加载」这种
 * 一眼看不出根因的事故。
 */
export const PLUGINRT_DIRNAME = "code-plugins";

/** 插件目录里的清单文件名。 */
export const MANIFEST_FILENAME = "plugin.json";

/** 插件键的形状：小写字母、数字、短横线；首字符必须是字母或数字；总长 ≤ 64。 */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 清单里允许出现的字段（其余一律当「不认识的字段」报错）。 */
const KNOWN_FIELDS = Object.freeze([
  "manifestVersion", "id", "name", "entry", "timeoutMs", "permissions",
]);

/** `permissions` 里允许出现的字段。 */
const KNOWN_PERMISSION_FIELDS = Object.freeze(["fsRead", "net"]);

/**
 * 清单里**不许**出现的字段名（凭据）。
 *
 * 理由与 `plugin.mjs` 一样：插件是要分发给别人的东西，一份带 key 的清单装到十台
 * 机器上就是一把 key 摊给十个不相干的人（还多半进了 git）。凭据由用户在面板里填。
 */
const CREDENTIAL_FIELDS = Object.freeze([
  "apiKey", "api_key", "apikey", "key", "token", "accessToken", "access_token",
  "refreshToken", "refresh_token", "secret", "secretKey", "secret_key",
  "password", "passwd", "credential", "credentials", "authorization", "bearer",
  "sessionToken", "session_token", "cookie",
]);

/** 默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 1000;

/** 清单里能声明的最大超时（毫秒）。 */
export const MAX_TIMEOUT_MS = 60000;

/** 装载插件（起进程 + 加载代码）最多等多久（毫秒）。 */
export const LOAD_TIMEOUT_MS = 5000;

/** 入口文件只许这两种扩展名。 */
export const ENTRY_EXTENSIONS = Object.freeze([".mjs", ".cjs"]);

/**
 * 子进程环境变量的**白名单**。
 *
 * 为什么是白名单而不是黑名单：宿主进程的环境里通常有 `ANTHROPIC_API_KEY` 这类
 * 凭据（Electron 启动时就带上了）。黑名单永远漏 —— 新加一种变量名就漏一次。
 * 白名单只放「进程能跑起来」必需的东西。
 */
const CHILD_ENV_ALLOW = Object.freeze([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "SystemDrive", "WINDIR",
  "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA",
  "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ComSpec",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS", "ELECTRON_RUN_AS_NODE",
]);

/**
 * 凭据类的头名 —— 摘要里**不出现**、插件**不许改**。
 *
 * 头**值**当然不给（那是凭据本身）；连头**名**也剔掉：插件不需要知道
 * 「这个请求带了 authorization」才能改写参数。
 */
const CREDENTIAL_HEADER_TOKENS = Object.freeze([
  "authorization", "apikey", "cookie", "token", "secret", "password",
  "passwd", "credential", "session",
]);

/** 凭据类的参数名 —— 摘要里剔掉、决策里拒掉。 */
const CREDENTIAL_PARAM_NAMES = Object.freeze([
  "apikey", "authorization", "cookie", "token", "accesstoken", "refreshtoken",
  "idtoken", "sessiontoken", "bearertoken", "secret", "clientsecret", "password",
  "passwd", "credential", "credentials", "sessionid", "xapikey", "openaiapikey",
  "anthropicapikey",
]);

/** 头名的合法字符（HTTP token）。 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 参数名的合法形状。 */
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 不许出现的键（原型污染）。 */
const FORBIDDEN_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

/** 决策里允许出现的字段。 */
const KNOWN_DECISION_FIELDS = Object.freeze(["action", "headers", "params", "model", "reason"]);

/** 决策里允许的动作。 */
const DECISION_ACTIONS = Object.freeze(["allow", "deny", "modify"]);

/* ====================================================================== *
 * 小工具（纯函数）
 * ====================================================================== */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 深拷贝档位映射 —— 免得调用方改了返回值就改坏注册表里的原件。 */
function cloneObject(obj) {
  const out = Object.create(null);
  for (const k of Object.keys(obj || {})) out[k] = obj[k];
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

/** 头名是不是凭据类（摘要里剔掉、决策里拒掉）。 */
export function isCredentialHeader(name) {
  const norm = String(name || "").toLowerCase().replace(/[-_]/g, "");
  return CREDENTIAL_HEADER_TOKENS.some((t) => norm.includes(t));
}

/** 参数名是不是凭据类。 */
export function isCredentialParam(name) {
  const norm = String(name || "").toLowerCase().replace(/[-_]/g, "");
  if (CREDENTIAL_PARAM_NAMES.includes(norm)) return true;
  return ["apikey", "accesstoken", "refreshtoken", "clientsecret", "sessiontoken", "bearertoken"]
    .some((t) => norm.endsWith(t));
}

/**
 * 把一个值洗成「可以安全地递给别人」的形状。
 *
 * 只留标量与浅层容器：字符串有长度上限（长的多半是正文，不是参数），
 * 深度有上限（防止深递归把宿主拖住），危险键直接扔掉。
 */
function scrubValue(v, depth = 0) {
  if (v === null) return null;
  const t = typeof v;
  if (t === "boolean") return v;
  if (t === "number") return Number.isFinite(v) ? v : null;
  if (t === "string") return v.length > 512 ? v.slice(0, 512) : v;
  if (depth >= 4) return null;
  if (Array.isArray(v)) {
    const out = [];
    for (const item of v.slice(0, 32)) out.push(scrubValue(item, depth + 1));
    return out;
  }
  if (t === "object") {
    const out = Object.create(null);
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n >= 32) break;
      if (FORBIDDEN_KEYS.includes(k)) continue;
      out[k] = scrubValue(v[k], depth + 1);
      n++;
    }
    return out;
  }
  return null;
}

/* ====================================================================== *
 * ① 解析
 * ====================================================================== */

/**
 * 把一份声明文本读成对象。
 *
 * ⚠ **只吃 JSON**：YAML 的解析器是外部依赖，而本仓不引新依赖；要 YAML 就先在
 *   解析前转成 JSON（与 `plugin.mjs` / `middleware.mjs` 同口径）。
 *
 * 失败时**抛错**（消息是人话）：JSON 语法错、顶层不是对象、空文件。
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
 * 返回 `{ ok, errors, manifest }`：全过才 `ok`；`errors` 每条 `{field, message}`
 * （`field` 是出错的字段名，面板据此标出是哪一栏）；`manifest` 是过了之后的
 * **归一化**声明（补上缺省的 `timeoutMs`、把 `permissions` 补齐）。
 *
 * 检查项：格式版本、id、显示名、入口文件、超时、权限声明，外加两条「不许」：
 * **凭据字段**与**不认识的字段**。
 *
 * @param {object} obj 待校验的声明（一般是 {@link parseManifest} 的产物）
 * @returns {{ok:boolean, errors:{field:string,message:string}[], manifest:object|null}}
 */
export function validateManifest(obj) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (!isPlainObject(obj)) {
    return {
      ok: false,
      errors: [{ field: "", message: "清单的顶层必须是一个 JSON 对象（{ … }），不是数组或标量。" }],
      manifest: null,
    };
  }

  /* ① 凭据字段 —— 先查，因为它比「不认识的字段」更该被单独点名 */
  for (const k of Object.keys(obj)) {
    if (CREDENTIAL_FIELDS.includes(k)) {
      fail(k, `清单里不许带凭据字段「${k}」：插件是要分发给别人的东西，`
        + "里面带 key 等于把你的 key 发给所有装这个插件的人。凭据请在面板里填。");
    }
  }

  /* ② 不认识的字段 —— 报错而不是忽略：`enrty` 这种手误若被静默忽略，
     这份清单会以「没写入口」的样子通过，用户看到的是另一种错，绕远路。 */
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

  /* ④ id */
  let id = null;
  if (obj.id === undefined) {
    fail("id", "清单缺少「id」：这是这个插件的键（小写字母 / 数字 / 短横线）。");
  } else if (typeof obj.id !== "string" || !obj.id.trim()) {
    fail("id", "插件键得是一段非空的文字。");
  } else {
    id = obj.id.trim();
    if (!PLUGIN_ID_RE.test(id)) {
      fail("id", `插件键「${id}」不合法：只许小写字母、数字和短横线（像 word-guard），`
        + "而且第一个字符得是字母或数字。");
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

  /* ⑥ 入口文件 */
  let entry = null;
  if (obj.entry === undefined) {
    fail("entry", "清单缺少「entry」：入口文件（相对插件自己的目录），"
      + `只许 ${ENTRY_EXTENSIONS.join(" 或 ")}。`);
  } else if (typeof obj.entry !== "string" || !obj.entry.trim()) {
    fail("entry", "入口文件得是一段非空的文字。");
  } else {
    entry = obj.entry.trim();
    const ext = path.extname(entry).toLowerCase();
    if (!ENTRY_EXTENSIONS.includes(ext)) {
      fail("entry", `入口文件「${entry}」的扩展名是 ${ext || "（没有）"}：`
        + `只许 ${ENTRY_EXTENSIONS.join(" 或 ")}（写清楚是哪种模块，别让宿主猜）。`);
    }
    if (path.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry)) {
      fail("entry", `入口文件「${entry}」得是**相对**插件目录的路径：`
        + "绝对路径在别人的机器上指不到同一个文件。");
    }
    const parts = entry.split(/[\\/]+/);
    if (parts.includes("..")) {
      fail("entry", `入口文件「${entry}」里不许有「..」：插件只许读自己目录里的东西。`);
    }
  }

  /* ⑦ 超时 */
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined && obj.timeoutMs !== null) {
    if (typeof obj.timeoutMs !== "number" || !Number.isInteger(obj.timeoutMs)) {
      fail("timeoutMs", `超时得是整数毫秒，拿到的是 ${JSON.stringify(obj.timeoutMs)}。`);
    } else if (obj.timeoutMs <= 0) {
      fail("timeoutMs", "超时得是正的毫秒数（0 等于「不给它时间」，那不如别装）。");
    } else if (obj.timeoutMs > MAX_TIMEOUT_MS) {
      fail("timeoutMs", `超时 ${obj.timeoutMs}ms 太大了：最多 ${MAX_TIMEOUT_MS}ms。`
        + "插件挂在热路径上，跑太久会把中转拖慢。");
    } else {
      timeoutMs = obj.timeoutMs;
    }
  }

  /* ⑧ 权限 —— 默认一个都没有 */
  const permissions = { fsRead: [], net: false };
  if (obj.permissions !== undefined && obj.permissions !== null) {
    if (!isPlainObject(obj.permissions)) {
      fail("permissions", "权限声明得是一个对象（{\"fsRead\": [...], \"net\": false} 这样）。");
    } else {
      for (const k of Object.keys(obj.permissions)) {
        if (!KNOWN_PERMISSION_FIELDS.includes(k)) {
          fail(`permissions.${k}`, `权限里有不认识的字段「${k}」：只许 ${KNOWN_PERMISSION_FIELDS.join("、")}。`);
        }
      }
      const fr = obj.permissions.fsRead;
      if (fr !== undefined && fr !== null) {
        if (!Array.isArray(fr)) {
          fail("permissions.fsRead", "要读的文件路径得是一个数组（[\"D:\\\\某目录\"] 这样）。");
        } else {
          const list = [];
          for (const p of fr) {
            if (typeof p !== "string" || !p.trim()) {
              fail("permissions.fsRead", "路径得是非空的文字。");
              continue;
            }
            const t = p.trim();
            if (!path.isAbsolute(t)) {
              fail("permissions.fsRead", `路径「${t}」得是**绝对路径**：`
                + "权限模型是按路径授权的，相对路径在谁的机器上指到哪说不准。");
              continue;
            }
            if (!list.includes(t)) list.push(t);
          }
          permissions.fsRead = list;
        }
      }
      if (obj.permissions.net !== undefined && obj.permissions.net !== null) {
        if (typeof obj.permissions.net !== "boolean") {
          fail("permissions.net", `「net」得是 true 或 false，拿到的是 ${JSON.stringify(obj.permissions.net)}。`);
        } else {
          permissions.net = obj.permissions.net === true;
        }
      }
    }
  }

  const manifest = id && name && entry ? {
    manifestVersion: MANIFEST_VERSION,
    id,
    name,
    entry,
    timeoutMs,
    permissions,
  } : null;

  return { ok: errors.length === 0, errors, manifest };
}

/* ====================================================================== *
 * ③ 权限展示（装之前给人看它要什么）
 * ====================================================================== */

/**
 * 把一份清单的权限翻成**给人看**的清单。
 *
 * 为什么单独做一个函数：权限模型是「按路径授权」的，用户不看清单就不知道
 * 插件要碰哪些目录。装之前必须能一眼看见「它要读 D:\资料、要不要联网」，
 * 否则「授权」就变成了「盲签」。
 *
 * @param {object} manifest 校验过的（归一化的）清单
 * @param {{dir?:string}} [opts] `dir` 是插件自己的目录 —— 宿主会额外放行它
 *        （不然插件连自己的代码都读不到），这一条也得如实列出来。
 * @returns {{kind:string, label:string, path?:string, allowed?:boolean}[]}
 */
export function describePermissions(manifest, opts = {}) {
  const m = manifest || {};
  const perms = m.permissions || { fsRead: [], net: false };
  const fsRead = Array.isArray(perms.fsRead) ? perms.fsRead.slice() : [];
  const net = perms.net === true;
  const out = [];

  if (opts.dir) {
    out.push({
      kind: "fsRead",
      path: opts.dir,
      label: `读插件自己的目录：${opts.dir}（它得读自己的代码，这是宿主自动放行的）`,
    });
  }
  for (const p of fsRead) {
    out.push({ kind: "fsRead", path: p, label: `读文件：${p}（含它下面的所有子目录）` });
  }
  if (fsRead.length === 0 && !opts.dir) {
    out.push({ kind: "fsRead", label: "读文件：（不许读任何文件）" });
  }
  out.push({
    kind: "net",
    allowed: net,
    label: net
      ? "联网：允许（它能往外发请求，也能连本机上的服务）"
      : "联网：不允许",
  });
  out.push({
    kind: "timeout",
    label: `单次调用超时：${m.timeoutMs || DEFAULT_TIMEOUT_MS}ms（超时会被杀掉，这次请求失败）`,
  });
  out.push({
    kind: "deny",
    label: "写文件：不允许（起子进程、开 worker、连调试器：都不允许）",
  });
  return out;
}

/* ====================================================================== *
 * ④ 请求摘要（插件能看到的那一份）
 * ====================================================================== */

/**
 * 把宿主手上的请求洗成**摘要** —— 插件唯一能看到的东西。
 *
 * 洗掉的东西（每一条都是凭据口子）：
 *   · 头**值**（authorization 的值就是凭据本身）→ 只留头**名**，而且凭据类的
 *     头名也剔掉；
 *   · 凭据类的参数名（api_key / token / secret …）；
 *   · 正文类的大块内容（摘要不是正文，参数只留标量与浅层容器，长的字符串截断）。
 *
 * @param {object} input 宿主手上的请求（可以有多余字段，多余的**一律不看**）
 * @returns {object} 摘要
 */
export function summarizeRequest(input) {
  const src = isPlainObject(input) ? input : {};
  const out = Object.create(null);

  for (const k of ["channel", "tier", "model", "protocol", "path"]) {
    const v = src[k];
    if (typeof v === "string" && v.length <= 200) out[k] = v;
  }
  /* 渠道：有的地方叫 provider（middleware.mjs 的叫法），两种都收。 */
  if (out.channel === undefined && typeof src.provider === "string" && src.provider.length <= 200) {
    out.channel = src.provider;
  }
  if (typeof src.stream === "boolean") out.stream = src.stream;

  /* 头：只有名字，没有值。凭据类的名字也剔掉。 */
  const names = [];
  const raw = src.headers ?? src.headerNames;
  const pushName = (n) => {
    if (typeof n !== "string") return;
    const t = n.trim().toLowerCase();
    if (!t || t.length > 128) return;
    if (isCredentialHeader(t)) return;
    if (!names.includes(t)) names.push(t);
  };
  if (Array.isArray(raw)) raw.forEach(pushName);
  else if (isPlainObject(raw)) Object.keys(raw).forEach(pushName);
  out.headerNames = names.slice(0, 64).sort();

  /* 参数：标量与浅层容器，凭据类的键剔掉。 */
  const params = Object.create(null);
  if (isPlainObject(src.params)) {
    let n = 0;
    for (const k of Object.keys(src.params)) {
      if (n >= 32) break;
      if (FORBIDDEN_KEYS.includes(k)) continue;
      if (!PARAM_NAME_RE.test(k)) continue;
      if (isCredentialParam(k)) continue;
      params[k] = scrubValue(src.params[k], 0);
      n++;
    }
  }
  out.params = params;

  return out;
}

/* ====================================================================== *
 * ⑤ 决策校验（插件说的话，宿主只认这一种形状）
 * ====================================================================== */

/**
 * 校验插件返回的「怎么改」。
 *
 * 这里就是**信任边界**：插件说什么，宿主只按这张表执行，多余的一律当错。
 *   · `action`：`allow`（不改）/ `deny`（拒绝这次请求，带一句人话原因）/
 *     `modify`（改头/改参数/改模型）。
 *   · `headers`：**只许加/改普通头**；凭据类头名直接拒（能改凭据的插件 =
 *     能把你的 key 发到别处的插件）；值里不许有换行（那是头注入）。
 *   · `params`：只许标量与浅层容器，参数名合法，凭据类的键拒。
 *   · `model`：一段非空文字。
 *   · `reason`：拒绝时必填，一句人话。
 *   · 不认识的字段：**报错**而不是忽略（静默忽略会让作者以为「设置成功了」）。
 *
 * @param {any} value 插件返回的东西
 * @returns {{ok:boolean, errors:{field:string,message:string}[], decision:object|null}}
 */
export function validateDecision(value) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (value === undefined || value === null) {
    return { ok: true, errors: [], decision: { action: "allow" } };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      errors: [{ field: "", message: "插件返回的不是对象：得是 {action: …} 这样的决定。" }],
      decision: null,
    };
  }

  for (const k of Object.keys(value)) {
    if (!KNOWN_DECISION_FIELDS.includes(k)) {
      fail(k, `插件返回了不认识的字段「${k}」：只许 ${KNOWN_DECISION_FIELDS.join("、")}。`);
    }
  }

  let action = value.action;
  const hasChange = value.headers !== undefined || value.params !== undefined || value.model !== undefined;
  if (action === undefined || action === null) {
    action = hasChange ? "modify" : "allow";
  }
  if (typeof action !== "string" || !DECISION_ACTIONS.includes(action)) {
    fail("action", `动作「${JSON.stringify(action)}」不认：只许 allow / deny / modify。`);
    action = "allow";
  }

  const decision = { action };

  /* headers */
  if (value.headers !== undefined && value.headers !== null) {
    if (!isPlainObject(value.headers)) {
      fail("headers", "headers 得是一个对象（{\"x-foo\": \"bar\"} 这样）。");
    } else {
      const h = Object.create(null);
      for (const raw of Object.keys(value.headers)) {
        const name = String(raw).trim().toLowerCase();
        if (!HEADER_NAME_RE.test(name)) {
          fail(`headers.${raw}`, `头名「${raw}」不合法：头名只能是字母数字和 !#$%&'*+-.^_\`|~ 这些字符。`);
          continue;
        }
        if (isCredentialHeader(name)) {
          fail(`headers.${raw}`, `不许改凭据类的头「${raw}」：能改凭据的插件 = 能把你的 key 发到别处的插件。`);
          continue;
        }
        const v = value.headers[raw];
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
          fail(`headers.${raw}`, `头「${name}」的值得是文字（数字和布尔也当文字处理）。`);
          continue;
        }
        const s = String(v);
        if (/[\r\n]/.test(s)) {
          fail(`headers.${raw}`, `头「${name}」的值里不许有换行：那是头注入（能把请求劈成两个）。`);
          continue;
        }
        if (s.length > 1024) {
          fail(`headers.${raw}`, `头「${name}」的值太长了（1024 字符以内）。`);
          continue;
        }
        h[name] = s;
      }
      decision.headers = h;
    }
  }

  /* params */
  if (value.params !== undefined && value.params !== null) {
    if (!isPlainObject(value.params)) {
      fail("params", "params 得是一个对象（{\"temperature\": 0.2} 这样）。");
    } else {
      const p = Object.create(null);
      let n = 0;
      for (const k of Object.keys(value.params)) {
        if (n >= 32) break;
        if (FORBIDDEN_KEYS.includes(k)) {
          fail(`params.${k}`, `参数名「${k}」不许用。`);
          continue;
        }
        if (!PARAM_NAME_RE.test(k)) {
          fail(`params.${k}`, `参数名「${k}」不合法：只许字母、数字、下划线，且第一个字符是字母或下划线。`);
          continue;
        }
        if (isCredentialParam(k)) {
          fail(`params.${k}`, `不许改凭据类的参数「${k}」。`);
          continue;
        }
        p[k] = scrubValue(value.params[k], 0);
        n++;
      }
      decision.params = p;
    }
  }

  /* model */
  if (value.model !== undefined && value.model !== null) {
    if (typeof value.model !== "string" || !value.model.trim()) {
      fail("model", "model 得是一段非空的文字。");
    } else if (value.model.length > 200) {
      fail("model", "model 太长了（200 字符以内）。");
    } else if (/[\r\n]/.test(value.model)) {
      fail("model", "model 里不许有换行。");
    } else {
      decision.model = value.model.trim();
    }
  }

  /* reason */
  if (value.reason !== undefined && value.reason !== null) {
    if (typeof value.reason !== "string" || !value.reason.trim()) {
      fail("reason", "reason 得是一段非空的文字（这是给用户看的人话）。");
    } else if (value.reason.length > 300) {
      fail("reason", "reason 太长了（300 字符以内）。");
    } else {
      decision.reason = value.reason.trim();
    }
  }
  if (decision.action === "deny" && !decision.reason) {
    fail("reason", "拒绝这次请求得给一句 reason（人话）：用户得知道你为什么被挡了。");
  }

  return { ok: errors.length === 0, errors, decision: errors.length === 0 ? decision : null };
}

/* ====================================================================== *
 * ⑥ 语法检查（只编译，不执行）
 * ====================================================================== */

/**
 * 编译检查插件入口的语法 —— **只编译，绝不执行**。
 *
 * 用 `node --check`（不执行目标文件，只解析）而不是 `vm.Script`：插件是 ESM
 * （`import` / `export`），`vm.Script` 只会编译成「脚本」，见到 import 就报
 * 「Cannot use import statement outside a module」—— 那是**假错**。`node --check`
 * 按扩展名走对应的模块类型，.mjs 当 ESM、.cjs 当 CommonJS，报的是真错。
 *
 * 语法错必须变成**人话**（哪一行、什么错），不能是一坨 Node 的堆栈。
 *
 * @param {string} file 入口文件绝对路径
 * @param {string} nodePath 用哪个 node 二进制
 * @returns {Promise<{ok:boolean, message?:string}>}
 */
export function checkSyntax(file, nodePath) {
  return new Promise((resolve) => {
    execFile(
      nodePath,
      ["--check", file],
      { env: buildChildEnv(process.env), windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true });
          return;
        }
        resolve({ ok: false, message: humanizeSyntaxError(String(stderr || "") + String(stdout || "")) });
      }
    );
  });
}

/** 把 `node --check` 的输出翻成一句人话（带行号）。 */
function humanizeSyntaxError(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  let line = 0;
  let message = "";
  for (const l of lines) {
    const m = /^(.+):(\d+)$/.exec(l);
    if (m && !line) {
      line = Number(m[2]);
      continue;
    }
    const s = /^SyntaxError:\s*(.+)$/.exec(l);
    if (s && !message) {
      message = s[1].trim();
      break;
    }
  }
  if (!message) {
    const first = lines.find((l) => l.trim());
    message = first ? first.trim() : "语法不对（Node 没说出是哪一行）";
  }
  return line
    ? `插件入口有语法错误：第 ${line} 行 ${message}`
    : `插件入口有语法错误：${message}`;
}

/* ====================================================================== *
 * ⑦ 子进程环境（白名单）
 * ====================================================================== */

/**
 * 造子进程的环境变量。
 *
 * 白名单的原因见 {@link CHILD_ENV_ALLOW}：宿主的環境里常有 API key 一类凭据，
 * 子进程**不需要**它们，也不该看得见。`NODE_OPTIONS` 尤其不能带过去 —— 它能
 * 塞进 `--allow-fs-read=...`，那样沙箱就白设了。
 */
function buildChildEnv(source) {
  const src = isPlainObject(source) ? source : {};
  const out = {};
  for (const k of CHILD_ENV_ALLOW) {
    const v = src[k];
    if (typeof v === "string") out[k] = v;
  }
  /* Electron 里跑的 node（ELECTRON_RUN_AS_NODE）派生的子进程也得是 node：
     不然 electron.exe 会把它当成「要开一个窗口的应用」去启动。 */
  if (process.versions && process.versions.electron && !out.ELECTRON_RUN_AS_NODE) {
    out.ELECTRON_RUN_AS_NODE = "1";
  }
  return out;
}

/** 宿主这个 Node 支持哪个权限模型开关（都不支持就返回 null）。 */
export function detectPermissionFlag() {
  const allowed = process.allowedNodeEnvironmentFlags;
  if (allowed && typeof allowed.has === "function") {
    if (allowed.has("--permission")) return "--permission";
    if (allowed.has("--experimental-permission")) return "--experimental-permission";
  }
  return null;
}

/* ====================================================================== *
 * ⑧ 协议（宿主这一侧）
 * ====================================================================== */

/**
 * 宿主 ↔ 子进程的一条窄通道：JSON-RPC 风格的 JSON 行。
 *
 * 方向与形状：
 *   宿主 → 子进程（stdin，每行一个 JSON）：
 *     {"t":"init","id":"p1","token":"…","entry":"…","pluginDir":"…",
 *      "permissions":{"fsRead":[],"net":false},"now":0}
 *     {"t":"transform","id":"p1","request":{…},"now":0}
 *     {"t":"shutdown"}
 *   子进程 → 宿主（stdout，每行一个 JSON，**前面带一个只有宿主与子进程知道的
 *   令牌**）：令牌对不上的一律当噪声丢掉 —— 插件可以直接往 stdout 写字节，
 *   没有令牌它伪造不了协议消息。
 *
 * 为什么用行分隔的 JSON 而不是裸对象：`fork` 的 IPC 通道虽然也是消息制的，
 * 但插件代码能摸到 `process.send`（它和子进程同处一个 realm），而 stdout +
 * 令牌是**另一条**路：插件能写 stdout，但写不出带令牌的行。
 */
class WorkerChannel {
  constructor({ child, token, onLog, onNoise }) {
    this.child = child;
    this.token = token;
    this.onLog = onLog || (() => {});
    this.onNoise = onNoise || (() => {});
    this.seq = 0;
    this.pending = new Map();
    this.buffer = "";
    this.dead = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.onNoise({ level: "warn", message: line });
      }
    });
    child.on("exit", (code, signal) => this._onExit(code, signal));
    child.on("error", (e) => this._onExit(null, null, e));
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      this._onLine(line);
    }
    /* 插件往 stdout 灌了一堆没换行的东西 —— 别把内存吃光。 */
    if (this.buffer.length > 1 << 20) {
      this.onNoise({ level: "warn", message: "插件输出了一行超长的内容，已经丢掉。" });
      this.buffer = "";
    }
  }

  _onLine(line) {
    const text = line.trim();
    if (!text) return;
    const prefix = `${this.token} `;
    if (!text.startsWith(prefix)) {
      /* 没有令牌的行 = 插件自己往 stdout 写的：只当日志，不当协议。 */
      this.onNoise({ level: "info", message: text });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text.slice(prefix.length));
    } catch {
      this.onNoise({ level: "warn", message: "子进程回了一行看不懂的 JSON。" });
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "log") {
      this.onLog({ level: msg.level === "error" ? "error" : msg.level === "warn" ? "warn" : "info", message: String(msg.message || "") });
      return;
    }
    if (msg.t !== "res") return;
    const p = this.pending.get(msg.id);
    if (!p) return;           /* 不认识的对端答复：丢掉（插件伪造不了别的插件的答复，但多一事不如少一事） */
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject({ code: msg.code || "PLUGIN_ERROR", message: String(msg.message || "插件报错了。") });
  }

  _onExit(code, signal, err) {
    this.dead = true;
    const why = err
      ? `子进程起不来：${err.message}`
      : `子进程退出了（${signal ? `被信号 ${signal} 杀掉` : `退出码 ${code}`}）`;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject({ code: "EXITED", message: why });
    }
  }

  /** 发一个请求，等一个答复；超时自己抛（杀人由调用方做 —— 那是策略，不是通道的事）。 */
  request(type, payload, timeoutMs) {
    if (this.dead) {
      return Promise.reject({ code: "EXITED", message: "子进程已经不在了。" });
    }
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "TIMEOUT", message: `插件超过 ${timeoutMs}ms 没有回话。` });
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ ...payload, t: type, id }) + "\n";
      try {
        this.child.stdin.write(line, (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject({ code: "WRITE_FAILED", message: `写给插件失败：${err.message}` });
          }
        });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject({ code: "WRITE_FAILED", message: `写给插件失败：${e.message}` });
      }
    });
  }

  /** 往子进程喊一声（不等答复）。 */
  notify(type, payload) {
    if (this.dead) return;
    try {
      this.child.stdin.write(JSON.stringify({ ...payload, t: type }) + "\n");
    } catch { /* 管道断了：子进程那边自会退出，宿主在 exit 事件里知道 */ }
  }
}

/* ====================================================================== *
 * ⑨ 运行时
 * ====================================================================== */

/**
 * 造一个代码插件运行时。
 *
 * 运行时里装着若干插件，每个插件一个子进程；`apply` 拿一次请求摘要，逐个问
 * 它们「你要怎么改」，把答复**验过**之后合并成一份补丁。
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] 取时刻的函数（**不传就用 0** —— 本模块不取
 *        `Date.now()`，时刻一律由调用方给）。
 * @param {number} [opts.timeoutMs] 宿主给插件的**超时封顶**（毫秒）。清单里写的
 *        超时只能比它小。
 * @param {(entry:{level:string,message:string,pluginId?:string}) => void} [opts.log]
 *        日志出口（面板日志走这里）。
 * @param {string} [opts.workerPath] 子进程脚本的路径（默认与本文件同目录的
 *        `plugin-worker.mjs`）。
 * @param {string} [opts.nodePath] node 二进制（默认当前进程的可执行文件）。
 * @param {"fail"|"pass"} [opts.onError] 插件出错时这次请求怎么办：
 *        `fail`（默认）= 明确失败；`pass` = 原样放行（magpie 的 fail open）。
 * @param {string} [opts.rootDir] 插件根目录（`DATA_DIR/code-plugins`），只用于
 *        `installFromDir`。
 */
export function createRuntime(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => 0;
  const cap = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : MAX_TIMEOUT_MS;
  const workerPath = opts.workerPath
    || path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-worker.mjs");
  const nodePath = opts.nodePath || process.execPath;
  const onError = opts.onError === "pass" ? "pass" : "fail";
  const rootDir = opts.rootDir ? path.resolve(opts.rootDir) : null;
  const plugins = new Map();

  const log = (entry) => {
    if (typeof opts.log === "function") {
      try { opts.log(entry); } catch { /* 日志出口坏了不该连累中转 */ }
    }
  };

  /** 一个插件实际生效的超时：清单里的与宿主的封顶取小的。 */
  const effectiveTimeout = (m) => Math.max(1, Math.min(m.timeoutMs || DEFAULT_TIMEOUT_MS, cap));

  /** 令牌：只有宿主与子进程知道，插件伪造不了协议消息。 */
  const makeToken = () => {
    try {
      return randomBytes(16).toString("hex");
    } catch {
      /* randomBytes 不会失败（node:crypto 是内置模块）；真失败时退回 UUID ——
         也不能退回 Math.random()：令牌是这条通道的**防伪证**机制，
         弱随机的令牌 = 别的插件能猜出你的令牌。（原来的写法正踩着这条：
         ESM 里没有 require，那句永远抛错，于是一直走在 Math.random() 的
         兜底上 —— 顺带还破了本模块「零时钟」的不变式。） */
      return randomUUID().replace(/-/g, "");
    }
  };

  /* --------------------------------------------------------------- *
   * 装载
   * --------------------------------------------------------------- */

  /**
   * 装一个插件：读清单 → 校验 → 查入口 → 语法检查 → 起子进程 → 加载代码。
   *
   * 返回 `{ok, errors}`：装不上时 `errors` 是人话；装上了 `errors` 是空数组。
   */
  async function install(spec = {}) {
    const dir = path.resolve(String(spec.dir || ""));
    if (!existsSync(dir)) {
      return { ok: false, errors: [{ field: "dir", message: `插件目录不存在：${dir}` }] };
    }

    let manifest = spec.manifest;
    if (!manifest) {
      const mpath = path.join(dir, MANIFEST_FILENAME);
      if (!existsSync(mpath)) {
        return { ok: false, errors: [{ field: "", message: `插件目录里没有 ${MANIFEST_FILENAME}。` }] };
      }
      let text;
      try {
        text = readFileSync(mpath, "utf8");
      } catch (e) {
        return { ok: false, errors: [{ field: "", message: `读清单失败：${e.message}` }] };
      }
      try {
        manifest = parseManifest(text);
      } catch (e) {
        return { ok: false, errors: [{ field: "", message: e.message }] };
      }
    }

    const v = validateManifest(manifest);
    if (!v.ok) return { ok: false, errors: v.errors };
    const m = v.manifest;

    if (plugins.has(m.id)) {
      return { ok: false, errors: [{ field: "id", message: `插件「${m.id}」已经装上了：先 remove 再装。` }] };
    }

    /* 入口必须在插件目录里（清单校验已经挡了 .. 和绝对路径，这里再确认一次
       —— 路径解析在不同盘符/大小写下有坑，宁可多判一次）。 */
    const entryPath = path.resolve(dir, m.entry);
    if (entryPath !== dir && !entryPath.startsWith(dir + path.sep)) {
      return { ok: false, errors: [{ field: "entry", message: `入口文件跑出插件目录了：${m.entry}` }] };
    }
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
      return { ok: false, errors: [{ field: "entry", message: `入口文件不存在：${m.entry}` }] };
    }

    /* 没有权限模型 = 没有沙箱 = 不跑用户代码。宁可少一个功能。 */
    const permFlag = detectPermissionFlag();
    if (!permFlag) {
      return {
        ok: false,
        errors: [{
          field: "",
          message: "这个 Node 没有权限模型（--permission / --experimental-permission）："
            + "没有沙箱就不跑插件代码 —— 插件是要分发给别人的代码。",
        }],
      };
    }

    /* 语法检查（只编译不执行）：语法错要在这里变成人话，而不是等第一次请求时崩。 */
    const syn = await checkSyntax(entryPath, nodePath);
    if (!syn.ok) {
      return { ok: false, errors: [{ field: "entry", message: syn.message }] };
    }

    const token = makeToken();
    const execArgv = [permFlag];
    /* 插件自己的目录：它得读自己的代码。清单里声明的目录：它申请的那部分。
       两样都在授权范围内，且都会展示给人看（describePermissions）。 */
    execArgv.push(`--allow-fs-read=${dir}`);
    for (const p of m.permissions.fsRead) execArgv.push(`--allow-fs-read=${p}`);

    let child;
    try {
      child = fork(workerPath, [], {
        execArgv,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: buildChildEnv(opts.env || process.env),
        cwd: dir,
        windowsHide: true,
      });
    } catch (e) {
      return { ok: false, errors: [{ field: "", message: `起子进程失败：${e.message}` }] };
    }

    const rec = {
      id: m.id,
      name: m.name,
      manifest: m,
      dir,
      entryPath,
      channel: new WorkerChannel({
        child,
        token,
        onLog: (e) => log({ ...e, pluginId: m.id }),
        onNoise: (e) => log({ ...e, pluginId: m.id }),
      }),
      status: "loading",
    };

    let loaded;
    try {
      loaded = await rec.channel.request("init", {
        token,
        entry: entryPath,
        pluginDir: dir,
        permissions: m.permissions,
        now: now(),
      }, LOAD_TIMEOUT_MS);
    } catch (e) {
      rec.status = "dead";
      try { child.kill("SIGKILL"); } catch { /* 已经死了就算了 */ }
      const message = e && e.message ? e.message : String(e);
      return {
        ok: false,
        errors: [{ field: "entry", message: `插件加载失败：${message}` }],
      };
    }

    rec.status = "active";
    plugins.set(m.id, rec);
    log({ level: "info", message: `插件「${m.name}」（${m.id}）装上了。`, pluginId: m.id });
    return { ok: true, errors: [], id: m.id, permissions: describePermissions(m, { dir }) };
  }

  /** 扫插件根目录，把每个子目录（有 plugin.json 的）都装一遍；装不上的记下来，别中断。 */
  async function installFromDir(dir) {
    const root = path.resolve(String(dir || rootDir || ""));
    const out = { installed: [], errors: [] };
    if (!existsSync(root)) return out;
    const { readdirSync } = await import("node:fs");
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const r = await install({ dir: path.join(root, ent.name) });
      if (r.ok) out.installed.push(r.id);
      else out.errors.push({ dir: ent.name, errors: r.errors });
    }
    return out;
  }

  /** 停掉一个插件（杀子进程）。 */
  function remove(id) {
    const rec = plugins.get(id);
    if (!rec) return false;
    plugins.delete(id);
    try { rec.channel.child.kill("SIGKILL"); } catch { /* 已经死了就算了 */ }
    log({ level: "info", message: `插件「${rec.name}」（${id}）停掉了。`, pluginId: id });
    return true;
  }

  /** 全部停掉。 */
  function close() {
    for (const id of Array.from(plugins.keys())) remove(id);
  }

  /* --------------------------------------------------------------- *
   * 跑一次请求
   * --------------------------------------------------------------- */

  /**
   * 拿一次请求摘要，逐个问插件「你要怎么改」。
   *
   * 返回：
   *   { ok:true, action:"allow", patch, plugins } —— 没人改（allow）；
   *   { ok:true, action:"modify", patch, plugins } —— 有人改了；
   *   { ok:true, action:"deny", reason, pluginId } —— 有人要拒绝这次请求；
   *   { ok:false, error:{code,message,pluginId} } —— 插件失灵了（默认：这次请求失败）。
   */
  async function apply(request) {
    const summary = summarizeRequest(request);
    const patches = [];
    const seen = [];

    for (const rec of plugins.values()) {
      if (rec.status !== "active") {
        /* 上次超时被杀掉的插件：这次请求明确失败（`onError:"pass"` 则放过）。 */
        const err = {
          code: "DEAD",
          message: `插件「${rec.name}」已经死了（上次超时被杀掉），先重装它再用。`,
          pluginId: rec.id,
        };
        log({ level: "error", message: err.message, pluginId: rec.id });
        if (onError === "fail") return { ok: false, error: err };
        continue;
      }

      let res;
      try {
        res = await rec.channel.request(
          "transform",
          { request: summary, now: now() },
          effectiveTimeout(rec.manifest)
        );
      } catch (e) {
        const code = e && e.code ? e.code : "PLUGIN_ERROR";
        const message = e && e.message ? e.message : String(e);
        if (code === "TIMEOUT") {
          /* 挂住了（死循环/不回话）：杀掉它 —— 它不会自己醒。 */
          try { rec.channel.child.kill("SIGKILL"); } catch { /* 已经死了就算了 */ }
          rec.status = "dead";
        }
        const err = { code, message, pluginId: rec.id };
        log({ level: "error", message: `插件「${rec.name}」出错：${message}`, pluginId: rec.id });
        if (onError === "fail") return { ok: false, error: err };
        continue;
      }

      const checked = validateDecision(res);
      if (!checked.ok) {
        const err = {
          code: "BAD_DECISION",
          message: `插件「${rec.name}」返回的东西不合法：${formatErrors(checked.errors)}`,
          pluginId: rec.id,
        };
        log({ level: "error", message: err.message, pluginId: rec.id });
        if (onError === "fail") return { ok: false, error: err };
        continue;
      }

      const d = checked.decision;
      if (d.action === "deny") {
        return {
          ok: true,
          action: "deny",
          reason: d.reason || "插件拒绝了这次请求（没给原因）。",
          pluginId: rec.id,
          plugins: seen,
        };
      }
      seen.push({ id: rec.id, action: d.action });
      if (d.action === "modify") patches.push(d);
    }

    const patch = Object.create(null);
    patch.headers = Object.create(null);
    patch.params = Object.create(null);
    let model = null;
    for (const d of patches) {
      if (d.headers) Object.assign(patch.headers, d.headers);
      if (d.params) Object.assign(patch.params, d.params);
      if (d.model) model = d.model;
    }
    const changed = Object.keys(patch.headers).length > 0
      || Object.keys(patch.params).length > 0
      || model !== null;

    return {
      ok: true,
      action: changed ? "modify" : "allow",
      patch: changed ? patch : null,
      plugins: seen,
    };
  }

  /* --------------------------------------------------------------- *
   * 门面
   * --------------------------------------------------------------- */

  return {
    install,
    installFromDir,
    remove,
    close,
    apply,
    /** 已装的插件：给面板看「它要什么权限」。 */
    list() {
      return Array.from(plugins.values()).map((rec) => ({
        id: rec.id,
        name: rec.name,
        status: rec.status,
        dir: rec.dir,
        timeoutMs: effectiveTimeout(rec.manifest),
        permissions: describePermissions(rec.manifest, { dir: rec.dir }),
      }));
    },
    get(id) {
      const rec = plugins.get(id);
      return rec ? { id: rec.id, name: rec.name, status: rec.status, dir: rec.dir } : null;
    },
  };
}
