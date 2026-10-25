// src/server/clients/env-shadow.mjs —— 「环境变量遮蔽」检查
//
// ## 这个功能解决什么
//
// 客户端接线把「网关地址 + 凭据」写进客户端自己的配置文件。但**有的客户端读环境变量，
// 而且环境变量优先于配置文件**：
//
//   · Gemini CLI —— `GOOGLE_GEMINI_BASE_URL` / `GEMINI_API_KEY` 是**行业标准名**
//     （别的工具、别的教程也让人设这两个）。我们写进 `~/.gemini/.env`，而 dotenv 的
//     默认语义是「**已有进程环境变量不覆盖**」⇒ 用户系统里已经设了同名变量时，
//     **真环境变量赢** ⇒ 我们写的地址/凭据根本不生效，而面板显示「已接上」。
//   · Qwen Code（Gemini CLI 的同源 fork）、Reasonix —— 同类机制。
//
// ⇒ 所以「写进文件」**不等于**「生效」。这个模块回答的就是那个没被回答的问题：
// **用户系统里那个同名变量，会不会盖掉我们写的？**
//
// ## 判据（三条，缺一不可）
//
// ① **哪几个键算「环境变量名」**（`envVarNameOf`）：
//    · `dotenv` 格式的文件 —— dotenv 的键**没有层级**，键路径整条就是变量名。
//    · 其它格式里 `env.<NAME>` 这种形状 —— 客户端自己配置里的 env 块
//      （settings.json 的 `"env": {...}`、config.toml 的 `[env]`）。
//    · 其余的键是**配置文件自己的键**，与环境变量无关 ⇒ 不查。
// ② **用户「真正设置过」的环境变量**（`readUserEnv`）：Windows 读注册表的
//    `HKCU\Environment` 与 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`。
//    ⚠ **不拿进程环境当作用户环境** —— 进程环境里可能有安装器、父进程、
//    我们自己起的服务注入的东西，那不是「用户设的」。
// ③ **同名且值不同 ⇒ 遮蔽**（我们的配置不生效，必须报出来）；
//    **同名且值相同 ⇒ 不算遮蔽**（只是碰巧一样，结果一样 ⇒ 不打扰用户）。
//
// ## 强度分级（为什么有两档，又为什么不按格式分）
//
//   · `blocking` —— **已确定被盖住**：这个客户端读环境变量**优先于**读自己的配置。
//     ⇒ 我们写的地址/凭据不生效，**必须报出来**。
//     目前两个：Gemini CLI 与 Qwen Code（同源实现：`.env` 的值只在系统里
//     **没有**同名变量时才生效 —— 见 ENV_WINS 那段注释里的依据）。
//   · `advisory` —— **提醒**：用户系统里确实有个同名变量，但这个客户端到底
//     谁赢**没有确凿依据**（Reasonix 自己的 dotenv 读取器就跟标准的不一样）⇒
//     提醒但不替客户端下定论。
//   · 不报 —— 这个客户端**自己的配置赢**（已实测：Claude Code 的
//     `settings.json` env 块覆盖继承来的进程环境变量）⇒ 报了是噪音。
//
// ⚠ **不能只看格式**：同样写在 `.env` 里的键，不同客户端的运行时优先级不同
//   ⇒ 分级要看**是哪个客户端**（`ENV_WINS` / `CONFIG_WINS` 两张表）。
// ⚠ 声明可以用 `envShadow: { priority: "env-wins" | "config-wins" }` 覆盖
//   （覆盖压过内置名单）—— 这样判定能跟着客户端声明走，不留在本模块里。
//
// ## 脱敏
//
// ⚠ 报告里**绝不能出现凭据原文**。值一律脱敏成「前 6 个字符…（长度 N）」；
// 长度 ≤ 6 的值**只报长度**（那么短的贴出来等于贴全文）。
//
// ## 纪律
//
//   · 判据 / 脱敏 / 比较都是**纯函数** ⇒ 可单测。
//   · 读注册表那层**可注入**（`opts.exec` / `opts.env`）⇒ 测试不碰真注册表。
//   · **只读**：这个模块一个字都不写用户的配置。
//   · 不 import 仓库里别的模块（自己站住，谁都能用）。

