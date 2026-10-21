/**
 * 更新通道 —— 稳定版（latest）与测试版（beta）两条路。
 *
 * 为什么要两条：用户要「**选择性升级、能正常回退**」。
 * 一次发版同时影响所有用户，出问题就只能全量回退；分通道之后，
 * 测试版的错只落在自愿装测试版的人身上，稳定版用户完全不受影响。
 *
 * 本模块是**纯逻辑、无 Electron 依赖**，而且是 **CommonJS**：
 * `src/main.js` 是 CommonJS（`require`），Electron 里 `require()` 一个 ESM
 * 并不可靠，所以这里跟着 main.js 的格式走，测试那边用 ESM 的具名 import
 * （Node 的 CJS 具名导出检测能处理 `module.exports = { ... }`）。
 *
 * 把判据抽出来还有个理由：`src/main.js` 一 import 就会起 app，
 * 没法直接 import 来测。判据在这里，main.js 与测试都 import 它。
 *
 * ⚠ 口径说明（别自己改）：
 * · 「稳定版」= electron-updater 的 `latest` 通道，读 release 里的 `latest.yml`
 * · 「测试版」= electron-updater 的 `beta` 通道，读 release 里的 `beta.yml`
 * · 两条通道都要 `allowPrerelease = true`，否则带 prerelease 后缀的版本
 *   （1.0.93-beta.1）在 semver 比较里根本不算「更新」，用户永远看不到。
 */

/** 两个通道。值是 config.json 里 `updateChannel` 字段的取值。 */
const CHANNELS = {
  stable: "stable",
  beta: "beta",
};

/** 缺省通道。没写、写错、写了不认识的值 → 一律当稳定版。 */
const DEFAULT_CHANNEL = CHANNELS.stable;

/**
 * 读出通道。**认不出来的值一律回落成稳定版**，不抛错也不猜。
 *
 * 为什么回落而不是报错：一个手改过 config.json 的用户，把 channel 写成
 * 「Beta」「beta2」之类的，不该让整个更新器起不来——最坏的结果只是
 * 回到稳定通道而已，那总是能用的那条路。
 */
function readChannel(cfg) {
  const v = cfg && typeof cfg === "object" ? cfg.updateChannel : null;
  if (typeof v !== "string") return DEFAULT_CHANNEL;
  const s = v.trim().toLowerCase();
  if (s === CHANNELS.beta) return CHANNELS.beta;
  return DEFAULT_CHANNEL;
}

/**
 * electron-updater 的 channel 名。
 *
 * ⚠ 「稳定版」映射到 **latest** 而不是 stable —— electron-updater 认的是
 * release 资产里的 yml 文件名：`latest.yml` / `beta.yml` / `alpha.yml`。
 * 写成 "stable" 它会去找 stable.yml，那个文件不存在，于是永远「检查不到更新」。
 */
function updaterChannel(channel) {
  return channel === CHANNELS.beta ? "beta" : "latest";
}

/**
 * 这个版本号是不是预发布版（1.0.93-beta.1 这种）。
 *
 * 判据用 semver 的 prerelease 分隔符 `-`：`1.0.93-beta.1` 是，
 * `1.0.93` 不是。**不要另加配置字段**——版本号本身就是那个声明。
 */
function isPrereleaseVersion(version) {
  const v = String(version == null ? "" : version).trim();
  if (!v) return false;
  /* 去掉可能的 v 前缀再判：`v1.0.93-beta.1` 也是预发布版。 */
  const bare = (v[0] === "v" || v[0] === "V") ? v.slice(1) : v;
  const i = bare.indexOf("-");
  if (i < 0) return false;
  return bare.slice(i + 1).length > 0;
}

/**
 * 这个版本该进哪条通道。
 *
 * ⚠ **版本号自己说了算，不看当前设置**。发版时人在命令行上跑 publish，
 * 那时没有「用户选了哪个通道」这回事——发布的是 beta 版，就产 beta.yml。
 * 用户选哪条通道是**客户端**的事，两边各管一段。
 */
function channelForVersion(version) {
  return isPrereleaseVersion(version) ? CHANNELS.beta : CHANNELS.stable;
}

module.exports = {
  CHANNELS,
  DEFAULT_CHANNEL,
  readChannel,
  updaterChannel,
  isPrereleaseVersion,
  channelForVersion,
};
