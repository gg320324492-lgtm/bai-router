/* 代码插件运行时（宿主 `src/server/pluginrt.mjs` + 子进程 `src/server/plugin-worker.mjs`）
 * 的口径测试。
 *
 * ## 这份测试在守什么
 *
 * 本仓已经有两套**声明式**插件（provider 插件 / middleware），它们只说「改什么」、
 * 不说「怎么算」。代码插件是第三套：**插件里跑真 JS**。magpie 的答案是「网关进程内的
 * moejs」，本仓的答案是「独立子进程 + Node 权限模型 + 窄协议」——因为本仓的插件是要
 * **分发给别人的代码**，必须假设它是恶意的。
 *
 * 这份测试盯住七件事（下面 ①–⑩ 各节按这个顺序展开）：
 *
 *   ① **清单**（① 解析 / ② 校验）：只吃 JSON；逐项校验；错要说得像人话；
 *      凭据字段一律拒收；
 *   ② **权限展示**（③ 节）：装之前要能一眼看见「它要读什么、要不要联网」（权限模型
 *      是按路径授权的，用户不看清单就等于盲签）；
 *   ③ **摘要**（④ 节）：插件唯一能看见的是**摘要**——凭据的值根本不进子进程，
 *      凭据头的**名字**也剔掉；
 *   ④ **决策**（⑤ 节）：宿主只认一张表。凭据头拒、头注入拒、不认识的字段拒、
 *      拒绝必须给理由；
 *   ⑤ **沙箱**（⑥ 节 + ⑦h/⑦i）：没有权限模型 ⇒ **不跑用户代码**（宁可少一个
 *      功能）；清单说「不许联网」⇒ 子进程里那几扇出网的门**真的关掉**
 *      （Node 的权限模型不管网络，这一层只能补在子进程里）；
 *   ⑥ **端到端**（⑦ 节）：装 → transform → remove 走一遍**真子进程**（这一节在
 *      没有权限模型的 Node 上跳过，但「拒绝」那条必须照样验）；
 *   ⑦ **协议**（⑧ 节）：令牌前缀是这条通道的防伪证机制 —— 插件能往 stdout 灌
 *      任何东西，却**写不出**一行带令牌的协议消息。
 *
 * 另有两节：⑨ 零依赖与防漂移（不许 import 仓库模块、不许取 Date.now、行尾必须 LF）、
 * ⑩ 反向对照（把实现改坏，证明对应的断言**真的会红**）。
 *
 * ## 纪律
 *
 *   ★ **反向对照**：末尾一节把实现改坏（复制到临时目录改几处再 import 进来），
 *     证明对应的断言**真的会红** —— 不会红的断言等于没写。
 *   ★ **零凭据**：夹具里的凭据一律现造的假货（明写着 test / fake / 0000…）。
 *   ★ **不碰真数据**：临时目录一律在 `os.tmpdir()` 下，**绝不**写 `%APPDATA%\bai-router`
 *     或真 `~/.claude/settings.json`。
 *   ★ **子进程按 PID 收**：跑起来的子进程由运行时自己 kill（`child.kill` 就是按 PID），
 *     测试退出前一律 `close()`。
 *   ★ 时间一律由参数注入（`opts.now`），本文件不取 `Date.now()`。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MANIFEST_VERSION,
  MANIFEST_FILENAME,
  PLUGINRT_DIRNAME,
  PLUGIN_ID_RE,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  ENTRY_EXTENSIONS,
  parseManifest,
  validateManifest,
  validateDecision,
  summarizeRequest,
  describePermissions,
  detectPermissionFlag,
  isCredentialHeader,
  isCredentialParam,
  formatErrors,
  createRuntime,
} from "../src/server/pluginrt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_PATH = path.join(ROOT, "src", "server", "pluginrt.mjs");
const WORKER_PATH = path.join(ROOT, "src", "server", "plugin-worker.mjs");
const HOST_SRC = fs.readFileSync(HOST_PATH, "utf8");
const WORKER_SRC = fs.readFileSync(WORKER_PATH, "utf8");

/** 宿主给的时刻（假的，但逐字可断言）。 */
const NOW = 1_700_000_000_000;

/** 一份合法的清单（后面的用例都从它改出来）。 */
const GOOD = Object.freeze({
  manifestVersion: 1,
  id: "word-guard",
  name: "敏感词拦截",
  entry: "main.mjs",
  timeoutMs: 2000,
  permissions: { fsRead: [], net: false },
});

/** 改一份清单（浅拷贝，够用）。 */
const withField = (patch) => ({ ...GOOD, ...patch });

/* 一次请求（宿主手上真正拿着的那一份，摘要由宿主自己洗）。 */
const request = (patch = {}) => ({
  channel: "sn",
  tier: "claude-opus-5",
  model: "glm-5.2",
  protocol: "anthropic",
  path: "/v1/messages",
  stream: true,
  headers: {
    "x-api-key": "sk-test-0000000000000000000000000000",
    "content-type": "application/json",
  },
  params: { temperature: 0.7, max_tokens: 4096 },
  ...patch,
});

/* ====================================================================== *
 * 夹具：几份「插件代码」
 *
 * 插件写在 os.tmpdir() 下的临时目录里，**绝不**落在仓库里。
 * 凭据一律现造的假货。
 * ====================================================================== */

/** 正常插件：按档位改参数，并把看到的摘要记进 api.log。 */
const PLUGIN_OK = `export default function (request, api) {
  api.log("看到 " + request.channel + " 的 " + request.model
    + "（档位 " + request.tier + "，时刻 " + api.now + "）"
    + "；头名：" + JSON.stringify(request.headerNames));
  if (request.tier !== "claude-opus-5") return { action: "allow" };
  return { action: "modify", params: { temperature: 0.2 }, headers: { "x-plugin": "on" } };
};
`;

/** 抛错的插件：宿主必须听见这次失败（子进程不许死）。 */
const PLUGIN_THROWS = `export default function () {
  throw new Error("插件自己炸了（测试夹具）");
};
`;

/** 返回坏形状的插件：形状由宿主去拒，子进程只管原样递回去。 */
const PLUGIN_BAD_SHAPE = `export default function () {
  return { action: "modify", headers: { authorization: "Bearer sk-test-0000000000000000" } };
};
`;

/** 拒绝的插件：给一句人话理由。 */
const PLUGIN_DENY = `export default function () {
  return { action: "deny", reason: "这个渠道这一档今天不接活" };
};
`;

/**
 * 试着伪造协议消息的插件。
 *
 * ⚠ 假的这条**故意不带令牌前缀**，而且 id 用 "r2"（宿主那边 init 是 r1、
 * 第一次 transform 就是 r2）—— 宿主要是只按 id 收答复、不看令牌，
 * 这条就会把真的答复顶掉，请求被凭这条假消息拒掉。
 */