import { execFileSync } from "node:child_process";

/* ------------------------------------------------------------------ *
 * ① 值：脱敏与比较
 * ------------------------------------------------------------------ */

/**
 * maskValue —— 把值脱敏成「能看出大概，但看不出原文」的形状。
 *
 * ⚠ 长度 ≤ 6 的值**只报长度**：6 个字符以内的东西（比如 `on`、`1`、`sk-x`）
 *   贴出前几位等于贴了全文 —— 令牌只有几位的时候尤其危险。
 *
 * @param {any} v
 * @returns {{masked:string, length:number}} masked 是给人看的，length 是原值长度
 */
export function maskValue(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (!s.length) return { masked: "(空)", length: 0 };
  if (s.length <= 6) return { masked: `(短值，长度 ${s.length})`, length: s.length };
  return { masked: `${s.slice(0, 6)}…（长度 ${s.length}）`, length: s.length };
}

/**
 * sameValue —— 两个值算不算「一样」。
 *
 * ⚠ 只做**保守**归一：去掉首尾空白、去掉尾斜杠。
 *   地址类（base url）两边常常只差一个尾斜杠，那种不算「被盖了」。
 * ⚠ **不做大小写归一** —— URL 的 host 大小写不敏感但路径敏感，
 *   凭据更是大小写敏感 ⇒ 归一过头会把「真的不同」说成「一样」⇒ 漏报。
 *
 * @param {any} a @param {any} b
 */
export function sameValue(a, b) {
  const x = a === null || a === undefined ? "" : String(a).trim();
  const y = b === null || b === undefined ? "" : String(b).trim();
  if (x === y) return true;
  const xs = x.replace(/\/+$/, "");
  const ys = y.replace(/\/+$/, "");
  return xs !== "" && xs === ys;
}

/* ------------------------------------------------------------------ *
 * ② 键：这个键是不是一个环境变量名
 * ------------------------------------------------------------------ */

/** 环境变量名的形状（POSIX 与 Windows 都用它；Windows 另加不区分大小写）。 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * envVarNameOf —— 这一处写入是不是「一个环境变量的名字」。
 *
 * @param {{path?:string}} write 一次写入（底座 writes 里的那一条）
 * @param {string} format 那份文件的格式（"json" / "toml" / "dotenv" …）
 * @returns {string|null} 是环境变量名就返回它；不是就返回 null
 *
 * ## 两条规则
 *
 * ① **dotenv**（`~/.gemini/.env`、Reasonix 的 `.env`）：
 *    dotenv 的键**没有层级**（见 formats-dotenv.mjs）⇒ 键路径整条就是变量名。
 *    键名不合规的（`A-B`、`1X`）dotenv 自己会忽略 ⇒ 不算环境变量。
 * ② **其它格式里的 `env.<NAME>`**：客户端自己配置里的 env 块
 *    （settings.json 的 `"env": {...}`、config.toml 的 `[env]`）。
 *    ⚠ 只认**单段**变量名：`env.foo.bar` 不是环境变量（那是 env 块里的嵌套键）。
 *    ⚠ 键名里可以带点（模型 id 当表名）—— 那条路径**不会**匹配这条正则 ⇒ 不误判。
 */
export function envVarNameOf(write, format) {
  const p = String((write && write.path) || "");
  if (!p) return null;
  if (String(format || "").toLowerCase() === "dotenv") {
    return ENV_NAME_RE.test(p) ? p : null;
  }
  const m = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(p);
  return m ? m[1] : null;
}

