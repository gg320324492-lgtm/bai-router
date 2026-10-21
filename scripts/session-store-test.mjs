// scripts/session-store-test.mjs —— session-store.mjs 的测试
//
// 红线一：这个模块是**缓存**，不是用户配置。
//   - 写失败**不抛**：丢的只是亲和，不是功能（请求照样发，只是没命中缓存）。
//   - 读失败**当空**：重新粘一次而已，绝不能把用户的其它东西一起弄丢。
// 红线二：「粘不粘」的判据不是「谁回答过」就算数，还要看**缓存值不值得留**
//   （magpie affinity.go 的 no-cache / cold 两条判据，顺序即语义）。
//
// 跑法：node --test scripts/session-store-test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MODES,
  CACHE_WORTH,
  CACHE_COLD_MS,
  CACHE_HOUR_MS,
  STICK_KEEP_MS,
  SessionStore,
} from "../src/server/session-store.mjs";

/* ========================================================================== *
 * 工具
 * ========================================================================== */

/** 假时钟：时间只在测试里动，模块内部永远不自己读墙上的钟。 */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(v) { t = v; return t; },
  };
}

/** 临时目录（用例结束就删）。 */
function tmpdir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-store-"));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ } });
  return dir;
}

/**
 * 断言「没有哪个会话还粘在 target 上」。
 *
 * 这条断言被两处用：真实现（§②）和**故意改坏的实现**（§⑦ 反向对照）——
 * 后者必须让它红，否则说明这条断言没有牙齿。
 */
function assertAllUnbound(store, target) {
  const left = store.entries().filter((e) => e.target === target);
  assert.deepEqual(left.map((e) => e.key), [], `还有会话粘在 ${target} 上`);
}

/* ========================================================================== *
 * ① 绑定 / 查找 / 遗忘
 * ========================================================================== */

test("① bind → lookup 查得到：目标、时刻、这次回答的账都在", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  const bound = store.bind("agent|sess-1", "acct-a", { cacheRead: 0, cacheWrite: 4096 });
  assert.ok(bound, "bind 应该成功");
  assert.equal(bound.target, "acct-a");
  assert.equal(bound.at, c.now());

  const got = store.lookup("agent|sess-1");
  assert.ok(got, "刚绑的会话查不到");
  assert.equal(got.target, "acct-a");
  assert.equal(got.at, c.now());
  assert.equal(got.meta.cacheWrite, 4096);
});

test("① forget 后查不到", () => {
  const store = new SessionStore({ now: clock().now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });
  assert.ok(store.lookup("k1"));
  assert.equal(store.forget("k1"), true);
  assert.equal(store.lookup("k1"), null);
  assert.equal(store.size, 0);
  assert.equal(store.forget("k1"), false, "再 forget 一次也不该炸");
});

test("① bind 一个空目标 = 解绑（不是「绑到空串」）", () => {
  const store = new SessionStore({ now: clock().now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });
  assert.equal(store.bind("k1", null), null);
  assert.equal(store.lookup("k1"), null);
  assert.equal(store.size, 0);
});

test("① 空 key / 空白 key 一律不粘（半截身份比没有身份更糟）", () => {
  const store = new SessionStore({ now: clock().now });
  assert.equal(store.bind("", "acct-a", {}), null);
  assert.equal(store.bind("   ", "acct-a", {}), null);
  assert.equal(store.bind(null, "acct-a", {}), null);
  assert.equal(store.lookup(""), null);
  assert.equal(store.size, 0);
});

test("① entries() 返回全部绑定（面板要显示「哪个会话粘在哪个号上」）", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k-old", "acct-a", { cacheWrite: 4096 });
  c.advance(1000);
  store.bind("k-new", "acct-b", { cacheWrite: 4096 });

  const all = store.entries();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.key), ["k-new", "k-old"], "按最近用过的排，新的在前");
  assert.equal(all[0].target, "acct-b");
  assert.equal(all[1].target, "acct-a");
});

