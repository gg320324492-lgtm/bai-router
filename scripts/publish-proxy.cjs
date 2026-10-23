/* 发版这一步的网络路径：要不要把代理变量摘掉（v1.0.78 引入）
 *
 * ## 为什么
 *
 * `gh release create` 要上传 111MB 的安装包。2026-10-12 实测两次：
 *
 *   方式                                          结果
 *   -------------------------------------------  ----------------------------
 *   HTTPS_PROXY=http://127.0.0.1:7897             卡 20+ 分钟，CPU 只用 0.56 秒，
 *                                                最后失败（**卡住时看 CPU：几乎
 *                                                不动就是在等网络，不是在传**）
 *   unset HTTPS_PROXY HTTP_PROXY https_proxy …    90~130 秒完成
 *
 * 本机开着 Clash TUN，所以去掉代理变量后**直连照样通**（`curl --noproxy '*'` 返 200）。
 *
 * ## 但不能无条件清
 *
 * 万一某台机器**没有 TUN、只能靠 HTTP 代理出网**，无条件清代理会让发布根本发不出去
 * ——从「慢」变成「失败」。所以规矩是：**先探，再决定**。
 *
 *   环境里有代理变量？
 *     └─ 没有 → 不动任何东西（本就没得清，也省掉探测的开销）
 *     └─ 有   → 探一次「不带代理能不能连通 GitHub」
 *                ├─ 通   → 清掉代理变量再上传（并说明为什么）
 *                └─ 不通 → **保留代理**照常上传（并说明为什么没清）
 *   探测本身跑不出结果（进程起不来、输出无法解析）→ 拿不到确证就不动，保留代理
 *
 * ## 边界（重要，改这个文件前先读）
 *
 * ① **只作用于发版那一步。** electron-builder 可能要靠代理拉二进制镜像
 *    （ELECTRON_BUILDER_BINARIES_MIRROR），所以构建阶段的 env 一个变量都不动。
 *    本模块从不写 `process.env`，只**返回一份新的 env** 给调用方传进 execFileSync。
 * ② Windows 上一并清 ALL_PROXY / all_proxy——只清 http/https 那四个的话，
 *    某些工具链仍会从 ALL_PROXY 取到代理地址，等于没清。
 *
 * 🔴 红线：**绝不打印代理变量的值。** 代理 URL 里可能嵌着 `user:password`
 *    （Clash 的订阅/鉴权就是这样）。本模块所有对外文案里只有变量**名**，没有值。
 *
 * ## 可测性
 *
 * 决策逻辑是纯函数 `decideProxyUse(env, probeDirect)`：env 进、{useProxy, reason} 出，
 * 探测函数由调用方注入，所以四种情形都能用假的探测器覆盖，不必真上传、不必真联网。
 * 真实探测器 `runDirectProbe()` 只是「把 HTTPS 请求塞进子进程跑」的薄壳（因为
 * publish.cjs 是全同步的），可用 `node scripts/publish-proxy.cjs --probe-direct` 单独跑。
 */
"use strict";
const { execFileSync } = require("child_process");
const https = require("https");
const path = require("path");

/* 要摘的代理变量：大写+小写 http/https，外加 ALL_PROXY（Windows 工具链认它）。
 * 顺序固定，日志里按这个顺序读，方便对着看。 */
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"];

/* 探测目标：api.github.com 根路径，HEAD，无鉴权、无响应体（几百字节以内）。
 * 刻意不用 `gh api rate_limit`（那要鉴权）和任何带大响应的接口。
 * ⚠ 只判「能不能连通」，不判连通得**快不快** —— 判慢需要大响应，那就不便宜了。 */
const PROBE_TARGET = { host: "api.github.com", path: "/" };
/* 探测自身的超时 4 秒（要求 3~5 秒内），父进程再兜一个硬杀。 */
const PROBE_TIMEOUT_MS = 4000;
const PROBE_HARD_TIMEOUT_MS = 8000;