const PLUGIN_FORGER = `export default function (request, api) {
  console.log(JSON.stringify({
    t: "res", id: "r2", ok: true, result: { action: "deny", reason: "这是插件伪造的" }
  }));
  api.log("插件喊了一嗓子");
  return { action: "allow" };
};
`;

/** 乱打印的插件：stdout 上全是噪声。 */
const PLUGIN_NOISY = `export default function (request, api) {
  console.log("插件自己打印的一行");
  console.log("插件自己打印的第二行");
  return { action: "allow" };
};
`;

/**
 * 想联网的插件：清单说不许联网，它就得连不出去。
 *
 * ⚠ 只**看**门关没关，不真的发请求：真发出去的话，测试要么等一次真实的
 *   DNS 超时（慢），要么（更糟）真的连出去 —— 测试不该有网络行为。
 */
const PLUGIN_NET = `export default async function (request, api) {
  let httpsBlocked = false;
  try { await import("node:https"); } catch (e) { httpsBlocked = true; }
  return {
    action: "modify",
    headers: {
      "x-fetch-gone": String(typeof fetch === "undefined"),
      "x-websocket-gone": String(typeof WebSocket === "undefined"),
      "x-https-blocked": String(httpsBlocked),
      "x-getbuiltin-gone": String(typeof process.getBuiltinModule === "undefined"),
      "x-binding-gone": String(typeof process.binding === "undefined"),
      "x-dlopen-gone": String(typeof process.dlopen === "undefined"),
    },
  };
};
`;

/* 临时目录：插件夹具 + 改坏用的副本，全在 os.tmpdir() 下。 */
const TMP_DIRS = [];
process.on("exit", () => {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录留着也无妨 */ }
  }
});

/** 造一个临时目录（登记起来，退出时删）。 */
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
}

/**
 * 造一个「装得起来」的插件目录：plugin.json + 入口文件。
 *
 * ⚠ 目录一律在 `os.tmpdir()` 下 —— 真数据目录（%APPDATA%\bai-router）与真
 * `~/.claude/settings.json` 是**不许**碰的。
 */
function makePluginDir(files, manifest = GOOD) {
  const dir = tmpDir("bai-pluginrt-plugin-");
  fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), "utf8");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

/** 造一个运行时（时刻固定、日志收进数组）。 */
async function runtimeWith(opts = {}) {
  const logs = [];
  const rt = createRuntime({
    now: () => NOW,
    timeoutMs: 5000,
    log: (e) => logs.push(e),
    ...opts,
  });
  return { rt, logs };
}

/**
 * 在一个运行时里跑一段东西，**跑完一律 close**。
 *
 * close 会把每个插件的子进程按 PID 杀掉（`child.kill("SIGKILL")`）——
 * 留着不管的话，断言一失败就留下一堆孤儿进程（子进程自己也会因为管道关闭而
 * 退出，但那是「碰巧」，不是「按规矩」）。
 */
async function withRuntime(fn, opts = {}) {
  const { rt, logs } = await runtimeWith(opts);
  try {
    return await fn(rt, logs);
  } finally {
    rt.close();
  }
}

/* ====================================================================== *
 * ① 解析：只吃 JSON
 * ====================================================================== */
describe("① 解析 —— 清单只吃 JSON", () => {
  test("①a 合法 JSON 读成对象", () => {
    const obj = parseManifest(JSON.stringify(GOOD));
    assert.equal(obj.id, "word-guard");
    assert.equal(obj.entry, "main.mjs");
  });

  test("①b 语法错 ⇒ 人话（说清在哪、缺了什么）", () => {
    /* ⚠ 只查「是不是人话 + 有没有位置」，**不查 Node 的具体措辞** ——
       各版本 JSON 报错文本不一样，把措辞写进断言等于给 Node 上了锁。 */
    for (const bad of ['{"id": "word-guard",}', '{"id": "word-guard"']) {
      assert.throws(
        () => parseManifest(bad),
        (e) => {
          assert.ok(/不是合法的 JSON/.test(e.message), "得说清是 JSON 坏了，不是「invalid schema」");
          assert.ok(/第 \d+ 行第 \d+ 列/.test(e.message), "得说清坏在哪");
          assert.ok(/[一-龥]/.test(e.message), "得是人话");
          return true;
        }
      );
    }
  });

  test("①c YAML 明确拒收，并说清为什么", () => {
    assert.throws(
      () => parseManifest("id: word-guard\nentry: main.mjs\n"),
      (e) => /JSON/.test(e.message) && /YAML/.test(e.message),
      "要说清是格式不支持（而不是清单写错了）"
    );
  });

  test("①d 空文件、顶层不是对象、不是文本 ⇒ 都拒收", () => {
    assert.throws(() => parseManifest("   "), (e) => /空的/.test(e.message));
    assert.throws(() => parseManifest("[1,2,3]"), (e) => /顶层/.test(e.message));
    assert.throws(() => parseManifest('"word-guard"'), (e) => /顶层/.test(e.message));
    assert.throws(() => parseManifest(42), (e) => /字符串/.test(e.message));
  });
});

/* ====================================================================== *
 * ② 清单校验
 * ====================================================================== */