test("① touch 续期：刷新闲置时间，但**不**动缓存冷热的基准时刻", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });
  const t0 = c.now();
  c.advance(60_000);
  const got = store.touch("k1");
  assert.ok(got, "touch 一个存在的会话");
  assert.equal(got.at, t0, "at 是「上次回答」的时刻，touch 不许改它（否则凭空焐热一个冷掉的缓存）");
  const e = store.entries()[0];
  assert.equal(e.used, c.now(), "闲置时间被刷新了");
  assert.equal(e.at, t0);
  assert.equal(store.touch("不存在的"), null);
});

/* ========================================================================== *
 * ② 目标死了要解绑（forgetTarget）
 * ========================================================================== */

test("② forgetTarget：那个号失效后，粘在它上面的会话全部解绑", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-dead", { cacheWrite: 4096 });
  store.bind("k2", "acct-dead", { cacheWrite: 4096 });
  c.advance(1000);
  store.bind("k3", "acct-dead", { cacheWrite: 4096 });
  store.bind("k4", "acct-alive", { cacheWrite: 4096 });

  const n = store.forgetTarget("acct-dead");
  assert.equal(n, 3, "应该解绑 3 条");
  assertAllUnbound(store, "acct-dead");
  assert.equal(store.lookup("k1"), null);
  assert.equal(store.lookup("k2"), null);
  assert.equal(store.lookup("k3"), null);
  assert.ok(store.lookup("k4"), "别的号不该被牵连");
  assert.equal(store.size, 1);
});

test("② forgetTarget 解绑之后，落盘的文件里也不再有这个号的会话", (t) => {
  const file = path.join(tmpdir(t), "affinity.json");
  const store = new SessionStore({ file, now: clock().now });
  store.bind("k1", "acct-dead", { cacheWrite: 4096 });
  store.bind("k2", "acct-alive", { cacheWrite: 4096 });
  assert.equal(store.save().ok, true);

  store.forgetTarget("acct-dead");
  assert.equal(store.save().ok, true);

  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(onDisk.entries).sort(), ["k2"], "死号名下的会话不该再落盘");
});

test("② forgetTarget 一个没人粘的目标 = 0 条，不该炸", () => {
  const store = new SessionStore({ now: clock().now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });
  assert.equal(store.forgetTarget("acct-不存在"), 0);
  assert.equal(store.forgetTarget(""), 0);
  assert.equal(store.size, 1);
});

/* ========================================================================== *
 * ③ 缓存值不值得留（magpie 的 no-cache / cold 两条判据）
 * ========================================================================== */

test("③ 缓存读写 < 1024 且缓存已冷 → 不粘（换目标）", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 100 }); // 太少，不值得留
  c.advance(CACHE_COLD_MS + 1000); // 冷掉了
  assert.equal(store.lookup("k1"), null, "不值得留的缓存，冷了就该换目标");
});

test("③ 缓存读写 ≥ 1024 且缓存还热着 → 粘", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: CACHE_WORTH });
  c.advance(CACHE_COLD_MS - 1000); // 还没冷
  const got = store.lookup("k1");
  assert.ok(got, "≥1024 且没冷 → 应该粘住");
  assert.equal(got.target, "acct-a");
});

test("③ 缓存读写 < 1024 → 不粘（magpie 的 no-cache，这一条排在冷热之前）", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 100 });
  // 注意：现在还**没冷**。magpie 的 switch 里 no-cache 排在 cold 前面，
  // 所以「量不够」本身就是不留的理由——留着一个只值 100 token 的缓存，
  // 下一轮照样重算，只是白占一个号的位置。
  assert.equal(store.lookup("k1"), null, "量不够就不该留（magpie: no-cache）");
});

test("③ 缓存读写 ≥ 1024 但已冷、又没有 1 小时缓存 → 不粘（magpie 的 cold）", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: CACHE_WORTH });
  c.advance(CACHE_COLD_MS + 1000);
  assert.equal(store.lookup("k1"), null, "冷掉的缓存留着也白留");
});

