/**
 * 发版代理决策测试 —— `gh release create` 上传 111MB 安装包时不走 HTTP 代理（v1.0.78）
 *
 * ## 背景
 *
 * 2026-10-12 实测两次：经本机 Clash 的 HTTP 代理传安装包会**卡死**（挂 20+ 分钟，
 * CPU 只用 0.56 秒＝纯等待，不是在传），最后失败；去掉代理变量则 90~130 秒完成。
 * 本机开着 Clash TUN，所以去代理后直连照样通（`curl --noproxy '*'` 返 200）。
 *
 * 但**不能无条件清**——没有 TUN、只能靠代理出网的机器，清掉就直接发不出去。
 * 规矩是「先探再决定」，这个测试锁的就是那个决定。
 *
 * ## 测什么
 *
 * `scripts/publish-proxy.cjs` 里的纯函数 `decideProxyUse(env, probeDirect)`：
 * 输入=env + 注入的探测器，输出={useProxy, reason}。
 *
 *   ① 无代理变量      → useProxy=false，且**探测器一次都不许被调用**（省一次网络往返）
 *   ② 有代理+直连通   → useProxy=false（清掉代理走直连）
 *   ③ 有代理+直连不通 → useProxy=true  ★ 反向对照就盯这一格
 *   ④ 探测失败(抛异常) → useProxy=true
 *   ⑤ 四种 reason **逐字不同**，且每条都说清了「为什么」
 *   ⑥ gh 的 env 确实摘干净了 6 个变量（含 Windows 的 ALL_PROXY / all_proxy）
 *   ⑦ ★★ run()（electron-builder 构建阶段）的 env **一个变量都没被改**
 *   ⑧ 探测子进程必须摘掉 NODE_USE_ENV_PROXY（Node 24 会真读 *_PROXY）
 *
 * ## 反向对照：必须真红
 *
 * 把 `scripts/publish-proxy.cjs` 复制到临时目录，把反向对照锚点那一行
 * （`const directOk = v.ok === true;`）改成 `= true` —— 即「无条件清代理」——
 * 再把**同一套四格断言**跑在这个坏副本上：**③ 必须红**（它变成了「直连不通也照样清代理」，
 * 那正是没有 TUN 的机器上会让发布彻底发不出去的那个 bug），④ 也必须红。
 *
 * 打法是打到**临时副本**上，不碰工作区里的真文件：共享工作区不做原地改写，
 * 不 git stash，也不用担心别人在我跑的时候读到半个文件。
 *
 * 🔴 红线：全文没有一个真实令牌/API key/代理地址。夹具里的代理值是明显假的
 *    占位串（`http://127.0.0.1:1/never-a-real-proxy`），只活在内存里，不落任何文件，
 *    也不进命令行参数。产物目录用 os.tmpdir() 下的 mkdtemp。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PROXY_SRC = path.join(HERE, "publish-proxy.cjs");
const PUBLISH_SRC = path.join(HERE, "publish.cjs");

// .cjs 用 require 拿（默认导入最保险，不依赖 cjs 具名导出探测）
const require_ = createRequire(import.meta.url);
const PP = require_(PROXY_SRC);
const { PROXY_ENV_KEYS, PROBE_EXTRA_STRIP_KEYS, decideProxyUse, buildGhEnv, stripProbeEnv, foundProxyKeys } = PP;

/** 假代理值：明显是假的，只在内存里待着。 */
const FAKE = "http://127.0.0.1:1/never-a-real-proxy";

/** 假探测器：按场景返回一个约定的 verdict，并记录被调用了几次。 */
function fakeProbe(result) {
  const c = { calls: 0 };
  c.fn = () => { c.calls++; return typeof result === "function" ? result() : result; };
  return c;
}

const ENV_WITH = (extra) => ({ PATH: "/usr/bin", HTTPS_PROXY: FAKE, ...extra });

/* 四种情形各自期望的结论。断言与反向对照共用这张表——坏实现跑同一张表才说明「真的判错」。 */
const CASES = [
  {
    name: "无代理变量",
    env: { PATH: "/usr/bin" },
    probe: { ok: true, why: "不该被调用" },   // 探测器要是被调用了，这一格自己就红了
    wantUseProxy: false,
    wantReasonHas: ["没有代理变量", "原样"],
    noProbeCall: true,
  },
  {
    name: "有代理 + 直连通",
    env: ENV_WITH(),
    probe: { ok: true, why: "HEAD https://api.github.com/ 返回 200" },
    wantUseProxy: false,
    wantReasonHas: ["检测到代理变量", "直连可用", "清掉", "卡死"],
  },
  {
    name: "有代理 + 直连不通",
    env: ENV_WITH({ ALL_PROXY: FAKE }),
    probe: { ok: false, why: "连 api.github.com 失败（ECONNREFUSED 127.0.0.1:1）" },
    wantUseProxy: true,                     // ★ 反向对照盯的就是这一格
    wantReasonHas: ["检测到代理变量", "连不上 GitHub", "保留", "发不出去"],
  },
  {
    name: "探测失败",
    env: ENV_WITH({ all_proxy: FAKE }),
    probe: new Error("探测进程起不来（ENOENT）"),
    wantUseProxy: true,
    wantReasonHas: ["检测到代理变量", "没跑出结论", "保留", "发不出去"],
  },
];

