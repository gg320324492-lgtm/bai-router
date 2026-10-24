/**
 * scripts/publish-seed-test.mjs —— 随包默认快照同步（scripts/publish-seed.cjs）
 *
 * ## 这条测试在钉什么
 *
 *   随包快照（`src/server/config.defaults.json`）会**跟着安装包发给每一个新用户**。
 *   发布脚本每次发版都会用「发布机当前配置」刷新它一遍——那段逻辑里有**按渠道名写死的
 *   名单**，而漏改一处的后果是**静默**的：
 *
 *   · v1.0.65 加第 7 家（wbai）：故障转移链的白名单漏了 wbai → 随包快照里的链少了国际版，
 *     当时**闸门全绿、构建成功、发布成功，没有任何一处报错**。
 *   · v1.0.89 加第 8 家（mm）：同一个位置又漏了 mm —— 而且这次更狠：发布机跑的是上一版，
 *     `config.json` 里**根本没有 mm 块** → mm 会被**整个从随包快照里抹掉**。
 *
 *   所以这里钉三件事：
 *   ① **名单不许漏渠道**：SEED_CHANNELS 与仓库的 failover.chain 必须逐条相等。
 *      → 加了第 9 家忘了改名单，本组当场红。
 *   ② **同步结果必须与仓库那份逐字相同**：拿一份「每个渠道都被漂移过、且没有 mm 块」的
 *      假发布机配置去跑 syncSeed，结果必须与 CUR 逐字一致。
 *      → 这一条同时钉住「mm 没被抹掉」「键顺序没漂」「每个渠道的模型/映射都取自仓库」。
 *   ③ **凭据一条都不许进快照**。
 *
 * ## 反向对照
 *
 *   手工改坏 scripts/publish-seed.cjs 里任意一处（把 mm 从名单里删掉／把 mm 块删掉／
 *   去掉键排序／漏掉某渠道的清理），下面对应的断言当场红。逐条锚点见文末。
 *
 * ## 红线
 *
 *   🔴 本文件**不读真实的 `%APPDATA%\bai-router\config.json`**：发布机配置里全是真凭据。
 *      夹具一律现造（且刻意造得**每个渠道都漂移过**——漂移才有鉴别力）。
 *   🔴 本文件**零网络、零写盘**（只读仓库里的 config.defaults.json）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const { syncSeed, reorderLike, SEED_CHANNELS, SEED_SUB_CHANNELS } = require("../scripts/publish-seed.cjs");

/** 仓库里已提交的出厂默认（权威那份）。 */
const CUR = JSON.parse(readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
const SEED_SRC = readFileSync(path.join(REPO, "scripts", "publish-seed.cjs"), "utf8");

/* ---------- 夹具：一台「上一版的发布机」+ 处处漂移的配置 ----------
 *
 * ① 没有 mm 块 —— 模拟**发布机跑的是上一版**（v1.0.88 写的 config.json 就是这样）。
 * ② 每个渠道的 availableModels / mapping / defaultModel 都**故意漂移**：
 *    漂移才有鉴别力 —— 若某个渠道没被「取自仓库」的逻辑覆盖，漂移的值就会留在快照里，
 *    下面那条「逐字相同」的断言立刻红。
 * ③ 凭据字段全是假值，但**形状是真的**（证明同步逻辑确实在清它们）。
 */
function fakeLocal() {
  const l = JSON.parse(JSON.stringify(CUR));
  delete l.mm;                                   // ① 上一版的发布机：没有 mm 块
  delete l._modelsSynced;

  l.apiKey = "fake-api-key-bai-0001";
  l.proxy = "http://127.0.0.1:7897";              // 本机状态：不该进出厂默认
  l.failover = { enabled: false, chain: CUR.failover.chain.slice() };
  l.sn.apiKey = "fake-sn-key-0002";
  l.sn.availableModels = ["drifted-sn-model"];
  l.sn.mapping = { "claude-opus-5": { target: "drifted-sn-model", label: "drifted" } };
  l.sn.defaultModel = "drifted-sn-model";
  l.zen.apiKey = "fake-zen-key-0003";
  l.zen.availableModels = ["drifted-zen-model"];
  l.zen.mapping = { "claude-opus-5": { target: "drifted-zen-model", label: "drifted" } };
  l.zen.defaultModel = "drifted-zen-model";
  l.wb.accessToken = "fake-wb-jwt-0004";
  l.wb.refreshToken = "fake-wb-refresh-0004";
  l.wb.deviceToken = "fake-wb-device-0004";
  l.wb.userId = "fake-wb-user-0004";
  l.wb.availableModels = ["drifted-wb-model"];
  l.wb.mapping = { "claude-opus-5": { target: "drifted-wb-model", label: "drifted" } };
  l.wb.defaultModel = "drifted-wb-model";
  l.wbai.accessToken = "fake-wbai-jwt-0005";
  l.wbai.refreshToken = "fake-wbai-refresh-0005";
  l.wbai.deviceToken = "fake-wbai-device-0005";
  l.wbai.userId = "fake-wbai-user-0005";
  l.wbai.availableModels = ["drifted-wbai-model"];
  l.wbai.mapping = { "claude-opus-5": { target: "drifted-wbai-model", label: "drifted" } };
  l.wbai.defaultModel = "drifted-wbai-model";
  l.or.keys = [{ key: "fake-or-key-0006" }];
  l.or.availableModels = ["drifted-or-model"];
  l.or.mapping = { "claude-opus-5": { target: "drifted-or-model", label: "drifted" } };
  l.or.defaultModel = "drifted-or-model";
  l.qd.token = "fake-jt-token-0007";
  l.qd.tokenFile = "C:/fake/temp/qoder-token.json";   // 本机绝对路径：不该进快照
  l.qd.modelsFile = "C:/fake/temp/qoder-models.json";
  l.qd.availableModels = ["drifted-qd-model"];
  l.qd.mapping = { "claude-opus-5": { target: "drifted-qd-model", label: "drifted" } };
  l.qd.defaultModel = "drifted-qd-model";
  l.availableModels = ["drifted-bai-model"];
  l.defaultModel = "drifted-bai-model";
  l.mapping = { "claude-opus-5": { target: "drifted-bai-model", label: "drifted" } };
  return l;
}

/** 与仓库那份逐字比较（用写盘时的同一套序列化方式：JSON.stringify(seed, null, 2) + "\n"）。 */
const asFile = (seed) => JSON.stringify(seed, null, 2) + "\n";
const asFileCur = () => JSON.stringify(CUR, null, 2) + "\n";

/* ====================================================================== *
 * ① 名单不许漏渠道
 * ====================================================================== */

describe("发版 · 渠道名单不许漏（漏了就是静默故障）", () => {
  test("SEED_CHANNELS 与仓库 failover.chain 逐条相等", () => {
    const chain = CUR.failover.chain;
    const miss = chain.filter((c) => !SEED_CHANNELS.includes(c));
    const extra = SEED_CHANNELS.filter((c) => !chain.includes(c));
    assert.deepEqual(miss, [],
      `这些渠道在链上、却不在发布脚本的名单里 → 随包快照会把它们**静默剔掉**：${miss.join(",")}`);
    assert.deepEqual(extra, [],
      `这些渠道在名单里、却不在链上：${extra.join(",")}`);
  });

  test("名单覆盖仓库里每一个嵌套渠道块（漏一个 = 该渠道的模型/映射不取自仓库）", () => {
    const nested = Object.keys(CUR).filter((k) => (
      CUR[k] && typeof CUR[k] === "object" && !Array.isArray(CUR[k]) && "relayPort" in CUR[k]
    ));
    for (const k of nested) {
      assert.ok(SEED_SUB_CHANNELS.includes(k),
        `渠道「${k}」是嵌套块，但不在「按渠道循环」的名单里 → 它的 availableModels/mapping/defaultModel 不会取自仓库`);
    }
  });

  test("名单在源码里只写一处（不许散成三份）", () => {
    const decl = SEED_SRC.match(/const SEED_CHANNELS = \[([^\]]+)\]/);
    assert.ok(decl, "publish-seed.cjs 里必须有 SEED_CHANNELS 常量");
    // 不许再出现别的「按渠道名写死的数组」
    const others = SEED_SRC.match(/\["bai"[^\]]*\]/g) || [];
    assert.equal(others.length, 1,
      `publish-seed.cjs 里只许有一处写死的渠道名单，现在有 ${others.length} 处：${others.join(" / ")}`);
  });
});