describe("② 清单校验 —— 逐项给人话", () => {
  test("②a 合法清单全过，且被归一化", () => {
    const v = validateManifest(GOOD);
    assert.equal(v.ok, true, formatErrors(v.errors));
    assert.deepEqual(v.errors, []);
    assert.equal(v.manifest.id, "word-guard");
    assert.equal(v.manifest.timeoutMs, 2000);
    assert.deepEqual(v.manifest.permissions, { fsRead: [], net: false });
  });

  test("②b 没写 timeoutMs ⇒ 用默认；没写 permissions ⇒ 一个权限都没有", () => {
    const v = validateManifest({ manifestVersion: 1, id: "x", name: "X", entry: "main.mjs" });
    assert.equal(v.ok, true, formatErrors(v.errors));
    assert.equal(v.manifest.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.deepEqual(v.manifest.permissions, { fsRead: [], net: false },
      "默认必须一个权限都没有（默认安全）");
  });

  test("②c 格式版本：缺了 / 不是整数 / 不认识，都要说人话", () => {
    const miss = validateManifest((() => { const o = { ...GOOD }; delete o.manifestVersion; return o; })());
    assert.equal(miss.ok, false);
    assert.ok(miss.errors.some((e) => e.field === "manifestVersion" && /缺少/.test(e.message)));

    const notInt = validateManifest(withField({ manifestVersion: "1" }));
    assert.equal(notInt.ok, false);
    assert.ok(notInt.errors.some((e) => e.field === "manifestVersion" && /整数/.test(e.message)));

    const wrong = validateManifest(withField({ manifestVersion: 2 }));
    assert.equal(wrong.ok, false);
    assert.ok(wrong.errors.some((e) => e.field === "manifestVersion" && /只认 1/.test(e.message)));
  });

  test("②d 插件键：只许小写字母、数字与短横线", () => {
    assert.ok(PLUGIN_ID_RE.test("word-guard"));
    assert.ok(PLUGIN_ID_RE.test("w2"));
    for (const bad of ["Word-Guard", "word_guard", "word guard", "-guard", "guard!"]) {
      const v = validateManifest(withField({ id: bad }));
      assert.equal(v.ok, false, `「${bad}」不该通过`);
      assert.ok(
        v.errors.some((e) => e.field === "id" && /不合法/.test(e.message)),
        `「${bad}」的报错要说的是「键不合法」`
      );
    }
  });

  test("②e 入口文件：扩展名、绝对路径、「..」都要挡", () => {
    const badExt = validateManifest(withField({ entry: "main.js" }));
    assert.equal(badExt.ok, false);
    assert.ok(badExt.errors.some((e) => e.field === "entry" && /扩展名/.test(e.message)));

    const abs = validateManifest(withField({ entry: "C:\\plugins\\main.mjs" }));
    assert.equal(abs.ok, false);
    assert.ok(abs.errors.some((e) => e.field === "entry" && /相对/.test(e.message)),
      "绝对路径在别人的机器上指不到同一个文件");

    const up = validateManifest(withField({ entry: "../outside/main.mjs" }));
    assert.equal(up.ok, false);
    assert.ok(up.errors.some((e) => e.field === "entry" && /\.\./.test(e.message)),
      "插件只许读自己目录里的东西");

    /* 只许 .mjs 与 .cjs 两种模块形态 */
    assert.deepEqual([...ENTRY_EXTENSIONS].sort(), [".cjs", ".mjs"]);
    for (const ok of ["main.mjs", "main.cjs", "sub/main.mjs"]) {
      const v = validateManifest(withField({ entry: ok }));
      assert.equal(v.ok, true, `${ok} 应当合法：${formatErrors(v.errors)}`);
    }
  });

  test("②f 超时：非整数 / 不为正 / 太大都要报错", () => {
    const notInt = validateManifest(withField({ timeoutMs: 1.5 }));
    assert.equal(notInt.ok, false);
    assert.ok(notInt.errors.some((e) => e.field === "timeoutMs" && /整数/.test(e.message)));

    const zero = validateManifest(withField({ timeoutMs: 0 }));
    assert.equal(zero.ok, false);
    assert.ok(zero.errors.some((e) => e.field === "timeoutMs" && /正/.test(e.message)));

    const huge = validateManifest(withField({ timeoutMs: MAX_TIMEOUT_MS + 1 }));
    assert.equal(huge.ok, false);
    assert.ok(huge.errors.some((e) => e.field === "timeoutMs" && /太大/.test(e.message)),
      "插件挂在热路径上，跑太久会把中转拖慢");
  });

  test("②g 权限：未知字段 / fsRead 不是数组 / 相对路径 / net 不是布尔", () => {
    const unknown = validateManifest(withField({ permissions: { fsRead: [], net: false, write: true } }));
    assert.equal(unknown.ok, false);
    assert.ok(unknown.errors.some((e) => e.field === "permissions.write" && /不认识的字段/.test(e.message)));

    const notArray = validateManifest(withField({ permissions: { fsRead: "D:\\资料" } }));
    assert.equal(notArray.ok, false);
    assert.ok(notArray.errors.some((e) => e.field === "permissions.fsRead" && /数组/.test(e.message)));

    const relative = validateManifest(withField({ permissions: { fsRead: ["资料\\词库"] } }));
    assert.equal(relative.ok, false);
    assert.ok(relative.errors.some((e) => e.field === "permissions.fsRead" && /绝对路径/.test(e.message)),
      "权限模型是按路径授权的，相对路径在谁的机器上指到哪说不准");

    const netBad = validateManifest(withField({ permissions: { fsRead: [], net: "yes" } }));
    assert.equal(netBad.ok, false);
    assert.ok(netBad.errors.some((e) => e.field === "permissions.net" && /true 或 false/.test(e.message)));
  });

  test("②h 清单里不许带凭据字段（要点名，还要说清为什么）", () => {
    for (const k of ["apiKey", "token", "secret", "password", "authorization"]) {
      const v = validateManifest(withField({ [k]: "sk-test-0000000000000000000000000000" }));
      assert.equal(v.ok, false, `「${k}」不该通过`);
      assert.ok(
        v.errors.some((e) => e.field === k && /凭据/.test(e.message)),
        `「${k}」要单独点名（且要说清是凭据）`
      );
      assert.ok(
        v.errors.some((e) => /要分发给别人的东西/.test(e.message)),
        "报错要说明为什么不行"
      );
    }
  });

  test("②i 不认识的字段要报错（不是静默忽略）", () => {
    const v = validateManifest(withField({ enrty: "main.mjs" }));
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.field === "enrty" && /不认识的字段/.test(e.message)),
      "手误字段要单独点名，否则作者会绕远路"
    );
  });

  test("②j 一次报全所有问题（不是只报第一个）", () => {
    const v = validateManifest({
      manifestVersion: 9,
      id: "Word-Guard",
      name: "",
      entry: "main.js",
      timeoutMs: -1,
      permissions: { net: "yes" },
    });
    assert.equal(v.ok, false);
    const fields = v.errors.map((e) => e.field);
    for (const f of ["manifestVersion", "id", "name", "entry", "timeoutMs", "permissions.net"]) {
      assert.ok(fields.includes(f), `「${f}」的问题也要报出来`);
    }
  });

  test("②k 每条错都带字段名与中文消息（面板要标出哪一栏）", () => {
    const v = validateManifest(withField({ id: "Word-Guard" }));
    for (const e of v.errors) {
      assert.equal(typeof e.field, "string");
      assert.equal(typeof e.message, "string");
      assert.ok(e.message.length > 0);
      assert.ok(/[一-龥]/.test(e.message), `「${e.message}」得是人话（中文）`);
    }
  });
});

/* ====================================================================== *
 * ③ 权限展示：装之前给人看
 * ====================================================================== */
describe("③ 权限展示 —— 装之前要能一眼看见", () => {
  test("③a 插件自己的目录、联网、超时、写文件都列出来", () => {
    const dir = "D:\\plugins\\word-guard";
    const v = validateManifest(GOOD);
    const perms = describePermissions(v.manifest, { dir });
    assert.ok(perms.some((p) => p.kind === "fsRead" && p.path === dir),
      "它得读自己的代码（宿主自动放行），这一条也得如实列出来");
    assert.ok(perms.some((p) => p.kind === "net" && p.allowed === false),
      "默认不许联网");
    assert.ok(perms.some((p) => p.kind === "timeout" && /2000ms/.test(p.label)));
    assert.ok(perms.some((p) => p.kind === "deny" && /写文件/.test(p.label)),
      "写文件 / 起子进程 / 开 worker / 连调试器：一律不许");
  });

  test("③b 清单声明要读的目录，也要列出来（清单就是权限）", () => {
    const m = validateManifest(withField({
      permissions: { fsRead: ["D:\\资料\\词库"], net: true },
    })).manifest;
    const perms = describePermissions(m, { dir: "D:\\plugins\\word-guard" });
    assert.ok(perms.some((p) => p.kind === "fsRead" && p.path === "D:\\资料\\词库"));
    assert.ok(perms.some((p) => p.kind === "net" && p.allowed === true));
  });
});