/** 把某一格跑一遍并断言。decide 可注入 → 反向对照把坏实现塞进来。 */
function assertCase(decide, c) {
  const probe = fakeProbe(c.probe instanceof Error ? (() => { throw c.probe; }) : c.probe);
  const got = decide(c.env, probe.fn);
  assert.equal(got.useProxy, c.wantUseProxy, `${c.name}：useProxy 应为 ${c.wantUseProxy}，实为 ${got.useProxy}\n理由：${got.reason}`);
  for (const frag of c.wantReasonHas) {
    assert.ok(got.reason.includes(frag), `${c.name}：理由里应说明「${frag}」，实得：\n${got.reason}`);
  }
  if (c.noProbeCall) assert.equal(probe.calls, 0, `${c.name}：没有代理变量就不该探测（白花一次网络往返）`);
  else assert.equal(probe.calls, 1, `${c.name}：应当且只应当探测一次`);
  return got;
}

describe("发版代理决策（scripts/publish-proxy.cjs）", () => {
  test("四种情形：useProxy 判定与 reason 文案都符合预期", () => {
    const reasons = [];
    for (const c of CASES) {
      const got = assertCase(decideProxyUse, c);
      reasons.push(got.reason);
      console.log(`  ${c.name.padEnd(18)} useProxy=${String(got.useProxy).padEnd(5)} probe=${got.probe.padEnd(7)} ${got.reason.slice(0, 60)}…`);
    }
    // 四条文案必须逐字不同：措辞一样 = 用户分不清「为什么这次没清」
    assert.equal(new Set(reasons).size, 4, `四种情形的 reason 应互不相同，实得 ${new Set(reasons).size} 种`);
  });

  test("反过来说：理由文案不能空、不能只是「是/否」这种没信息量的", () => {
    for (const c of CASES) {
      const got = assertCase(decideProxyUse, c);
      assert.ok(got.reason.length >= 20, `${c.name}：理由太短，等于没说：${got.reason}`);
    }
  });

  test("代理变量存在但为空串 → 视同没有代理（不算「有代理」）", () => {
    const env = { PATH: "/usr/bin", HTTPS_PROXY: "   ", HTTP_PROXY: "" };
    const probe = fakeProbe({ ok: true, why: "不该被调用" });
    const got = decideProxyUse(env, probe.fn);
    assert.equal(got.useProxy, false);
    assert.equal(probe.calls, 0, "空串不是代理，不该触发探测");
    assert.equal(got.found.length, 0);
  });

  test("gh 用的 env：清的那份摘干净 6 个变量，其余原样；保留的那份一个不少", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/x", HTTPS_PROXY: FAKE, http_proxy: FAKE, ALL_PROXY: FAKE, CUSTOM: "keep-me" };
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"]) env[k] = FAKE;

    const d = decideProxyUse(env, fakeProbe({ ok: true, why: "ok" }).fn);
    const ghEnv = buildGhEnv(env, d);
    for (const k of PROXY_ENV_KEYS) assert.ok(!(k in ghEnv), `清代理后 gh env 里不该还有 ${k}`);
    assert.equal(ghEnv.PATH, "/usr/bin");
    assert.equal(ghEnv.CUSTOM, "keep-me", "非代理变量必须原样带过去");
    // ★ 源 env 一个字节都不能被改（run() 还要用它跑 electron-builder）
    for (const k of PROXY_ENV_KEYS) assert.equal(env[k], FAKE, `buildGhEnv 改了源 env 的 ${k}`);

    const d2 = decideProxyUse(env, fakeProbe({ ok: false, why: "no" }).fn);
    const ghEnv2 = buildGhEnv(env, d2);
    for (const k of PROXY_ENV_KEYS) assert.ok(k in ghEnv2, `保留代理时 gh env 里必须有 ${k}`);
  });

  test("PROXY_ENV_KEYS 覆盖 Windows 的 ALL_PROXY / all_proxy（只清 http/https 那四个不够）", () => {
    assert.deepEqual([...PROXY_ENV_KEYS].sort(), [
      "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "http_proxy", "https_proxy",
    ].sort());
  });
});

