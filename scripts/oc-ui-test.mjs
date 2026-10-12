/**
 * scripts/oc-ui-test.mjs —— OpenCode 接入的**面板那一块**（v1.0.75 最后一块）。
 *
 * 接线的测试在 oc-wiring-test.mjs（真的换了进程、真的拿到 tool_use）。
 * 本文件只管「用户够得着吗、够得着的时候说的是不是实话」：
 *
 *   ① 出厂值仍然是 direct —— 这次是往面板上加控件，最容易犯的错就是顺手把默认翻掉
 *   ② 服务端探测的三态（找到 / 没装 / **检测出错**）与各自的文案
 *   ③ 前端把三态画成三种**不同**的东西，且「检测出错」绝不被画成「没装」
 *   ④ 渲染层源码里没有任何渠道名（机械扫描，锁死 C11 纪律）
 *   ⑤ 切换请求的载荷正确；服务端拒收时前端**有**对应提示（不是静默拨回去）
 *   ⑥ 切换之后明确说「何时生效」，不是静默切换
 *   ⑦ 端到端：真 server.mjs（临时 BAI_DATA_DIR + 17xxx 隔离端口）读 /api/status、切开关、被拒非法值
 *
 * 反向对照：文件末尾 SABOTAGE 表 + scripts/oc-ui-sabotage-run.mjs（grep SABOTAGE 可定位）。
 * 判据只有一个——改回改前行为，测试必须红。
 *
 * 红线：本文件绝不写真实 %APPDATA%\bai-router，不含任何真实令牌，
 * 端口全部动态挑空闲（落在 17xxx 段），taskkill 只按 PID。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import { probeOcBinary, ocTransportFields, resetOcBinaryCache, PROBE_TTL_MS } from "../src/server/oc-transport-info.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const CARD = path.join(REPO, "src", "server", "cards", "oc-transport.js");
const PANEL = path.join(REPO, "src", "server", "panel-common.js");
const PROVIDERS = path.join(REPO, "src", "server", "providers.js");
const DEFAULTS_JSON = path.join(REPO, "src", "server", "config.defaults.json");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-oc-ui-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ------------------------------------------------------------------ *
 * 把渲染层那块卡拿进一个只有 window 的 vm 里，取它的三个纯函数。
 * 之所以能这么干：卡在顶层只往 window.BAI_CARDS 上登记，DOM 全在 mount() 里
 * （闸门 C6 也正是这么要求它能在沙箱里单独求值）。于是测试跑的是**真源码**，
 * 不是把渲染逻辑抄一份到测试里那种自欺欺人。
 * ------------------------------------------------------------------ */
function loadCard(doc) {
  const sandbox = { window: {}, console };
  if (doc) sandbox.document = doc;   // 只有 mount() 需要 document；纯函数测试不必给
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  /* 挂载时读的是 window.BAI_PROVIDERS（清单先加载，和浏览器里的顺序一致），
     所以要测 mount 就得把真清单也装进同一个沙箱。 */
  vm.runInContext(readFileSync(PROVIDERS, "utf8"), sandbox, { filename: PROVIDERS });
  vm.runInContext(readFileSync(CARD, "utf8"), sandbox, { filename: CARD });
  const mod = (sandbox.window.BAI_CARDS || {})["oc-transport"];
  assert.ok(mod, "cards/oc-transport.js 必须登记 window.BAI_CARDS[\"oc-transport\"]");
  return mod;
}
const CARD_MOD = loadCard();

/** 清单里声明的选项（真 providers.js，不抄一份）。 */
function manifestOptions() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(PROVIDERS, "utf8"), sandbox, { filename: PROVIDERS });
  const P = (sandbox.window.BAI_PROVIDERS || {});
  const keys = Object.keys(P).filter((k) => P[k] && P[k].transportSwitch === true);
  assert.equal(keys.length, 1, `目前应当只有一家声明 transportSwitch，实际 ${keys.length} 家：${keys.join("、")}`);
  return { key: keys[0], P: P[keys[0]], others: Object.keys(P).filter((k) => k !== keys[0] && P[k]) };
}

/* 三种探测态的**假数据**：路径长得像 Windows 上真会找到的那种，但显然不是本机的真实安装。 */
const PROBE_FOUND = {
  state: "found",
  path: "C:\\fake-appdata\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
  source: "appdata-npm-package", hint: "", error: "", checkedAt: "2026-10-12T00:00:00.000Z",
};
/** find() 的**真形状**（oc-runtime 返的不是 status 形状，别把两者混用）。 */
const FIND_FOUND = () => ({ ok: true, path: PROBE_FOUND.path, source: PROBE_FOUND.source, tried: [] });
/* missing / error 的 hint 由服务端算（这里取真值，见 ②），不手抄，避免两边漂移。 */
function probeMissing() {
  resetOcBinaryCache();
  return probeOcBinary({ find: () => ({ ok: false, reason: "opencode-not-found", tried: [{ how: "where", path: "<假路径>", skipped: "missing" }] }), force: true });
}
function probeError() {
  resetOcBinaryCache();
  return probeOcBinary({ find: () => { throw new Error("假故障：spawnSync 抛了"); }, force: true });
}
function probeMissingFields() {
  const p = probeMissing();
  return { state: p.state, path: p.path, source: p.source, hint: p.hint, error: p.error, checkedAt: p.checkedAt };
}
function probeErrorFields() {
  const p = probeError();
  return { state: p.state, path: p.path, source: p.source, hint: p.hint, error: p.error, checkedAt: p.checkedAt };
}