/* 探测子进程还要额外摘掉的键。
 *
 * ⚠ **不是可有可无的保险，是承重墙。** Node 24 起若环境里有 NODE_USE_ENV_PROXY=1，
 * 核心 `https` 模块**就会**去读 HTTPS_PROXY（2026-10-13 实测：设了
 * HTTPS_PROXY=http://127.0.0.1:9 之后，一个 HEAD 直接 ECONNREFUSED 到 127.0.0.1:9；
 * 摘掉才 200/642ms，curl --noproxy '*' 同样 200）。
 * 也就是说「Node 不认 *_PROXY」这个老假设在新版已经不成立——不摘这一把，
 * 探测器量到的会是**代理那条路**，而我们要量的恰恰是**直连那条路**，判定整个反了。 */
const PROBE_EXTRA_STRIP_KEYS = ["NODE_USE_ENV_PROXY"];

function foundProxyKeys(env) {
  const e = env || {};
  return PROXY_ENV_KEYS.filter((k) => {
    const v = e[k];
    return typeof v === "string" && v.trim() !== "";
  });
}

/**
 * 纯函数：决定发版这一步用不用代理。
 * @param {object} env        当前环境（只读，不改）
 * @param {() => {ok:true}|{ok:false,why:string}} probeDirect 注入的探测器；
 *        ok=true 表示「不带代理能连通 GitHub」，ok=false 表示连不通；
 *        **抛异常**表示探测本身没跑出结果（这与 ok=false 是两回事，见下面文案）。
 * @returns {{useProxy:boolean, reason:string, found:string[], probe:string}}
 *          useProxy=true → 调用方应**保留**代理变量上传；false → 调用方应清掉。
 */
function decideProxyUse(env, probeDirect) {
  const found = foundProxyKeys(env);
  const list = found.join("、") || "（无）";

  // ① 压根没有代理变量：不探、不改。省掉一次网络往返，也省掉一次误判的机会。
  if (!found.length) {
    return {
      useProxy: false,
      probe: "skipped",
      found,
      reason: `环境里没有代理变量（已查 ${PROXY_ENV_KEYS.join("/")}，全为空）——`
        + `发版这步没有可摘的代理，保持当前网络设置原样上传。`,
    };
  }

  // ② 只有真有代理时才探「直连能不能通」。
  let v;
  try {
    v = probeDirect();
  } catch (e) {
    v = { ok: null, why: `探测进程没能给出结果（${msg(e)}）` };
  }
  if (!v || (v.ok !== true && v.ok !== false)) {
    v = { ok: null, why: "探测器返回了无法识别的结果" };
  }

  /* ★★★ 反向对照锚点（全仓库唯一一处，勿手改）★★★ ——「直连探测是否通过」。
   * 把它改成 `const directOk = true;` 就等于「无条件清代理」，
   * 有代理且直连不通那一格、以及探测失败那一格，都必须变红。
   * scripts/publish-proxy-test.mjs 靠这一行把坏实现打到临时副本上真跑一遍。 */
  const directOk = v.ok === true;

  if (directOk) {
    return {
      useProxy: false,
      probe: "ok",
      found,
      reason: `检测到代理变量 ${list}，但探针 ${v.why} —— 直连可用，`
        + `所以这次**清掉**这些变量再上传：经 HTTP 代理传 111MB 安装包会卡死`
        + `（2026-10-12 实测卡 20+ 分钟、CPU 只用 0.56 秒＝纯等待；去代理 90~130 秒完成）。`,
    };
  }
  if (v.ok === false) {
    return {
      useProxy: true,
      probe: "fail",
      found,
      reason: `检测到代理变量 ${list}，但探针 ${v.why} —— 去掉代理连不上 GitHub，`
        + `这台机器只能靠代理出网，所以**保留**代理原样上传（清掉就发不出去）。`,
    };
  }
  return {
    useProxy: true,
    probe: "broken",
    found,
    reason: `检测到代理变量 ${list}，但探测没跑出结论：${v.why} —— 拿不到确证就不动网络设置，`
      + `**保留**代理原样上传（宁可慢，也不能发不出去）。`,
  };
}