/* ====================================================================== *
 * ④ 请求摘要：插件唯一能看见的东西
 * ====================================================================== */
describe("④ 请求摘要 —— 凭据不进子进程", () => {
  test("④a 白名单字段照抄，头只留名字", () => {
    const s = summarizeRequest(request());
    assert.equal(s.channel, "sn");
    assert.equal(s.tier, "claude-opus-5");
    assert.equal(s.model, "glm-5.2");
    assert.equal(s.protocol, "anthropic");
    assert.equal(s.path, "/v1/messages");
    assert.equal(s.stream, true);
    assert.deepEqual([...s.headerNames], ["content-type"]);
  });

  test("④b 凭据头的**名字**也剔掉（插件不需要知道这个请求带了 authorization）", () => {
    const s = summarizeRequest(request());
    assert.ok(!s.headerNames.includes("x-api-key"), "凭据头的名字也不该给插件");
    assert.ok(!JSON.stringify(s).includes("sk-test-"), "凭据的值更不该出现");
    assert.equal(isCredentialHeader("x-api-key"), true);
    assert.equal(isCredentialHeader("Authorization"), true);
    assert.equal(isCredentialHeader("content-type"), false);
  });

  test("④c 凭据类的参数剔掉", () => {
    const s = summarizeRequest(request({
      params: { temperature: 0.7, api_key: "sk-test-0000", accessToken: "x", foo: 1 },
    }));
    assert.equal(s.params.temperature, 0.7);
    assert.equal(s.params.foo, 1);
    assert.equal(s.params.api_key, undefined);
    assert.equal(s.params.accessToken, undefined);
    assert.equal(isCredentialParam("api_key"), true);
    assert.equal(isCredentialParam("temperature"), false);
  });

  test("④d 多余的字段一律不看（摘要不是正文）", () => {
    const s = summarizeRequest({ ...request(), body: "一大段正文", stream: true });
    assert.equal(s.body, undefined, "正文不进摘要");
  });

  test("④e provider 也收（有的地方叫 provider）", () => {
    const s = summarizeRequest({ provider: "sn", tier: "claude-opus-5" });
    assert.equal(s.channel, "sn");
  });
});

/* ====================================================================== *
 * ⑤ 决策校验：宿主只认这一种形状
 * ====================================================================== */
describe("⑤ 决策校验 —— 插件说什么，宿主只按这张表执行", () => {
  test("⑤a 三种动作都认（allow / deny+理由 / modify）", () => {
    const allow = validateDecision({ action: "allow" });
    assert.equal(allow.ok, true, formatErrors(allow.errors));
    assert.equal(allow.decision.action, "allow");

    const deny = validateDecision({ action: "deny", reason: "这个渠道今天不接活" });
    assert.equal(deny.ok, true, formatErrors(deny.errors));
    assert.equal(deny.decision.action, "deny");

    const mod = validateDecision({ action: "modify", params: { temperature: 0.2 }, model: "glm-5.2" });
    assert.equal(mod.ok, true, formatErrors(mod.errors));
    assert.equal(mod.decision.params.temperature, 0.2);
    assert.equal(mod.decision.model, "glm-5.2");
  });

  test("⑤b 凭据类头一律拒（能改凭据的插件 = 能把你的 key 发到别处的插件）", () => {
    for (const h of ["authorization", "x-api-key", "Cookie", "x-session-token"]) {
      const v = validateDecision({ action: "modify", headers: { [h]: "Bearer whatever" } });
      assert.equal(v.ok, false, `「${h}」不该通过`);
      assert.ok(
        v.errors.some((e) => /凭据/.test(e.message)),
        `「${h}」要单独点名（且要说清是凭据）`
      );
    }
  });

  test("⑤c 头值里不许有换行（那是头注入）", () => {
    const v = validateDecision({
      action: "modify",
      headers: { "x-foo": "bar\r\nX-Evil: 1" },
    });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /换行/.test(e.message)), "带换行的头值是头注入，必须挡住");
  });

  test("⑤d 不认识的字段要报错（静默忽略会让作者以为「设置成功了」）", () => {
    const v = validateDecision({ action: "allow", reuqest: { temperature: 0.2 } });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "reuqest" && /不认识的字段/.test(e.message)));
  });

  test("⑤e 拒绝必须给一句人话理由", () => {
    const v = validateDecision({ action: "deny" });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "reason" && /reason/.test(e.message)));
    assert.equal(v.decision, null, "不许给半改的结果");
  });

  test("⑤f 参数：凭据类键拒、非法参数名拒", () => {
    const cred = validateDecision({ action: "modify", params: { api_key: "sk-test-0000" } });
    assert.equal(cred.ok, false);
    assert.ok(cred.errors.some((e) => /凭据/.test(e.message)));

    const badName = validateDecision({ action: "modify", params: { "bad name": 1 } });
    assert.equal(badName.ok, false);
    assert.ok(badName.errors.some((e) => /不合法/.test(e.message)));

    const proto = validateDecision({ action: "modify", params: JSON.parse('{"__proto__": 1}') });
    assert.equal(proto.ok, false, "原型污染的键不许过");
  });

  test("⑤g 返回的不是对象 ⇒ 拒；没返回 ⇒ 放行", () => {
    const notObj = validateDecision("allow");
    assert.equal(notObj.ok, false);
    assert.ok(notObj.errors.some((e) => /不是对象/.test(e.message)));

    const none = validateDecision(undefined);
    assert.equal(none.ok, true);
    assert.equal(none.decision.action, "allow");
  });
});

/* ====================================================================== *
 * ⑥ 沙箱：没有权限模型就不跑用户代码
 * ====================================================================== */