function render(probeState, current) {
  const { P } = manifestOptions();
  return CARD_MOD.renderTransportPanel({
    options: P.transportOptions || [],
    current: current || "",
    probe: probeState,
    hint: "下一次请求生效。",
    esc: (s) => String(s == null ? "" : s),
  });
}

/** 只取「检测结果」那一块（选项自带的前置条件文案不算——那是选项说明，
 *  它**本来就该**一直写着；混在一起断言会把「找到了还叫人装一遍」这种
 *  真正的回归放过）。 */
function probeBlock(html) {
  const m = /<div data-role="oc-probe">([\s\S]*?)<\/div>\s*<div class="hint" data-role="oc-effect"/.exec(html);
  assert.ok(m, "渲染结果里必须能单独取到检测结果那一块（data-role=oc-probe）");
  return m[1];
}

/* ================================================================== *
 * ① 出厂值仍然是 direct
 * ================================================================== */
describe("① 出厂值仍然是 direct（面板改动不许翻掉默认值）", () => {
  test("config.defaults.json 的 zen.transport 就是 direct", () => {
    const d = JSON.parse(readFileSync(DEFAULTS_JSON, "utf8"));
    assert.equal(d.zen.transport, "direct",
      "config.defaults.json 的 zen.transport 出厂必须是 direct —— 这次只加控件，一个字都不许改默认行为");
  });

  test("服务端的判据：缺字段 / 乱值 一律报 direct", () => {
    for (const cfg of [
      {}, { zen: {} }, { zen: { transport: null } }, { zen: { transport: "" } },
      { zen: { transport: "OpenCode" } }, { zen: { transport: "直连" } }, { zen: { transport: 1 } },
      { zen: { transport: {} } },
    ]) {
      const f = ocTransportFields(cfg, { find: () => PROBE_FOUND, force: true });
      assert.equal(f.transport, "direct",
        `配置 ${JSON.stringify(cfg)} 必须回落到 direct，实际 ${f.transport}`);
    }
  });

  test("服务端的判据：只有认得的 opencode 才算 opencode", () => {
    assert.equal(ocTransportFields({ zen: { transport: "opencode" } }, { find: FIND_FOUND }).transport, "opencode");
    assert.equal(ocTransportFields({ zen: { transport: "direct" } }, { find: FIND_FOUND }).transport, "direct");
  });

  test("清单声明的选项里第一项就是出厂那一档", () => {
    const { P } = manifestOptions();
    const opts = P.transportOptions || [];
    assert.ok(opts.length >= 2, "至少要有两个选项");
    const d = JSON.parse(readFileSync(DEFAULTS_JSON, "utf8"));
    assert.equal(opts[0].value, d.zen.transport,
      "清单里排第一的选项必须就是出厂值，否则面板第一眼显示的与实际走的不是一条路");
  });
});

/* ================================================================== *
 * ② 服务端探测的三态
 * ================================================================== */
describe("② 服务端探测：找到 / 没装 / 检测出错 是三件事", () => {
  test("找到 → found，带路径", () => {
    resetOcBinaryCache();
    const p = probeOcBinary({ find: () => ({ ok: true, path: "C:\\fake\\opencode.exe", source: "where", tried: [] }), force: true });
    assert.equal(p.state, "found");
    assert.equal(p.path, "C:\\fake\\opencode.exe");
    assert.equal(p.cached, false);
  });

  test("没装 → missing，且给出**可以自己执行**的安装命令并明说不会替你下载", () => {
    const p = probeMissing();
    assert.equal(p.state, "missing");
    assert.match(p.hint, /npm i -g opencode-ai/, "找不到时必须给出可执行的安装命令");
    assert.match(p.hint, /不会替你下载/, "必须明说本产品不会替用户下载（装法因人而异，猜错比不给更糟）");
    assert.equal(p.error, "", "missing 不是错误，不该带 error 字段");
  });

  test("检测出错 → error，**不是** missing，且明说「这不等于没装」", () => {
    const p = probeError();
    assert.equal(p.state, "error", "探测自己抛了必须落成 error，不能落成 missing");
    assert.match(p.error, /假故障/, "必须如实带上出错原因");
    assert.match(p.hint, /不等于「本机没装」/, "必须明说这不等于没装——两者处置完全不同");
  });

  test("探测结果有 TTL 缓存（/api/status 每 5 秒轮询一次，不能每次都同步阻塞）", () => {
    resetOcBinaryCache();
    let calls = 0;
    const find = () => { calls++; return { ok: true, path: "C:\\fake\\opencode.exe", source: "where", tried: [] }; };
    probeOcBinary({ find, now: () => 1000 });
    probeOcBinary({ find, now: () => 1000 + PROBE_TTL_MS - 1 });
    assert.equal(calls, 1, "TTL 内不该重复探测");
    const later = probeOcBinary({ find, now: () => 1000 + PROBE_TTL_MS + 1 });
    assert.equal(calls, 2, "过了 TTL 要重探（用户装完不该要重启服务才看得到）");
    assert.equal(later.cached, false);
  });

  test("status 字段里带着三态所需的全部信息，且不含任何凭据", () => {
    const f = ocTransportFields({ zen: { transport: "opencode" } },
      { find: () => ({ ok: true, path: PROBE_FOUND.path, source: "where", tried: [] }) });
    assert.equal(f.transportProbe.state, "found");
    assert.equal(f.transportProbe.path, PROBE_FOUND.path);
    assert.ok(f.transportProbe.checkedAt, "探测时间要给：用户有权知道这一格是几秒前的结论");
    const s = JSON.stringify(f);
    assert.equal(/oc_sk_|sk-[A-Za-z0-9_-]{16,}/.test(s), false, "status 字段里不许出现任何密钥形状的东西");
  });
});