/**
 * ENV_WINS —— **真环境变量赢**的客户端：我们写进配置文件的键会被系统里的同名变量盖掉。
 *
 * ## 依据（2026-10 核对上游源码）
 *
 *   · **gemini-cli** —— Gemini CLI 的 `loadEnvironment()`
 *     （`packages/cli/src/config/settings.ts`）只在 `!Object.hasOwn(process.env, key)`
 *     时才把 `.env` 的值写进 `process.env` ⇒ **真环境变量赢，.env 只填补空缺**。
 *     它的配置优先级也是「环境变量 > 一切 settings 文件」。
 *   · **qwen-code** —— Gemini CLI 的同源 fork，同一套加载逻辑
 *     （magpie `internal/agent/qwen.go:41-48` 的注释也这么说）。
 *
 * ⚠ **未在本机端到端验证**（本机没装这两个客户端）—— 依据是它们的上游源码/文档，
 *   不是本机实测。⚠ 但这两个变量的名字是**行业标准名**（别的工具也让人设），
 *   撞名的概率高 ⇒ 即便判据有偏差，方向也是「宁可多提醒一句」。
 */
const ENV_WINS = new Set(["gemini-cli", "qwen-code"]);

/**
 * CONFIG_WINS —— **客户端自己的配置赢**的客户端：系统环境变量盖不住我们写的。
 *
 * ⚠ 这里只收**实测**过的，不收「推断」：
 *   · **claude-code** —— 实测 2×2 矩阵 + 静态（`Object.assign(process.env, settings.env)`）
 *     ⇒ `settings.json` 的 env 块**覆盖**继承来的进程环境变量 ⇒ 我们写的有效。
 *     ⚠ 三个条件性例外（我们写的键都不在其中）：
 *       · 设了 `ANTHROPIC_UNIX_SOCKET` ⇒ settings 里的
 *         ANTHROPIC_BASE_URL/API_KEY/AUTH_TOKEN 被剔掉；
 *       · `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 只放行白名单键；
 *       · `CLAUDE_CODE_ENTRYPOINT==="claude-desktop"` 时只放行「启动时就有」的进程 env
 *         （⇒ 那种场景下进程环境变量反而赢）。
 *
 * ⚠ 为什么 claude-code 不报 advisory：它的 env 块有十几个键（含 HTTPS_PROXY、
 *   HTTP_PROXY、NO_PROXY 这些系统里本来就有的）⇒ 全报一遍是噪音，会把用户
 *   对真告警的注意力磨光。
 */
const CONFIG_WINS = new Set(["claude-code"]);

/**
 * severityOf —— 这个键被盖住之后有多严重。
 *
 * @param {{path?:string}} write 一次写入
 * @param {string} format 那份文件的格式（"json" / "toml" / "dotenv" …）
 * @param {string} clientId 客户端 id（要知道它**怎么读**环境变量）
 * @param {string} [priority] 声明式覆盖："env-wins" / "config-wins"
 * @returns {"blocking"|"advisory"|null} null = 这个客户端**不会**被盖 ⇒ 不报
 *
 * ## ⚠ 为什么不能只看格式
 *
 * 同样写在 `.env` 里的键，不同客户端的**运行时**优先级不一样：
 *   · Gemini CLI（同源 fork 也一样）：真环境变量赢 ⇒ 一定被盖。
 *   · Reasonix Studio：它**自己的 dotenv 读取器**对重复赋值的处理与编辑器不同
 *     （magpie `internal/agent/reasonix.go:151-154` 明写）⇒ 优先级**不确定**。
 * ⇒ 拿不准的一律 advisory（提醒，但不替客户端下定论）。
 */
export function severityOf(write, format, clientId, priority) {
  const p = String(priority || "");
  if (p === "config-wins") return null;
  const id = String(clientId || "");
  if (p === "env-wins") return "blocking";
  if (CONFIG_WINS.has(id)) return null;
  if (ENV_WINS.has(id)) return "blocking";
  /* 没列入已知名单的：dotenv 键与 env 块键都只提醒 */
  return "advisory";
}

