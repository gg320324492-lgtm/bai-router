/**
 * backup-test.mjs —— src/server/backup.mjs 的口径测试
 *
 * 测的是 magpie（yetone/magpie internal/backup）那套封口语义的三件要命的事：
 *   ① **带得走的与故意不带得分开**：端口、代理、运行态标记换台机器就是错的，
 *      带过去会把对面的请求打到不存在的端口上；凭据反过来，不带走就等于白备份。
 *   ② **密文里不能有明文**：导出的字节里搜不到任何原始 key / 端点 / 模型名。
 *   ③ **口令错或文件被改过，必须明确报错**，绝不能返回半个快照——
 *      半个快照比没有快照更坏：写回去就是把用户的配置换成一份残缺的东西。
 *
 * 时间一律由参数注入（opts.now），本文件不取 Date.now()。
 *
 * ⚠ 全程零 IO：除了「反向对照」往系统临时目录写一份源码副本，
 *   本测试**不碰**真实的 %APPDATA%\bai-router 与 ~/.claude/settings.json。
 *
 * 反向对照的手法表在文件末尾（SABOTAGE）：每一处「把实现改坏」都配一条
 * 对应的断言，证明那条断言**真的会红**——测试绿了但改坏了实现它不响，那是假绿。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pbkdf2Sync, createCipheriv } from "node:crypto";
import {
  snapshotOf,
  exportBundle,
  importBundle,
  restoreConfig,
  canonicalJson,
  assertSnapshot,
  BackupError,
  PROVIDER_TRAVEL_FIELDS,
  LOCAL_ONLY_ROOT_FIELDS,
  LOCAL_ONLY_PROVIDER_FIELDS,
  RUNTIME_ROOT_FIELDS,
  ROUTER_OWNED_ENV,
  BUNDLE_MAGIC,
  HEADER_LEN,
  TAG_LEN,
  SALT_LEN,
  NONCE_LEN,
  KEY_LEN,
  KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  SNAPSHOT_FORMAT,
} from "../src/server/backup.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "src", "server", "backup.mjs");

const NOW = 1_700_000_000_000;
const PASS = "test-passphrase-0000";

/* 夹具里的凭据必须一眼看出是假的（sk-test-0000…），别用像真 key 的串。 */
const CFG = {
  apiKey: "sk-test-0000-bai-key-abcdef",
  upstream: "https://api.test.invalid",
  proxy: "http://127.0.0.1:9",
  relayPort: 15722,
  panelPort: 15723,
  gatewayPort: 15799,
  gatewayMode: "on",
  defaultModel: "test-model-alpha",
  availableModels: ["test-model-alpha", "test-model-beta"],
  mapping: { "test-tier-alpha": { target: "test-model-alpha", label: "测试档位甲" } },
  failover: { enabled: true, chain: ["qd", "bai"] },
  _modelsSynced: "1.0.0-test",
  sn: {
    apiKey: "sk-test-0000-sn-key-abcdef",
    upstream: "https://sn.test.invalid",
    relayPort: 15732,
    defaultModel: "test-model-sensenova",
    availableModels: ["test-model-sensenova"],
    mapping: { "test-tier-alpha": { target: "test-model-sensenova", label: "SN" } },
  },
  zen: {
    apiKey: "sk-test-0000-zen-key-abcdef",
    upstream: "https://zen.test.invalid",
    relayPort: 15752,
    useProxy: true,
    transport: "opencode",
    defaultModel: "test-model-zen",
    availableModels: ["test-model-zen"],
    mapping: { "test-tier-alpha": { target: "test-model-zen", label: "Zen" } },
  },
  qd: {
    token: "qd-test-0000-token-abcdef",
    tokenFile: "C:\\nowhere\\qd-token.txt",
    modelsFile: "C:\\nowhere\\qd-models.json",
    upstream: "https://qd.test.invalid",
    relayPort: 15762,
    defaultModel: "test-model-qoder",
    availableModels: ["test-model-qoder"],
    mapping: { "test-tier-alpha": { target: "test-model-qoder", label: "QD" } },
  },
  wb: {
    accessToken: "wb-test-0000-access-abcdef",
    refreshToken: "wb-test-0000-refresh-abcdef",
    deviceToken: "wb-test-0000-device-abcdef",
    userId: "test-user-id-0000",
    upstream: "https://wb.test.invalid",
    relayPort: 15742,
    useProxy: false,
    defaultModel: "test-model-workbuddy",
    availableModels: ["test-model-workbuddy"],
    mapping: { "test-tier-alpha": { target: "test-model-workbuddy", label: "WB" } },
  },
  or: {
    keys: ["sk-or-test-0000-key-abcdef"],
    upstream: "https://or.test.invalid",
    relayPort: 15772,
    useProxy: false,
    defaultModel: "test-model-openrouter",
    availableModels: ["test-model-openrouter"],
    mapping: { "test-tier-alpha": { target: "test-model-openrouter", label: "OR" } },
  },
};