describe("⑥ 权限模型 —— 没有沙箱就没有这个功能", () => {
  test("⑥a detectPermissionFlag 认得出本机的开关", () => {
    const flag = detectPermissionFlag();
    assert.ok(flag === null || flag === "--permission" || flag === "--experimental-permission",
      `认出的是 ${flag}，只许是这两个之一或 null`);
    const allowed = process.allowedNodeEnvironmentFlags;
    const expected = allowed.has("--permission")
      ? "--permission"
      : (allowed.has("--experimental-permission") ? "--experimental-permission" : null);
    assert.equal(flag, expected, "探测结果要与 Node 自己说的对得上");
  });

  test("⑥b 没有权限模型 ⇒ 干净地拒绝（不跑用户代码）", async () => {
    /* 这台机器**有**权限模型时，真实的拒绝分支走不到 —— 用一份改坏的副本把
       detectPermissionFlag 变成「永远没有」，好让这条断言在**任何**机器上都
       真的跑一遍（恒真的断言等于没写）。 */
    const mod = await sabotagedHost([
      ["  if (allowed && typeof allowed.has === \"function\") {", "  if (false) {"],
    ]);
    assert.equal(mod.detectPermissionFlag(), null, "改坏之后应当「没有权限模型」");

    const dir = makePluginDir({ "main.mjs": PLUGIN_OK });
    const rt = mod.createRuntime({ now: () => NOW });
    try {
      const r = await rt.install({ dir });
      assert.equal(r.ok, false, "没有沙箱就不许装用户代码");
      assert.ok(/权限模型/.test(r.errors[0].message), "要说清是「没有权限模型」这件事");
      assert.ok(/[一-龥]/.test(r.errors[0].message), "得是人话");
    } finally {
      rt.close();
    }
  });

  test("⑥c 这台机器上没有权限模型时，装插件也必须被拒（同样的理由）", async (t) => {
    if (detectPermissionFlag()) {
      t.skip("这个 Node 有权限模型，真实分支走不到（⑥b 用改坏的副本覆盖了它）");
      return;
    }
    const dir = makePluginDir({ "main.mjs": PLUGIN_OK });
    await withRuntime(async (rt) => {
      const r = await rt.install({ dir });
      assert.equal(r.ok, false);
      assert.ok(/权限模型/.test(r.errors[0].message));
    });
  });
});

/* ====================================================================== *
 * ⑦ 端到端：装 → transform → remove（真子进程）
 * ====================================================================== */

const HAS_PERM = !!detectPermissionFlag();
if (!HAS_PERM) {
  console.log(
    "\n[pluginrt-test] 提示：这个 Node 没有权限模型（--permission / --experimental-permission）——"
    + "端到端那一节（⑦⑧）**跳过**，没有沙箱不跑插件代码是本仓的既定口径。\n"
  );
}

describe("⑦ 端到端 —— 装 → transform → remove（真子进程）", { skip: HAS_PERM ? false : "这个 Node 没有权限模型" }, () => {
  test("⑦a 装上 → 改写 → 卸掉，全流程", async () => {
    const dir = makePluginDir({ "main.mjs": PLUGIN_OK });
    await withRuntime(async (rt, logs) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));
      assert.equal(installed.id, "word-guard");
      assert.ok(installed.permissions.some((p) => p.kind === "fsRead" && p.path === dir),
        "装的时候要把它要什么权限如实列出来");

      const a = await rt.apply(request());
      assert.equal(a.ok, true, JSON.stringify(a.error));
      assert.equal(a.action, "modify");
      assert.equal(a.patch.params.temperature, 0.2);
      assert.equal(a.patch.headers["x-plugin"], "on");

      /* 卸掉之后就没了 */
      assert.equal(rt.remove("word-guard"), true);
      assert.equal(rt.get("word-guard"), null);
      assert.equal(rt.list().length, 0);

      /* 插件喊过的话进了面板日志 */
      const said = logs.map((l) => l.message).join("\n");
      assert.ok(/看到 sn 的 glm-5\.2/.test(said), "api.log 的话要进面板日志");
      assert.ok(/时刻 1700000000000/.test(said), "api.now 是宿主给的时刻（插件不自己取时钟）");
      assert.ok(!said.includes("x-api-key"), "插件看不见凭据头的名字");
      assert.ok(!said.includes("sk-test-"), "插件看不见凭据的值");
    });
  });

  test("⑦b 插件抛错 ⇒ 这次请求明确失败（fail closed），子进程不许死", async () => {
    const dir = makePluginDir({ "main.mjs": PLUGIN_THROWS });
    await withRuntime(async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));

      const a = await rt.apply(request());
      assert.equal(a.ok, false, "插件失灵时这次请求必须明确失败（不能静悄悄按原样放行）");
      assert.equal(a.error.code, "PLUGIN_ERROR");
      assert.equal(a.error.pluginId, "word-guard");
      assert.ok(/插件自己炸了/.test(a.error.message), "失败要说得清是插件抛的什么");

      /* 子进程还活着：再问一次，还得能听见它的失败（不是「进程没了」） */
      const again = await rt.apply(request());
      assert.equal(again.ok, false);
      assert.equal(again.error.code, "PLUGIN_ERROR", "子进程不许因为插件抛错就死掉");
    });
  });

  test("⑦c 插件返回坏形状 ⇒ 宿主拒（子进程只管原样递回去）", async () => {
    const dir = makePluginDir({ "main.mjs": PLUGIN_BAD_SHAPE });
    await withRuntime(async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));

      const a = await rt.apply(request());
      assert.equal(a.ok, false);
      assert.equal(a.error.code, "BAD_DECISION");
      assert.ok(/凭据/.test(a.error.message), "要说清是「改了凭据头」这件事");
    });
  });

  test("⑦d 插件拒绝 ⇒ 原样带出理由", async () => {
    const dir = makePluginDir({ "main.mjs": PLUGIN_DENY });
    await withRuntime(async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));

      const a = await rt.apply(request());
      assert.equal(a.ok, true);
      assert.equal(a.action, "deny");
      assert.equal(a.reason, "这个渠道这一档今天不接活");
      assert.equal(a.pluginId, "word-guard");
    });
  });

  test("⑦e 插件入口没有默认导出 ⇒ 装不上（要在这里就炸）", async () => {
    const dir = makePluginDir({ "main.mjs": "export const notDefault = 1;\n" });
    await withRuntime(async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, false, "没有默认导出就是装不上");
      assert.ok(/默认函数/.test(formatErrors(installed.errors)),
        "要说清「得是 export default function (request, api)」");
    });
  });

  test("⑦f 入口有语法错 ⇒ 装不上（只编译不执行）", async () => {
    const dir = makePluginDir({ "main.mjs": "export default function ( {\n" });
    await withRuntime(async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, false);
      assert.ok(/语法/.test(formatErrors(installed.errors)), "要说清是语法错");
    });
  });

  test("⑦g 清单不合法 ⇒ 装不上，且错误是清单那一栏的问题", async () => {
    const dir = makePluginDir({ "main.mjs": PLUGIN_OK }, withField({ id: "Word-Guard" }));
    await withRuntime(async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, false);
      assert.ok(installed.errors.some((e) => e.field === "id"));
    });
  });

  test("⑦h 清单说不许联网 ⇒ 插件就真的连不出去（网络那一层补在子进程里）", async () => {
    /* Node 的权限模型**不管网络**（没有 --allow-net）：这一层得子进程自己补
       （宿主与插件同处一个 realm 的反面 —— 插件在子进程里，宿主拦不住它）。
       面板上写着「联网：不允许」，那就得真的不允许。 */
    const dir = makePluginDir({ "main.mjs": PLUGIN_NET });
    await withRuntime(async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));

      const a = await rt.apply(request());
      assert.equal(a.ok, true, JSON.stringify(a.error));
      const h = a.patch.headers;
      assert.equal(h["x-fetch-gone"], "true", "fetch 这个全局必须没了");
      assert.equal(h["x-websocket-gone"], "true", "WebSocket 这个全局必须没了");
      assert.equal(h["x-https-blocked"], "true", "node:https 这个模块入口必须封住");
      assert.equal(h["x-getbuiltin-gone"], "true",
        "process.getBuiltinModule 能绕过模块钩子，必须没了");
      assert.equal(h["x-binding-gone"], "true", "process.binding 能绕过模块入口，必须没了");
      assert.equal(h["x-dlopen-gone"], "true", "process.dlopen 能加载原生扩展，必须没了");
    });
  });

  test("⑦i 清单说了要联网 ⇒ 那就留着（授权过的门不该被误关）", async () => {
    const dir = makePluginDir(
      { "main.mjs": PLUGIN_NET },
      withField({ permissions: { fsRead: [], net: true } })
    );
    await withRuntime(async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));

      const a = await rt.apply(request());
      assert.equal(a.ok, true, JSON.stringify(a.error));
      const h = a.patch.headers;
      assert.equal(h["x-fetch-gone"], "false", "说了要联网就不许把 fetch 删了");
      assert.equal(h["x-getbuiltin-gone"], "false", "说了要联网就不许把原生口子删了");
    });
  });
});