/** 遮蔽的成因说明（给人看的，也给面板显示用）。 */
export function reasonOf(severity) {
  if (severity === "blocking") {
    return "这个客户端读环境变量**优先于**读自己的配置文件（Gemini CLI 同源实现："
      + ".env 的值只在系统里没有同名变量时才生效）⇒ 用户系统里那个同名变量会赢 "
      + "⇒ 我们写进文件的地址/凭据不生效。";
  }
  return "用户系统里有一个同名的环境变量。这个键会不会被它盖住，"
    + "取决于该客户端怎么读环境变量（有的读自己的配置优先、有的读环境变量优先）"
    + "⇒ 需要你确认一下；若是前者，我们写的是有效的。";
}

/* ------------------------------------------------------------------ *
 * ③ 用户「真正设置过」的环境变量
 * ------------------------------------------------------------------ */

/**
 * normalizeUserEnv —— 把各种形状的用户环境变量收成一张表。
 *
 * 接受的形状：
 *   · `[{name, value, scope}]`（readUserEnv 的原样）
 *   · `{KEY: "值"}`
 *   · `{KEY: {value, scope}}`
 *
 * ⚠ **Windows 上环境变量名不区分大小写** ⇒ 键按大写归一。
 *   POSIX 区分 ⇒ `caseInsensitive:false` 时按原样存。
 * ⚠ **同名时 User 赢 Machine** —— 与 Windows 实际行为一致（用户级覆盖机器级）。
 *
 * @param {any} userEnv
 * @param {{caseInsensitive?:boolean}} opts
 * @returns {Map<string,{value:string, scope:string, name:string}>}
 */
export function normalizeUserEnv(userEnv, opts = {}) {
  const ci = opts.caseInsensitive !== false;
  const out = new Map();
  const keyOf = (n) => (ci ? String(n).toUpperCase() : String(n));
  const put = (name, value, scope) => {
    if (!name) return;
    const k = keyOf(name);
    const prev = out.get(k);
    /* User 赢 Machine；同 scope 时后来者赢（后写的那条是更新的那份） */
    if (prev && prev.scope === "User" && scope !== "User") return;
    out.set(k, { name: String(name), value: value === null || value === undefined ? "" : String(value), scope: scope || "" });
  };
  if (Array.isArray(userEnv)) {
    for (const it of userEnv) {
      if (!it) continue;
      if (typeof it === "string") { put(it, "", ""); continue; }
      put(it.name !== undefined ? it.name : it.key, it.value, it.scope);
    }
    return out;
  }
  if (userEnv && typeof userEnv === "object") {
    for (const [k, v] of Object.entries(userEnv)) {
      if (v && typeof v === "object") put(k, v.value, v.scope);
      else put(k, v, "");
    }
  }
  return out;
}

/**
 * PS_SCRIPT —— 读「用户级 + 机器级」环境变量的 PowerShell 脚本。
 *
 * ⚠ **[Environment]::GetEnvironmentVariables(scope) 读的就是注册表**
 *   （User ⇒ HKCU\Environment；Machine ⇒ HKLM\...\Session Manager\Environment），
 *   且 REG_EXPAND_SZ **不展开**（我们要的是用户写的原样，不是展开后的 PATH）。
 * ⚠ **输出走 Base64（UTF-8 的 JSON）**：Windows 上 stdout 的编码取决于控制台代码页
 *   （中文机器是 936）⇒ 直接吐 JSON 会乱码；Base64 只有 ASCII，任何代码页都安全，
 *   Node 侧再解 UTF-8。
 * ⚠ 键名用 `scope|KEY` 分开 ⇒ 同一名字在两个作用域都有时也知道是哪一份。
 */
const PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$out=@{}",
  "foreach($scope in @('User','Machine')){",
  "  $v=[Environment]::GetEnvironmentVariables($scope)",
  "  foreach($k in $v.Keys){ $out[($scope+'|'+$k)]=[string]$v[$k] }",
  "}",
  "$json = $out | ConvertTo-Json -Compress",
  "if ([string]::IsNullOrEmpty($json)) { $json = '{}' }",
  "[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))",
].join("\n");