const CLAUDE = {
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
    ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "test-tier-alpha",
    MY_OWN_API_KEY: "my-own-test-key-0000",
    MY_OWN_PLAIN: "keep-me-please",
  },
  permissions: { allow: ["Bash(npm run test:only)"] },
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo test-hook" }] }] },
};

/* 快照里绝不该出现的字符串（明文关键词）。 */
const SECRETS_IN_PLAIN = [
  "sk-test-0000-bai-key-abcdef",
  "sk-test-0000-sn-key-abcdef",
  "sk-test-0000-zen-key-abcdef",
  "qd-test-0000-token-abcdef",
  "wb-test-0000-access-abcdef",
  "wb-test-0000-refresh-abcdef",
  "wb-test-0000-device-abcdef",
  "sk-or-test-0000-key-abcdef",
  "https://api.test.invalid",
  "https://sn.test.invalid",
  "https://zen.test.invalid",
  "https://qd.test.invalid",
  "https://wb.test.invalid",
  "https://or.test.invalid",
  "test-model-alpha",
  "test-model-workbuddy",
  "test-tier-alpha",
  "my-own-test-key-0000",
  "keep-me-please",
  "Bash(npm run test:only)",
  "echo test-hook",
];

/* ====================================================================== *
 * 断言（正向与反向对照共用同一批函数：改坏了实现，它们必须真的红）
 * ====================================================================== */

/** 本机专属的字段一个都不许进快照。 */
function assertLocalFieldsAbsent(snap) {
  const bai = snap.parts.providers.bai;
  for (const f of LOCAL_ONLY_ROOT_FIELDS) {
    assert.equal(bai[f], undefined, `bai 块的 ${f} 是本机专属，不许进快照`);
    assert.equal(snap.parts.settings[f], undefined, `settings 的 ${f} 是本机专属，不许进快照`);
  }
  for (const f of RUNTIME_ROOT_FIELDS) {
    assert.equal(bai[f], undefined, `${f} 是纯运行态标记，不许进快照`);
    assert.equal(snap.parts.settings[f], undefined, `${f} 是纯运行态标记，不许进快照`);
  }
  for (const ch of ["sn", "zen", "qd", "wb", "or"]) {
    for (const f of LOCAL_ONLY_PROVIDER_FIELDS) {
      assert.equal(snap.parts.providers[ch][f], undefined, `${ch} 的 ${f} 是本机专属，不许进快照`);
    }
  }
  assert.equal(snap.parts.providers.qd.tokenFile, undefined, "指向本机文件的路径不许带走");
  assert.equal(snap.parts.providers.qd.modelsFile, undefined, "指向本机文件的路径不许带走");
}

/** 凭据、端点、模型偏好必须在快照里。 */
function assertPortableFieldsPresent(snap) {
  assert.equal(snap.parts.providers.bai.apiKey, CFG.apiKey, "bai 的 key 必须带走");
  assert.equal(snap.parts.providers.bai.upstream, CFG.upstream, "bai 的端点必须带走");
  assert.equal(snap.parts.providers.bai.defaultModel, CFG.defaultModel, "bai 的默认模型必须带走");
  assert.deepEqual(snap.parts.providers.bai.availableModels, CFG.availableModels, "bai 的模型清单必须带走");
  assert.deepEqual(snap.parts.providers.bai.mapping, CFG.mapping, "bai 的映射必须带走");
  assert.equal(snap.parts.providers.sn.apiKey, CFG.sn.apiKey, "sn 的 key 必须带走");
  assert.equal(snap.parts.providers.qd.token, CFG.qd.token, "qd 的 token 必须带走");
  assert.equal(snap.parts.providers.wb.accessToken, CFG.wb.accessToken, "wb 的 accessToken 必须带走");
  assert.equal(snap.parts.providers.wb.refreshToken, CFG.wb.refreshToken, "wb 的 refreshToken 必须带走");
  assert.deepEqual(snap.parts.providers.or.keys, CFG.or.keys, "or 的多把 key 必须带走");
  assert.deepEqual(snap.parts.settings.failover, CFG.failover, "failover 链必须带走");
}