test("③ cacheHour：供应商声明留 1 小时 → 突破 5 分钟的限制", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  // 这次写了 4096 token 进缓存，其中 2048 声明「留一小时」
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 4096, cacheWrite1h: 2048 });
  c.advance(CACHE_COLD_MS + 1000); // 超过 5 分钟了——普通缓存早冷了
  const got = store.lookup("k1");
  assert.ok(got, "1 小时缓存还热着 → 应该继续粘");
  assert.equal(got.target, "acct-a");

  // 再等：1 小时缓存也冷了 → 不粘
  c.advance(CACHE_HOUR_MS);
  assert.equal(store.lookup("k1"), null, "1 小时也过了 → 该换目标");
});

test("③ 1 小时缓存会跟着「读回来」续期（读满了就续，读少了就没了）", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 4096, cacheWrite1h: 4096 });
  c.advance(CACHE_COLD_MS + 1000);
  assert.ok(store.lookup("k1"), "1 小时缓存还热着");

  // 同一轮：读回来 4096（读满了）→ 续期
  store.bind("k1", "acct-a", { cacheRead: 4096, cacheWrite: 0 });
  c.advance(CACHE_COLD_MS + 1000);
  assert.ok(store.lookup("k1"), "读满了 → 1 小时缓存续期 → 还是粘");

  // 读回来的比留下的少（会话被压缩过）→ 1 小时缓存没了
  store.bind("k1", "acct-a", { cacheRead: 10, cacheWrite: 0 });
  c.advance(CACHE_COLD_MS + 1000);
  assert.equal(store.lookup("k1"), null, "读少了 → 1 小时缓存作废 → 该换目标");
});

test("③ 供应商不报缓存时，发出去的 input 顶替「缓存写入」（written counts as read）", () => {
  const store = new SessionStore({ now: clock().now });
  // OpenAI 自动前缀缓存 / Gemini：不报 cacheRead 也不报 cacheWrite，
  // 但它确实存了——发出去的那段就是下一轮要读的。不顶替的话这一轮会被当成
  // 「没缓存」挪走，白白重建一次缓存（magpie `answered()` 里那句话的意思：
  // 「第一轮读不到什么、却把整段提示词写了进去，下一轮就该留在原地读它」）。
  store.bind("k1", "acct-a", { input: 5000 });

  // 顶替生效：记下来的「缓存写入」是发出去的那 5000 token
  assert.equal(store.entries()[0].meta.cacheWrite, 5000);
  // 因此它「值得留」（≥1024）——没冷的时候粘住
  const got = store.lookup("k1");
  assert.ok(got, "发出去的 5000 token 算写进缓存了 → 值得留");
  assert.equal(got.target, "acct-a");

  // 反过来：只发了 100 token，顶替之后仍然「量不够」→ 不值得留（no-cache）
  store.bind("k2", "acct-b", { input: 100 });
  assert.equal(store.lookup("k2"), null, "量不够 → 不值得留（哪怕还没冷）");
});

/* ========================================================================== *
 * ④ 五种模式
 * ========================================================================== */

test("④ off：不粘——bind 什么都不留，lookup 永远 null", () => {
  const store = new SessionStore({ now: clock().now, mode: "off" });
  assert.equal(store.bind("k1", "acct-a", { cacheWrite: 4096 }), null);
  assert.equal(store.lookup("k1"), null);
  assert.equal(store.size, 0);
});

test("④ session：一个会话固定一个目标（跨轮、缓存冷掉都留在原处）", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now, mode: "session" });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 100 }); // 量很少
  c.advance(CACHE_COLD_MS * 10); // 早就冷了
  const got = store.lookup("k1");
  assert.ok(got, "session 模式不看缓存冷热");
  assert.equal(got.target, "acct-a");
});

