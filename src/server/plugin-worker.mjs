/**
 * plugin-worker.mjs —— 代码插件运行时的**子进程那一侧**
 * （宿主那一侧是 `src/server/pluginrt.mjs`）
 *
 * ── 这一侧干什么 ────────────────────────────────────────────────────
 * 宿主把一段插件代码变成一个**独立子进程**，再用一条窄协议问它「这次请求你要
 * 怎么改」。本文件就是这条协议的另一端：
 *   宿主 → 子进程（stdin，每行一个 JSON）：init / transform / shutdown
 *   子进程 → 宿主（stdout，每行一个 JSON，**前面带一个令牌**）：res / log
 *
 * ── 为什么非要令牌 ───────────────────────────────────────────────────
 * 插件与本进程**同处一个 realm**：它能写 stdout、能往 stderr 喊、能挂
 * `process.stdin` 的监听器、能摸到 `process` 对象。它**唯一拿不到**的是令牌 ——
 * 令牌只出现在宿主发来的 init 那一行里，而那一行在插件被装载**之前**就被我们
 * 读走、消化掉了（插件再挂监听器，也只能看到后来的消息，那里面没有令牌）。
 * 于是插件能往 stdout 灌任何东西，却**写不出**一行带令牌的协议消息 ——
 * 宿主那条通道才分得清「这是协议」与「这是插件自己写的日志」。
 *
 * ⚠ 因此本文件**只许**在 {@link say} 这一个地方把令牌拼进输出；别处一律不许
 * 出现它（错误消息里也不行：那些消息会进面板日志与落盘文件）。
 *
 * ── 与 magpie 的差别 ────────────────────────────────────────────────
 *   magpie 的 `internal/plugin/host.js` 在 **Bun 的网关进程内**执行插件 JS：
 *   插件能读能写能发网络请求，插件崩了网关跟着崩。
 *   本文件在独立子进程里跑，外面还罩着 Node 的权限模型（读文件 / 起子进程 /
 *   连调试器都被内核级地禁掉 —— 见 pluginrt.mjs 的「沙箱与权限模型」一节），
 *   **网络**那一层则由本文件自己补（见下面的「沙箱：网络那一层」）。
 *   代价是插件在这里失灵只会让**这一次请求**失败，宿主那边听得见（不静悄悄）。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────
 *   ① **只递摘要**：插件拿到的是宿主洗过的请求摘要（凭据根本没进过这个进程）。
 *   ② **不许崩**：插件抛错 / 返回乱七八糟的东西，本进程都得活着把失败**说清楚**
 *      回给宿主 —— 宿主要靠这条信息决定这次请求是失败还是放过。
 *   ③ **零时钟**：时刻由宿主给（`api.now`），本进程不取 `Date.now()`。
 *   ④ **零依赖**：只用 Node 内置模块。
 */

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

/* ====================================================================== *
 * 状态
 * ====================================================================== */

/** 宿主给的令牌。init 之前是 null —— 那时候没有令牌，也就谈不上前缀。 */
let token = null;

/** 插件的默认导出（init 装好之后才有）。 */
let plugin = null;

/** 宿主最近一次给的时刻（宿主给什么我们就用什么，不自己取时钟）。 */
let lastNow = 0;

/**
 * 一条消息里带的时刻。
 *
 * 宿主给什么就是什么 —— 本进程**不自己取时钟**（插件也不许，见 `api.now`）。
 * 消息里没带时刻就用上一次那个（总比编一个 0 强）。
 */
function nowOf(msg, fallback) {
  const v = Number(msg.now);
  return Number.isFinite(v) ? v : fallback;
}

/* ====================================================================== *
 * 回话（唯一出口）
 * ====================================================================== */

/**
 * 往 stdout 写一行**不带前缀**的文本 —— 本文件唯一碰 stdout 的地方。
 *
 * ⚠ 绝不能拿它写协议：没有令牌前缀的行，宿主只会当日志。
 */
function writePlain(text) {
  try {
    process.stdout.write(text);
  } catch {
    /* 管道断了：宿主那边会收到 exit 事件，写不进去也没意义 */
  }
}