/** 路由台自己写的 env 不许进快照；用户自己写的要进。 */
function assertRouterEnvStripped(snap) {
  const env = snap.parts.claude.env;
  for (const k of ROUTER_OWNED_ENV) {
    assert.equal(env[k], undefined, `${k} 是路由台自己写的（指向本机端口），不许带走`);
  }
  assert.equal(env.MY_OWN_PLAIN, "keep-me-please", "用户自己写的 env 必须带走");
  assert.deepEqual(snap.parts.claude.permissions, CLAUDE.permissions, "用户的权限设置必须带走");
  assert.deepEqual(snap.parts.claude.hooks, CLAUDE.hooks, "用户的钩子必须带走");
}

/** 改一个字节 ⇒ 必须明确报错（口令错或被改过），且**不能**返回半个快照。 */
function assertTamperRejected(mod, bundle) {
  let err = null;
  let out;
  try {
    out = mod.importBundle(bundle, PASS);
  } catch (e) {
    err = e;
  }
  assert.equal(out, undefined, "被改过的密文绝不能返回半个快照");
  assert.ok(err instanceof mod.BackupError, "必须抛本模块的错误类型");
  assert.equal(err.code, "BAD_PASSPHRASE", `错误码必须是 BAD_PASSPHRASE，实际 ${err && err.code}`);
}

/** 头里的迭代次数不合法 ⇒ 明确说「不是本程序写的」，而不是当成好文件去解。 */
function assertBadHeaderRejected(mod, bundle) {
  const bad = Buffer.from(bundle);
  bad.writeUInt32BE(1, 8); // 把迭代次数改成 1
  let err = null;
  try {
    mod.importBundle(bad, PASS);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "迭代次数不合法必须报错");
  assert.equal(err.code, "NOT_A_BUNDLE", `错误码必须是 NOT_A_BUNDLE，实际 ${err && err.code}`);
}

/** 同一份内容、不同的键序 ⇒ 必须算出同一段字节。 */
function assertCanonicalStable(mod, snap) {
  const reordered = {};
  for (const k of Object.keys(snap).reverse()) reordered[k] = snap[k];
  const a = mod.exportBundle(snap, PASS, { salt: Buffer.alloc(SALT_LEN, 7), nonce: Buffer.alloc(NONCE_LEN, 9) });
  const b = mod.exportBundle(reordered, PASS, { salt: Buffer.alloc(SALT_LEN, 7), nonce: Buffer.alloc(NONCE_LEN, 9) });
  assert.equal(Buffer.compare(a, b), 0, "键序不同但内容相同 ⇒ 字节必须相同");
}

/** 还原不得就地改当前配置对象（那是在动用户手里的东西）。 */
function assertNoMutationOfCurrent(mod, snap, cur) {
  const before = canonicalJson(cur);
  mod.restoreConfig(snap, cur);
  assert.equal(canonicalJson(cur), before, "还原不得就地改当前配置对象");
}

/**
 * 一份**与快照不同**的当前配置。
 *
 * 为什么必须不同：还原时若快照与当前的值一样，改不改当前对象都看不出来，
 * 那条断言就成了空转——「就地改当前配置」这种 bug 正是这样蒙混过关的。
 */
function differingCurrent() {
  const cur = JSON.parse(JSON.stringify(CFG));
  cur.apiKey = "sk-test-0000-old-bai-key";
  cur.sn.apiKey = "sk-test-0000-old-sn-key";
  cur.failover.chain = ["bai"];
  return cur;
}

/* ====================================================================== *
 * ① 快照：带得走的 / 故意不带的
 * ====================================================================== */