/**
 * 按决策造一份给 `gh` 用的 env。**从不修改传入的 env，也从不写 process.env。**
 * useProxy=true 时原样返回（连对象都不是新建的，省一次拷贝也没别的意思，
 * 重点是别让人误以为这里动了什么）。
 */
function buildGhEnv(env, decision) {
  const src = env || {};
  if (!decision || decision.useProxy) return { ...src };
  const out = { ...src };
  for (const k of decision.found || foundProxyKeys(src)) delete out[k];
  return out;
}

/** 探测子进程用的 env：代理变量 + NODE_USE_ENV_PROXY 全摘，其余原样。
 *  仍然只返回新对象，绝不写 process.env（父进程还要靠它跑 gh）。 */
function stripProbeEnv(env) {
  const out = { ...(env || {}) };
  for (const k of PROXY_ENV_KEYS) delete out[k];
  for (const k of PROBE_EXTRA_STRIP_KEYS) delete out[k];
  return out;
}

/** 真实探测器：起一个子进程做一次无代理 HTTPS HEAD。
 *  同步返回是因为 publish.cjs 全程是同步的（execSync/execFileSync），不敢为此改成异步——
 *  改成异步就要重排整个脚本的控制流，而顺序/闸门/产物检查一个字都不能动。 */
function runDirectProbe() {
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "publish-proxy.cjs"), "--probe-direct"], {
      encoding: "utf8",
      timeout: PROBE_HARD_TIMEOUT_MS,     // 硬杀兜底：万一子进程自己卡住
      stdio: ["ignore", "pipe", "pipe"],
      // 显式剥掉代理变量（理由见 PROBE_EXTRA_STRIP_KEYS：新版 Node 会真读 *_PROXY，
      // 不剥的话量到的是代理那条路，而我们要量的是直连）。
      env: stripProbeEnv(process.env),
    });
  } catch (e) {
    if (e && typeof e.stdout === "string" && /^fail\b/m.test(e.stdout)) {
      return { ok: false, why: (e.stdout.match(/^fail (.*)$/m) || [, e.stdout.trim()])[1] };
    }
    if (e && e.killed) throw new Error(`探测进程超过 ${PROBE_HARD_TIMEOUT_MS / 1000}s 被硬杀`);
    throw new Error(`探测进程起不来（${msg(e)}）`);
  }
  if (/^ok\b/m.test(out)) {
    return { ok: true, why: (out.match(/^ok (.*)$/m) || [, "已连通"])[1] };
  }
  throw new Error("探测进程输出无法解析");
}

/** --probe-direct 模式：真发一次 HEAD，结果打到 stdout + 退出码。 */
function probeDirectAsync() {
  return new Promise((resolve) => {
    const req = https.request(
      { method: "HEAD", host: PROBE_TARGET.host, path: PROBE_TARGET.path, headers: { "user-agent": "bai-router-publish-probe" } },
      (res) => {
        // 任何 HTTP 响应都说明「网络这条路通」——403/404 也是通的（限流、路径问题，不是连不上）。
        res.resume();
        resolve({ ok: true, why: `HEAD https://${PROBE_TARGET.host}${PROBE_TARGET.path} 返回 ${res.statusCode}` });
      },
    );
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ ok: false, why: `连 ${PROBE_TARGET.host} 超过 ${PROBE_TIMEOUT_MS / 1000}s 无响应（超时）` });
    });
    req.on("error", (e) => resolve({ ok: false, why: `连 ${PROBE_TARGET.host} 失败（${msg(e)}）` }));
    req.end();
  });
}

function msg(e) {
  if (!e) return "未知错误";
  const m = e.code ? `${e.code}: ${e.message || ""}`.trim() : (e.message || String(e));
  return String(m).split("\n")[0].slice(0, 120);
}