/* ====================================================================== *
 * ⑧ 协议：令牌、噪声、伪造
 * ====================================================================== */
describe("⑧ 协议 —— 令牌是这条通道的防伪证机制", { skip: HAS_PERM ? false : "这个 Node 没有权限模型" }, () => {
  test("⑧a 插件往 stdout 写的任何东西都只是日志，不是协议", async () => {
    const dir = makePluginDir({ "main.mjs": PLUGIN_NOISY });
    await withRuntime(async (rt, logs) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));

      const a = await rt.apply(request());
      assert.equal(a.ok, true, JSON.stringify(a.error));
      assert.equal(a.action, "allow", "插件的噪声没把协议挤掉");
      const said = logs.map((l) => l.message).join("\n");
      assert.ok(/插件自己打印的一行/.test(said), "插件自己的输出要进面板日志");
      assert.ok(/插件自己打印的第二行/.test(said));
    });
  });

  test("⑧b 插件伪造协议消息 ⇒ 伪造无效（没有令牌前缀的行只是日志）", async () => {
    const dir = makePluginDir({ "main.mjs": PLUGIN_FORGER });
    await withRuntime(async (rt, logs) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));

      const a = await rt.apply(request());
      assert.equal(a.ok, true, JSON.stringify(a.error));
      assert.equal(a.action, "allow", "插件伪造的「拒绝」不许生效");
      assert.equal(a.reason, undefined);

      /* 那条伪造的行确实到了宿主那儿 —— 只是被当成了日志。
         （如果它被当成了协议，宿主就不会把它记进日志。） */
      const said = logs.map((l) => l.message).join("\n");
      assert.ok(/插件伪造的/.test(said), "伪造的那行到了宿主，但只被当成日志");
    });
  });
});

/* ====================================================================== *
 * ⑨ 零依赖与防漂移
 * ====================================================================== */

/** 去掉注释（块注释 + 行注释）——判「有没有调 Date.now」只看**代码**，不看注释里提到它。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("⑨ 零依赖与防漂移", () => {
  test("⑨a 宿主不 import 仓库里任何模块，也不用 require", () => {
    const code = stripComments(HOST_SRC);
    assert.equal(/\brequire\s*\(/.test(code), false, "ESM 里没有 require —— 写上去也是死代码");
    assert.equal(/from\s*["']\./.test(code), false, "不许有相对 import（它得能单独跑）");
    const imports = [...HOST_SRC.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith("node:"), `只许依赖 Node 内置模块，多了「${spec}」`);
    }
  });

  test("⑨b 子进程只 import Node 内置模块（不许有相对 import）", () => {
    /* 打包用的是**显式白名单**（build.extraResources[].filter）：相对 import
       指向的文件不在白名单里 ⇒ 源码跑得通、装出来的版本启动即崩。
       check-manifest 的 C15 闸门管这条，这里再钉一道。 */
    const code = stripComments(WORKER_SRC);
    assert.equal(/from\s*["']\./.test(code), false, "子进程不许有相对 import");
    assert.equal(/\brequire\s*\(/.test(code), false);
    const imports = [...WORKER_SRC.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith("node:"), `只许依赖 Node 内置模块，多了「${spec}」`);
    }
  });

  test("⑨c 两个文件都是零时钟（不取 Date.now）", () => {
    assert.equal(/Date\s*\.\s*now\s*\(/.test(stripComments(HOST_SRC)), false,
      "时刻一律由 opts.now 传进来");
    assert.equal(/Date\s*\.\s*now\s*\(/.test(stripComments(WORKER_SRC)), false,
      "子进程的时刻由宿主给（api.now）");
  });

  test("⑨d 两个文件都是 UTF-8 且**没有 BOM**", () => {
    for (const p of [HOST_PATH, WORKER_PATH]) {
      const buf = fs.readFileSync(p);
      assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
        `${path.basename(p)} 带 BOM：BOM 会让第一个标识符带上看不见的字符`);
    }
  });

  test("⑨e 两个文件的行尾都是 LF（CRLF 会让按文本锚点切片的老测试全崩）", () => {
    for (const p of [HOST_PATH, WORKER_PATH]) {
      const buf = fs.readFileSync(p);
      assert.equal(buf.includes(0x0d), false, `${path.basename(p)} 里有 CR —— 行尾必须是 LF`);
    }
  });

  test("⑨f 令牌不许用弱随机（它是这条通道的防伪证机制）", () => {
    const code = stripComments(HOST_SRC);
    assert.equal(/Math\s*\.\s*random\s*\(/.test(code), false,
      "Math.random 不是密码学随机：猜得出令牌就能伪造协议消息");
    assert.equal(/node:crypto/.test(HOST_SRC), true, "令牌得用 node:crypto 生成");
  });

  test("⑨g 关键常量不许漂移", () => {
    assert.equal(MANIFEST_VERSION, 1);
    assert.equal(MANIFEST_FILENAME, "plugin.json");
    assert.equal(PLUGINRT_DIRNAME, "code-plugins",
      "代码插件的目录是独立的 —— 混进 provider 插件的目录就会出现「一眼看不出根因」的事故");
    assert.equal(DEFAULT_TIMEOUT_MS, 1000);
    assert.equal(MAX_TIMEOUT_MS, 60000);
  });

  test("⑨h 临时目录一律在 os.tmpdir() 下（不许碰真数据目录）", () => {
    /* 真数据目录（%APPDATA%\bai-router）与真 ~/.claude/settings.json 是**不许**碰的：
       测试一旦写进去，用户装的东西就没了 —— 而且这类事故往往在 CI 上看不出来。 */
    for (const d of TMP_DIRS) {
      const rel = path.relative(os.tmpdir(), d);
      assert.ok(rel && !rel.startsWith("..") && !path.isAbsolute(rel),
        `临时目录跑到 os.tmpdir() 外头去了：${d}`);
    }
    const appdata = process.env.APPDATA || "";
    if (appdata) {
      for (const d of TMP_DIRS) {
        assert.ok(!d.startsWith(appdata), `临时目录落进了 %APPDATA%：${d}`);
      }
    }
  });
});