describe("① 快照 —— 带得走的与故意不带得分开", () => {
  test("①a 本机专属字段一个都不进快照", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    assertLocalFieldsAbsent(snap);
  });

  test("①b 凭据、端点、模型偏好必须进快照", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    assertPortableFieldsPresent(snap);
  });

  test("①c 不带凭据导出 ⇒ 凭据被清空，形状不变", () => {
    const snap = snapshotOf(CFG, { now: NOW, keys: false, claude: CLAUDE });
    assert.equal(snap.carriesKeys, false, "快照要记着自己是不是带凭据的");
    assert.equal(snap.parts.providers.bai.apiKey, "", "不带凭据时 key 必须清空");
    assert.equal(snap.parts.providers.wb.accessToken, "", "不带凭据时 accessToken 必须清空");
    assert.deepEqual(snap.parts.providers.or.keys, [], "不带凭据时多把 key 必须清空");
    assert.equal(snap.parts.providers.bai.upstream, CFG.upstream, "端点不是凭据，仍然带走");
    assert.equal(snap.parts.claude.env.MY_OWN_API_KEY, "", "像密钥的 env 必须清空");
    assert.equal(snap.parts.claude.env.MY_OWN_PLAIN, "keep-me-please", "不像密钥的 env 仍然带走");
  });

  test("①d 路由台自己写的 env 不带走，用户自己写的带走", () => {
    const snap = snapshotOf(CFG, { now: NOW, claude: CLAUDE });
    assertRouterEnvStripped(snap);
  });

  test("①e opts.now 必须给：时刻不由模块自己取", () => {
    assert.throws(() => snapshotOf(CFG, {}), (e) => e instanceof BackupError && e.code === "NO_TIME");
    assert.throws(() => snapshotOf(CFG, { now: "now" }), (e) => e instanceof BackupError && e.code === "NO_TIME");
  });

  test("①f 配置读不出来 ≠ 空配置：传 null 必须报错", () => {
    assert.throws(() => snapshotOf(null, { now: NOW }), (e) => e instanceof BackupError && e.code === "BAD_CONFIG");
    assert.throws(() => snapshotOf(undefined, { now: NOW }), (e) => e instanceof BackupError && e.code === "BAD_CONFIG");
  });

  test("①g 快照是深拷贝：之后改原配置，不影响已取的快照", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const mutable = JSON.parse(JSON.stringify(CFG));
    const snap2 = snapshotOf(mutable, { now: NOW });
    mutable.sn.apiKey = "sk-test-9999-changed";
    mutable.failover.chain.push("or");
    assert.equal(snap2.parts.providers.sn.apiKey, CFG.sn.apiKey, "快照不能是浅拷贝");
    assert.deepEqual(snap2.parts.settings.failover.chain, CFG.failover.chain, "快照不能是浅拷贝");
  });

  test("①h 快照的形状固定：三个部件 + 元信息", () => {
    const snap = snapshotOf(CFG, { now: NOW, claude: CLAUDE });
    assert.equal(snap.format, SNAPSHOT_FORMAT);
    assert.equal(snap.createdAt, NOW, "时刻必须来自 opts.now");
    assert.deepEqual(Object.keys(snap.parts).sort(), ["claude", "providers", "settings"]);
    const bare = snapshotOf(CFG, { now: NOW });
    assert.equal(bare.parts.claude, null, "没给 claude 设置时这一块就是 null，不许是空对象");
  });
});

/* ====================================================================== *
 * ② 导出：密文里不许有明文
 * ====================================================================== */

