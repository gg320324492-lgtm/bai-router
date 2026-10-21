/* 更新通道（稳定版 / 测试版）的判据。
 *
 * 这条链路的两端各管一段，别混：
 *   · **发布端**（scripts/publish.cjs）：版本号带 `-beta.N` → 上传 beta.yml，GitHub 上标
 *     prerelease。electron-builder 自己会按版本号推导通道（appInfo.channel 取 semver 的
 *     prerelease 标签），所以构建命令一个字都不用改。
 *   · **客户端端**（src/main.js）：用户选的那条通道决定读 latest.yml 还是 beta.yml。
 *
 * 最要紧的一条：**稳定版绝不能读到 beta.yml**。那等于把测试版推给了所有人，
 * 「选择性升级」就名存实亡。所以「稳定版 → latest」这个映射必须钉死。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNELS, DEFAULT_CHANNEL, readChannel, updaterChannel, allowPrereleaseFor,
  isPrereleaseVersion, channelForVersion,
} from "../src/update-channel.js";

describe("更新通道判据", () => {
  test("① 缺省是稳定版；认不出来的值一律回落成稳定版", () => {
    assert.equal(readChannel({}), DEFAULT_CHANNEL);
    assert.equal(readChannel(null), DEFAULT_CHANNEL);
    assert.equal(readChannel(undefined), DEFAULT_CHANNEL);
    assert.equal(readChannel({ updateChannel: "" }), CHANNELS.stable);
    assert.equal(readChannel({ updateChannel: "beta2" }), CHANNELS.stable, "不认识的值不能当 beta");
    assert.equal(readChannel({ updateChannel: 123 }), CHANNELS.stable, "类型不对也不能当 beta");
    assert.equal(readChannel({ updateChannel: "Beta" }), CHANNELS.beta, "大小写不敏感");
    assert.equal(readChannel({ updateChannel: " beta " }), CHANNELS.beta, "首尾空白要容忍");
  });

  test("② 稳定版映射到 latest，测试版映射到 beta（不是 stable！）", () => {
    /* ⚠ 「stable」是错的：electron-updater 认的是 release 资产里的 yml 文件名
     * （latest.yml / beta.yml），写 stable 它会去找 stable.yml，那个文件不存在，
     * 于是永远「检查不到更新」。 */
    assert.equal(updaterChannel(CHANNELS.stable), "latest");
    assert.equal(updaterChannel(CHANNELS.beta), "beta");
    assert.equal(updaterChannel("stable"), "latest", "认不出来的通道也回落成 latest");
    assert.equal(updaterChannel(undefined), "latest");
  });

  test("③ 两条通道必须读不同的清单（否则等于没分通道）", () => {
    assert.notEqual(updaterChannel(CHANNELS.stable), updaterChannel(CHANNELS.beta));
  });

  test("③b ★ allowPrerelease 必须按通道分开（读 electron-updater 源码得到的结论）", () => {
    /* 四种组合里只有两种是对的：
     *   稳定版：allowPrerelease=false + channel="latest" → 走 /releases/latest（排除预发布）
     *   测试版：allowPrerelease=true  + channel="beta"   → 走 Atom feed 挑 beta
     * 另两种都错：true+不设 → 稳定版会拿到 beta；true+"latest" → 报「No published versions」。 */
    assert.equal(allowPrereleaseFor(CHANNELS.stable), false,
      "稳定版必须 allowPrerelease=false —— 设成 true 且 channel 为 latest 会让检查更新直接失败");
    assert.equal(allowPrereleaseFor(CHANNELS.beta), true,
      "测试版必须 allowPrerelease=true —— 否则预发布版本在版本比较里根本不算「更新」");
    assert.equal(allowPrereleaseFor("stable"), false, "不认识的通道按稳定版处理");
    assert.equal(allowPrereleaseFor(undefined), false, "缺省按稳定版处理");
    /* 两条通道的组合必须各不相同 —— 相同就等于没分通道 */
    const stable = [updaterChannel(CHANNELS.stable), allowPrereleaseFor(CHANNELS.stable)];
    const beta = [updaterChannel(CHANNELS.beta), allowPrereleaseFor(CHANNELS.beta)];
    assert.notDeepEqual(stable, beta, "两条通道的 (channel, allowPrerelease) 组合必须不同");
    assert.deepEqual(stable, ["latest", false]);
    assert.deepEqual(beta, ["beta", true]);
  });

  test("④ 版本号带 prerelease 后缀才算预发布", () => {
    assert.equal(isPrereleaseVersion("1.0.93-beta.1"), true);
    assert.equal(isPrereleaseVersion("v1.0.93-beta.1"), true, "v 前缀也要认");
    assert.equal(isPrereleaseVersion("1.0.93-alpha"), true);
    assert.equal(isPrereleaseVersion("1.0.93"), false);
    assert.equal(isPrereleaseVersion("v1.0.93"), false);
    assert.equal(isPrereleaseVersion(""), false);
    assert.equal(isPrereleaseVersion(null), false);
    assert.equal(isPrereleaseVersion(undefined), false);
  });

  test("⑤ 版本自己决定进哪条通道（发布端与客户端端各管一段）", () => {
    assert.equal(channelForVersion("1.0.93-beta.1"), CHANNELS.beta);
    assert.equal(channelForVersion("1.0.93"), CHANNELS.stable);
    /* 反过来最危险：预发布版本被当成稳定版 → 上传 latest.yml → 推给所有稳定版用户 */
    assert.notEqual(channelForVersion("1.0.93-beta.1"), CHANNELS.stable,
      "预发布版本绝不能进稳定通道");
  });

  test("⑥ 反向对照：把「稳定版 → latest」改坏，②③ 必须红", () => {
    /* 模拟「写成了 stable」这个错：electron-updater 会去找 stable.yml，永远查不到更新 */
    const broken = (ch) => (ch === CHANNELS.beta ? "beta" : "stable");
    assert.equal(broken(CHANNELS.stable), "stable");
    assert.notEqual(broken(CHANNELS.stable), updaterChannel(CHANNELS.stable),
      "改坏之后必须与正确实现不同，否则这条断言是空转");
  });

  test("⑦ 反向对照：把「预发布判定」改坏，④⑤ 必须红", () => {
    /* 模拟「只认 beta 字样、不认 semver 的 prerelease 结构」这个错。
     * 区分点在于 **alpha / rc 这类别的 prerelease 标签**：
     * 只认 beta 的实现会把 1.0.93-alpha 当成稳定版，于是那个版本被上传成
     * latest.yml —— 测试版被推给了所有稳定版用户。 */
    const broken = (v) => /beta/i.test(String(v || ""));
    assert.equal(broken("1.0.93-alpha"), false, "坏的实现把 alpha 当稳定版");
    assert.equal(isPrereleaseVersion("1.0.93-alpha"), true, "真实现认得出 alpha");
    assert.notEqual(broken("1.0.93-alpha"), isPrereleaseVersion("1.0.93-alpha"),
      "两种判据必须在这个输入上不同，否则 ④ 的断言没咬住实现");
  });
});