/* ====================================================================== *
 * ② 同步结果必须与仓库那份逐字相同
 * ====================================================================== */

describe("发版 · 随包快照必须与仓库那份逐字相同", () => {
  test("★ 发布机跑的是上一版（没有 mm 块）时，mm 仍必须在快照里", () => {
    const { seed } = syncSeed(fakeLocal(), CUR);
    assert.ok(seed.mm, "mm 块被整个抹掉了 —— 上一版的发布机配置里没有 mm 键");
    assert.equal(seed.mm.defaultModel, CUR.mm.defaultModel);
    assert.deepEqual(seed.mm.availableModels, CUR.mm.availableModels);
  });

  test("★ mm 块在键顺序上落在 wbai 与 or 之间（清单顺序 = 转移优先级顺序）", () => {
    const { seed } = syncSeed(fakeLocal(), CUR);
    const keys = Object.keys(seed);
    const iWbai = keys.indexOf("wbai"), iMm = keys.indexOf("mm"), iOr = keys.indexOf("or");
    assert.ok(iMm > 0, "mm 不在顶层键里");
    assert.ok(iMm > iWbai && iMm < iOr,
      `mm 的位置不对：keys = [${keys.join(",")}] —— 键顺序漂移会让「发布后 git status 干净」这条自检永远报警`);
  });

  test("★ 全量逐字相同（每个渠道的漂移值都必须被仓库那份覆盖）", () => {
    const { seed } = syncSeed(fakeLocal(), CUR);
    const got = asFile(seed), want = asFileCur();
    if (got !== want) {
      /* 给出第一处差异，别只说「不相等」——那没法定位。 */
      const a = got.split("\n"), b = want.split("\n");
      let i = 0;
      while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
      assert.fail(
        `随包快照与仓库那份不一致（第 ${i + 1} 行起）\n  实际: ${a[i]}\n  应为: ${b[i]}\n`
        + `（若差在某个渠道的 availableModels/mapping/defaultModel，说明那个渠道没被「取自仓库」覆盖）`);
    }
  });

  test("故障转移链没被白名单剔掉任何一段", () => {
    const { seed } = syncSeed(fakeLocal(), CUR);
    assert.deepEqual(seed.failover.chain, CUR.failover.chain,
      "链被改短了 —— 白名单漏了某个渠道");
    assert.equal(seed.failover.enabled, CUR.failover.enabled,
      "「本机勾没勾故障转移」是用户偏好，不该进出厂默认");
  });
});