/**
 * 往宿主回一句话 —— **所有协议回话的唯一出口**。
 *
 * 为什么所有回话都得走这儿：令牌前缀是这条通道的**防伪证机制**，散在各处
 * 手写就一定会漏一处；漏一处 = 那一行被宿主当成「插件自己写的日志」丢掉，
 * 宿主于是永远等不到答复（最后超时杀掉本进程 —— 症状与插件挂死一模一样，
 * 但根因完全不同，最难查）。
 */
function say(msg) {
  if (!token) return;                    /* 还没有令牌：没有前缀可言，不写 */
  let text;
  try {
    text = JSON.stringify(msg);
  } catch (e) {
    /* 回话里带了循环引用之类没法序列化的东西：降级成一条日志，
       免得整个回话丢掉（丢掉的话宿主就永远等不到答复）。 */
    text = JSON.stringify({ t: "log", level: "error", message: `回话序列化失败：${errText(e)}` });
  }
  writePlain(`${token} ${text}\n`);
}

/** 回一个「成了」：把插件返回的东西**原样**递给宿主（形状由宿主去验）。 */
function replyOk(id, result) {
  try {
    JSON.stringify(result);
  } catch (e) {
    /* 返回值没法用 JSON 递回去（循环引用之类）：这不是「宿主不认」，是根本
       递不过去 —— 如实说，别装成成功。 */
    replyErr(id, "PLUGIN_ERROR", `插件返回的东西没法用 JSON 传回去：${errText(e)}`);
    return;
  }
  say({ t: "res", id, ok: true, result });
}

/** 回一个「错了」：插件抛了 / 没法用了 —— 宿主据此决定这次请求怎么办。 */
function replyErr(id, code, message) {
  say({ t: "res", id, ok: false, code, message: String(message || "") });
}

/* ====================================================================== *
 * 递给插件的 api
 * ====================================================================== */

/**
 * 把一件东西变成一行日志文本。
 *
 * 插件爱传什么就传什么（字符串居多，但也可能传对象）：传对象时用 JSON，
 * 直接 `String(obj)` 会变成 "[object Object]" —— 面板上一眼看不出是什么。
 */
function logText(msg) {
  if (typeof msg === "string") return msg;
  if (msg === undefined || msg === null) return "";
  try {
    return JSON.stringify(msg);
  } catch {
    return String(msg);
  }
}

/**
 * 递给插件的 `api` —— **只有两个成员**。
 *
 * 为什么不给别的：插件拿到的每个能力都是一处能被滥用的口子。
 *   · `log(msg)` —— 进宿主的面板日志（宿主那边当纯文本看，不是协议）。
 *   · `now` —— 宿主给的时刻。插件**不许**自己取时钟：宿主拿同一把尺子量所有
 *     插件的耗时与超时；自己取时钟的插件会用自己的时区与时钟改写答案。
 */
function makeApi(at) {
  return {
    log(msg) {
      say({ t: "log", level: "info", message: logText(msg) });
    },
    now: at,
  };
}

/* ====================================================================== *
 * 沙箱：网络那一层
 *
 * Node 的权限模型**不管网络**（没有 --allow-net）：内核级的那三条（读文件 /
 * 起子进程 / 连调试器）拦得住，插件却照样能 fetch()、能 import("node:https")。
 * 所以「清单说不许联网」这件事**只能**补在**子进程**里 —— 插件与宿主同处一个
 * realm，宿主拦不住插件在子进程里做的事（宿主自己也没有别的办法）。
 *
 * ⚠ 这一层**不是内核级的**（模块入口 + 全局对象层面的封堵，理论上仍有未封到的
 *   出网路子）。它比 magpie（moejs 里插件想发网络请求就发）严格，但**不等于**
 *   防火墙 —— 这一点必须写在文档里，不许含糊（见 pluginrt.mjs 的「挡不住什么」）。
 * ====================================================================== */

/** 网络类模块的入口 —— 插件能出网的门就这几扇。 */
const NET_MODULES = Object.freeze([
  "node:http", "node:https", "node:http2", "node:net", "node:tls",
  "node:dgram", "node:dns", "node:dns/promises",
]);