/* ====================================================================== *
 * ⑩ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */

/* 改坏的办法：把源码复制一份到临时目录，改掉其中一处，再 import 进来。
   复制件没有任何相对 import（宿主与子进程都只依赖 Node 内置模块），所以
   单独放着也能跑。 */
const SABOTAGE_DIR = tmpDir("bai-pluginrt-sabotage-");
let sabotageSeq = 0;

/** 造一份「改坏之后的宿主」，import 进来。 */
async function sabotagedHost(replacements) {
  let next = HOST_SRC;
  for (const [from, to] of replacements) {
    assert.ok(next.includes(from), `改坏的锚点找不到了（源码漂移了，这条反向对照失效）：${from}`);
    next = next.replace(from, to);
  }
  assert.notEqual(next, HOST_SRC, "改动没生效");
  const file = path.join(SABOTAGE_DIR, `pluginrt-${sabotageSeq++}.mjs`);
  fs.writeFileSync(file, next, "utf8");
  return import(pathToFileURL(file).href);
}

/**
 * 造一份「改坏之后的子进程」，写进插件目录（那份目录在宿主授权的读范围里，
 * 改坏件才读得到），返回它的路径。
 */
function sabotagedWorker(replacements, intoDir) {
  let next = WORKER_SRC;
  for (const [from, to] of replacements) {
    assert.ok(next.includes(from), `改坏的锚点找不到了（源码漂移了，这条反向对照失效）：${from}`);
    next = next.replace(from, to);
  }
  assert.notEqual(next, WORKER_SRC, "改动没生效");
  const file = path.join(intoDir, `worker-mutant-${sabotageSeq++}.mjs`);
  fs.writeFileSync(file, next, "utf8");
  return file;
}

/** 「这条断言在改坏之后必须会红」—— 不红就说明它是恒真的，等于没写。 */
function assertGoesRed(fn, why) {
  let threw = false;
  let msg = "";
  try { fn(); } catch (e) { threw = true; msg = String((e && e.message) || e); }
  assert.equal(threw, true, `${why}：改坏之后这条断言居然还是绿的，说明它是恒真的`);
  return msg;
}

/** 「改坏之后必须**不**绿」—— 异步版（给端到端那些要等子进程的断言用）。 */
async function assertGoesRedAsync(fn, why) {
  let threw = false;
  let msg = "";
  try { await fn(); } catch (e) { threw = true; msg = String((e && e.message) || e); }
  assert.equal(threw, true, `${why}：改坏之后这条断言居然还是绿的，说明它是恒真的`);
  return msg;
}