describe("② 导出 —— 密文里不许出现明文配置", () => {
  test("②a 导出物里搜不到任何原始 key / 端点 / 模型名", () => {
    const snap = snapshotOf(CFG, { now: NOW, claude: CLAUDE });
    const bytes = exportBundle(snap, PASS);
    for (const s of SECRETS_IN_PLAIN) {
      assert.equal(bytes.includes(s, 0, "utf8"), false, `密文里不该出现「${s}」`);
    }
  });

  test("②b 容器头是固定的：magic 在最前面，后面是密文", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const bytes = exportBundle(snap, PASS);
    assert.equal(bytes.subarray(0, BUNDLE_MAGIC.length).toString("latin1"), BUNDLE_MAGIC, "magic 必须是固定的那几个字节");
    assert.ok(bytes.length > HEADER_LEN + TAG_LEN, "得有密文正文与认证标签");
    assert.equal(bytes[bytes.length - TAG_LEN - 1] !== undefined, true);
  });

  test("②c 同一份盐与 IV ⇒ 字节逐字相同（导出可复现）", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const salt = Buffer.alloc(SALT_LEN, 3);
    const nonce = Buffer.alloc(NONCE_LEN, 5);
    const a = exportBundle(snap, PASS, { salt, nonce });
    const b = exportBundle(snap, PASS, { salt, nonce });
    assert.equal(Buffer.compare(a, b), 0, "同盐同 IV 必须导出同样的字节");
  });

  test("②d 不同盐 ⇒ 字节不同（同一份配置也不该撞出同一个文件）", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const a = exportBundle(snap, PASS, { salt: Buffer.alloc(SALT_LEN, 1), nonce: Buffer.alloc(NONCE_LEN, 2) });
    const b = exportBundle(snap, PASS, { salt: Buffer.alloc(SALT_LEN, 4), nonce: Buffer.alloc(NONCE_LEN, 2) });
    assert.notEqual(Buffer.compare(a, b), 0, "换盐必须换出不同的密文");
  });

  test("②e 没有口令不许导出", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    assert.throws(() => exportBundle(snap, ""), (e) => e instanceof BackupError && e.code === "NO_PASSPHRASE");
    assert.throws(() => exportBundle(snap, null), (e) => e instanceof BackupError && e.code === "NO_PASSPHRASE");
  });

  test("②f 迭代次数不合法 ⇒ 拒绝导出（KDF 的下限是防线，不是建议）", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    assert.throws(
      () => exportBundle(snap, PASS, { iterations: 10 }),
      (e) => e instanceof BackupError && e.code === "BAD_OPTION",
    );
    assert.throws(
      () => exportBundle(snap, PASS, { iterations: 99_999_999 }),
      (e) => e instanceof BackupError && e.code === "BAD_OPTION",
    );
  });

  test("②g 迭代次数够高：默认就是 600000（magpie 同值）", () => {
    assert.equal(KDF_ITERATIONS, 600000, "默认迭代次数必须与 magpie backup.go:46 一致");
    assert.ok(MIN_KDF_ITERATIONS >= 100000, "读回时的下限不能低于 100000");
  });
});

/* ====================================================================== *
 * ③ 导入：口令错 / 被改过 ⇒ 明确报错
 * ====================================================================== */

describe("③ 导入 —— 口令错或文件被改过，必须明确报错", () => {
  test("③a 正常往返：解出来的就是原来那份快照", () => {
    const snap = snapshotOf(CFG, { now: NOW, claude: CLAUDE });
    const bytes = exportBundle(snap, PASS);
    const back = importBundle(bytes, PASS);
    assert.deepEqual(back, snap, "往返必须逐字相同");
  });

  test("③b 口令错 ⇒ 明确报错，绝不返回半个快照", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const bytes = exportBundle(snap, PASS);
    let err = null;
    let out;
    try {
      out = importBundle(bytes, "wrong-passphrase-0000");
    } catch (e) {
      err = e;
    }
    assert.equal(out, undefined, "口令错绝不能返回半个快照");
    assert.ok(err instanceof BackupError);
    assert.equal(err.code, "BAD_PASSPHRASE");
    assert.match(err.message, /口令不对/, "错误要说清是口令或文件的问题");
  });

  test("③c 密文被改一个字节 ⇒ 明确报错", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const bytes = exportBundle(snap, PASS);
    const tampered = Buffer.from(bytes);
    tampered[HEADER_LEN + 3] ^= 0xff;
    assertTamperRejected({ importBundle, BackupError }, tampered);
  });

  test("③d 认证标签被改 ⇒ 明确报错", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const bytes = exportBundle(snap, PASS);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 0x01;
    assertTamperRejected({ importBundle, BackupError }, tampered);
  });

  test("③e 头被改（迭代次数）⇒ 明确报错，不是好文件", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const bytes = exportBundle(snap, PASS);
    assertBadHeaderRejected({ importBundle, BackupError }, bytes);
  });

  test("③f 截断的文件 ⇒ 不是备份", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const bytes = exportBundle(snap, PASS);
    let err = null;
    try {
      importBundle(bytes.subarray(0, 30), PASS);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "NOT_A_BUNDLE");
  });

  test("③g 不是我们的文件（魔数不对）⇒ 不是备份", () => {
    let err = null;
    try {
      importBundle(Buffer.from("这不是备份，只是一段普通文字而已啊", "utf8"), PASS);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "NOT_A_BUNDLE");
  });

  test("③h 版本比本版本新 ⇒ 说清是版本问题（别当成坏文件）", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const bytes = exportBundle(snap, PASS);
    const newer = Buffer.from(bytes);
    newer[6] = 9;
    let err = null;
    try {
      importBundle(newer, PASS);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "UNSUPPORTED_VERSION");
  });

  test("③i 解开了但里面不是快照 ⇒ 明确报错，不许把垃圾当配置用", () => {
    const garbage = buildRawBundle(Buffer.from(JSON.stringify({ hello: "world" }), "utf8"), PASS);
    let err = null;
    try {
      importBundle(garbage, PASS);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "BAD_SNAPSHOT");
  });

  test("③j 没有口令不许导入", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const bytes = exportBundle(snap, PASS);
    assert.throws(() => importBundle(bytes, ""), (e) => e instanceof BackupError && e.code === "NO_PASSPHRASE");
  });
});