/**
 * readUserEnv —— 读「用户真正设置过」的环境变量。
 *
 * ⚠ **不是进程环境**（`process.env`）：进程环境里可能有安装器、父进程、
 *   我们自己起的服务注入的东西 —— 那不是「用户设的」，用它判遮蔽会误报。
 *
 * @param {{exec?:Function, platform?:string, timeout?:number}} opts
 *   · `opts.exec` —— 注入的 runner（测试用；签名同 `execFileSync`）
 *   · `opts.platform` —— 默认 `process.platform`
 * @returns {{ok:boolean, env:Array<{name:string,value:string,scope:string}>, source:string, error:string}}
 *   ⚠ 读不到时 `ok:false` 且 `error` 有一句能给人看的说明 —— **不假装没遮蔽**。
 */
export function readUserEnv(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "win32") {
    return {
      ok: false, env: [], source: "none",
      error: `这台机器上还没实现读「用户设置过的环境变量」（只做了 Windows 注册表）；当前平台 ${platform} ⇒ 没法判断有没有被环境变量盖住。`,
    };
  }
  const exec = opts.exec || execFileSync;
  const timeout = opts.timeout || 8000;
  let b64 = "";
  try {
    /* -EncodedCommand：脚本是 UTF-16LE base64 ⇒ 命令行里没有引号/换行的坑。 */
    const enc = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
    b64 = String(exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
      { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
    ) || "");
  } catch (e) {
    return {
      ok: false, env: [], source: "windows-registry",
      error: "读用户环境变量失败（注册表读不到或 PowerShell 不可用）：" + String((e && e.message) || e),
    };
  }
  let json = "";
  try {
    json = Buffer.from(String(b64).trim(), "base64").toString("utf8");
  } catch (e) {
    return { ok: false, env: [], source: "windows-registry", error: "解不开读回来的用户环境变量：" + String((e && e.message) || e) };
  }
  if (!json.trim()) return { ok: true, env: [], source: "windows-registry", error: "" };
  let obj = null;
  try { obj = JSON.parse(json); }
  catch (e) {
    return { ok: false, env: [], source: "windows-registry", error: "读回来的用户环境变量不是 JSON：" + String((e && e.message) || e) };
  }
  const env = [];
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const i = String(k).indexOf("|");
      const scope = i >= 0 ? String(k).slice(0, i) : "";
      const name = i >= 0 ? String(k).slice(i + 1) : String(k);
      env.push({ name, value: v === null || v === undefined ? "" : String(v), scope });
    }
  }
  return { ok: true, env, source: "windows-registry", error: "" };
}

/* ------------------------------------------------------------------ *
 * ④ 判据本体
 * ------------------------------------------------------------------ */

/**
 * detectEnvShadow —— 核心判据（纯函数，不碰 IO）。
 *
 * @param {{writes?:Array, userEnv?:any, clientId?:string, clientName?:string,
 *          priority?:string, caseInsensitive?:boolean}} p
 *   · `writes` —— 我们要写的那些键，每条 `{path, value, file?, format?}`
 *   · `userEnv` —— 用户设置过的环境变量（三种形状都收，见 normalizeUserEnv）
 *   · `priority` —— 声明式覆盖："env-wins" / "config-wins"（优先于内置名单）
 * @returns {{checked:number, shadows:Array, same:Array, empty:Array, ignored:Array, shadowed:boolean}}
 *   · `shadows` —— **真遮蔽**（同名且值不同）：我们的配置不生效
 *   · `same` —— 同名且值相同：只是碰巧一样，不算遮蔽
 *   · `empty` —— 我们自己这个键是空的（压根没写东西 ⇒ 谈不上被盖）
 *   · `ignored` —— 这个客户端**自己的配置赢**（已实测）⇒ 不算遮蔽
 *
 * ## ⚠ 结果里**没有明文值**
 * 只有脱敏后的片段与长度 —— 报告是要给人看的，不能把凭据抄进日志。
 */