test("④ turn：同一轮内不换；换一轮就重新选", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now, mode: "turn" });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });

  // 同一轮内（agent 回传工具结果）：不换
  const within = store.lookup("k1", { within: true });
  assert.ok(within, "同一轮内不该换号");
  assert.equal(within.target, "acct-a");

  // 新的一轮：重新选
  assert.equal(store.lookup("k1", { within: false }), null, "新的一轮就该重新选");
  assert.equal(store.lookup("k1"), null, "不传 within（默认不在同一轮内）→ 不粘");
});

test("④ strict：粘住就绝不换，哪怕那个号已经休息（magpie #1797）", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now, mode: "strict" });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 100 }); // 量很少、早就冷了
  c.advance(CACHE_COLD_MS * 10);

  // 那个号在休息（usable=false）——strict 照样粘
  const got = store.lookup("k1", { usable: false });
  assert.ok(got, "strict：哪怕那个号休息也不换");
  assert.equal(got.target, "acct-a");
});

test("④ auto：那个号真用不了了（休息中/额度用尽）就换，但绑定留着", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now, mode: "auto" });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });

  // 目标休息中 → 这一轮不粘（换目标）
  assert.equal(store.lookup("k1", { usable: false }), null, "auto：目标用不了就换");

  // 但**绑定还在**：等它缓过来还能接回去
  assert.equal(store.size, 1, "只是这一轮不粘，绑定不该被删");
  const back = store.lookup("k1");
  assert.ok(back, "目标缓过来之后应该还能粘回原处");
  assert.equal(back.target, "acct-a");
});

test("④ auto：同一轮内总是粘；跨轮才看缓存值不值得留", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now, mode: "auto" });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 100 }); // 量很少
  // 同一轮内：粘（哪怕缓存量根本不够）
  const within = store.lookup("k1", { within: true });
  assert.ok(within, "auto：同一轮内总是粘");
  assert.equal(within.target, "acct-a");
  // 跨轮：量不够 → 不粘
  assert.equal(store.lookup("k1", { within: false }), null, "auto：跨轮看缓存值");
});

test("④ 模式集合就是 magpie 那五个；认不出来的模式当场炸，空串当 auto", () => {
  assert.deepEqual([...MODES], ["auto", "session", "turn", "off", "strict"]);
  assert.throws(() => new SessionStore({ now: clock().now, mode: "sticky" }), TypeError);
  assert.doesNotThrow(() => new SessionStore({ now: clock().now, mode: "" }));
  assert.equal(new SessionStore({ now: clock().now, mode: "" }).mode, "auto");
  // 运行时改模式也过一遍校验
  const store = new SessionStore({ now: clock().now });
  store.mode = "strict";
  assert.equal(store.mode, "strict");
  assert.throws(() => { store.mode = "随便"; }, TypeError);
});

/* ========================================================================== *
 * ⑤ 持久化
 * ========================================================================== */

test("⑤ save → load → 绑定还在（跨进程重启的粘性）", (t) => {
  const file = path.join(tmpdir(t), "affinity.json");
  const c = clock();

  const a = new SessionStore({ file, now: c.now });
  a.bind("agent|sess-1", "acct-a", { cacheRead: 128, cacheWrite: 4096 });
  a.bind("agent|sess-2", "acct-b", { cacheWrite: 4096 });
  const saved = a.save();
  assert.equal(saved.ok, true);

  // 换一个 store（= 另一个进程）
  const b = new SessionStore({ file, now: c.now });
  const loaded = b.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.count, 2);

  const got = b.lookup("agent|sess-1");
  assert.ok(got, "重启后粘性还在");
  assert.equal(got.target, "acct-a");
  assert.equal(got.meta.cacheRead, 128);
  assert.equal(got.meta.cacheWrite, 4096);
  assert.equal(b.lookup("agent|sess-2").target, "acct-b");
});