describe("⑩ 反向对照 —— 改坏实现，对应断言必须红", () => {
  test("⑩a 去掉「决策里不许改凭据头」⇒ ⑤b 的断言会红", async () => {
    const mod = await sabotagedHost([
      ["        if (isCredentialHeader(name)) {", "        if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateDecision({ action: "modify", headers: { authorization: "Bearer x" } });
      assert.equal(v.ok, false, "凭据头必须被拒");
      assert.ok(v.errors.some((e) => /凭据/.test(e.message)));
    };
    check(mod);
    const msg = assertGoesRed(check(mod), "去掉了凭据头检查");
    assert.ok(/凭据头必须被拒/.test(msg), `红的是哪一条：${msg}`);
  });

  test("⑩b 去掉「头值不许有换行」⇒ ⑤c 的断言会红", async () => {
    const mod = await sabotagedHost([
      ["        if (/[\\r\\n]/.test(s)) {", "        if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateDecision({ action: "modify", headers: { "x-foo": "bar\r\nX-Evil: 1" } });
      assert.equal(v.ok, false, "带换行的头值必须被拒（头注入）");
      assert.ok(v.errors.some((e) => /换行/.test(e.message)));
    };
    const msg = assertGoesRed(check(mod), "去掉了头值换行检查");
    assert.ok(/带换行的头值必须被拒/.test(msg), `红的是哪一条：${msg}`);
  });

  test("⑩c 去掉「决策里不认识的字段」⇒ ⑤d 的断言会红", async () => {
    const mod = await sabotagedHost([
      ["    if (!KNOWN_DECISION_FIELDS.includes(k)) {", "    if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateDecision({ action: "allow", reuqest: { temperature: 0.2 } });
      assert.equal(v.ok, false, "手误字段必须被拒");
      assert.ok(v.errors.some((e) => /不认识的字段/.test(e.message)));
    };
    const msg = assertGoesRed(check(mod), "去掉了未知字段检查");
    assert.ok(/手误字段必须被拒/.test(msg), `红的是哪一条：${msg}`);
  });

  test("⑩d 去掉「拒绝必须给理由」⇒ ⑤e 的断言会红", async () => {
    const mod = await sabotagedHost([
      ["  if (decision.action === \"deny\" && !decision.reason) {", "  if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateDecision({ action: "deny" });
      assert.equal(v.ok, false, "拒绝必须给理由");
      assert.ok(v.errors.some((e) => e.field === "reason"));
    };
    const msg = assertGoesRed(check(mod), "去掉了「拒绝要给理由」");
    assert.ok(/拒绝必须给理由/.test(msg), `红的是哪一条：${msg}`);
  });

  test("⑩e 去掉「清单里不许带凭据字段」⇒ ②h 的断言会红", async () => {
    const mod = await sabotagedHost([
      ["    if (CREDENTIAL_FIELDS.includes(k)) {", "    if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateManifest({
        manifestVersion: 1, id: "x", name: "X", entry: "main.mjs", apiKey: "sk-test-0000",
      });
      assert.equal(v.ok, false, "带凭据的清单必须被拒");
      assert.ok(v.errors.some((e) => e.field === "apiKey" && /凭据/.test(e.message)));
    };
    const msg = assertGoesRed(check(mod), "去掉了清单的凭据字段检查");
    assert.ok(/带凭据的清单必须被拒/.test(msg), `红的是哪一条：${msg}`);
  });

  test("⑩f 去掉「摘要里剔掉凭据头名」⇒ ④b 的断言会红", async () => {
    const mod = await sabotagedHost([
      ["    if (isCredentialHeader(t)) return;", "    if (false) return;"],
    ]);
    const check = (m) => () => {
      const s = m.summarizeRequest(request());
      assert.ok(!s.headerNames.includes("x-api-key"), "凭据头的名字也不该给插件");
    };
    const msg = assertGoesRed(check(mod), "去掉了摘要里的凭据头名剔除");
    assert.ok(/凭据头的名字也不该给插件/.test(msg), `红的是哪一条：${msg}`);
  });

  test("⑩g 去掉「没有权限模型就不装」⇒ ⑥b 的断言会红", async () => {
    const mod = await sabotagedHost([
      ["  if (allowed && typeof allowed.has === \"function\") {", "  if (false) {"],
      ["    if (!permFlag) {\n      return {\n        ok: false,", "    if (!permFlag) {\n      return {\n        ok: true,"],
    ]);
    const dir = makePluginDir({ "main.mjs": PLUGIN_OK });
    const check = async () => {
      const rt = mod.createRuntime({ now: () => NOW });
      try {
        const r = await rt.install({ dir });
        assert.equal(r.ok, false, "没有沙箱就不许装用户代码");
        assert.ok(/权限模型/.test(r.errors[0].message), "要说清是「没有权限模型」这件事");
      } finally {
        rt.close();
      }
    };
    const msg = await assertGoesRedAsync(check, "去掉了「没有权限模型就不跑用户代码」那道闸");
    assert.ok(/没有沙箱就不许装用户代码/.test(msg), `红的是哪一条：${msg}`);
  });

  test("⑩h 宿主不再核对令牌前缀 ⇒ ⑧b 的断言会红", { skip: HAS_PERM ? false : "这个 Node 没有权限模型" }, async () => {
    /* 令牌前缀是这条通道的**防伪证**机制：宿主一旦不再核对它，插件往 stdout
       写一行长得像协议的话就能把真的答复顶掉（它甚至能自己决定这次请求被不被拒）。
       这条反向对照把「核对前缀」这一步拿掉，看 ⑧b 那条断言是不是真的在守它。 */
    const mod = await sabotagedHost([
      ["    if (!text.startsWith(prefix)) {", "    if (false) {"],
      [
        "      msg = JSON.parse(text.slice(prefix.length));",
        "      msg = JSON.parse(text.startsWith(prefix) ? text.slice(prefix.length) : text);",
      ],
    ]);
    const dir = makePluginDir({ "main.mjs": PLUGIN_FORGER });

    /* 契约：真的宿主必须挡住伪造（正向），改坏之后必须挡不住（反向）。 */
    const contract = (rt) => async () => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));
      const a = await rt.apply(request());
      assert.equal(a.action, "allow", "插件伪造的「拒绝」不许生效");
      assert.equal(a.reason, undefined, "理由也不该是插件编的那句");
    };

    const real = createRuntime({ now: () => NOW, timeoutMs: 5000 });
    try {
      await contract(real)();
    } finally {
      real.close();
    }
    const bad = mod.createRuntime({ now: () => NOW, timeoutMs: 5000, workerPath: WORKER_PATH });
    try {
      const msg = await assertGoesRedAsync(contract(bad), "宿主不再核对令牌前缀");
      assert.ok(/插件伪造的「拒绝」不许生效/.test(msg), `红的是哪一条：${msg}`);
    } finally {
      bad.close();
    }
  });

  test("⑩i 子进程不给「插件抛错」回话 ⇒ ⑦b 的断言会红", { skip: HAS_PERM ? false : "这个 Node 没有权限模型" }, async () => {
    /* 插件抛错时子进程必须**活着把失败说清楚** —— 宿主要靠这条信息决定
       这次请求是失败还是放过。不回话的话，宿主只能等到超时（症状与「插件
       挂死」一模一样，根因却完全不同，最难查）。 */
    const dir = makePluginDir({ "main.mjs": PLUGIN_THROWS });
    const badWorker = sabotagedWorker(
      [["    replyErr(msg.id, \"PLUGIN_ERROR\", errText(e));", "    void e;"]],
      dir
    );

    /* 契约：真正的子进程必须做到（正向），改坏之后必须做不到（反向）。 */
    const contract = async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));
      const a = await rt.apply(request());
      assert.equal(a.ok, false, "插件失灵时这次请求必须明确失败");
      assert.equal(a.error.code, "PLUGIN_ERROR",
        `不回话的话宿主只能等到超时（拿到 ${a.error.code}）`);
    };

    const real = createRuntime({ now: () => NOW, timeoutMs: 1500 });
    try {
      await contract(real);
    } finally {
      real.close();
    }
    const bad = createRuntime({ now: () => NOW, timeoutMs: 1500, workerPath: badWorker });
    try {
      const msg = await assertGoesRedAsync(() => contract(bad), "子进程不给失败回话");
      assert.ok(/不回话的话宿主只能等到超时/.test(msg), `红的是哪一条：${msg}`);
    } finally {
      bad.close();
    }
  });

  test("⑩j 子进程不封网络 ⇒ ⑦h 的断言会红", { skip: HAS_PERM ? false : "这个 Node 没有权限模型" }, async () => {
    /* 「清单说不许联网」这个承诺，是**子进程**在兑现（宿主拦不住插件在子进程里
       做的事）。拿掉封堵这一步，面板上那句「联网：不允许」就成了空话。 */
    const dir = makePluginDir({ "main.mjs": PLUGIN_NET });
    const badWorker = sabotagedWorker(
      [["  if (perms.net !== true) blockNetwork();", "  if (false) blockNetwork();"]],
      dir
    );

    const contract = async (rt) => {
      const installed = await rt.install({ dir });
      assert.equal(installed.ok, true, formatErrors(installed.errors));
      const a = await rt.apply(request());
      assert.equal(a.ok, true, JSON.stringify(a.error));
      assert.equal(a.patch.headers["x-fetch-gone"], "true", "fetch 这个全局必须没了");
      assert.equal(a.patch.headers["x-https-blocked"], "true", "node:https 必须封住");
      assert.equal(a.patch.headers["x-getbuiltin-gone"], "true",
        "process.getBuiltinModule 能绕过模块钩子，必须没了");
    };

    const real = createRuntime({ now: () => NOW, timeoutMs: 5000 });
    try {
      await contract(real);
    } finally {
      real.close();
    }
    const bad = createRuntime({ now: () => NOW, timeoutMs: 5000, workerPath: badWorker });
    try {
      const msg = await assertGoesRedAsync(() => contract(bad), "子进程不封网络");
      assert.ok(/fetch 这个全局必须没了/.test(msg), `红的是哪一条：${msg}`);
    } finally {
      bad.close();
    }
  });
});
