/**
 * sync-test.mjs —— src/server/sync.mjs 的口径测试
 *
 * 测的是 magpie（yetone/magpie internal/davsync）那套合并语义的四件要命的事：
 *   ① **两边都改过时听谁的**：新的赢（本地这份的改动时刻 vs 远端快照的制作时刻），
 *      并且要把「顶掉了什么」记下来给用户看（magpie 的 Notice）。
 *   ② **第一次同步以远端为准**：新机器加入一个已有设置的远端 ⇒ 拿远端的。
 *   ③ **幂等**：同一份配置同步两次，第二次不许产生新版本——
 *      否则 GitHub 上会攒出一串一模一样的 commit（magpie davsync.go:1249 的那道闸）。
 *   ④ **面板要能回答**：远端比我新吗 / 我比远端新吗 / 两边一样吗 / 要不要备份。
 *
 * 时间一律由参数注入（opts.now），本文件不取 Date.now()。
 *
 * ⚠ 全程零 IO：除了「反向对照」往系统临时目录写一份源码副本，
 *   本测试**不碰**真实的 %APPDATA%\bai-router 与 ~/.claude/settings.json，
 *   同步目标是一个**内存里的假目标**（不联网、不碰磁盘）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  planSync,
  runSync,
  compareState,
  describeTarget,
  hashParts,
  partHash,
  canonicalJson,
  TARGETS,
  TARGET_KINDS,
  REMOTE_CHANGED_CODES,
  SyncError,
} from "../src/server/sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "src", "server", "sync.mjs");

const NOW = 1_700_000_000_000;
const OLD = NOW - 10_000;
/* 本机这次改动的时间：比上次同步晚，比远端快照的制作时刻早。 */
const LOCAL_CHANGE = NOW - 50_000;
/* 远端快照的制作时刻。 */
const REMOTE_CREATE = NOW - 10_000;

/* 假配置：三个部件，凭据一眼看出是假的。
 *
 * 四份夹具的关系（这是本文件最容易写错的地方，所以说清楚）：
 *   BASE_*     —— 上一次同步时两边都有的那份内容（settings 与 claude 两边一样）
 *   OLD_LOCAL  —— 上一次同步时**本机**的样子（providers 与远端不同）
 *   OLD_REMOTE —— 上一次同步时**远端**的样子
 *   LOCAL      —— 现在的本机（providers 改了）
 *   REMOTE     —— 现在的远端（providers 改了）
 * 只有 providers 这一块在动：settings 与 claude 两边始终一样，
 * 这样「哪个部件变了」的判断才是干净的。 */
const BASE_SETTINGS = { failover: { enabled: true, chain: ["bai", "sn"] } };
const BASE_CLAUDE = { permissions: { allow: ["Bash(npm test)"] } };

const OLD_LOCAL = {
  providers: { bai: { apiKey: "sk-test-0000-old-bai-key", defaultModel: "test-model-a" } },
  settings: BASE_SETTINGS,
  claude: BASE_CLAUDE,
};
const OLD_REMOTE = {
  providers: { bai: { apiKey: "sk-test-0000-old-remote-key", defaultModel: "test-model-a" } },
  settings: BASE_SETTINGS,
  claude: BASE_CLAUDE,
};
const LOCAL = {
  providers: { bai: { apiKey: "sk-test-0000-bai-key", defaultModel: "test-model-a" } },
  settings: BASE_SETTINGS,
  claude: BASE_CLAUDE,
};
const REMOTE = {
  providers: { bai: { apiKey: "sk-test-0000-remote-key", defaultModel: "test-model-b" } },
  settings: BASE_SETTINGS,
  claude: BASE_CLAUDE,
};

/** 上一次同步的状态：两边的哈希都是那时的。 */
function stateOf(localParts, remoteParts) {
  return { local: hashParts(localParts), remote: hashParts(remoteParts), lastAt: OLD };
}

/* ====================================================================== *
 * 断言（正向与反向对照共用）
 * ====================================================================== */