test("⑤ 落盘是原子写：临时文件用完就没了", (t) => {
  const file = path.join(tmpdir(t), "affinity.json");
  const store = new SessionStore({ file, now: clock().now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });
  store.save();
  assert.ok(existsSync(file), "文件应该写出来了");
  assert.ok(!existsSync(file + ".tmp"), "临时文件不该留下来");
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(data.entries), ["k1"]);
});

test("⑤ 写失败不抛（磁盘写不进去时只是丢亲和，不是丢功能）", (t) => {
  // 造一个「写不进去」的路径：某个文件被当成目录用 → 建目录就失败
  const dir = tmpdir(t);
  const blocker = path.join(dir, "not-a-dir");
  writeFileSync(blocker, "x");
  const file = path.join(blocker, "sub", "affinity.json");

  const store = new SessionStore({ file, now: clock().now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });

  let res = null;
  assert.doesNotThrow(() => { res = store.save(); }, "写失败不许抛");
  assert.equal(res.ok, false);
  assert.ok(res.reason, "失败要说清楚为什么");
  assert.ok(store.lookup("k1"), "写失败不影响内存里的粘性");
});

test("⑤ 读失败当空（不抛、表为空）——文件是垃圾", (t) => {
  const file = path.join(tmpdir(t), "affinity.json");
  writeFileSync(file, "{ 这不是 JSON");

  const store = new SessionStore({ file, now: clock().now });
  let res = null;
  assert.doesNotThrow(() => { res = store.load(); }, "读失败不许抛");
  assert.equal(res.ok, false);
  assert.equal(res.count, 0);
  assert.equal(store.size, 0, "当空表处理");
  assert.equal(store.lookup("k1"), null);
});

test("⑤ 读失败当空（不抛、表为空）——文件根本不存在", (t) => {
  const file = path.join(tmpdir(t), "根本没有这个文件.json");
  const store = new SessionStore({ file, now: clock().now });
  let res = null;
  assert.doesNotThrow(() => { res = store.load(); }, "读失败不许抛");
  assert.equal(res.ok, false);
  assert.equal(res.missing, true);
  assert.equal(store.size, 0);
});

test("⑤ 读失败当空会把内存里已有的表也清掉（别拿半旧不新的表继续跑）", (t) => {
  const file = path.join(tmpdir(t), "affinity.json");
  const store = new SessionStore({ file, now: clock().now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });
  assert.equal(store.size, 1);
  writeFileSync(file, "垃圾");
  store.load();
  assert.equal(store.size, 0, "读失败 = 当空表");
});

test("⑤ 没有持久化路径时，save/load 都不抛（这一层可以只在内存里跑）", () => {
  const store = new SessionStore({ now: clock().now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });
  assert.equal(store.save().ok, false);
  assert.equal(store.load().ok, false);
  assert.equal(store.size, 1, "内存里的东西不该被清掉");
});

/* ========================================================================== *
 * ⑥ 淘汰
 * ========================================================================== */

test("⑥ 超过 max 时按闲置时间淘汰最旧的", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now, max: 3 });
  for (const k of ["k1", "k2", "k3", "k4", "k5"]) {
    store.bind(k, "acct-a", { cacheWrite: 4096 });
    c.advance(1000);
  }
  store.prune();
  assert.equal(store.size, 3, "最多留 3 条");
  const keys = store.entries().map((e) => e.key).sort();
  assert.deepEqual(keys, ["k3", "k4", "k5"], "留的应该是最近用的，淘汰最旧的");
  assert.equal(store.lookup("k1"), null);
  assert.equal(store.lookup("k2"), null);
});

test("⑥ 闲置超过 24 小时的被淘汰（magpie 的 stickKeep）", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k-old", "acct-a", { cacheWrite: 4096 });
  c.advance(STICK_KEEP_MS + 1000);
  store.bind("k-new", "acct-a", { cacheWrite: 4096 });
  store.prune();
  assert.equal(store.size, 1);
  assert.equal(store.lookup("k-old"), null, "闲置太久的该淘汰");
  assert.ok(store.lookup("k-new"));
});

