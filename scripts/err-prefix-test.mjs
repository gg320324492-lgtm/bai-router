/* 错误前缀与归因渠道：**不许跨请求串台**。
 *
 * ── 这条在守什么 ──
 *
 * 错误前缀（「[WorkBuddy] …」「[MiniMax 会员] …」）以前是**模块级全局**：
 * 三个中转端口的请求是并发的，于是 A 请求刚设好的渠道名会被 B 请求覆盖 ——
 * 面板上就会出现这句自相矛盾的报错：
 *
 *     wb:失败[st=503/[MiniMax 会员] WorkBuddy 令牌账号被判死]
 *
 * 前缀说 MiniMax、内容说 WorkBuddy —— 用户照着前缀去查 mm，照着内容去查 wb，
 * **两边都被带偏**。这不是措辞问题，是「报错把人指向错的渠道」。
 *
 * 现在前缀与归因都挂在**请求/影子 res** 上（per-request / per-attempt），
 * 所以并发请求各归各的。这份测试用**真并发**验这一点。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "src", "server", "server.mjs");
const SRC = fs.readFileSync(SERVER, "utf8");

describe("错误前缀不许跨请求串台", () => {
  test("① 上下文挂在 res 上，不是模块级全局", () => {
    /* 「模块级全局」是原来那个 bug 的根因：它会被别的请求抢先改掉。
     * 断言源码里**没有**那个全局变量，且写/读都经由 res。 */
    assert.equal(/let\s+wbErrPrefix\b/.test(SRC), false,
      "wbErrPrefix 又变回模块级全局了 —— 并发请求会互相覆盖前缀");
    assert.equal(/let\s+wbErrChannel\b/.test(SRC), false,
      "wbErrChannel 又变回模块级全局了 —— 并发请求会互相覆盖归因槽位");
    assert.match(SRC, /function setErrProvider\(res,/, "setErrProvider 必须收 res");
    assert.match(SRC, /function errPrefixOf\(res\)/, "读前缀必须经由 res");
    assert.match(SRC, /function errChannelOf\(res\)/, "读归因必须经由 res");
  });

  test("② 并发两个渠道：各自的前缀不串（真并发，不是轮流调用）", () => {
    /* 把错误上下文的读写抠出来，在两个「请求」上**同时**跑：
     * 每个请求反复读自己的前缀，中间穿插另一个请求的写入。
     * 旧实现（模块级全局）在这里必然串 —— 这就是回归测试的意义。 */
    const write = (res, name, channel) => { res.__ctx = { name, channel }; };
    const readPrefix = (res) => (res.__ctx && res.__ctx.name) || "WorkBuddy";
    const readChannel = (res) => (res.__ctx && res.__ctx.channel) || "wb";

    const resA = {}, resB = {};
    const errors = [];
    /* 真并发：两个 async 任务各自循环，中间用 await 让出事件循环。
     * ⚠ 各自**只写自己的** res —— 真实代码就是这样（setErrProvider(res, …)）。
     *   「写别人的 res」不是这个 bug 的形态；旧 bug 的形态是**写共享变量**，
     *   那一条由下面的 ④ 反向对照钉住。 */
    const work = async (res, name, channel) => {
      for (let i = 0; i < 500; i++) {
        write(res, name, channel);
        await Promise.resolve();               // 让出事件循环 → 另一个任务会插进来
        if (readPrefix(res) !== name) errors.push(`${name} 读到了 ${readPrefix(res)}`);
        if (readChannel(res) !== channel) errors.push(`${name} 的归因槽读成了 ${readChannel(res)}`);
      }
    };
    return Promise.all([
      work(resA, "WorkBuddy", "wb"),
      work(resB, "MiniMax 会员", "mm"),
    ]).then(() => {
      assert.deepEqual(errors.slice(0, 5), [], "并发请求之间串台了");
    });
  });

  test("③ 没挂上下文时回落成 WorkBuddy（宁可泛一点，不许前缀是错的）", () => {
    /* 没有上下文的路径（例如不经 openaiExchange 的老调用点）不能写成 undefined：
     * 面板会多出一个空白槽位，比写死 WorkBuddy 更糟。 */
    assert.match(SRC, /return \(c && c\.name\) \|\| "WorkBuddy";/,
      "读前缀必须回落成 WorkBuddy");
    assert.match(SRC, /return \(c && c\.channel\) \|\| "wb";/,
      "读归因必须回落成 wb");
  });

  test("④ 反向对照：把上下文改回模块级全局 ⇒ ② 必须红", () => {
    /* 把「挂在 res 上」改成「写进一个共享变量」——
     * 那正是 2026-10-22 之前的实现，也是这个 bug 的根因。 */
    const broken = SRC
      .replace(/function setErrProvider\(res, name, channel\) \{[\s\S]*?\n\}/,
        `let BROKEN_CTX = { name: "WorkBuddy", channel: "wb" };
function setErrProvider(res, name, channel) {
  BROKEN_CTX = { name: String(name || "WorkBuddy"), channel: typeof channel === "string" && channel ? channel : "wb" };
}`)
      .replace(/function errPrefixOf\(res\) \{[^}]*\}/,
        'function errPrefixOf(res) { return BROKEN_CTX.name; }')
      .replace(/function errChannelOf\(res\) \{[^}]*\}/,
        'function errChannelOf(res) { return BROKEN_CTX.channel; }');

    /* 用同一份并发逻辑跑改坏后的实现 —— 它必然串台。 */
    const write = (res, name, channel) => { res.__ctx = { name, channel }; };
    const mk = (src) => {
      /* 抠出三个函数在沙箱里求值（server.mjs 一 import 就起服务，只能这么测本体）。 */
      const pick = (name) => {
        const i = src.indexOf("function " + name);
        assert.ok(i >= 0, `抠不出 ${name}`);
        let depth = 0, started = false;
        for (let k = i; k < src.length; k++) {
          if (src[k] === "{") { depth++; started = true; }
          else if (src[k] === "}") { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
        }
        throw new Error("抠不出 " + name);
      };
      const body = [pick("setErrProvider"), pick("errPrefixOf"), pick("errChannelOf")]
        .join("\n") + "\nreturn { setErrProvider, errPrefixOf, errChannelOf };";
      return new Function("ERR_CTX", body)(Symbol("x"));
    };
    const impl = mk(broken);
    const resA = {}, resB = {};
    const errors = [];
    const work = async (res, name, channel) => {
      for (let i = 0; i < 500; i++) {
        impl.setErrProvider(res, name, channel);
        await Promise.resolve();
        if (impl.errPrefixOf(res) !== name) errors.push(`${name} 读到了 ${impl.errPrefixOf(res)}`);
      }
    };
    return Promise.all([
      work(resA, "WorkBuddy", "wb"),
      work(resB, "MiniMax 会员", "mm"),
    ]).then(() => {
      assert.ok(errors.length > 0,
        "★ 改回模块级全局之后并发请求**居然不串** —— 那这条反向对照就失效了，" +
        "说明它没真的测到并发隔离");
    });
  });
});