/* ================================================================== *
 * ③ 前端把三态画成三种不同的东西
 * ================================================================== */
describe("③ 渲染：三种状态三样东西，检测出错 ≠ 没装", () => {
  const htmlFound = () => render(PROBE_FOUND);
  const htmlMissing = () => render(probeMissingFields());
  const htmlError = () => render(probeErrorFields());

  test("找到：绿色语义 + 显示路径，不出现「未安装」也不出现安装命令", () => {
    const b = probeBlock(htmlFound());
    assert.match(b, /已安装/, "找到时要说已安装");
    assert.match(b, /class="v ok"/, "找到要用绿的");
    assert.match(b, /C:\\fake-appdata/, "找到时必须显示路径（用户要能确认找到的是哪个）");
    assert.equal(/未安装/.test(b), false, "找到时不该出现「未安装」");
    assert.equal(/检测失败/.test(b), false, "找到时不该出现「检测失败」");
    assert.equal(/npm i -g/.test(b), false, "★ 找到了还叫人装一遍 = 把一台能用的机器说成不能用");
  });

  test("没装：红色语义 + 可执行命令 + 明说不会替你下载", () => {
    const b = probeBlock(htmlMissing());
    assert.match(b, /未安装/, "没装时要说未安装");
    assert.match(b, /class="v err"/, "没装要用红的");
    assert.match(b, /npm i -g opencode-ai/, "必须显示可执行的安装命令");
    assert.match(b, /不会替你下载/, "必须明说本产品不会替你下载");
    assert.equal(/检测失败/.test(b), false, "没装不是检测失败");
  });

  test("检测出错：黄色语义 + 原因，且**绝不**画成「没装」", () => {
    const b = probeBlock(htmlError());
    assert.match(b, /检测失败/, "探测出错必须说检测失败");
    assert.match(b, /class="v warn"/, "检测出错用黄，不用「没装」那档红");
    assert.match(b, /假故障/, "必须显示出错原因");
    assert.match(b, /不等于「本机没装」/, "必须明说这不等于没装");
    assert.equal(/未安装/.test(b), false,
      "★ 「检测出错」绝不能被渲染成「没装」：两者的处置完全不同（重试 vs 去装东西）");
    assert.equal(/npm i -g opencode-ai/.test(b), false,
      "★ 检测出错时不该叫人去装——他很可能早就装了，叫他重装会弄坏一个能用的机器");
  });

  test("三段 HTML 两两不同（真画出了不同的东西）", () => {
    const a = probeBlock(htmlFound()), b = probeBlock(htmlMissing()), c = probeBlock(htmlError());
    assert.notEqual(a, b, "找到与没装必须画得不一样");
    assert.notEqual(b, c, "没装与检测出错必须画得不一样");
    assert.notEqual(a, c, "找到与检测出错必须画得不一样");
  });

  test("服务端给什么就画什么：没读到探测结果时如实说「尚未读到」，不假装检测过", () => {
    const b = probeBlock(render(null));
    assert.match(b, /尚未读到/, "还没拿到 status 时要说尚未读到");
    assert.equal(/已安装|未安装|检测失败/.test(b), false, "没读到不许三选一地挑一个说");
  });

  test("清单没声明 transportSwitch 的渠道就不画这一格", () => {
    assert.equal(CARD_MOD.shouldShow({}), false);
    assert.equal(CARD_MOD.shouldShow({ transportSwitch: false }), false);
    assert.equal(CARD_MOD.shouldShow({ transportSwitch: "yes" }), false, "只有布尔 true 才算声明");
    assert.equal(CARD_MOD.shouldShow({ transportSwitch: true }), true);
  });

  test("两个选项的前置条件都在选项里写着（打开这一档要什么，一眼能看到）", () => {
    const { P } = manifestOptions();
    for (const op of P.transportOptions) {
      assert.ok(op.label, `选项 ${op.value} 缺 label`);
      assert.ok(op.desc && op.desc.length > 6, `选项 ${op.value} 缺 desc（它意味着什么）`);
      assert.ok(op.need && op.need.length > 6, `选项 ${op.value} 缺 need（它的前置条件）`);
    }
    const direct = P.transportOptions.find((o) => o.value === "direct");
    const viaOc = P.transportOptions.find((o) => o.value === "opencode");
    assert.match(direct.need, /免费档会被拒/, "直连的前置条件必须写清免费档会被拒");
    assert.match(direct.need, /\$10/, "直连的前置条件必须写清 Go 档要订阅");
    assert.match(viaOc.need, /本机必须已装/, "OpenCode 档的前置条件必须写清本机必须已装");
    assert.match(viaOc.need, /npm i -g opencode-ai/, "前置条件要给出可执行的命令");
    assert.match(viaOc.need, /不需要任何订阅/, "要写清免费模型不需要订阅");
    assert.equal(viaOc.requiresProbe, "opencode", "这一档的前置条件要靠探测给出，必须声明出来");
  });
});

/* ================================================================== *
 * ④ 渲染层不得硬编码渠道名
 * ================================================================== */