/* ====================================================================== *
 * ④ 还原：合并，不是覆盖
 * ====================================================================== */

describe("④ 还原 —— 把快照合并回本机，不覆盖本机的东西", () => {
  test("④a 本机专属字段保持本机的值", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const cur = {
      ...JSON.parse(JSON.stringify(CFG)),
      relayPort: 25000,
      panelPort: 25001,
      proxy: "http://127.0.0.1:7",
      gatewayPort: 25002,
    };
    const out = restoreConfig(snap, cur).config;
    assert.equal(out.relayPort, 25000, "端口是本机的，不能被快照改掉");
    assert.equal(out.panelPort, 25001, "端口是本机的，不能被快照改掉");
    assert.equal(out.gatewayPort, 25002, "端口是本机的，不能被快照改掉");
    assert.equal(out.proxy, "http://127.0.0.1:7", "代理是本机的，不能被快照改掉");
    assert.equal(out.sn.relayPort, CFG.sn.relayPort, "各家的端口也是本机的");
  });

  test("④b 带得走的字段被快照覆盖", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const cur = { ...JSON.parse(JSON.stringify(CFG)), apiKey: "sk-test-0000-old-bai", sn: { apiKey: "sk-test-0000-old-sn" } };
    const out = restoreConfig(snap, cur).config;
    assert.equal(out.apiKey, CFG.apiKey, "凭据必须还原成快照里的");
    assert.equal(out.sn.apiKey, CFG.sn.apiKey, "凭据必须还原成快照里的");
  });

  test("④c 还原不得就地改当前配置对象", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const cur = differingCurrent();
    assertNoMutationOfCurrent({ restoreConfig, canonicalJson }, snap, cur);
  });

  test("④d Claude 那侧：路由台自己写的 env 用本机的现值", () => {
    const snap = snapshotOf(CFG, { now: NOW, claude: CLAUDE });
    const cur = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:25021", MY_OWN_PLAIN: "keep-me-please" }, permissions: { allow: [] } };
    const out = restoreConfig(snap, cur, { claude: cur });
    assert.equal(out.claude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:25021", "本机端口必须用本机的");
    assert.equal(out.claude.permissions.allow[0], "Bash(npm run test:only)", "用户的权限要还原");
  });

  test("④e 快照里没有 Claude 那块时，本机的那块原样返回", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const cur = { env: { X: "y" } };
    const out = restoreConfig(snap, cur, { claude: cur });
    assert.deepEqual(out.claude, cur, "没有快照就没有还原，不许动本机的");
  });

  test("④f 结构坏的快照在还原前就被拒绝", () => {
    assert.throws(() => restoreConfig({ format: "别的软件" }, {}), (e) => e instanceof BackupError && e.code === "BAD_SNAPSHOT");
    assert.throws(() => assertSnapshot({ format: SNAPSHOT_FORMAT, version: 99, parts: {} }), (e) => e instanceof BackupError && e.code === "UNSUPPORTED_VERSION");
  });

  test("④g 不带凭据的快照还原时，不许把本机配好的凭据抹掉", () => {
    /* 这份快照是「不带凭据导出的」：凭据格是空的（magpie 的 withoutKeys）。
       直接盖上去就等于「还原一份没带钥匙的备份 ⇒ 把本机刚配好的 Key 也清空」——
       用户刚填的 Key 当场消失，比不还原还坏。 */
    const snap = snapshotOf(CFG, { now: NOW, keys: false, claude: CLAUDE });
    const cur = {
      ...JSON.parse(JSON.stringify(CFG)),
      apiKey: "sk-test-0000-local-bai-key",
      sn: { ...JSON.parse(JSON.stringify(CFG.sn)), apiKey: "sk-test-0000-local-sn-key" },
      wb: { ...JSON.parse(JSON.stringify(CFG.wb)), accessToken: "wb-test-0000-local-access" },
      or: { ...JSON.parse(JSON.stringify(CFG.or)), keys: ["sk-or-test-0000-local-key"] },
    };
    const out = restoreConfig(snap, cur, { claude: CLAUDE });
    assert.equal(out.config.apiKey, "sk-test-0000-local-bai-key", "本机的 key 必须留着");
    assert.equal(out.config.sn.apiKey, "sk-test-0000-local-sn-key", "本机的 key 必须留着");
    assert.equal(out.config.wb.accessToken, "wb-test-0000-local-access", "本机的 key 必须留着");
    assert.deepEqual(out.config.or.keys, ["sk-or-test-0000-local-key"], "本机的多把 key 必须留着");
    assert.equal(out.claude.env.MY_OWN_API_KEY, "my-own-test-key-0000", "本机自己的 env 密钥必须留着");
  });

  test("④h 带凭据的快照照常覆盖本机的凭据（真要换机器时能换过去）", () => {
    const snap = snapshotOf(CFG, { now: NOW });
    const cur = { ...JSON.parse(JSON.stringify(CFG)), apiKey: "sk-test-0000-local-bai-key" };
    const out = restoreConfig(snap, cur).config;
    assert.equal(out.apiKey, CFG.apiKey, "带凭据的快照必须能把凭据换过去");
  });
});