/**
 * 把「不许联网」落到实处。
 *
 * 三道门，缺一不可：
 *   ① **模块入口**：用模块钩子（module.registerHooks）把网络模块的加载封掉 ——
 *      ESM 的 import 与 CJS 的 require 都在钩子里过（都验过了）。
 *   ② **全局对象**：删掉 fetch / WebSocket —— 它们不经过模块入口。
 *   ③ **原生口子**：删掉 process.binding / process.getBuiltinModule /
 *      process.dlopen —— `process.getBuiltinModule("node:http")` 是**绕过模块
 *      钩子**直接拿内置模块的门（钩子拦不住它），`process.dlopen` 则能加载
 *      原生扩展（那等于把整个沙箱作废）。
 */
function blockNetwork() {
  /* ① 模块入口 */
  try {
    if (typeof registerHooks !== "function") {
      throw new Error("这个 Node 没有 module.registerHooks（模块钩子）");
    }
    registerHooks({
      load(url, ctx, next) {
        if (NET_MODULES.includes(url)) {
          throw new Error(`插件不许联网：这个 Node 不允许加载 ${url}。`);
        }
        return next(url, ctx);
      },
    });
  } catch (e) {
    /* 钩子装不上：下面两道门还在，但第一道没关上 —— 如实说给宿主听，
       不许假装「已经不许联网了」。 */
    say({ t: "log", level: "warn", message: `网络封堵的模块钩子装不上：${errText(e)}` });
  }

  /* ② 全局对象 */
  for (const name of ["fetch", "WebSocket"]) {
    try { delete globalThis[name]; } catch { /* 删不掉：这层本来就不是内核级的 */ }
  }

  /* ③ 原生口子 */
  for (const name of ["binding", "getBuiltinModule", "dlopen"]) {
    try { delete process[name]; } catch { /* 同上 */ }
  }
}

/* ====================================================================== *
 * 宿主发来的消息
 * ====================================================================== */

/**
 * 一条错误怎么变成一句人话。
 *
 * 带栈：插件作者要靠它定位自己代码里的哪一行出了事；不带：面板上只有一句
 * "undefined" 谁也看不懂。
 */
function errText(e) {
  if (e === undefined || e === null) return "插件报错了（没给出原因）。";
  if (e instanceof Error) return e.stack || e.message || String(e);
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * 装载插件：把入口文件 import 进来，取它的默认导出。
 *
 * ⚠ **只在 init 之后做**：令牌随 init 那一行一起到，那一行必须在我们手上
 * 消化掉（插件要是能读到它，令牌就不保密了）。
 */
async function loadPlugin(entry) {
  if (!entry) throw new Error("宿主没给入口文件路径。");
  const mod = await import(pathToFileURL(entry).href);
  const fn = mod && typeof mod.default === "function" ? mod.default : null;
  if (!fn) {
    throw new Error(
      "插件入口没有导出默认函数：得是 export default function (request, api) { … }。"
    );
  }
  return fn;
}

/** init：握手 + 装载。 */
async function onInit(msg) {
  if (token) {
    /* 已经初始化过了：重复的 init 是协议错误。回一条错，**别换令牌** ——
       换了令牌，宿主那边按旧令牌等的那条就永远等不到了。 */
    replyErr(msg.id, "ALREADY_INIT", "已经初始化过了。");
    return;
  }
  token = String(msg.token || "");
  lastNow = nowOf(msg, 0);
  if (!token) {
    /* 没有令牌就没有防伪证可言：宁可拒绝，也不裸着说话。 */
    replyErr(msg.id, "NO_TOKEN", "宿主没有给令牌，这条通道没法用。");
    return;
  }

  /* 权限：清单说「不许联网」就不许联网。
     ⚠ 必须赶在**装载插件之前**做：插件在 import 那一刻就能把 fetch 抓在手里，
       之后再删 globalThis.fetch 已经晚了。 */
  const perms = msg.permissions && typeof msg.permissions === "object" ? msg.permissions : {};
  if (perms.net !== true) blockNetwork();

  try {
    plugin = await loadPlugin(String(msg.entry || ""));
  } catch (e) {
    replyErr(msg.id, "PLUGIN_ERROR", `插件装载失败：${errText(e)}`);
    return;
  }
  replyOk(msg.id, { loaded: true, entry: String(msg.entry || "") });
}

/** transform：把这一次的请求摘要递给插件，把它返回的东西递回宿主。 */
async function onTransform(msg) {
  if (!plugin) {
    replyErr(msg.id, "NOT_READY", "插件还没装载好。");
    return;
  }
  const at = nowOf(msg, lastNow);
  lastNow = at;
  const request = msg.request && typeof msg.request === "object" ? msg.request : {};
  let result;
  try {
    /* 插件可能是 async：等它。宿主那边是按「答复」算超时的，不等就等于
       把一个还没说完的答复当成说完了。 */
    result = await plugin(request, makeApi(at));
  } catch (e) {
    /* 插件抛错 —— **本进程不许死**：宿主得听见这次失败，否则它只能等到
       超时才把子进程杀掉，症状与「插件挂死」一样，根因却完全不同。 */
    replyErr(msg.id, "PLUGIN_ERROR", errText(e));
    return;
  }
  /* 返回值什么形状都**原样**递回去：由宿主验（validateDecision）。
     插件返回得离谱是它的事，宿主会拒；子进程在这里自作主张地"替宿主改一改"
     才是把信任边界捅穿了。 */
  replyOk(msg.id, result);
}

/**
 * 处理一行宿主发来的 JSON。
 *
 * ⚠ **init 那一行必须在我们手上消化掉**（令牌就在里面）：插件与本进程同处
 * 一个 realm，它能自己给 `process.stdin` 挂监听器。init 的那一行在我们
 * 读走之后就没了，插件挂上监听器也只能看到后来的消息（里面没有令牌）。
 */
async function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;                     /* 看不懂的行：不回话（没有 id 可回） */
  }
  if (!msg || typeof msg !== "object") return;
  try {
    if (msg.t === "init") return await onInit(msg);
    if (msg.t === "transform") return await onTransform(msg);
    if (msg.t === "shutdown") {
      /* 宿主说要收工：干净退出（宿主在 exit 事件里知道我们走了）。 */
      process.exit(0);
      return undefined;
    }
    /* 不认识的指令：宿主若给了 id 就回一条错（它在那儿等答复），没给就当没看见。 */
    if (msg.id !== undefined) {
      replyErr(msg.id, "UNKNOWN_TYPE", `不认识的指令「${String(msg.t)}」。`);
    }
  } catch (e) {
    if (msg.id !== undefined) replyErr(msg.id, "PLUGIN_ERROR", errText(e));
    else say({ t: "log", level: "error", message: `处理宿主消息时出错：${errText(e)}` });
  }
}