describe("④ 渲染层源码里没有任何渠道名（C11 纪律）", () => {
  /* 渠道「键」是判定用的短码；渠道「显示名」是给人看的。两者都不许出现在渲染层里：
     一旦出现，加第七家就一定会漏改一处。 */
  const KEYS = ["bai", "sn", "wb", "wbai", "zen", "qd", "or"];
  const NAMES = ["OpenCode Zen", "SenseNova", "WorkBuddy", "OpenRouter", "Qoder", "B.AI", "CC Switch"];
  const word = (k) => new RegExp("(?<![A-Za-z0-9_])" + k + "(?![A-Za-z0-9_])");

  test("新增的渲染文件里既没有渠道键也没有渠道显示名", () => {
    const src = readFileSync(CARD, "utf8");
    const hits = [];
    for (const k of KEYS) {
      const re = word(k); re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        hits.push(`键 "${k}" 在第 ${src.slice(0, m.index).split("\n").length} 行：`
          + src.slice(m.index, m.index + 40).replace(/\n/g, " "));
      }
    }
    for (const n of NAMES) if (src.includes(n)) hits.push(`显示名 "${n}"`);
    assert.deepEqual(hits, [],
      "渲染层出现渠道名 —— 渠道特有的一切必须由 providers.js 声明 + 服务端字段给出：\n    " + hits.join("\n    "));
  });

  test("panel-common.js 没有引入任何新的渠道字面量（沿用 C11 的判定形态）", () => {
    /* 扫描前先剥注释：panel-common.js 顶部的历史事故说明里就写着 `m.mode === "wb"`
     * 这种**举例**，它是文档不是代码。C11 也是这么处理的，两边判据一致。 */
    const src = readFileSync(PANEL, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
    const quoted = KEYS.map((k) => `(?:["']${k}["'])`).join("|");
    const WS = "[ \\t]";
    const eqRe = new RegExp(`(?:===|!==)${WS}*(?:${quoted})|(?:${quoted})${WS}*(?:===|!==)`, "g");
    const idxRe = new RegExp(`\\[\\s*(?:${quoted})\\s*\\]`, "g");
    const hits = [...src.matchAll(eqRe), ...src.matchAll(idxRe)].map((m) => m[0].replace(/\s+/g, " "));
    assert.deepEqual(hits, [], `panel-common.js 出现渠道字面量：${hits.join(" | ")}`);
  });

  test("这次的面板改动没有把传输开关写进共享渲染层（它由清单声明驱动）", () => {
    /* 共享层一行没改：开关画不画、画成什么样，全部由 providers.js 的声明 +
     * 服务端字段决定。加这一条是为了挡住「顺手在 panel-common.js 里加一个 if」。 */
    assert.equal(/transportSwitch/.test(readFileSync(PANEL, "utf8")), false,
      "panel-common.js 不该知道传输开关这件事（它认识的是 tierBadge / capabilityProbe 那套声明）");
    assert.match(readFileSync(PROVIDERS, "utf8"), /transportSwitch: true/,
      "声明必须在 providers.js 里");
    assert.match(readFileSync(PROVIDERS, "utf8"), /"oc-transport"/,
      "卡必须被某个视图引用（C6 是双向对账的）");
  });
});

/* ================================================================== *
 * ⑤ 切换载荷 + 服务端拒收时前端有提示
 * ================================================================== */
describe("⑤ 切换请求：载荷正确，被拒时有提示", () => {
  test("载荷只有 provider 与 transport 两个字段（服务端是白名单收字段，多余的会被静默丢掉）", () => {
    const body = CARD_MOD.transportPayload("someKey", "opencode");
    assert.deepEqual(Object.keys(body).sort(), ["provider", "transport"]);
    assert.equal(body.provider, "someKey");
    assert.equal(body.transport, "opencode");
    assert.deepEqual(CARD_MOD.transportPayload("k", null).transport, "", "空值要归一成空串，不能塞 undefined 进 JSON");
  });

  test("服务端拒收时（400），前端按失败渲染并转述它的理由", async () => {
    /* 拿**服务端真实的 400 报文**当被测输入：前端拿到什么就显示什么，不是自己编一句。 */
    const serverMsg = "传输方式只能是 direct 或 opencode（收到 \"OpenCode\"）";
    const seen = [];
    const r = await CARD_MOD.applyTransport({
      post: async () => { const e = new Error(serverMsg); e.status = 400; throw e; },
      onResult: (good, text) => seen.push({ good, text }),
    }, { provider: "k", value: "OpenCode", label: "OpenCode 客户端中转" });

    assert.equal(r.ok, false, "服务端拒了就是没保存成功");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].good, false, "★ 必须按失败渲染——静默成功提示会让用户以为已经切过去了");
    assert.match(seen[0].text, /没保存成功/, "要明说没保存成功");
    assert.ok(seen[0].text.includes(serverMsg), `必须转述服务端的理由（前端最清楚的就是它那句），实际：${seen[0].text}`);
  });

  test("成功时给出「已保存 + 何时生效」，且通知调用方重画（把单选钮拨回服务端说的那一档）", async () => {
    const seen = [];
    let settled = 0;
    const r = await CARD_MOD.applyTransport({
      post: async (path, body) => {
        assert.equal(path, "/api/config");
        /* ⚠ 不能用 assert.deepEqual 比对象：这个对象是在 vm 沙箱里造的，
         * 它的原型不是宿主的 Object.prototype，deepStrictEqual 会因为
         * 「结构相同但原型不同」直接判不等 —— 那不是这里要测的东西。
         * 比键值对既避开了跨 realm 原型，又顺手证明了「只有这两个字段」。 */
        assert.deepEqual(Object.entries(body).sort(), [["provider", "k"], ["transport", "opencode"]]);
      },
      onResult: (good, text) => seen.push({ good, text }),
      onSettled: () => { settled++; },
    }, { provider: "k", value: "opencode", label: "OpenCode 客户端中转", hint: "下一次请求生效。" });

    assert.equal(r.ok, true);
    assert.equal(seen[0].good, true);
    assert.match(seen[0].text, /已保存/, "成功要说已保存");
    assert.match(seen[0].text, /下一次请求生效/, "★ 成功也要说何时生效，不许静默切换");
    assert.equal(settled, 1, "成败都要回调一次：失败时要按服务端说的那一档把界面拨回去");
  });

  test("网络异常也走失败分支（不能当成成功）", async () => {
    const seen = [];
    const r = await CARD_MOD.applyTransport({
      post: async () => { throw new Error("读取超时（超过 12 秒）"); },
      onResult: (good, text) => seen.push({ good, text }),
    }, { provider: "k", value: "opencode" });
    assert.equal(r.ok, false);
    assert.equal(seen[0].good, false);
    assert.match(seen[0].text, /读取超时/);
  });
});