/**
 * gitNetVariants —— **远端核对**（git ls-remote 打 github.com）该试哪几条路。
 *
 * ⚠ 为什么单独抽出来：这条路的探测目标是 **github.com**，而上传那条路的探测目标
 *   是 **api.github.com** —— 两者不是同一条路（2026-10-22 实测：直连 api 0.8 秒、
 *   直连 github 16.7 秒，git 的连接预算撑不住那次握手）。
 *   ⇒ 「探测量的是一条路，决定的却是另一条路」⇒ 远端核对**自己**挑一条能通的。
 *
 * 候选顺序：**显式指定的（BAI_GIT_PROXY）→ 环境里本来就有的 → 上传那份 →
 * 不带代理**。⚠「环境里有没有代理变量」是**偶然**的（换个终端、换个工具就可能
 * 没有）⇒ 所以第一档是「显式指定」，它不依赖运气。
 *
 * @param {object} env        进程环境（一般传 process.env）
 * @param {object} [ghEnv]    上传那份 env（decideProxyUse 定的那份）
 * @param {object} [noProxyEnv] 不带代理的那份
 * @returns {object[]} 去重后的候选 env（按优先级）
 */
function gitNetVariants(env, ghEnv, noProxyEnv) {
  const src = env || {};
  const sig = (e) => PROXY_ENV_KEYS.map((k) => `${k}=${e[k] || ""}`).join("|");
  const out = [];
  const push = (e) => {
    if (!e) return;
    if (!out.some((v) => sig(v) === sig(e))) out.push(e);
  };
  const explicit = String(src.BAI_GIT_PROXY || "").trim();
  if (explicit) {
    const e = { ...src };
    for (const k of PROXY_ENV_KEYS) e[k] = explicit;
    push(e);
  }
  push(src);
  push(ghEnv);
  push(noProxyEnv);
  return out;
}

/**
 * gitRemoteError —— 所有路都试过之后的**说人话**的错。
 *
 * ⚠ 为什么不能把原始错误原样抛出：2026-10-23 那次发布挂在
 *   `spawnSync git ETIMEDOUT` —— 看不出「这是远端核对那步」「这台机器 github.com
 *   直连不通」「带代理重跑就行」这三件事。⇒ 报错要说清**是哪一步、为什么、怎么办**。
 *
 * @param {Error|string} last 最后一次失败的错误
 * @returns {Error} 带解法的错误
 */
function gitRemoteError(last) {
  const msg = String((last && last.message) || last || "");
  const timedOut = /ETIMEDOUT|timeout|timed out/i.test(msg);
  return new Error([
    "发布已中止：远端核对连不上 GitHub（所有候选路都试过了）。",
    "  打的地址：github.com —— 很多机器上它**直连不通**（api.github.com 通、github.com 不通）。",
    "  ⇒ 带上代理变量重跑（按你的实际代理改端口）：",
    "     HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 node scripts/publish.cjs \"<更新说明>\"",
    "  ⇒ 或只给 git 那一段指定：BAI_GIT_PROXY=http://127.0.0.1:7897 node scripts/publish.cjs \"<更新说明>\"",
    "  最后一次错误：" + (timedOut ? "连不上（超时）" : msg),
  ].join("\n"));
}

module.exports = {
  PROXY_ENV_KEYS, PROBE_EXTRA_STRIP_KEYS, PROBE_TARGET, PROBE_TIMEOUT_MS, PROBE_HARD_TIMEOUT_MS,
  foundProxyKeys, decideProxyUse, buildGhEnv, stripProbeEnv, runDirectProbe, probeDirectAsync,
  gitNetVariants, gitRemoteError,
};

if (require.main === module && process.argv.includes("--probe-direct")) {
  probeDirectAsync().then((r) => {
    process.stdout.write((r.ok ? "ok " : "fail ") + r.why + "\n");
    process.exitCode = r.ok ? 0 : 1;
  });
}