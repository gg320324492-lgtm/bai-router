/**
 * 走哪条通道的判定（scripts/proxy-policy-test.mjs）
 *
 * ## 这测的是「老是被杀掉」的**根因**
 *
 * 原来只有一个判据：端到端 curl 探上游。上游一慢/一限流 ⇒ 探针误判「代理坏了」
 * ⇒ 换代理 ⇒ **必须重启进程**（Node 在启动时就把代理缓存进 env 了）⇒ 新进程又去探、
 * 这次另一个代理探通了 ⇒ 再换 ⇒ **来回跳**。
 * 那台机器上 Clash 同占 7890 与 7897 两个端口，正好构成这个条件：
 * 2026-10-20/21 的日志里服务以 604s / 1811s / 3617s 的寿命反复退出，
 * 且新进程起来 4~5 秒就再退一次。
 *
 * ## 测什么
 *
 * ★ ① **当前代理的端口还通 ⇒ 绝不换**（周期探测）—— 这条是修掉自杀循环的关键。
 * ★ ② 当前代理的**端口死了** ⇒ 换到端到端真探得通的候选。
 * ★ ③ 直连（TUN）能通 ⇒ 保持直连；不通 ⇒ 换。
 * ★ ④ **手动检测**（thorough）才做端到端深探：当前探不通就换到探得通的。
 * ★ ⑤ 一条都没探通 ⇒ **null**（不换、不重启）。
 * ★ ⑥ **来回跳的回归场景**：两个代理端口都活着、端到端结果交替 ⇒ 连选多次都保持当前。
 *
 * ## 红线
 *
 * 纯逻辑 + 本机回环端口（不联网、不发任何外部请求）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseChannel, proxyPortAlive } from "../src/server/proxy-policy.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 假判据：portAlive/probe 由表驱动。 */
function fakeProbes({ ports = {}, endToEnd = {} } = {}) {
  const calls = { port: [], probe: [] };
  return {
    calls,
    portAlive: async (p) => { calls.port.push(p); return !!ports[p]; },
    probe: async (p) => { calls.probe.push(p); return !!endToEnd[p]; },
  };
}