/* ================================================================== *
 * ⑥ 切换后的「何时生效」
 * ================================================================== */
describe("⑥ 切换之后要说明何时生效，不许静默切换", () => {
  test("两个档位都给出「下一次请求生效 / 不需要重启」", () => {
    for (const t of ["direct", "opencode"]) {
      const f = ocTransportFields({ zen: { transport: t } }, { find: FIND_FOUND });
      assert.match(f.transportHint, /下一次/, `${t} 档的说明里必须有「下一次」`);
      assert.match(f.transportHint, /不需要重启/, `${t} 档的说明里必须说清要不要重启`);
    }
  });

  test("opencode 档额外说清：切回去不会立刻关掉已经起着的进程", () => {
    const f = ocTransportFields({ zen: { transport: "opencode" } }, { find: FIND_FOUND });
    assert.match(f.transportHint, /切回/, "要说清切回去会发生什么");
    assert.match(f.transportHint, /空闲/, "要如实说回收条件，不许让用户以为切回去就立刻收掉了");
  });

  test("这段说明被画在面板上（不是只存在服务端字段里）", () => {
    const { P } = manifestOptions();
    const f = ocTransportFields({ zen: { transport: "opencode" } }, { find: FIND_FOUND });
    const h = CARD_MOD.renderTransportPanel({
      options: P.transportOptions, current: "opencode", probe: PROBE_FOUND, hint: f.transportHint,
      esc: (s) => String(s == null ? "" : s),
    });
    assert.match(h, /data-role="oc-effect"/, "生效说明要有稳定落点（测试与将来的改动都指着它）");
    assert.match(h, /下一次/, "生效说明要真的画出来");
  });

  test("当前档位由服务端字段给出，并高亮在选项上", () => {
    const { P } = manifestOptions();
    const h = CARD_MOD.renderTransportPanel({
      options: P.transportOptions, current: "opencode", probe: PROBE_FOUND, hint: "h",
      esc: (s) => String(s == null ? "" : s),
    });
    const marked = [...h.matchAll(/value="([^"]+)"([^>]*)>/g)].filter((m) => /checked/.test(m[2]));
    assert.equal(marked.length, 1, `必须恰好选中一项，实际 ${marked.length} 项`);
    assert.equal(marked[0][1], "opencode");
  });
});

/* ================================================================== *
 * ⑧ 挂载不炸：mount() 里任何一处抛异常都会让**整个控制台视图白屏**
 *    （卡片与共享层在同一条渲染链上）。纯函数测不到这一层，所以用最小 DOM
 *    替身把 mount() 真跑一遍：落点对不对、只在声明的渠道上显示、换渠道会不会收起来。
 * ================================================================== */