/* ====================================================================== *
 * ③ 凭据一条都不许进快照
 * ====================================================================== */

describe("发版 · 凭据一条都不许进随包快照", () => {
  test("各渠道的凭据字段全空", () => {
    const { seed } = syncSeed(fakeLocal(), CUR);
    assert.equal(seed.apiKey, "", "bai 的 apiKey");
    assert.equal(seed.sn.apiKey, "", "sn 的 apiKey");
    assert.equal(seed.zen.apiKey, "", "zen 的 apiKey");
    for (const k of ["wb", "wbai"]) {
      for (const f of ["accessToken", "refreshToken", "deviceToken", "userId"]) {
        assert.equal(seed[k][f], "", `${k}.${f} 必须清空（v1.0.65 实测产物里带过真实 UUID）`);
      }
    }
    assert.deepEqual(seed.or.keys, [], "or 的三把 key 绝不能进快照");
    assert.equal(seed.qd.token, "", "qd 的 jobToken");
    assert.equal(seed.qd.tokenFile, "", "qd 的 tokenFile 是本机绝对路径（C13 闸门会拦）");
    assert.equal(seed.qd.modelsFile, "", "qd 的 modelsFile 是本机绝对路径（C13 闸门会拦）");
  });

  test("mm 块里没有任何凭据字段（令牌只存内存，见 src/server/mm-auth.mjs）", () => {
    const { seed } = syncSeed(fakeLocal(), CUR);
    const credish = Object.keys(seed.mm).filter((k) => /token|key|secret|passw|auth/i.test(k));
    assert.deepEqual(credish, [],
      `mm 块里出现了疑似凭据字段：${credish.join(",")} —— 会员令牌只该在内存里，绝不能落盘`);
  });

  test("快照里搜不到任何假凭据值（真的去扫，不是看代码）", () => {
    const { seed } = syncSeed(fakeLocal(), CUR);
    const text = JSON.stringify(seed);
    for (const v of [
      "fake-api-key-bai-0001", "fake-sn-key-0002", "fake-zen-key-0003",
      "fake-wb-jwt-0004", "fake-wb-refresh-0004", "fake-wb-device-0004", "fake-wb-user-0004",
      "fake-wbai-jwt-0005", "fake-wb-user-0005",
      "fake-or-key-0006", "fake-jt-token-0007",
    ]) {
      assert.ok(!text.includes(v), `快照里出现了假凭据值 ${v} —— 清理没生效`);
    }
    assert.ok(!text.includes("C:/fake/temp"), "快照里出现了本机绝对路径");
  });
});

/* ====================================================================== *
 * ⑤ 用户自己的选择不进随包快照（2026-10-25）
 * ====================================================================== *
 *
 * 同步逻辑开头是 `const def = { ...local }` ⇒ **整份**本地配置都会进快照。
 * 而「用户选了哪条更新通道」是**每个用户自己的选择**（托盘菜单里切的）⇒
 * 把它烘进出厂默认 = **所有新用户默认都是测试版用户** ⇒ 稳定版用户会收到 beta。
 *
 * 2026-10-25 真踩到：发布机装的是 beta 版（`updateChannel: "beta"`）⇒
 * 发布时它被抄进了 config.defaults.json ⇒ 被发布闸门拦下（工作区变脏）。
 * 闸门是兜底，**根因在同步逻辑** ⇒ 这里钉死。
 */