/** 两边都改过、旧的那份赢（远端更新）。 */
function assertRemoteWins(mod, input) {
  const plan = mod.planSync(input);
  assert.deepEqual(plan.pull.providers, REMOTE.providers, "远端更新 ⇒ 远端赢");
  assert.equal(plan.push.providers, undefined, "远端赢 ⇒ 不该把本地推上去");
  assert.equal(plan.conflicts.length, 1, "两边都改过必须记成一次冲突");
  assert.equal(plan.conflicts[0].winner, "remote");
  assert.deepEqual(plan.notice.here, ["providers"], "本机被顶掉的部件要记下来");
}

/** 两边都改过、本地更新。 */
function assertLocalWins(mod, input) {
  const plan = mod.planSync(input);
  assert.deepEqual(plan.push.providers, LOCAL.providers, "本地更新 ⇒ 本地赢");
  assert.equal(plan.pull.providers, undefined, "本地赢 ⇒ 不该把远端拉下来");
  assert.equal(plan.conflicts[0].winner, "local");
  assert.deepEqual(plan.notice.there, ["providers"], "远端被顶掉的部件要记下来");
}

/** 第一次同步以远端为准。 */
function assertFirstSyncTakesRemote(mod, input) {
  const plan = mod.planSync(input);
  assert.deepEqual(plan.pull.providers, REMOTE.providers, "第一次同步必须拿远端的");
  assert.equal(plan.push.providers, undefined, "第一次同步不该把本地推上去");
  assert.deepEqual(plan.notice.here, ["providers"], "本机被顶掉的部件要记下来给「撤销」");
}

/** 同一份配置同步两次，第二次不许产生新版本。 */
async function assertSecondSyncWritesNothing(mod) {
  const target = memoryTarget(null);
  const seal = fakeSeal();
  const open = fakeOpen();
  const first = await mod.runSync({
    target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: null, seal, open, now: NOW,
  });
  assert.equal(first.pushed, true, "第一次同步必须把本地的推上去");
  const writesAfterFirst = target.writes;
  const second = await mod.runSync({
    target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: first.state, seal, open, now: NOW + 1,
  });
  assert.equal(second.pushed, false, "同一份配置再同步一次不许产生新版本");
  assert.equal(target.writes, writesAfterFirst, "第二次同步不许写远端");
  assert.equal(second.plan.action, "noop", "第二次同步应该是什么都不做");
}

/** 同一份内容、不同的键序 ⇒ 同一个哈希。 */
function assertHashIgnoresKeyOrder(mod) {
  const a = { x: 1, y: { p: 1, q: 2 } };
  const b = { y: { q: 2, p: 1 }, x: 1 };
  assert.equal(mod.partHash(a), mod.partHash(b), "键序不同但内容相同 ⇒ 哈希必须相同");
}

/* ====================================================================== *
 * ① 合并计划
 * ====================================================================== */