describe("⑧ 挂载：落点正确，只在清单声明的渠道上显示", () => {
  /** 最小 DOM：只实现这张卡真正用到的那几个方法，别把替身写成半个浏览器。 */
  function domStub() {
    const byId = {};
    const mk = () => {
      const el = {
        children: [], _html: "", className: "", style: {}, parentNode: null,
        listeners: [], _qs: {}, _qsa: {}, textContent: "",
        get id() { return this._id || ""; },
        set id(v) { this._id = v; byId[v] = el; },
        get nextSibling() {
          if (!this.parentNode) return null;
          const i = this.parentNode.children.indexOf(el);
          return this.parentNode.children[i + 1] || null;
        },
        set innerHTML(v) {
          this._html = String(v);
          /* 真 DOM 里 innerHTML 一换，旧节点连同它们身上的 text 一起没了。
           * 替身必须照做，否则「重画把提示抹掉」这个回归在这套替身上测不出来
           * （节点被缓存复用 → 抹不掉 → 假绿）。 */
          this._qs = {};
          this._qsa = {};
        },
        get innerHTML() { return this._html; },
        appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
        insertBefore(c, ref) {
          c.parentNode = el;
          const i = ref ? el.children.indexOf(ref) : -1;
          if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
          return c;
        },
        addEventListener(t, fn) { el.listeners.push([t, fn]); },
        _count(sel) {
          const m = /^\[data-role="([^"]+)"\]$/.exec(sel);
          return m ? (el._html.match(new RegExp(`data-role="${m[1]}"`, "g")) || []).length : 0;
        },
        querySelectorAll(sel) {
          const n = el._count(sel);
          if (!el._qsa[sel]) {
            /* 同一个选择器返回**同一批**节点（真 DOM 就是这样），且按出现顺序带上 value。 */
            const vals = [...el._html.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
            el._qsa[sel] = [];
            for (let i = 0; i < n; i++) { const k = mk(); k.value = vals[i]; el._qsa[sel].push(k); }
          }
          return el._qsa[sel];
        },
        querySelector(sel) {
          if (!(sel in el._qs)) el._qs[sel] = el._count(sel) ? mk() : null;
          return el._qs[sel];
        },
      };
      return el;
    };
    const document = { createElement: () => mk(), getElementById: (id) => byId[id] || null, body: mk() };
    /* provider.html 里的真实落点：#mapPanel 在 #viewConsole 里 */
    const viewConsole = mk(); viewConsole.id = "viewConsole";
    const mapPanel = mk(); mapPanel.id = "mapPanel"; mapPanel.parentNode = viewConsole;
    viewConsole.children.push(mapPanel);
    return { document, byId, viewConsole, mapPanel };
  }

  const { key, others } = manifestOptions();
  const status = {
    [key]: {
      transport: "opencode", transportHint: "下一次请求生效。",
      transportProbe: { state: "found", path: "C:\\fake\\opencode.exe", source: "where" },
    },
  };
  const seen = [];
  const ctx = {
    $: (id) => domStubDoc.getElementById(id),
    esc: (s) => String(s == null ? "" : s),
    channel: key,
    stOf: (k) => status[k] || {},
    postJSON: async (path, body) => { seen.push({ post: path, body }); return { ok: true }; },
    /* 照共享层 showResult 的真实行为写节点（textContent + className），
     * 只记不算的话「重画把提示抹掉」这条回归在替身上就测不出来。 */
    showResult: (el, text, good) => {
      seen.push({ text, good });
      if (el) { el.textContent = text; el.className = "result show " + (good ? "good" : "bad"); }
    },
    poll: async () => {},
  };
  let domStubDoc;

  test("落点是映射编辑卡之下，且只对声明了 transportSwitch 的渠道显示", () => {
    const stub = domStub();
    domStubDoc = stub.document;
    const api = loadCard(stub.document).mount(ctx);
    const panel = stub.byId["oc-transport"];
    assert.ok(panel, "卡片必须自己落进页面");
    assert.equal(panel.parentNode, stub.viewConsole, "落点应当在视图容器里");
    assert.equal(panel.style.display, "", "清单声明了的渠道上必须显示");

    const other = others[0];   // 清单里另一个没声明这一项的渠道
    ctx.channel = other;
    api.refresh();
    assert.equal(panel.style.display, "none", "没声明的渠道上必须收起来（不能给别家也画一个开关）");

    ctx.channel = key;
    api.update();
    assert.equal(panel.style.display, "", "切回来必须重新显示");
    ctx.channel = key;
  });

  test("点一下切换：先发请求、发完写提示，紧跟着的那次重画不许把提示抹掉", async () => {
    const stub = domStub();
    domStubDoc = stub.document;
    const api = loadCard(stub.document).mount(ctx);
    const panel = stub.byId["oc-transport"];
    const bodyEl = panel.children[0];

    const radios = bodyEl.querySelectorAll('[data-role="oc-transport-opt"]');
    const target = radios.find((r) => r.value === "direct");
    assert.ok(target, "要能取到另一个档位的那个单选钮");
    const fire = target.listeners.find(([t]) => t === "change");
    assert.ok(fire, "单选钮必须接上监听器（否则点了什么都不会发生）");
    await fire[1]();                                  // 用户点了一下
    await new Promise((r) => setTimeout(r, 0));      // 让 postJSON / onSettled 走完

    const posted = seen.find((x) => x.post);
    assert.ok(posted, "必须真的发出切换请求");
    assert.equal(posted.post, "/api/config");
    assert.deepEqual(Object.entries(posted.body).sort(), [["provider", key], ["transport", "direct"]]);

    const said = seen.filter((x) => x.text).map((x) => x.text);
    assert.ok(said.some((t) => /已保存/.test(t)), `成功要有提示，实际：${JSON.stringify(said)}`);
    assert.ok(said.some((t) => /下一次/.test(t)), `提示里要有「何时生效」，实际：${JSON.stringify(said)}`);

    /* ★ 关键断言：轮询回来的那次重画会整块换掉 innerHTML。
     * 「下一次请求生效」那句要是活不过这一次重画，用户看到的就是静默切换。 */
    status[key].transport = "direct";
    api.update();
    const slot = bodyEl.querySelector('[data-role="oc-transport-result"]');
    assert.match(String(slot.textContent || ""), /已保存/,
      "重画之后「已保存 + 何时生效」这句话必须还在（否则等于静默切换）");
  });

  test("画出来的是两个可选项 + 当前档位 + 检测结果", () => {
    const stub = domStub();
    domStubDoc = stub.document;
    status[key].transport = "opencode";   // 上一条用例会把它改成 direct
    loadCard(stub.document).mount(ctx);
    const html = stub.byId["oc-transport"].children[0].innerHTML;
    assert.equal((html.match(/oc-transport-opt/g) || []).length, 2, "两个选项都要画出来");
    assert.match(html, /value="opencode" checked/, "当前档位要选中");
    assert.match(html, /已安装/, "检测结果要画出来");
    assert.match(html, /data-role="oc-effect"/, "生效说明要画出来");
  });
});

