/**
 * 随包默认「故障转移」↔ 代码默认值：**必须是同一个取值**（回归测试）
 *
 * ## 为什么要有这个测试
 *
 * 2026-10-30 发现的矛盾：随包种子 `src/server/config.defaults.json` 里
 * `failover.enabled = true`（v1.0.62 的发布提交 b7508be 有意改成这样），
 * 而 `src/server/server.mjs` 的 `DEFAULTS.failover.enabled = false`，
 * 且那段注释明写「默认关闭——改变请求去向这种事得用户点头才开」。
 *
 * ⚠ 矛盾之所以有**实际后果**，是因为首启逻辑（server.mjs 的
 *   「首启：用户目录还没有 config → 从随包默认配置复制一份」）会把**种子**
 *   复制成用户的 config.json ⇒ **种子里的取值就是新装用户的实际默认**。
 *   而 DEFAULTS 里那个 false 只在「config.json 已存在、但缺 failover 键」时才生效。
 *
 * ⇒ 两处默认值不一致 ⇒ 新装用户拿到的是「开」，与代码注释宣称的「关」相反。
 *
 * ## 实测过的后果（2026-10-30）
 *
 * 起一个没有 config.json 的隔离实例，打一条普通请求 ⇒ 请求被**静默转移**：
 * `from: bai → to: mm`，`/api/status` 的 `failover.silentJump.total = 2`，
 * 实际服务的是 MiniMax-M3.1-Flash。渠道失败时自动换人，而**用户不知情**：
 * ① 额度从别家扣；② 面板显示的模型 ≠ 实际服务的模型。
 *
 * ⇒ 现在两处统一为**关**（用户 2026-10-30 拍板：「改回关」）。
 *   本测试钉住它们**不许再分叉**。
 *
 * ## ⚠ 老用户不在这个测试的射程内
 *
 * 已经装过、且 config.json 里 `failover.enabled = true` 的机器（v1.0.62 之后首启的），
 * 改种子救不了他们 —— 那是**用户自己那份配置**，不该被静默改写。
 *
 * ## 红线
 *
 * 纯源码/JSON 断言：不 spawn、不联网、不落盘。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = JSON.parse(fs.readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
const SERVER = fs.readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");

/**
 * 种子的 failover.enabled 与代码 DEFAULTS 的 failover.enabled 是否一致。
 * 抽成函数，好让「反向对照」能在内存里造样本，不必改仓库里的文件。
 *
 * @param {object} seed 种子配置
 * @param {string} serverSrc server.mjs 源码
 * @returns {{ok:boolean, seed:any, code:string|null, why?:string}}
 */
export function failoverDefaultsAgree(seed, serverSrc) {
  /* 只认 DEFAULTS 那一处：`failover: {\n    enabled: true|false,`。
   * 面板状态输出里也有 `failover: { enabled: cfg.failover?.enabled === true, …}`，
   * 那一处不是字面量，正则匹配不到 ⇒ 不会误取。 */
  const m = serverSrc.match(/failover:\s*\{\s*\n\s*enabled:\s*(true|false),/);
  if (!m) return { ok: false, seed: seed?.failover?.enabled, code: null, why: "认不出 server.mjs 的 DEFAULTS.failover.enabled" };
  return { ok: String(seed?.failover?.enabled) === m[1], seed: seed?.failover?.enabled, code: m[1] };
}

describe("随包默认「故障转移」↔ 代码默认值", () => {
  test("① 种子的 failover.enabled == 代码 DEFAULTS 的 failover.enabled", () => {
    const r = failoverDefaultsAgree(SEED, SERVER);
    assert.ok(r.ok,
      `★ 两处默认值不一致：种子 ${JSON.stringify(r.seed)}、代码 ${JSON.stringify(r.code)}`
      + " —— 种子会被复制成新装用户的 config.json ⇒ 用户的实际默认与代码注释说的相反");
  });

  test("② 首启会把种子复制成用户的 config.json（所以种子就是新装用户的默认）", () => {
    assert.ok(/if \(!existsSync\(CONFIG_FILE\)\)[\s\S]{0,500}?copyFileSync\(seed, CONFIG_FILE\)/.test(SERVER),
      "★ 首启复制逻辑不在了 —— 那这条测试的前提就变了，得跟着改");
  });

  test("③ 默认是关的（'改变请求去向这种事得用户点头才开'）", () => {
    assert.equal(SEED.failover.enabled, false,
      "★ 随包默认又是开着的 —— 用户 2026-10-30 拍板的是「改回关」");
    assert.match(SERVER, /默认关闭——改变请求去向这种事得用户点头才开/,
      "★ server.mjs 里那句注释不见了（它才是「默认关」的出处）");
  });

  test("④ 反向对照：种子改成开 ⇒ ① 必须判为不一致", () => {
    /* 证明 ① 不是恒真的空测试。 */
    const bad = { ...SEED, failover: { ...SEED.failover, enabled: true } };
    assert.equal(failoverDefaultsAgree(bad, SERVER).ok, false,
      "★ 种子开着竟然还判一致 ⇒ 断言写空了");
    assert.equal(failoverDefaultsAgree(SEED, SERVER).ok, true);
  });
});