export function detectEnvShadow(p = {}) {
  const writes = Array.isArray(p.writes) ? p.writes : [];
  const env = normalizeUserEnv(p.userEnv, { caseInsensitive: p.caseInsensitive !== false });
  const clientId = String(p.clientId || "");
  const clientName = String(p.clientName || "");
  const shadows = [];
  const same = [];
  const empty = [];
  const ignored = [];
  let checked = 0;

  for (const w of writes) {
    if (!w) continue;
    const name = envVarNameOf(w, w.format);
    if (!name) continue;
    checked++;
    const ours = w.value === null || w.value === undefined ? "" : String(w.value);
    const hit = env.get(p.caseInsensitive === false ? name : name.toUpperCase());
    const severity = severityOf(w, w.format, clientId, p.priority);
    if (severity === null) {
      /* 这个客户端**自己的配置赢**（已实测）⇒ 同名变量不影响它 ⇒ 不报。 */
      ignored.push({ clientId, clientName, envKey: name, keyPath: String(w.path || "") });
      continue;
    }
    const rec = {
      clientId, clientName,
      envKey: name,
      keyPath: String(w.path || ""),
      file: String(w.file || ""),
      format: String(w.format || ""),
      severity,
      scope: hit ? hit.scope : "",
      ours: maskValue(ours),
      theirs: maskValue(hit ? hit.value : ""),
      same: false,
    };
    if (!ours) { empty.push(rec); continue; }
    if (!hit) continue;
    if (sameValue(ours, hit.value)) { rec.same = true; same.push(rec); continue; }
    rec.reason = reasonOf(severity);
    shadows.push(rec);
  }
  return { checked, shadows, same, empty, ignored, shadowed: shadows.length > 0 };
}

/**
 * checkClientEnvShadow —— 从一份**客户端声明**直接得出遮蔽情况（便利函数）。
 *
 * ⚠ 只读声明（`def.files(ctx)` / `f.writes(ctx)`），**一个字都不写**用户的配置。
 *
 * ## opts 里那三个「环境变量来源」
 *
 *   · `opts.envRead` —— **完整**的 `readUserEnv()` 结果（推荐）。
 *     ⚠ 传这个才能把「读失败了」这件事一路带到文案里 ——
 *       传一个空数组会被当成「读到了、确实没有同名变量」⇒ 面板显示「没有遮蔽」，
 *       而真相是「没查成」。**沉默会被读成「没问题」。**
 *   · `opts.env` —— 裸的用户环境变量（数组 / 对象都收）。测试与「假数据」用这个。
 *   · 都不给 ⇒ 自己去读注册表（Windows）。
 *
 * ## ⚠ 面板上有一堆客户端时**只读一次**
 *
 * `readUserEnv()` 要起一次 PowerShell（几百毫秒）。28 个客户端各读一次 ⇒ 十几秒。
 * ⇒ 正确姿势：`const envRead = readUserEnv();` 读一次，然后每个客户端
 *   `checkClientEnvShadow(c, ctx, { envRead })`。
 *
 * @param {object} def  客户端声明（clients/ 下的那些）
 * @param {object} ctx  接线时的 ctx
 * @param {{envRead?:object, env?:any, exec?:Function, platform?:string, timeout?:number}} opts
 */