/* ================================================================== *
 * ⑦ 端到端：真 server.mjs，隔离端口 + 临时 BAI_DATA_DIR
 * ================================================================== */
async function freePorts(n) {
  const servers = [], ports = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    ports.push(s.address().port);
    servers.push(s);
  }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}
function live(port) {
  return new Promise((r) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); r(true); });
    s.on("error", () => r(false));
    setTimeout(() => { try { s.destroy(); } catch { } r(false); }, 1500);
  });
}

/** 真 server.mjs 起一份。端口动态挑空闲（17xxx 段），数据目录是临时目录。 */
async function bootServer() {
  const ports = await freePorts(8);
  const P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7] };
  const dataDir = mkdtempSync(path.join(TMPROOT, "boot-"));

  const cfg = JSON.parse(readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover.enabled = false;
  /* ① 预置成一个必定命中探测的值 → applyProxy 首行短路，**不自重启**；
   * ② 同时把代理环境变量从子进程环境里摘掉。两件事缺一不可（见 oc-wiring-test 的同款注释）。 */
  cfg.proxy = "http://127.0.0.1:7897";
  cfg.relayPort = P.bai; cfg.panelPort = P.panel;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "or"]) cfg[k] = { ...cfg[k], relayPort: P[k] };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

  const out = [];
  const env = { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1" };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));

  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) { up = true; break; } }
    catch { }
    await sleep(300);
  }
  if (!up) {
    try { child.kill(); } catch { }
    throw new Error(`server.mjs 40 秒内没把面板端口起起来。\nstdout 尾：${out.join("").slice(-1200)}`);
  }
  return {
    P, dataDir, out,
    get: (p) => fetch(`http://127.0.0.1:${P.panel}${p}`).then((r) => r.json()),
    post: (p, body) => fetch(`http://127.0.0.1:${P.panel}${p}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
    kill: () => {
      try { spawnSync("taskkill", ["/PID", String(child.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { }
    },
  };
}

describe("⑦ 端到端：真 server.mjs（临时数据目录 + 隔离端口）", () => {
  let srv;
  before(async () => { srv = await bootServer(); }, { timeout: 90000 });
  after(() => { try { srv && srv.kill(); } catch { } });

  test("新起的实例默认就是 direct（出厂值没被这次改动翻掉）", async () => {
    const st = await srv.get("/api/status");
    assert.equal(st.zen.transport, "direct");
    const cfg = await srv.get("/api/config");
    assert.equal(cfg.zen.transport, "direct");
  });

  test("/api/status 带着面板画这个开关所需的全部字段", async () => {
    const st = await srv.get("/api/status");
    const t = st.zen;
    assert.ok(t, "status 里要有这一档的块");
    assert.equal(typeof t.transport, "string");
    assert.deepEqual(t.transportValues, ["direct", "opencode"], "可选取值集合要由服务端给出");
    assert.ok(t.transportHint && /下一次/.test(t.transportHint), "生效说明要在");
    assert.ok(t.transportProbe, "探测结果要在");
    assert.ok(["found", "missing", "error"].includes(t.transportProbe.state),
      `探测状态必须是三态之一，实际 ${t.transportProbe.state}`);
    if (t.transportProbe.state === "found") assert.ok(t.transportProbe.path, "找到时必须有路径");
    if (t.transportProbe.state === "missing") assert.match(t.transportProbe.hint, /npm i -g opencode-ai/, "没装时必须有可执行命令");
    if (t.transportProbe.state === "error") assert.match(t.transportProbe.hint, /不等于「本机没装」/, "检测出错必须明说它不等于没装");
    assert.ok(t.transportProbe.checkedAt, "探测时间要给");
    assert.equal(/oc_sk_|sk-[A-Za-z0-9_-]{16,}/.test(JSON.stringify(t)), false, "status 里不许出现密钥形状");
  });

  test("切换请求：载荷被收下并落盘，status 立刻跟上", async () => {
    const before = await srv.get("/api/config");
    assert.equal(before.zen.transport, "direct");
    const r = await srv.post("/api/config", { provider: "zen", transport: "opencode" });
    assert.notEqual(r.status, 400, `切换不该被拒：${JSON.stringify(r.body)}`);
    const cfg = await srv.get("/api/config");
    assert.equal(cfg.zen.transport, "opencode", "切换必须真的落盘");
    const st = await srv.get("/api/status");
    assert.equal(st.zen.transport, "opencode", "status 要立刻跟上（每个请求实时读配置）");
    /* 切回出厂值：这一档之外的用例都应当在 direct 上跑。 */
    await srv.post("/api/config", { provider: "zen", transport: "direct" });
    assert.equal((await srv.get("/api/config")).zen.transport, "direct");
  });

  test("非法取值被服务端拒掉（400），且**没**落盘", async () => {
    const r = await srv.post("/api/config", { provider: "zen", transport: "OpenCode" });
    assert.equal(r.status, 400, `非法取值必须被拒，实际 ${r.status}：${JSON.stringify(r.body)}`);
    assert.match(JSON.stringify(r.body), /传输方式/, "错误信息要说清只能取哪两个值");
    assert.equal((await srv.get("/api/config")).zen.transport, "direct", "被拒之后配置不许被留在坏状态上");
  });

  test("卡片与样式真的被服务端端出去（取不到 = 面板上这一格静默不画）", async () => {
    /* /cards/<name>.js 是按名字白名单取的：文件名拼错、大小写不对、忘了打包，
     * 面板上都不会报错，只是那一格**什么都不画**。所以必须从真服务上取一次。 */
    const r = await fetch(`http://127.0.0.1:${srv.P.panel}/cards/oc-transport.js`);
    assert.equal(r.status, 200, `卡片取不到（${r.status}）——面板上这一格会静默不画`);
    const src = await r.text();
    assert.match(src, /BAI_CARDS\["oc-transport"\]/, "端出去的必须是这张卡");
    assert.equal(src.trim().length > 0, true);
    const css = await fetch(`http://127.0.0.1:${srv.P.panel}/panel-common.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /\.ocopt/, "卡用的样式类必须在样式表里，否则画出来是裸的");
  });

  test("面板的渲染产物确实由清单驱动（清单里删掉声明 → 这一格就不再画）", () => {
    /* 不真去改文件：直接把「清单条目去掉声明」这件事在内存里演一遍。 */
    const { P } = manifestOptions();
    assert.equal(CARD_MOD.shouldShow({ ...P, transportSwitch: true }), true);
    const stripped = { ...P }; delete stripped.transportSwitch;
    assert.equal(CARD_MOD.shouldShow(stripped), false, "清单不声明就不画——渲染层不能自己决定要不要画");
  });
});

/* ================================================================== *
 * 反向对照的「把手册」：--list-sabotage / --sabotage
 * ================================================================== */
const SABOTAGE = [
  {
    name: "factory-default-opencode", where: "config.defaults.json · zen.transport",
    from: `"transport": "direct"`, to: `"transport": "opencode"`,
    reds: "① 出厂值 / 清单第一项必须是出厂值 / ⑦ 新实例默认 direct",
  },
  {
    name: "probe-error-as-missing", where: "oc-transport-info.mjs · 探测抛错的分支",
    from: `      state: "error", path: "", source: null,`,
    to: `      state: "missing", path: "", source: null,`,
    reds: "② error 态 / ③ error 不得画成「未安装」· 不得叫人去装",
  },
  {
    name: "probe-missing-as-error", where: "oc-transport-info.mjs · 没找到的分支",
    from: `        state: "missing", path: "", source: null,`,
    to: `        state: "error", path: "", source: null,`,
    reds: "② missing 态 / ③ 没装要画成红色并给出安装命令",
  },
  {
    name: "no-install-hint", where: "oc-transport-info.mjs · 没找到时的话",
    from: `        hint: ocInstallHint(tried),`,
    to: `        hint: "",`,
    reds: "② missing 必须给可执行命令 / ③ 没装那一条 / ⑦ status 里的 hint",
  },
  {
    name: "status-always-direct", where: "oc-transport-info.mjs · 读的档位",
    from: `  const transport = raw === ZEN_TRANSPORT_OPENCODE ? ZEN_TRANSPORT_OPENCODE : ZEN_TRANSPORT_DIRECT;`,
    to: `  const transport = ZEN_TRANSPORT_DIRECT;`,
    reds: "② 认得的 opencode 才算 opencode / ⑦ 切换后 status 要跟上",
  },
  {
    name: "no-effect-hint", where: "oc-transport-info.mjs · 生效说明",
    from: `      + "不需要重启中转，也不需要重启本程序。"`,
    to: `      + "重启一下就好。"`,
    reds: "⑥ 「下一次请求生效 / 不需要重启」/ 生效说明要被真的画出来",
  },
  {
    name: "card-err-as-missing", where: "cards/oc-transport.js · 检测出错那一段",
    from: `      probeLine = \`<div class="fpline"><span class="k">本机检测</span><span class="v warn">检测失败</span></div>\``,
    to: `      probeLine = \`<div class="fpline"><span class="k">本机检测</span><span class="v err">未安装</span></div>\``,
    reds: "③ ★「检测出错」不得被渲染成「没装」",
  },
  {
    name: "swallow-server-reject", where: "cards/oc-transport.js · 切换失败分支",
    from: `      if (deps.onResult) deps.onResult(false, msg);`,
    to: `      if (deps.onResult) deps.onResult(true, "已保存");`,
    reds: "⑤ 服务端拒收时必须按失败渲染并转述理由",
  },
  {
    name: "payload-extra-field", where: "cards/oc-transport.js · 切换载荷",
    from: `    return { provider: provider, transport: String(value == null ? "" : value) };`,
    to: `    return { provider: provider, transport: String(value == null ? "" : value), forced: true };`,
    reds: "⑤ 载荷只能有 provider 与 transport 两个字段（服务端是白名单）",
  },
  {
    name: "repaint-wipes-result", where: "cards/oc-transport.js · 重画时保留上一条结果",
    from: `      if (prevText && ctx.showResult) ctx.showResult(resultSlot(), prevText, prevGood);`,
    to: `      /* sabotage: 重画不保留上一条结果 */`,
    reds: "⑧ 切换后的「已保存 + 何时生效」不许被下一次重画抹掉（抹掉就等于静默切换）",
  },
];

if (process.argv.includes("--list-sabotage")) {
  console.log(`oc-ui 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(24)} ${s.where}\n  ${"".padEnd(24)} → 会打红: ${s.reds}`);
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  const name = process.argv[process.argv.indexOf("--sabotage") + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}`); process.exit(2); }
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}