describe("① 当前代理的端口还通 ⇒ 绝不换（修「老是被杀掉」的关键）", () => {
  test("①a 端口活着、端到端探不通（上游一慢）⇒ 保持当前，不换", async () => {
    const cur = "http://127.0.0.1:7897";
    const f = fakeProbes({ ports: { [cur]: true }, endToEnd: { [cur]: false, "http://127.0.0.1:7890": true } });
    const got = await chooseChannel({
      current: cur, thorough: false,
      candidates: ["http://127.0.0.1:7890"],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, cur, "★ 上游探不通不是代理的错 ⇒ 不许换（换了就要重启进程）");
    assert.ok(!f.calls.port.includes("http://127.0.0.1:7890"), "★ 既然当前能用，就不该去探候选");
  });

  test("①b 端口活着、端到端探不通 ⇒ **不做端到端探测**（省一次 6 秒）", async () => {
    const cur = "http://127.0.0.1:7897";
    const f = fakeProbes({ ports: { [cur]: true }, endToEnd: {} });
    await chooseChannel({ current: cur, thorough: false, candidates: [], portAlive: f.portAlive, probe: f.probe });
    assert.deepEqual(f.calls.probe, [], "★ 周期探测对当前通道只问端口，不问上游");
  });
});

describe("② 当前代理死了 ⇒ 换到真能用的候选", () => {
  test("②a 端口不通 ⇒ 换到端到端探得通的候选", async () => {
    const dead = "http://127.0.0.1:7897";
    const good = "http://127.0.0.1:7890";
    const f = fakeProbes({ ports: { [good]: true }, endToEnd: { [good]: true } });
    const got = await chooseChannel({
      current: dead, thorough: false,
      candidates: [good],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, good, "★ 端口死了就该换");
  });

  test("②b 候选端口也不通 ⇒ 一条都没找到 ⇒ null（不换、不重启）", async () => {
    const f = fakeProbes({ ports: {}, endToEnd: {} });
    const got = await chooseChannel({
      current: "http://127.0.0.1:7897", thorough: false,
      candidates: ["http://127.0.0.1:7890"],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, null, "★ 找不到就别乱换");
  });

  test("②c 候选端口通但端到端探不通 ⇒ 不选它（换过去得真能用）", async () => {
    const dead = "http://127.0.0.1:7897";
    const half = "http://127.0.0.1:7890";
    const f = fakeProbes({ ports: { [half]: true }, endToEnd: { [half]: false, "DIRECT": true } });
    const got = await chooseChannel({
      current: dead, thorough: false,
      candidates: [half],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, "DIRECT", "★ 端口通但探不通的候选不能选；实在没有就退到直连");
  });
});

describe("③ 直连（TUN）", () => {
  test("③a 当前是直连且直连探得通 ⇒ 保持直连", async () => {
    const f = fakeProbes({ endToEnd: { DIRECT: true } });
    const got = await chooseChannel({
      current: "", thorough: false,
      candidates: ["http://127.0.0.1:7890"],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, "DIRECT", "★ 直连能用就别去动它");
  });

  test("③b 直连探不通、候选能用 ⇒ 换到候选", async () => {
    const good = "http://127.0.0.1:7890";
    const f = fakeProbes({ ports: { [good]: true }, endToEnd: { [good]: true } });
    const got = await chooseChannel({
      current: "", thorough: false,
      candidates: [good],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, good);
  });
});

describe("④ 手动检测（thorough）才做端到端深探", () => {
  test("④a 当前代理端到端探不通、另一个探得通 ⇒ 换（用户点了「检测」）", async () => {
    const cur = "http://127.0.0.1:7897";
    const good = "http://127.0.0.1:7890";
    const f = fakeProbes({ ports: { [cur]: true, [good]: true }, endToEnd: { [cur]: false, [good]: true } });
    const got = await chooseChannel({
      current: cur, thorough: true,
      candidates: [good],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, good, "★ 手动检测就是来找一条真能用的路");
  });

  test("④b 当前代理端到端探得通 ⇒ 保持（不用换）", async () => {
    const cur = "http://127.0.0.1:7897";
    const f = fakeProbes({ ports: { [cur]: true }, endToEnd: { [cur]: true } });
    const got = await chooseChannel({
      current: cur, thorough: true, candidates: [],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, cur);
  });
});

describe("⑤ 来回跳的回归场景（本文件最重要的一条）", () => {
  test("⑤a 两个代理端口都活着、端到端结果交替 ⇒ 连选 6 次都保持当前", async () => {
    /* 这就是那台机器上的真实形状：Clash 同占 7890 与 7897，两个端口都活着，
       而端到端探上游时好时坏（上游一慢就探不通）。
       ⇒ 旧逻辑会在两者之间来回跳 ⇒ 每跳一次重启一次服务。 */
    const cur = "http://127.0.0.1:7897";
    const other = "http://127.0.0.1:7890";
    let flip = false;
    const f = {
      portAlive: async () => true,                 // 两个端口都活着
      probe: async (p) => (flip = !flip),          // 端到端结果每次都反
    };
    let last = cur;
    for (let i = 0; i < 6; i++) {
      const got = await chooseChannel({
        current: last, thorough: false,
        candidates: [other],
        portAlive: f.portAlive, probe: f.probe,
      });
      assert.equal(got, cur, `★ 第 ${i + 1} 次就跳走了 ⇒ 又要重启服务`);
    }
  });

  test("⑤b 同样的场景在 thorough（手动）下**应该**跳（那才是手动检测的职责）", async () => {
    const cur = "http://127.0.0.1:7897";
    const other = "http://127.0.0.1:7890";
    const f = { portAlive: async () => true, probe: async () => false };
    const got = await chooseChannel({
      current: cur, thorough: true, candidates: [other],
      portAlive: f.portAlive, probe: f.probe,
    });
    assert.equal(got, null, "两条都探不通 ⇒ 挑不出 ⇒ null（宁可不动）");
  });
});

describe("⑥ 端口判据本身（真回环，不联网）", () => {
  test("⑥a 真开着的端口 ⇒ 通；没人听的端口 ⇒ 不通", async () => {
    const srv = net.createServer();
    const port = await new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
    try {
      assert.equal(await proxyPortAlive(`http://127.0.0.1:${port}`), true, "开着的端口要判通");
      /* 找一个确定没人听的端口：先拿到一个再关掉它。 */
      const dead = await new Promise((res) => {
        const s2 = net.createServer();
        s2.listen(0, "127.0.0.1", () => { const p = s2.address().port; s2.close(() => res(p)); });
      });
      assert.equal(await proxyPortAlive(`http://127.0.0.1:${dead}`), false, "没人听的端口要判不通");
    } finally { await new Promise((res) => srv.close(res)); }
  });

  test("⑥b 不是本地的地址 ⇒ 不判死（别把远程代理误杀）", async () => {
    assert.equal(await proxyPortAlive("http://example.com:8080"), true);
  });

  test("⑥c 乱七八糟的输入不抛", async () => {
    for (const s of ["", "not a url", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:99999"]) {
      await assert.doesNotThrow(async () => { await proxyPortAlive(s); });
    }
  });
});

describe("⑦ 打包白名单", () => {
  test("⑦a proxy-policy.mjs 得在 extraResources 的白名单里", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    const filter = pkg.build.extraResources.find((x) => x.from === "src/server").filter;
    assert.ok(filter.includes("proxy-policy.mjs"),
      "★ proxy-policy.mjs 不在白名单里 ⇒ 装出来的版本 import 不到它 ⇒ 服务起不来");
  });
});