export function checkClientEnvShadow(def, ctx, opts = {}) {
  const clientId = String((def && def.id) || "");
  const clientName = String((def && def.name) || "");
  /* ⚠ **声明式覆盖优先于内置名单** —— 声明是针对这个客户端的具体事实，
   *   应当压过模块里的通用名单。写法：`envShadow: { priority: "env-wins" }`
   *   或 `{ priority: "config-wins" }`（⇒ 这个客户端自己的配置赢，不报）。 */
  const declared = (def && def.envShadow && def.envShadow.priority) || "";
  const reads = opts.envRead
    ? opts.envRead
    : (opts.env !== undefined
      ? { ok: true, env: opts.env, source: "given", error: "" }
      : readUserEnv(opts));

  const writes = [];
  let files = [];
  try {
    files = (def && typeof def.files === "function" ? def.files(ctx) : []) || [];
    if (!Array.isArray(files)) files = [files];
  } catch (e) {
    return {
      ok: false, checked: 0, shadows: [], same: [], empty: [], ignored: [], shadowed: false,
      clientId, clientName,
      envOk: reads.ok, envError: reads.error || "", envSource: reads.source,
      detail: "列这个客户端要改哪些文件时出错，没法检查环境变量遮蔽：" + String((e && e.message) || e),
    };
  }
  for (const f of files) {
    if (!f) continue;
    let ws = [];
    try {
      ws = (typeof f.writes === "function" ? f.writes(ctx) : f.writes) || [];
    } catch (e) {
      return {
        ok: false, checked: 0, shadows: [], same: [], empty: [], ignored: [], shadowed: false,
        clientId, clientName,
        envOk: reads.ok, envError: reads.error || "", envSource: reads.source,
        detail: "算这个客户端要写什么时出错，没法检查环境变量遮蔽：" + String((e && e.message) || e),
      };
    }    for (const w of ws) {
      if (!w) continue;
      writes.push({ path: w.path, value: w.value, file: String(f.path || ""), format: String(f.format || "") });
    }
  }

  const res = detectEnvShadow({
    writes, userEnv: reads.env, clientId, clientName, priority: declared,
    caseInsensitive: opts.platform ? opts.platform === "win32" : undefined,
  });
  return {
    ...res,
    ok: true,
    clientId, clientName,
    envOk: reads.ok,
    envError: reads.error || "",
    envSource: reads.source,
    detail: envShadowNotice({ ...res, clientId, clientName, envOk: reads.ok, envError: reads.error }),
  };
}

/** 环境变量来源的中文说法。⚠ scope 是**透传**的 ⇒ 主线程可以再加自己的档
 *  （比如把进程环境单列成 "Process"），文案不会因此说错。 */
const SCOPE_ZH = { User: "用户级", Machine: "机器级", Process: "进程级" };

function scopeZh(scope) {
  const s = String(scope || "");
  if (SCOPE_ZH[s]) return SCOPE_ZH[s];
  return s || "来源不明";
}

/**
 * envShadowNotice —— 把结果说成**一句能给人看的话**。
 *
 * ⚠ 这句话是要出现在面板/接口返回里的 ⇒ 里面**只有脱敏片段**。
 * ⚠ 没遮蔽时返回空串（不打扰）；读不到用户环境变量时返回一句「没查成」——
 *   **不能沉默**：沉默会被读成「没有遮蔽」。
 *
 * @param {object} res detectEnvShadow / checkClientEnvShadow 的结果
 */
export function envShadowNotice(res) {
  if (!res) return "";
  if (res.envOk === false && res.envError) {
    return "⚠ 没能读到你系统里设置过的环境变量，" + String(res.envError) + " ⇒ 没法确认有没有同名变量盖住这次的接线。";
  }
  const shadows = Array.isArray(res.shadows) ? res.shadows : [];
  if (!shadows.length) {
    const same = Array.isArray(res.same) ? res.same.length : 0;
    if (same) return `（系统里有 ${same} 个同名环境变量，值与我们写的一样 ⇒ 不算遮蔽。）`;
    return "";
  }
  const who = (s) => s.clientName || s.clientId || "这个客户端";
  const parts = shadows.map((s) => {
    const sev = s.severity === "blocking" ? "已确定被盖住" : "可能被盖住";
    return `${who(s)} 的 ${s.envKey}（写在 ${s.file || "配置里"}）${sev}：`
      + `我们写的是 ${s.ours.masked}，你系统里那个是 ${s.theirs.masked}`
      + `（${scopeZh(s.scope)}环境变量）`;
  });
  return "⚠ 环境变量遮蔽：" + parts.join("；") + "。"
    + "把系统里那个同名变量删掉（或改成一样的值），这次的接线才真的生效。";
}

export default {
  maskValue, sameValue, envVarNameOf, severityOf, reasonOf,
  normalizeUserEnv, readUserEnv, detectEnvShadow, checkClientEnvShadow, envShadowNotice,
};