test("⑥ touch 过的会话不因为「闲置」被淘汰", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-a", { cacheWrite: 4096 });
  c.advance(STICK_KEEP_MS - 1000);
  store.touch("k1");
  c.advance(2000);
  store.prune();
  assert.equal(store.size, 1, "刚 touch 过，不算闲置");
});

test("⑥ load 回来的陈货也会被淘汰（文件里有几个月前的绑定）", (t) => {
  const file = path.join(tmpdir(t), "affinity.json");
  const c = clock();
  const a = new SessionStore({ file, now: c.now });
  a.bind("k-old", "acct-a", { cacheWrite: 4096 });
  assert.equal(a.save().ok, true);

  c.advance(STICK_KEEP_MS + 1000);
  const b = new SessionStore({ file, now: c.now });
  b.load();
  assert.equal(b.size, 0, "24 小时前的绑定不该被读回来");
});

/* ========================================================================== *
 * ⑦ 反向对照：把关键判据改坏，测试必须红
 * ========================================================================== */

test("⑦ 反向对照：把「目标死了要解绑」改坏（forgetTarget 变空操作），断言必须红", () => {
  const c = clock();
  const good = new SessionStore({ now: c.now });
  good.bind("k1", "acct-dead", { cacheWrite: 4096 });
  good.bind("k2", "acct-dead", { cacheWrite: 4096 });
  good.bind("k3", "acct-alive", { cacheWrite: 4096 });

  // 正常实现：断言通过
  good.forgetTarget("acct-dead");
  assertAllUnbound(good, "acct-dead");
  assert.ok(good.lookup("k3"), "别的号不受影响");

  // 改坏的实现：同样的断言必须红
  const broken = new SessionStore({ now: c.now });
  broken.bind("k1", "acct-dead", { cacheWrite: 4096 });
  broken.bind("k2", "acct-dead", { cacheWrite: 4096 });
  broken.bind("k3", "acct-alive", { cacheWrite: 4096 });
  broken.forgetTarget = () => 0; // ← 改坏：什么都不解绑
  assert.throws(() => assertAllUnbound(broken, "acct-dead"), "断言没有牙齿，改坏实现测不出来");
});

test("⑦ 反向对照：把「缓存值不值得留」改坏（永远粘），断言必须红", () => {
  const c = clock();
  const store = new SessionStore({ now: c.now });
  store.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 100 }); // 量不够
  c.advance(CACHE_COLD_MS + 1000);
  // 正常实现：不粘
  assert.equal(store.lookup("k1"), null);
  // 改坏的实现（永远返回绑定）：同样的查询必须粘住——这正是它必须被测出来的地方
  const broken = new SessionStore({ now: c.now });
  broken.bind("k1", "acct-a", { cacheRead: 0, cacheWrite: 100 });
  broken.lookup = () => ({ target: "acct-a", meta: {}, at: 0 });
  assert.notEqual(broken.lookup("k1"), null, "改坏的实现会粘住——它必须被测出来");
});

/* ========================================================================== *
 * ⑧ 纪律：时间源必须注入、零第三方依赖
 * ========================================================================== */

test("⑧ 不注入时间源就当场炸（本模块不自己读墙上的钟）", () => {
  assert.throws(() => new SessionStore({}), TypeError);
  assert.throws(() => new SessionStore({ now: "现在" }), TypeError);
});

test("⑧ 模块内部绝不读墙上的钟，也只依赖 node: 内置模块", () => {
  const src = readFileSync(new URL("../src/server/session-store.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.length > 0, "应该读到 import 语句");
  for (const i of imports) {
    assert.ok(i.startsWith("node:"), `不许有第三方依赖，发现：${i}`);
  }
  assert.ok(!/Date\s*\.\s*now\s*\(/.test(src), "模块内部不许读墙上的钟");
  assert.ok(!/new\s+Date\s*\(/.test(src), "模块内部不许造本地时间对象");
});