describe("探测子进程：量的是「直连」，不是「代理那条路」", () => {
  test("stripProbeEnv 必须连 NODE_USE_ENV_PROXY 一起摘", () => {
    // Node 24 起 NODE_USE_ENV_PROXY=1 会让核心 https 真读 *_PROXY。
    // 不摘这一把，探测器量到的是代理那条路 —— 判定整个反着来（2026-10-13 实测）。
    assert.ok(PROBE_EXTRA_STRIP_KEYS.includes("NODE_USE_ENV_PROXY"),
      "探测子进程必须摘掉 NODE_USE_ENV_PROXY，否则量的不是直连");
    const out = stripProbeEnv({ PATH: "/x", NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: FAKE, KEEP: "1" });
    assert.equal("NODE_USE_ENV_PROXY" in out, false);
    assert.equal("HTTPS_PROXY" in out, false);
    assert.equal(out.KEEP, "1");
    for (const k of PROXY_ENV_KEYS) assert.equal(k in out, false, `探测 env 里不该有 ${k}`);
  });

  test("--probe-direct 真跑一次：不带代理能连通 GitHub（本机有 Clash TUN）", () => {
    const r = spawnSync(process.execPath, [PROXY_SRC, "--probe-direct"], {
      encoding: "utf8", timeout: 15000,
      env: (() => { const e = { ...process.env }; for (const k of PROXY_ENV_KEYS) delete e[k]; delete e.NODE_USE_ENV_PROXY; return e; })(),
    });
    console.log(`  探测输出：${(r.stdout || r.stderr || "").trim()}`);
    assert.equal(r.status, 0, `本机去掉代理后应当直连得通，实际：${(r.stdout || r.stderr || "").trim()}`);
  });

  test("runDirectProbe 返回 ok（集成：注入不进去的那一层也得真的通）", () => {
    const v = PP.runDirectProbe();
    console.log(`  runDirectProbe → ok=${v.ok} ${v.why}`);
    assert.equal(v.ok, true, `真探测器在本机应判为直连可用，实得：${JSON.stringify(v)}`);
  });
});