/* ====================================================================== *
 * 读宿主来的行
 * ====================================================================== */

let buffer = "";

/**
 * 消息**一条一条**来。
 *
 * 为什么排队：init 还在装载插件时，宿主不会发 transform（它要等 init 的答复），
 * 但万一来了，transform 必须排在 init 后面 —— 否则它会在插件还没到位时跑，
 * 回一句「还没装载好」，宿主那头就成了「插件自己不干活」。
 */
let queue = Promise.resolve();

function enqueue(fn) {
  queue = queue.then(fn).catch((e) => {
    /* 一条消息处理失败不许卡住后面的：说给宿主听，继续。 */
    say({ t: "log", level: "error", message: `处理宿主消息时出错：${errText(e)}` });
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    enqueue(() => handleLine(line));
  }
  /* 宿主灌了一堆不带换行的东西 —— 别把内存吃光。 */
  if (buffer.length > 1 << 20) {
    buffer = "";
    say({ t: "log", level: "warn", message: "宿主发来一行超长的内容，已经丢掉。" });
  }
});
process.stdin.on("end", () => {
  /* 宿主关了管道：没有下文了，干净退出（别留一个孤儿进程占着内存）。 */
  process.exit(0);
});
process.stdin.on("error", () => process.exit(0));

/* ====================================================================== *
 * 兜底：插件那些「没接住」的异步错误
 * ====================================================================== */

/**
 * 插件里 `setTimeout` 回调抛的、或者忘了 catch 的 Promise —— 这些**不该**把
 * 本进程带走：宿主要听见的是「插件出错了」，不是「子进程没了」。
 * 带走的后果是宿主等不到答复、只能等到超时 —— 症状与「插件挂死」一模一样，
 * 根因却完全不同，最难查。
 */
process.on("uncaughtException", (e) => {
  say({ t: "log", level: "error", message: `插件抛了没接住的异常：${errText(e)}` });
});
process.on("unhandledRejection", (e) => {
  say({ t: "log", level: "error", message: `插件有个 Promise 没人接：${errText(e)}` });
});
