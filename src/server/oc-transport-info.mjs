/* oc-transport-info.mjs —— 传输方式开关给面板用的**只读事实**（v1.0.75）。
 *
 * 开关本身写在 cfg.zen.transport（POST /api/config 已经收），本文件只回答两件事：
 *   ① 现在是哪一档（认不出来的一律报 direct，与 zenTransportOf 同一判据）；
 *   ② 打开需要的那件前置条件，在**这台机器**上到底满足没有。
 *
 * ── 为什么单独一个文件 ──
 * ① `/api/status` 被面板每 5 秒轮询一次，而探测要跑 `where opencode`
 *    （spawnSync，**同步阻塞事件循环**）。不做 TTL 缓存就等于每 5 秒卡一次。
 * ② 「探测出错」和「没装」必须能分开验证。真实机器上把探测弄挂是做不到的
 *    （既没装又报错的情形更少见），所以 find 做成**可注入**：生产用默认实现，
 *    测试用替身把三种状态各跑一遍。生产代码里不留任何测试钩子。
 *
 * ── 三态为什么必须分清 ──
 *   found  → 绿色 + 路径，可以直接打开这一档
 *   missing → 红色 + 可自己执行的安装命令。**本产品不会替你下载**：装法因人而异
 *             （npm 全局 / 官方脚本 / 手放），猜一种装下去比不给更糟。
 *   error  → 「检测失败」。这是**第三种**处置：不是让你去装（你可能早就装了），
 *             而是让你知道面板这一格此刻说不出话，重试或自己确认。
 *   把 error 画成 missing，处置就从「再试一次」变成了「去装一个可能已经装过的东西」。
 *
 * 纪律：本文件不出现任何渠道名，也不碰凭据（探测的是二进制路径，不是任何 token）。
 */
import fs from "node:fs";
import { findOpenCodeBinary } from "./oc-runtime.mjs";
import { spawnableExists, ocInstallHint, ZEN_TRANSPORT_DIRECT, ZEN_TRANSPORT_OPENCODE } from "./oc-wiring.mjs";

/** 探测结果的缓存时长。30 秒：面板 5 秒一 polls，够挡住绝大部分重复探测，
 *  而用户装完 OpenCode 后最多半分钟就能在面板上看到，不必重启服务。 */
export const PROBE_TTL_MS = 30_000;

let cache = { at: 0, val: null };

/**
 * 默认探测：**复用**接线层那一份发现逻辑，不另造一套。
 * `exists` 用 oc-wiring 的 spawnableExists —— Windows 上无扩展名的 shim 一律当不存在，
 * 否则 `where opencode` 的第一条会被选中，而它根本 spawn 不起来（见 oc-runtime 的注释）。
 */
export function defaultFind() {
  return findOpenCodeBinary({ env: process.env, exists: spawnableExists(fs.existsSync) });
}

/** 测试用：清掉 TTL 缓存。生产代码不需要它。 */
export function resetOcBinaryCache() {
  cache = { at: 0, val: null };
}

/**
 * 探一次本机的 OpenCode。
 *
 * @param {object} [o]
 * @param {() => object} [o.find] 注入的发现函数（默认 defaultFind）
 * @param {() => number} [o.now]
 * @param {number} [o.ttlMs]
 * @param {boolean} [o.force] 无视缓存强制重探
 * @returns {{state:"found"|"missing"|"error", path:string, source:string|null,
 *            hint:string, error:string, reason:string|null,
 *            tried:Array, checkedAt:string, cached:boolean}}
 */
export function probeOcBinary(o = {}) {
  const { find = defaultFind, now = () => Date.now(), ttlMs = PROBE_TTL_MS, force = false } = o;
  if (!force && cache.val && now() - cache.at < ttlMs) {
    return Object.assign({}, cache.val, { cached: true });
  }

  const t = now();
  let val;
  try {
    const r = find();
    const tried = (r && Array.isArray(r.tried)) ? r.tried : [];
    if (r && r.ok) {
      val = {
        state: "found", path: String(r.path || ""), source: r.source || null,
        hint: "", error: "", reason: null, tried,
      };
    } else {
      val = {
        state: "missing", path: "", source: null,
        /* 装法说明来自 oc-wiring.ocInstallHint —— 与请求真失败时给用户的那段字**同一份**，
         * 面板上看到的和真出错时看到的不会打架。 */
        hint: ocInstallHint(tried),
        error: "", reason: (r && r.reason) || "opencode-not-found", tried,
      };
    }
  } catch (e) {
    /* ★ 探测自己抛了 = 检测失败，**不是**「没装」。两者分开落成两种 state，
       面板据此给出两种**处置完全不同**的提示（见文件头）。 */
    val = {
      state: "error", path: "", source: null,
      hint: "这次没能完成检测（这不等于「本机没装」）：检测步骤自己报错了，下面是它说的原因。"
        + "面板此刻说不出「装没装」这件事——可以点「刷新」重试，或自己按上面的命令确认。",
      error: String((e && e.message) || e).slice(0, 300),
      reason: "probe-failed", tried: [],
    };
  }

  val.checkedAt = new Date(t).toISOString();
  cache = { at: t, val };
  return Object.assign({}, val, { cached: false });
}

/**
 * `/api/status` 里那一组字段。
 *
 * 只读：不写配置、不起进程、不发任何请求。
 *
 * @param {object} cfg 全量配置
 * @param {object} [probeOpts] 透传给 probeOcBinary（测试注入用）
 */
export function ocTransportFields(cfg, probeOpts = {}) {
  /* 与 zenTransportOf 同一判据：认不出来的一律 direct。面板显示的必须是
   * 中转**真正会走**的那条路，而不是配置文件里那个认不出来的字面量。 */
  const raw = cfg && cfg.zen ? cfg.zen.transport : undefined;
  const transport = raw === ZEN_TRANSPORT_OPENCODE ? ZEN_TRANSPORT_OPENCODE : ZEN_TRANSPORT_DIRECT;
  const probe = probeOcBinary(probeOpts);

  const hint = transport === ZEN_TRANSPORT_OPENCODE
    ? "已保存即生效：**下一次模型请求**就走这一档——每个请求都会重新读这份配置，"
      + "不需要重启中转，也不需要重启本程序。"
      + "切回「直连」不会立刻关掉已经起着的 OpenCode 进程（本产品在退出时收它，"
      + "下次用到它时按空闲 2 小时回收），它不在请求路径上，不占 CPU。"
    : "已保存即生效：**下一次模型请求**就走直连——每个请求都会重新读这份配置，"
      + "不需要重启中转，也不需要重启本程序。切到 OpenCode 客户端中转前请先看下面的检测结果。";

  return {
    transport,
    transportHint: hint,
    transportValues: [ZEN_TRANSPORT_DIRECT, ZEN_TRANSPORT_OPENCODE],
    transportProbe: {
      state: probe.state,
      path: probe.path,
      source: probe.source,
      hint: probe.hint,
      error: probe.error,
      reason: probe.reason,
      checkedAt: probe.checkedAt,
      cached: probe.cached,
      /* 只给路径与来源，不给 tried 全量清单：面板不需要逐条列，真出错时
       * 请求错误消息里已经带上了同一份 tried（ocInstallHint）。 */
      triedCount: Array.isArray(probe.tried) ? probe.tried.length : 0,
    },
  };
}