describe("① 合并计划 —— 两边都改过时听谁的", () => {
  test("①a 远端一个文件都没有 ⇒ 本地的推上去", () => {
    const plan = planSync({ localParts: LOCAL, localChangedAt: {}, remote: null, state: null, now: NOW });
    assert.equal(plan.action, "push");
    assert.equal(plan.shouldPush, true);
    assert.deepEqual(plan.mergedParts.providers, LOCAL.providers);
    assert.deepEqual(plan.push.providers, LOCAL.providers);
  });

  test("①b 第一次同步（有远端）⇒ 以远端为准，本机被顶掉的记下来", () => {
    assertFirstSyncTakesRemote({ planSync }, {
      localParts: LOCAL,
      localChangedAt: { providers: NOW },
      remote: { parts: REMOTE, createdAt: OLD, version: "v1" },
      state: null,
      now: NOW,
    });
  });

  test("①c 只有本地改了 ⇒ 推上去", () => {
    const plan = planSync({
      localParts: LOCAL,
      /* 本机这次改动的时间比远端快照的制作时刻还早：只有真冲突才该比时间，
         单边改动比了就会判反（magpie 的 switch 是四个分支，不是三个）。 */
      localChangedAt: { providers: LOCAL_CHANGE },
      remote: { parts: OLD_REMOTE, createdAt: REMOTE_CREATE, version: "v1" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
      now: NOW,
    });
    assert.equal(plan.action, "push");
    assert.deepEqual(plan.push.providers, LOCAL.providers, "本地改的必须推上去");
    assert.equal(plan.pull.providers, undefined, "远端没改，不该拉");
    assert.equal(plan.conflicts.length, 0, "只有一边改，不算冲突");
  });

  test("①d 只有远端改了 ⇒ 拉下来", () => {
    const plan = planSync({
      localParts: OLD_LOCAL,
      localChangedAt: { providers: OLD },
      remote: { parts: REMOTE, createdAt: NOW, version: "v2" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
      now: NOW,
    });
    assert.equal(plan.action, "pull");
    assert.deepEqual(plan.pull.providers, REMOTE.providers, "远端改的必须拉下来");
    assert.equal(plan.push.providers, undefined, "本地没改，不该推");
    assert.equal(plan.conflicts.length, 0, "只有一边改，不算冲突");
  });

  test("①e 两边都改了、本地更新 ⇒ 本地赢", () => {
    assertLocalWins({ planSync }, {
      localParts: LOCAL,
      localChangedAt: { providers: NOW },
      remote: { parts: REMOTE, createdAt: OLD, version: "v1" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
      now: NOW,
    });
  });

  test("①f 两边都改了、远端更新 ⇒ 远端赢", () => {
    assertRemoteWins({ planSync }, {
      localParts: LOCAL,
      localChangedAt: { providers: OLD },
      remote: { parts: REMOTE, createdAt: NOW, version: "v2" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
      now: NOW,
    });
  });

  test("①g 两边一样 ⇒ 什么都不做", () => {
    const plan = planSync({
      localParts: LOCAL,
      localChangedAt: { providers: OLD },
      remote: { parts: LOCAL, createdAt: OLD, version: "v1" },
      state: stateOf(LOCAL, LOCAL),
      now: NOW,
    });
    assert.equal(plan.action, "noop");
    assert.equal(plan.shouldPush, false, "两边一样时绝不能推（否则每次同步多一个版本）");
    assert.equal(plan.shouldPull, false);
  });

  test("①h 远端没有某个部件 ⇒ 本地的推上去", () => {
    const plan = planSync({
      localParts: LOCAL,
      localChangedAt: { providers: NOW },
      remote: { parts: { providers: OLD_REMOTE.providers }, createdAt: OLD, version: "v1" },
      state: null,
      now: NOW,
    });
    assert.deepEqual(plan.push.settings, LOCAL.settings, "远端缺的部件由本地的补上");
    assert.equal(plan.push.claude, LOCAL.claude, "远端缺的部件由本地的补上");
    assert.deepEqual(plan.pull.providers, OLD_REMOTE.providers, "远端有的那一块按远端来（第一次同步以远端为准）");
  });

  test("①i 本地没有某个部件 ⇒ 远端的拉下来", () => {
    const plan = planSync({
      localParts: { providers: OLD_LOCAL.providers },
      localChangedAt: {},
      remote: { parts: REMOTE, createdAt: NOW, version: "v2" },
      state: stateOf({ providers: OLD_LOCAL.providers }, OLD_REMOTE),
      now: NOW,
    });
    assert.deepEqual(plan.pull.settings, REMOTE.settings, "本地缺的部件从远端拿");
    assert.deepEqual(plan.pull.claude, REMOTE.claude, "本地缺的部件从远端拿");
  });

  test("①j 冲突要带上判据：谁赢、拿什么比的", () => {
    const plan = planSync({
      localParts: LOCAL,
      localChangedAt: { providers: NOW },
      remote: { parts: REMOTE, createdAt: OLD, version: "v1" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
      now: NOW,
    });
    assert.equal(plan.conflicts[0].part, "providers");
    assert.equal(plan.conflicts[0].winner, "local");
    assert.equal(plan.conflicts[0].localChangedAt, NOW, "要记下比的是哪两个时刻");
    assert.equal(plan.conflicts[0].remoteCreatedAt, OLD);
  });

  test("①k opts.now 必须给", () => {
    assert.throws(
      () => planSync({ localParts: LOCAL, remote: null, state: null }),
      (e) => e instanceof SyncError && e.code === "NO_TIME",
    );
  });
});

/* ====================================================================== *
 * ② 幂等
 * ====================================================================== */

describe("② 幂等 —— 同一份配置同步两次不许多出版本", () => {
  test("②a 第一次推、第二次什么都不做", async () => {
    await assertSecondSyncWritesNothing({ runSync });
  });

  test("②b 合并结果与远端一样 ⇒ 不推", () => {
    const plan = planSync({
      localParts: LOCAL,
      localChangedAt: { providers: NOW },
      remote: { parts: LOCAL, createdAt: OLD, version: "v1" },
      state: stateOf(LOCAL, LOCAL),
      now: NOW,
    });
    assert.equal(plan.shouldPush, false, "内容一样就不许推");
  });

  test("②c 推过一次之后，远端与本地的哈希一致", async () => {
    const target = memoryTarget(null);
    const r = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: null,
      seal: fakeSeal(), open: fakeOpen(), now: NOW,
    });
    assert.deepEqual(r.state.local, r.state.remote, "推完之后两边必须一样");
  });
});

/* ====================================================================== *
 * ③ 面板要的那句话
 * ====================================================================== */

describe("③ 状态比较 —— 面板上「要不要备份」的数据来源", () => {
  test("③a 两边一样", () => {
    const s = compareState({ localParts: LOCAL, remote: { parts: LOCAL, createdAt: OLD, version: "v1" }, state: stateOf(LOCAL, LOCAL) });
    assert.equal(s.relation, "same");
    assert.equal(s.needsBackup, false, "两边一样 ⇒ 不用备份");
  });

  test("③b 我比远端新", () => {
    const s = compareState({
      localParts: LOCAL,
      remote: { parts: OLD_REMOTE, createdAt: OLD, version: "v1" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
    });
    assert.equal(s.relation, "local-newer");
    assert.equal(s.needsBackup, true, "本地变了 ⇒ 该备份");
    assert.equal(s.parts.providers, "local");
  });

  test("③c 远端比我新", () => {
    const s = compareState({
      localParts: OLD_LOCAL,
      remote: { parts: REMOTE, createdAt: NOW, version: "v2" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
    });
    assert.equal(s.relation, "remote-newer");
    assert.equal(s.parts.providers, "remote");
  });

  test("③d 两边都改了（同一个部件）⇒ 分歧", () => {
    const s = compareState({
      localParts: LOCAL,
      remote: { parts: REMOTE, createdAt: NOW, version: "v2" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
    });
    assert.equal(s.relation, "diverged");
    assert.equal(s.parts.providers, "both");
    assert.equal(s.needsBackup, true);
  });

  test("③e 从来没同步过 ⇒ 不知道", () => {
    const s = compareState({ localParts: LOCAL, remote: null, state: null });
    assert.equal(s.relation, "unknown");
    assert.equal(s.needsBackup, true, "从来没备份过 ⇒ 该提示备份");
  });

  test("③f 上次备份是什么时候", () => {
    const st = stateOf(LOCAL, LOCAL);
    st.lastAt = 12345;
    const s = compareState({ localParts: LOCAL, remote: { parts: LOCAL, createdAt: OLD, version: "v1" }, state: st });
    assert.equal(s.lastAt, 12345, "面板显示「上次备份是什么时候」用这个");
  });
});

/* ====================================================================== *
 * ④ 跑一次同步（内存里的假目标，不联网不碰磁盘）
 * ====================================================================== */

describe("④ 跑一次同步 —— 只调注入进来的适配器", () => {
  test("④a 远端是空的 ⇒ 推上去", async () => {
    const target = memoryTarget(null);
    const r = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: null,
      seal: fakeSeal(), open: fakeOpen(), now: NOW,
    });
    assert.equal(r.pushed, true);
    assert.equal(target.writes, 1);
    assert.equal(target.file.version, "v1");
  });

  test("④b 远端已有本地的内容 ⇒ 不写", async () => {
    const target = memoryTarget({ bytes: Buffer.from(JSON.stringify({ parts: LOCAL, createdAt: OLD })), version: "v1" });
    const r = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: OLD },
      state: stateOf(LOCAL, LOCAL), seal: fakeSeal(), open: fakeOpen(), now: NOW,
    });
    assert.equal(r.pushed, false);
    assert.equal(target.writes, 0, "内容一样不许写远端");
  });

  test("④c 远端在读之后被别人改了 ⇒ 明确报错 REMOTE_CHANGED", async () => {
    /* 写的时候发现版本对不上：条件写被拒（别的机器抢先写过了）。 */
    const target = memoryTarget(
      { bytes: Buffer.from(JSON.stringify({ parts: OLD_REMOTE, createdAt: OLD })), version: "v1" },
      {
        onWrite: () => {
          const e = new Error("precondition failed");
          e.code = "CHANGED";
          throw e;
        },
      },
    );
    let err = null;
    try {
      await runSync({
        target, localParts: LOCAL, localChangedAt: { providers: NOW },
        state: stateOf(OLD_LOCAL, OLD_REMOTE),
        seal: fakeSeal(), open: fakeOpen(), now: NOW,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "条件写被拒不许当没事");
    assert.equal(err.code, "REMOTE_CHANGED");
    assert.ok(REMOTE_CHANGED_CODES.includes("CHANGED"));
  });

  test("④d 远端那份打不开 ⇒ 停下并说清楚，不许用本机的悄悄盖上去", async () => {
    const target = memoryTarget({ bytes: Buffer.from("这不是备份", "utf8"), version: "v1" });
    let err = null;
    try {
      await runSync({
        target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: null,
        seal: fakeSeal(),
        open: async () => { throw new Error("口令不对"); },
        now: NOW,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "REMOTE_UNREADABLE", "远端坏了必须是这个错，不能是别的");
    assert.equal(target.writes, 0, "远端坏了不许写它——那会把另一台机器的更新顶掉");
  });

  test("④e 远端是空文件 ⇒ 也是坏文件，不是「远端没有」", async () => {
    const target = memoryTarget({ bytes: Buffer.alloc(0), version: "v1" });
    let err = null;
    try {
      await runSync({
        target, localParts: LOCAL, localChangedAt: {}, state: null,
        seal: fakeSeal(), open: fakeOpen(), now: NOW,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "REMOTE_UNREADABLE");
  });

  test("④f 拉下来的部件由调用方写回（本模块不写盘）", async () => {
    const target = memoryTarget({ bytes: Buffer.from(JSON.stringify({ parts: REMOTE, createdAt: NOW })), version: "v2" });
    const r = await runSync({
      target, localParts: OLD_LOCAL, localChangedAt: { providers: OLD },
      state: stateOf(OLD_LOCAL, OLD_REMOTE), seal: fakeSeal(), open: fakeOpen(), now: NOW,
    });
    assert.deepEqual(r.pull.providers, REMOTE.providers, "拉下来的东西要交给调用方写回去");
  });

  test("④g 目标适配器不合格 ⇒ 明确报错", async () => {
    await assert.rejects(
      () => runSync({ target: {}, localParts: LOCAL, state: null, seal: fakeSeal(), open: fakeOpen(), now: NOW }),
      (e) => e instanceof SyncError && e.code === "BAD_TARGET",
    );
  });

  test("④h 与 backup.mjs 拼起来能用：真加密真解密跑一遍", async () => {
    const backup = await import("../src/server/backup.mjs");
    const snap = backup.snapshotOf({ apiKey: "sk-test-0000-bai-key" }, { now: NOW });
    const target = memoryTarget(null);
    const r = await runSync({
      target,
      localParts: snap.parts,
      localChangedAt: { providers: NOW },
      state: null,
      seal: async (parts, { now }) => backup.exportBundle({ ...snap, parts, createdAt: now }, "test-passphrase-0000"),
      open: async (bytes) => backup.importBundle(bytes, "test-passphrase-0000"),
      now: NOW,
    });
    assert.equal(r.pushed, true, "真加密的那条路也要能推上去");
    const back = backup.importBundle(target.file.bytes, "test-passphrase-0000");
    assert.deepEqual(back.parts.providers.bai.apiKey, "sk-test-0000-bai-key", "推上去再取回来，内容要对");
  });
});

/* ====================================================================== *
 * ⑤ 目标语义
 * ====================================================================== */

describe("⑤ 目标语义 —— 本地目录 / WebDAV / GitHub", () => {
  test("⑤a 三种目标都写清楚了版本号与写的方式", () => {
    assert.deepEqual(TARGET_KINDS, ["local", "webdav", "github"]);
    for (const k of TARGET_KINDS) {
      const t = describeTarget(k);
      assert.equal(t.kind, k);
      assert.equal(typeof t.version, "string", "版本号是什么必须写清楚");
      assert.equal(typeof t.conditional, "boolean");
      assert.ok(t.file, "文件放哪要写清楚");
    }
  });

  test("⑤b 本地目录是盲写，WebDAV 与 GitHub 是条件写", () => {
    assert.equal(TARGETS.local.conditional, false, "本地目录没有服务端版本号");
    assert.equal(TARGETS.webdav.conditional, true, "WebDAV 用 ETag 条件写");
    assert.equal(TARGETS.github.conditional, true, "GitHub 用 blob SHA 条件写");
  });

  test("⑤c GitHub 的文件名带前缀目录（与 magpie 的 <prefix>/magpie/… 同形）", () => {
    assert.match(TARGETS.github.file, /^bai-router\//, "GitHub 上要落在自己的目录下，不能糊在仓库根");
  });

  test("⑤d 不认识的目标 ⇒ 明确报错", () => {
    assert.throws(() => describeTarget("ftp"), (e) => e instanceof SyncError && e.code === "BAD_TARGET");
  });
});

/* ====================================================================== *
 * ⑥ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */

/**
 * 把源码抄一份到临时目录，打上补丁，import 进来。
 * 补丁没打上（锚点对不上）就直接失败——「反向对照是假的」比「没有反向对照」更糟。
 */
async function brokenModule(from, to) {
  const src = await readFile(SRC, "utf8");
  const hits = src.split(from).length - 1;
  assert.equal(hits, 1, `反向对照的锚点必须恰好命中一次，实际 ${hits} 次`);
  const patched = src.replace(from, to);
  const dir = await mkdtemp(path.join(tmpdir(), "bai-sync-sabotage-"));
  const file = path.join(dir, "sync-broken.mjs");
  await writeFile(file, patched, "utf8");
  return import(pathToFileURL(file).href);
}

describe("⑥ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑥a 幂等那道闸拆了（每次都推）⇒ ②a 必须红", async () => {
    const broken = await brokenModule(
      "const shouldPush = !sameHashes(mergedHashes, R);",
      "const shouldPush = true;",
    );
    await assert.rejects(
      () => assertSecondSyncWritesNothing(broken),
      "每次同步都推 ⇒ ②a 那条断言必须失败，否则幂等是假做的",
    );
  });

  test("⑥b 冲突判据改成「本地永远赢」⇒ ①f 必须红", async () => {
    const broken = await brokenModule(
      "if (localAt > remoteCreatedAt) {",
      "if (true) {",
    );
    assert.throws(
      () => assertRemoteWins(broken, {
        localParts: LOCAL,
        localChangedAt: { providers: OLD },
        remote: { parts: REMOTE, createdAt: NOW, version: "v2" },
        state: stateOf({ providers: { bai: { apiKey: "sk-test-0000-old-key" } } }, { providers: { bai: { apiKey: "sk-test-0000-old-remote" } } }),
        now: NOW,
      }),
      "远端更新时本地赢 ⇒ ①f 那条断言必须失败",
    );
  });

  test("⑥c 第一次同步改成「本地也算改过」⇒ ①b 必须红", async () => {
    const broken = await brokenModule(
      "const lc = !first && lh !== stLocal[p];",
      "const lc = lh !== stLocal[p];",
    );
    assert.throws(
      () => assertFirstSyncTakesRemote(broken, {
        localParts: LOCAL,
        localChangedAt: { providers: NOW },
        remote: { parts: REMOTE, createdAt: OLD, version: "v1" },
        state: null,
        now: NOW,
      }),
      "第一次同步不拿远端的 ⇒ ①b 那条断言必须失败",
    );
  });

  test("⑥d 哈希不排序键 ⇒ 键序不同的同一份内容被算成两份 ⇒ 必须红", async () => {
    const broken = await brokenModule(
      "const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();",
      "const keys = Object.keys(value).filter((k) => value[k] !== undefined);",
    );
    assert.throws(
      () => assertHashIgnoresKeyOrder(broken),
      "键序不排序 ⇒ 哈希对不上，同一份配置会被当成变了",
    );
  });

  test("⑥e 远端单边改动没被认出来 ⇒ ①d 必须红", async () => {
    const broken = await brokenModule(
      "if (rc && !lc) {",
      "if (false) {",
    );
    const plan = broken.planSync({
      localParts: OLD_LOCAL,
      localChangedAt: { providers: OLD },
      remote: { parts: REMOTE, createdAt: NOW, version: "v2" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
      now: NOW,
    });
    assert.throws(
      () => assert.deepEqual(plan.pull.providers, REMOTE.providers, "远端单边改动没被认出来 ⇒ ①d 那条断言必须失败"),
      "远端单边改动没被拉下来 ⇒ ①d 那条断言必须失败",
    );
  });

  test("⑥f 单边改动被误当成冲突（比了时间）⇒ ①c 必须红", async () => {
    const broken = await brokenModule(
      "if (lc && !rc) {",
      "if (false) {",
    );
    const plan = broken.planSync({
      localParts: LOCAL,
      localChangedAt: { providers: LOCAL_CHANGE },
      remote: { parts: OLD_REMOTE, createdAt: REMOTE_CREATE, version: "v1" },
      state: stateOf(OLD_LOCAL, OLD_REMOTE),
      now: NOW,
    });
    assert.throws(
      () => assert.deepEqual(plan.push.providers, LOCAL.providers, "单边改动被当成冲突 ⇒ ①c 那条断言必须失败"),
      "只有本地改了却没推上去 ⇒ ①c 那条断言必须失败",
    );
  });
});

/* ====================================================================== *
 * ⑦ 纪律自检
 * ====================================================================== */

describe("⑦ 纪律自检", () => {
  test("⑦a 源码里没有 Date.now()：时刻一律由参数传入", async () => {
    const src = codeOnly(await readFile(SRC, "utf8"));
    assert.doesNotMatch(src, /Date\.now\(\)/, "本模块不许自己取时刻");
    assert.doesNotMatch(src, /new Date\(\)/, "本模块不许自己取时刻");
  });

  test("⑦b 源码里没有 fs / http / fetch：这层不碰磁盘也不联网", async () => {
    const src = codeOnly(await readFile(SRC, "utf8"));
    assert.doesNotMatch(src, /node:fs/, "这层不许读磁盘写磁盘");
    assert.doesNotMatch(src, /node:http|node:net|node:https/, "这层不许发网络请求");
    assert.doesNotMatch(src, /\bfetch\s*\(/, "这层不许发网络请求");
  });

  test("⑦c 不 import 本仓库任何模块（backup.mjs 也不许）", async () => {
    const src = await readFile(SRC, "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const im of imports) {
      assert.ok(im.startsWith("node:"), `只许 import node: 内置模块，found ${im}`);
    }
  });
});

/* ====================================================================== *
 * 工具
 * ====================================================================== */

/**
 * 把注释与字符串字面量去掉，只留代码（纪律自检用）。
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/**
 * 内存里的假同步目标：**不联网、不碰磁盘**。
 * 远端就是一个 { bytes, version }；写的时候按 ifVersion 判一下版本对不对。
 */
function memoryTarget(initial, opts = {}) {
  const st = { file: initial || null, writes: 0, onWrite: opts.onWrite || null };
  return {
    kind: "local",
    get writes() { return st.writes; },
    get file() { return st.file; },
    async read() {
      return st.file ? { bytes: st.file.bytes, version: st.file.version } : null;
    },
    async write(bytes, opts) {
      if (st.onWrite) st.onWrite(bytes, opts);
      if (opts.ifVersion != null && st.file && st.file.version !== opts.ifVersion) {
        const e = new Error("远端变过了");
        e.code = "CHANGED";
        throw e;
      }
      st.writes++;
      st.file = { bytes, version: `v${st.writes}` };
      return { version: st.file.version };
    },
  };
}

/** 假的 seal/open：只做 JSON 编解码，把「加密归 backup.mjs 管」这件事表达清楚。 */
function fakeSeal() {
  return async (parts, { now }) => Buffer.from(JSON.stringify({ parts, createdAt: now }), "utf8");
}
function fakeOpen() {
  return async (bytes) => JSON.parse(bytes.toString("utf8"));
}