describe("★ 只清发版那一步：构建阶段的 env 没被动过", () => {
  test("run()（electron-builder）仍然用 process.env，且完全不认识 ghEnv/代理键", () => {
    const src = readFileSync(PUBLISH_SRC, "utf8");
    const m = src.match(/const run = \(cmd\) => \{[\s\S]*?\};/);
    assert.ok(m, "找不到 run() 的定义——publish.cjs 结构变了，先看这里");
    const body = m[0];
    assert.ok(body.includes("...process.env"), "run() 必须仍以 process.env 为底");
    assert.ok(body.includes("ELECTRON_BUILDER_BINARIES_MIRROR"), "run() 必须仍设二进制镜像（构建可能要靠代理拉）");
    assert.ok(!/PROXY|ghEnv|proxyDecision/.test(body),
      `run() 里不该出现代理/ghEnv（构建阶段必须原样带代理）：\n${body}`);
  });

  test("整个 publish.cjs 从不写 process.env（只造新对象）", () => {
    const src = readFileSync(PUBLISH_SRC, "utf8");
    assert.ok(!/process\.env\.[A-Za-z_0-9]+\s*=(?!=)/.test(src), "publish.cjs 不该给 process.env 的属性赋值");
    assert.ok(!/delete\s+process\.env/.test(src), "publish.cjs 不该 delete process.env");
  });

  test("运行期证明：buildGhEnv 前后 process.env 逐字不变", () => {
    // 真起一个子进程改自己的 process.env 再调用被测函数，比读源码更有说服力。
    const harness = `
      const PP = require(${JSON.stringify(PROXY_SRC)});
      const before = JSON.stringify(process.env);
      process.env.HTTPS_PROXY = ${JSON.stringify(FAKE)};
      process.env.ALL_PROXY = ${JSON.stringify(FAKE)};
      const snap = JSON.stringify(process.env);
      const d = PP.decideProxyUse(process.env, () => ({ ok: true, why: "fake" }));
      const ghEnv = PP.buildGhEnv(process.env, d);
      // 模拟 run() 用的 env：直接以 process.env 为底
      const buildEnv = { ...process.env, ELECTRON_BUILDER_BINARIES_MIRROR: "https://example.invalid/m/" };
      process.stdout.write(JSON.stringify({
        useProxy: d.useProxy,
        envUnchanged: JSON.stringify(process.env) === snap,
        buildStillHasProxy: buildEnv.HTTPS_PROXY === ${JSON.stringify(FAKE)} && buildEnv.ELECTRON_BUILDER_BINARIES_MIRROR.startsWith("https://"),
        ghStripped: !("HTTPS_PROXY" in ghEnv) && !("ALL_PROXY" in ghEnv),
      }));
    `;
    const r = spawnSync(process.execPath, ["-e", harness], { encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 0, `子进程失败：${r.stderr}`);
    const out = JSON.parse(r.stdout);
    console.log(`  子进程回报：${JSON.stringify(out)}`);
    assert.equal(out.useProxy, false, "有代理 + 探测通 → 应清代理");
    assert.equal(out.envUnchanged, true, "★ decideProxyUse/buildGhEnv 改了 process.env —— 构建阶段会被带偏");
    assert.equal(out.buildStillHasProxy, true, "★ 构建阶段的 env 必须仍带着代理与二进制镜像");
    assert.equal(out.ghStripped, true, "gh 的 env 必须已摘掉代理");
  });

  test("顺序/闸门/产物检查没被动：probe 在闸门之后、发布之前", () => {
    const src = readFileSync(PUBLISH_SRC, "utf8");
    const at = (re) => { const m = src.match(re); assert.ok(m, `publish.cjs 里找不到：${re}`); return m.index; };
    const iBuild = at(/run\("npx electron-builder/);
    const iGate = at(/runCheckManifest\("post-build"\)/);
    const iCopy = at(/upgrade\.ps1/);
    const iProbe = at(/decideProxyUse\(process\.env/);
    const iCreate = at(/"release", "create"/);
    assert.ok(iBuild < iGate, "electron-builder 仍须在 post-build 闸门之前");
    assert.ok(iGate < iProbe, "发版探测须在闸门之后（闸门失败就不该白探一次网）");
    assert.ok(iCopy < iProbe, "发版探测须在拷 upgrade.ps1 之后");
    assert.ok(iProbe < iCreate, "★ 探测（网络路径）必须发生在 gh release create 之前");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 反向对照：把「先探再决定」改成「无条件清代理」，「直连不通」那一格必须变红。
 * ══════════════════════════════════════════════════════════════════════════ */

/** ★ 唯一锚点：与 publish-proxy.cjs 里那行注释里的 ★★★ 一一对应。
 *  改成 `= true` 就等于「探测都不看，一律清代理」。 */
const ANCHOR_FROM = "const directOk = v.ok === true;";
const ANCHOR_TO = "const directOk = true;";

const SABOTAGE = [
  {
    name: "unconditional-strip",
    where: "decideProxyUse 里的直连判定",
    from: ANCHOR_FROM,
    to: ANCHOR_TO,
    reds: "★③「有代理 + 直连不通」：没有 TUN、只能靠代理的机器会被清掉代理 → 根本发不出去",
    expectRed: ["有代理 + 直连不通", "探测失败"],
  },
];

if (process.argv.includes("--list-sabotage")) {
  console.log(`发版代理决策 · 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
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

/** 把坏实现打到临时目录，返回一个能 import 的 decideProxyUse。 */
function loadSabotagedDecide(s) {
  const src = readFileSync(PROXY_SRC, "utf8");
  const hits = src.split(s.from).length - 1;
  assert.equal(hits, 1, `锚点在 publish-proxy.cjs 里必须恰好命中 1 次，实得 ${hits} 次（源码变了，这条对照作废）`);
  const dir = mkdtempSync(path.join(os.tmpdir(), "bai-publish-proxy-sabotage-"));
  const file = path.join(dir, "publish-proxy.cjs");
  writeFileSync(file, src.replace(s.from, s.to), "utf8");
  return { decide: require_(file).decideProxyUse, dir };
}

describe("反向对照：坏实现必须被同一套断言打红", () => {
  for (const s of SABOTAGE) {
    test(`${s.name} —— ${s.reds}`, () => {
      const { decide, dir } = loadSabotagedDecide(s);
      try {
        const reds = [];
        for (const c of CASES) {
          try {
            assertCase(decide, c);
            console.log(`  [${s.name}] ${c.name.padEnd(18)} 竟然还绿 ← 这格本该红`);
          } catch (e) {
            reds.push(c.name);
            console.log(`  [${s.name}] ${c.name.padEnd(18)} ✔ 红：${String(e.message).split("\n")[0].slice(0, 90)}`);
          }
        }
        for (const need of s.expectRed) {
          assert.ok(reds.includes(need), `反向对照没生效：「${need}」这一格在坏实现下竟然还是绿的`);
        }
        assert.ok(reds.length > 0, "坏实现却一条都没打红 —— 这条反向对照是假的");
      } finally {
        rmSync(dir, { recursive: true, force: true });   // 临时副本，不碰工作区
      }
    });
  }

  test("对照本身的自检：好实现下四格全绿（证明不是恒红）", () => {
    for (const c of CASES) assertCase(decideProxyUse, c);
  });
});

/* ====================================================================== *
 * 远端核对（git ls-remote 打 github.com）该试哪几条路、全失败怎么报错
 *
 * ⚠ 为什么要单独测：上传那条路探的是 api.github.com（直连通），远端核对打的是
 *   github.com（直连常常不通）—— **两者不是同一条路**。
 *   ⇒ 「环境里有没有代理变量」是**偶然**的（换个终端就没了）⇒ 不能靠运气，
 *   得有一个**显式**的入口 + 一个说人话的报错。
 * ====================================================================== */
describe("远端核对：候选路与「说人话」的报错", () => {
  const V = PP.gitNetVariants;
  const E = PP.gitRemoteError;
  const sig = (e) => PP.PROXY_ENV_KEYS.map((k) => `${k}=${e[k] || ""}`).join("|");

  test("① 显式指定的 BAI_GIT_PROXY 排第一档（不靠运气）", () => {
    const list = V({ BAI_GIT_PROXY: "http://127.0.0.1:7897" }, null, null);
    assert.ok(list.length >= 1, "一条候选路都没有");
    assert.equal(list[0][PP.PROXY_ENV_KEYS[0]], "http://127.0.0.1:7897",
      "★ 显式指定的代理没排在第一档");
  });

  test("② 环境里一个代理变量都没有时，也还有候选路（不会一条都没有）", () => {
    const list = V({}, null, { FOO: "bar" });
    assert.ok(list.length >= 1, "★ 没有代理变量 ⇒ 候选路空了 ⇒ 远端核对直接没路可走");
  });

  test("③ 候选路去重（同样的一批代理变量不重复试）", () => {
    const a = { HTTPS_PROXY: "http://127.0.0.1:7897" };
    const list = V(a, a, a);
    const sigs = list.map(sig);
    assert.equal(new Set(sigs).size, sigs.length, "★ 候选路里有重复 ⇒ 白试一遍");
  });

  test("④ 全部失败 ⇒ 报错说清「哪一步 / 为什么 / 怎么办」", () => {
    const err = E(new Error("spawnSync git ETIMEDOUT"));
    const m = String(err.message || "");
    assert.match(m, /远端核对/, "★ 没说清是哪一步");
    assert.match(m, /github\.com/, "★ 没说清打的是哪个地址");
    /* ⚠ 断言的是**短语**而不是「消息里出现过 HTTPS_PROXY」——
       后面那行可复制的命令里本来就有 HTTPS_PROXY，断言它会被命令满足 ⇒ 判据恒真。 */
    assert.match(m, /带上代理变量重跑/, "★ 没说清怎么办（带代理重跑）");
    assert.match(m, /node scripts\/publish\.cjs/, "★ 没说清重跑的命令长什么样");
    assert.match(m, /BAI_GIT_PROXY/, "★ 没说清另一个办法（只给 git 那段指定）");
  });

  test("⑤ 反向对照：把「怎么办」那句删掉 ⇒ ④ 必须红", () => {
    /* 手法：把 publish-proxy.cjs 复制到临时目录，在**副本**上删掉报错里
       「⇒ 带上代理变量重跑」那一行，再 import 副本跑 ④ 的判据 ——
       它必须抓不到「说了怎么办」。
       ⚠ 改的是副本，仓库源码一个字不动。 */
    const src = readFileSync(PROXY_SRC, "utf8");
    const anchor = '    "  ⇒ 带上代理变量重跑（按你的实际代理改端口）：",';
    const hits = src.split(anchor).length - 1;
    assert.equal(hits, 1, `锚点在 publish-proxy.cjs 里必须恰好命中 1 次，实得 ${hits} 次（源码变了，这条对照作废）`);
    const dir = mkdtempSync(path.join(os.tmpdir(), "bai-publish-err-sabotage-"));
    const file = path.join(dir, "publish-proxy.cjs");
    writeFileSync(file, src.replace(anchor, ""), "utf8");
    try {
      const bad = require_(file).gitRemoteError(new Error("spawnSync git ETIMEDOUT"));
      assert.doesNotMatch(String(bad.message || ""), /带上代理变量重跑/,
        "★ 坏实现仍然说清了怎么办 —— 那 ④ 的判据是恒真的，测了个寂寞");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});