/* ====================================================================== *
 * ⑤ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */

/**
 * 把源码抄一份到临时目录，打上补丁，import 进来。
 * 补丁没打上（锚点对不上）就直接失败——「反向对照是假的」比「没有反向对照」更糟。
 */
async function brokenModule(from, to) {
  const src = await readFile(SRC, "utf8");
  assert.notEqual(src, from, "反向对照的锚点必须在本源码里存在");
  const hits = src.split(from).length - 1;
  assert.equal(hits, 1, `反向对照的锚点必须恰好命中一次，实际 ${hits} 次`);
  const patched = src.replace(from, to);
  const dir = await mkdtemp(path.join(tmpdir(), "bai-backup-sabotage-"));
  const file = path.join(dir, "backup-broken.mjs");
  await writeFile(file, patched, "utf8");
  return import(pathToFileURL(file).href);
}

describe("⑤ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑤a 白名单一旦漏成黑名单（端口混进快照）⇒ ①a 必须红", async () => {
    const broken = await brokenModule(
      '"upstream", "defaultModel", "availableModels", "mapping",',
      '"upstream", "defaultModel", "availableModels", "mapping", "relayPort",',
    );
    assert.throws(
      () => assertLocalFieldsAbsent(broken.snapshotOf(CFG, { now: NOW })),
      "端口混进快照后，①a 那条断言必须失败——否则它是假绿",
    );
  });

  test("⑤b 不校验 GCM 标签（密文被改也照样开）⇒ ③c 必须红", async () => {
    const broken = await brokenModule(
      "plain = Buffer.concat([dec.update(body), dec.final()]);",
      "plain = Buffer.concat([dec.update(body)]);",
    );
    const snap = broken.snapshotOf(CFG, { now: NOW });
    const bytes = broken.exportBundle(snap, PASS);
    const tampered = Buffer.from(bytes);
    tampered[HEADER_LEN + 3] ^= 0xff;
    assert.throws(
      () => assertTamperRejected(broken, tampered),
      "去掉标签校验后，③c 那条断言必须失败——否则完整性校验是假做的",
    );
  });

  test("⑤c 迭代次数下限放松（坏头被当成好文件）⇒ ③e 必须红", async () => {
    const broken = await brokenModule(
      "export const MIN_KDF_ITERATIONS = 100000;",
      "export const MIN_KDF_ITERATIONS = 1;",
    );
    const snap = broken.snapshotOf(CFG, { now: NOW });
    const bytes = broken.exportBundle(snap, PASS);
    assert.throws(
      () => assertBadHeaderRejected(broken, bytes),
      "下限放松后，③e 那条断言必须失败",
    );
  });

  test("⑤d 规范 JSON 不排序键 ⇒ ②c 必须红", async () => {
    const broken = await brokenModule(
      "const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();",
      "const keys = Object.keys(value).filter((k) => value[k] !== undefined);",
    );
    const snap = broken.snapshotOf(CFG, { now: NOW });
    assert.throws(
      () => assertCanonicalStable(broken, snap),
      "键序不排序后，②c 那条断言必须失败",
    );
  });

  test("⑤e 还原时直接改当前配置对象 ⇒ ④c 必须红", async () => {
    const broken = await brokenModule(
      "const out = clone(cur);",
      "const out = cur;",
    );
    const snap = broken.snapshotOf(CFG, { now: NOW });
    const cur = differingCurrent();
    assert.throws(
      () => assertNoMutationOfCurrent(broken, snap, cur),
      "就地改当前配置后，④c 那条断言必须失败",
    );
  });

  test("⑤f Claude 的路由 env 没剔掉 ⇒ ①d 必须红", async () => {
    const broken = await brokenModule(
      "if (ROUTER_OWNED_ENV.includes(k)) continue;",
      "if (false) continue;",
    );
    const snap = broken.snapshotOf(CFG, { now: NOW, claude: CLAUDE });
    assert.throws(
      () => assertRouterEnvStripped(snap),
      "把 127.0.0.1 的端口带到别的机器后，①d 那条断言必须失败",
    );
  });
});