describe("发版 · 用户自己的选择不进随包快照", () => {
  test("★ updateChannel（更新通道）不进出厂默认", () => {
    const l = fakeLocal();
    l.updateChannel = "beta";
    const { seed } = syncSeed(l, CUR);
    assert.equal(seed.updateChannel, undefined,
      "★ 用户的更新通道被烘进了出厂默认 ⇒ 所有新用户默认都是测试版用户");
  });

  test("★ 出厂默认里本来就没有这个键（仓库那份也不许有）", () => {
    assert.equal(CUR.updateChannel, undefined,
      "★ 仓库的 config.defaults.json 里出现了 updateChannel —— 出厂默认不该记用户的通道选择");
  });
});

/* ====================================================================== *
 * ④ reorderLike 本身的行为（顶层用它排键序）
 * ====================================================================== */

describe("发版 · reorderLike 的语义", () => {
  test("按 ref 的键顺序重建；ref 没有的追加在后面", () => {
    const out = reorderLike({ a: 1, b: 2 }, { b: 20, c: 30, a: 10 });
    assert.deepEqual(Object.keys(out), ["a", "b", "c"]);
    assert.deepEqual(out, { a: 10, b: 20, c: 30 });
  });

  test("ref 里独有的键会被丢掉 —— 所以顶层必须先合并再排（见 publish-seed.cjs 的注释）", () => {
    const out = reorderLike({ a: 1, gone: 2 }, { a: 10 });
    assert.deepEqual(Object.keys(out), ["a"], "reorderLike 只搬动两边都有的键");
  });
});

/* ====================================================================== *
 * 反向对照锚点（手工改坏 → 对应断言必须当场红）
 *
 * ⚠ **先读这段再改**：下面 ② 那条是**两处一起改**才红。原因：
 *   「显式带 mm 块」与「顶层合并补齐 CUR 的键」这两道机制**互为双保险**——
 *   单独拿掉任何一道，mm 仍然在快照里（我实测过：只删 `def.mm` 那一行，测试照样全绿）。
 *   真正会致坏的是**两道都没有**——那正是原代码的样子。
 *   所以改代码时**别单独删一道就以为还有另一道**：删了另一道也跟着确认。
 * ====================================================================== *
 *
 *   ① 名单漏渠道：把 publish-seed.cjs 的 SEED_CHANNELS 里的 "mm" 删掉
 *      → 「SEED_CHANNELS 与仓库 failover.chain 逐条相等」红（miss 里出现 mm），
 *        「名单覆盖仓库里每一个嵌套渠道块」红，
 *        且「★ 全量逐字相同」「故障转移链没被白名单剔掉任何一段」也红。
 *        （实测：4 项红）
 *
 *   ② mm 块被整个抹掉（= 复原原代码）：
 *      ① 删掉 `if (CUR.mm) def.mm = { ...CUR.mm };`
 *      ② 把 `const seed = reorderLike(CUR, { ...CUR, ...def });` 改成
 *         `const seed = reorderLike(CUR, def);`
 *      → 「★ 发布机跑的是上一版（没有 mm 块）时，mm 仍必须在快照里」红，
 *        「★ mm 块在键顺序上落在 wbai 与 or 之间」红，
 *        「★ 全量逐字相同」红，「mm 块里没有任何凭据字段」红。
 *        （实测：4 项红）
 *
 *   ③ 键顺序漂掉：把 `const seed = reorderLike(CUR, { ...CUR, ...def });` 改成
 *      `const seed = def;`
 *      → 「★ mm 块在键顺序上落在 wbai 与 or 之间」红。
 *
 *   ④ 某个渠道的模型不取自仓库：把 SEED_SUB_CHANNELS 里的 "wb" 删掉
 *      → 「★ 全量逐字相同」红（wb 的 availableModels 留了漂移值）。
 *
 *   ⑤ 顶层 mapping 不取自仓库：删掉
 *      `if (CUR.mapping && typeof CUR.mapping === "object") def.mapping = CUR.mapping;`
 *      → 「★ 全量逐字相同」红（bai 的档位映射留了漂移值）。
 *      （这条是 v1.0.89 顺手修的缺口：原先顶层 mapping 漏了「取自仓库」。）
 *
 *   ⑥ 凭据没清干净：把 WBD 里的 userId 改成 "userId"
 *      → 「各渠道的凭据字段全空」与「快照里搜不到任何假凭据值」红。
 * ====================================================================== */