/* ====================================================================== *
 * ⑥ 纪律自检：这层不许碰 IO、不许自己取时刻、不许依赖仓库其它模块
 * ====================================================================== */

describe("⑥ 纪律自检", () => {
  test("⑥a 源码里没有 Date.now()：时刻一律由参数传入", async () => {
    const src = codeOnly(await readFile(SRC, "utf8"));
    assert.doesNotMatch(src, /Date\.now\(\)/, "本模块不许自己取时刻");
    assert.doesNotMatch(src, /new Date\(\)/, "本模块不许自己取时刻");
  });

  test("⑥b 源码里没有 fs / http / net：这层不碰磁盘也不联网", async () => {
    const src = await readFile(SRC, "utf8");
    assert.doesNotMatch(src, /node:fs/, "这层不许读磁盘写磁盘");
    assert.doesNotMatch(src, /node:http|node:net|node:dgram/, "这层不许发网络请求");
  });

  test("⑥c 不 import 本仓库任何模块（edit-json.mjs 尤其不许）", async () => {
    const src = await readFile(SRC, "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const im of imports) {
      assert.ok(im.startsWith("node:"), `只许 import node: 内置模块，found ${im}`);
    }
  });

  test("⑥d 字段白名单里没有本机专属字段", () => {
    for (const f of LOCAL_ONLY_ROOT_FIELDS) {
      assert.equal(PROVIDER_TRAVEL_FIELDS.includes(f), false, `${f} 不许进白名单`);
    }
    for (const f of LOCAL_ONLY_PROVIDER_FIELDS) {
      assert.equal(PROVIDER_TRAVEL_FIELDS.includes(f), false, `${f} 不许进白名单`);
    }
    for (const f of RUNTIME_ROOT_FIELDS) {
      assert.equal(PROVIDER_TRAVEL_FIELDS.includes(f), false, `${f} 不许进白名单`);
    }
  });
});

/* ====================================================================== *
 * 工具：手工造一个「解开了但不是快照」的容器（正向测试用）
 * ====================================================================== */

/**
 * 把注释与字符串字面量去掉，只留代码。
 *
 * 为什么：纪律自检要查的是「代码里有没有取时刻」，而注释与错误消息里都写着
 * 「本模块不取 Date.now()」这句话——不剥掉就会把自己骂一顿。
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
 * 按同样的容器格式装一个任意明文。
 * 为什么不复用 exportBundle：它只肯装一份合法的快照，而这里要装的是**垃圾**，
 * 用来验「解开了但不是快照」这条错误路径。
 */
function buildRawBundle(plain, passphrase) {
  const salt = Buffer.alloc(SALT_LEN, 11);
  const nonce = Buffer.alloc(NONCE_LEN, 13);
  const header = Buffer.alloc(HEADER_LEN);
  header.write(BUNDLE_MAGIC, 0, "latin1");
  header[6] = 1;
  header[7] = 1;
  header.writeUInt32BE(KDF_ITERATIONS, 8);
  salt.copy(header, 12);
  nonce.copy(header, 28);
  const key = pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, KEY_LEN, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}
