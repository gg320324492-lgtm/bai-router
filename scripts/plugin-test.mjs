/* 声明式 provider 插件层（src/server/plugin.mjs）的口径测试。
 *
 * 这层是「对标 magpie 的插件化」的第一步：把**加一家渠道要改代码**这件事，
 * 改成**一份声明就能加一家**。测的是四条硬规矩：
 *
 *   ① 清单只吃 JSON（YAML 解析器是外部依赖，本仓不引新依赖）；
 *   ② 校验逐项给**人话**错误（不是 "invalid schema"）；
 *   ③ 转换出来的形状与 config.defaults.json 里的一家**同构**；
 *   ④ **凭据不进清单**（插件是分发物，里面带 key 等于把 key 发给所有装它的人）；
 *   ⑤ 注册表**检出冲突就报错**，不许悄悄覆盖出厂渠道。
 *
 * 时间一律由参数注入（opts.now），本文件不取 Date.now()。
 *
 * 末尾有「反向对照」一节：把实现改坏（复制到临时目录改几处再 import 进来），
 * 证明对应的断言**真的会红** —— 不会红的断言等于没写。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MANIFEST_VERSION,
  FACTORY_CHANNELS,
  TIER_KEYS,
  PROTOCOLS,
  AUTH_SCHEMES,
  CHANNEL_KEY_RE,
  RESERVED_PORTS,
  parseManifest,
  validateManifest,
  toProviderSpec,
  createRegistry,
  formatErrors,
} from "../src/server/plugin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_PATH = path.join(ROOT, "src", "server", "plugin.mjs");
const SERVER_PATH = path.join(ROOT, "src", "server", "server.mjs");
const DEFAULTS_PATH = path.join(ROOT, "src", "server", "config.defaults.json");

/* 一份合法的声明（后面的用例都从它改出来）。 */
const GOOD = Object.freeze({
  manifestVersion: 1,
  id: "acme",
  name: "Acme LLM",
  upstream: "https://api.acme.example/v1",
  protocol: "openai",
  auth: "apikey",
  models: ["acme-pro", "acme-lite"],
  mapping: {
    "claude-fable-5": "acme-lite",
    "claude-sonnet-5": "acme-pro",
    "claude-opus-5": "acme-pro",
    "claude-haiku-4-5": { target: "acme-lite", label: "Acme Lite" },
  },
});

/** 改一份声明（浅拷贝，够用）。 */
const withField = (patch) => ({ ...GOOD, ...patch });

/** 真实现成的「模块视角」—— 反向对照里拿它跟改坏的副本对照。 */
const REAL = { parseManifest, validateManifest, toProviderSpec, createRegistry };

/* ====================================================================== *
 * ① 解析：只吃 JSON
 * ====================================================================== */
describe("① 解析 —— 只吃 JSON", () => {
  test("①a 合法 JSON 读成对象", () => {
    const obj = parseManifest(JSON.stringify(GOOD));
    assert.equal(obj.id, "acme");
    assert.equal(obj.protocol, "openai");
  });

  test("①b 语法错 ⇒ 人话（说清在哪、缺了什么）", () => {
    /* ⚠ 断言只查「是不是人话 + 有没有位置」，**不查 Node 的具体措辞** ——
       Node 各版本的 JSON 报错文本不一样（20 之后从 "Unexpected token" 改成了
       "Expected …"），把措辞写进断言等于给 Node 的实现细节上了锁。 */
    for (const bad of ['{"id": "acme",}', '{"id": "acme"']) {
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
    /* YAML 解析器是外部依赖，本仓不引新依赖 —— 这条要在报错里说给用户听，
       否则作者会以为是清单写错了。 */
    assert.throws(
      () => parseManifest("id: acme\nname: Acme\n"),
      (e) => /JSON/.test(e.message) && /YAML/.test(e.message),
      "要说清是格式不支持（而不是清单写错了）"
    );
  });

  test("①d 空文件与顶层不是对象 ⇒ 拒收", () => {
    assert.throws(() => parseManifest("   "), (e) => /空的/.test(e.message));
    assert.throws(() => parseManifest("[1,2,3]"), (e) => /顶层/.test(e.message));
    assert.throws(() => parseManifest('"acme"'), (e) => /顶层/.test(e.message));
  });
});

/* ====================================================================== *
 * ② 校验：逐项 + 人话
 * ====================================================================== */
describe("② 校验 —— 逐项给人话", () => {
  test("②a 合法声明全过", () => {
    const v = validateManifest(GOOD);
    assert.equal(v.ok, true, formatErrors(v.errors));
    assert.deepEqual(v.errors, []);
    assert.equal(v.manifest.id, "acme");
  });

  test("②b 格式版本：缺了/不对/不认识，都要说人话", () => {
    const miss = validateManifest((() => { const o = { ...GOOD }; delete o.manifestVersion; return o; })());
    assert.equal(miss.ok, false);
    assert.ok(miss.errors.some((e) => e.field === "manifestVersion" && /缺少/.test(e.message)));

    const wrong = validateManifest(withField({ manifestVersion: 2 }));
    assert.equal(wrong.ok, false);
    assert.ok(wrong.errors.some((e) => e.field === "manifestVersion" && /只认 1/.test(e.message)));

    const notInt = validateManifest(withField({ manifestVersion: "1" }));
    assert.equal(notInt.ok, false);
    assert.ok(notInt.errors.some((e) => e.field === "manifestVersion" && /整数/.test(e.message)));
  });

  test("②c 渠道键：只许小写字母数字与短横线", () => {
    assert.ok(CHANNEL_KEY_RE.test("acme"));
    assert.ok(CHANNEL_KEY_RE.test("my-provider-2"));
    for (const bad of ["Acme", "acme_x", "ac me", "-acme", "acme!", "渠道"]) {
      const v = validateManifest(withField({ id: bad }));
      assert.equal(v.ok, false, `「${bad}」不该通过`);
      assert.ok(
        v.errors.some((e) => e.field === "id" && /不合法/.test(e.message)),
        `「${bad}」的报错要说的是「键不合法」`
      );
    }
  });

  test("②d 渠道键不许与出厂八家撞", () => {
    for (const k of FACTORY_CHANNELS) {
      const v = validateManifest(withField({ id: k }));
      assert.equal(v.ok, false, `「${k}」是出厂渠道，插件不许用`);
      assert.ok(
        v.errors.some((e) => e.field === "id" && /撞了/.test(e.message)),
        `「${k}」的报错要说明是撞了出厂渠道`
      );
    }
  });

  test("②e 显示名：不能空、不能太长", () => {
    assert.equal(validateManifest(withField({ name: "  " })).ok, false);
    const long = validateManifest(withField({ name: "x".repeat(61) }));
    assert.equal(long.ok, false);
    assert.ok(long.errors.some((e) => e.field === "name" && /太长/.test(e.message)));
  });

  test("②f 上游地址：必须是 http/https", () => {
    const ftp = validateManifest(withField({ upstream: "ftp://acme.example/v1" }));
    assert.equal(ftp.ok, false);
    assert.ok(ftp.errors.some((e) => e.field === "upstream" && /只许 http 或 https/.test(e.message)));

    const file = validateManifest(withField({ upstream: "file:///etc/passwd" }));
    assert.equal(file.ok, false);

    const bad = validateManifest(withField({ upstream: "不是网址" }));
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.field === "upstream" && /不是网址/.test(e.message)));
  });

  test("②g 上游地址里不许带用户名密码", () => {
    const v = validateManifest(withField({ upstream: "https://user:pass@acme.example/v1" }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "upstream" && /用户名密码/.test(e.message)));
  });

  test("②h 协议：只许 anthropic / openai", () => {
    assert.deepEqual([...PROTOCOLS], ["anthropic", "openai"]);
    const v = validateManifest(withField({ protocol: "grpc" }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "protocol" && /不认/.test(e.message)));
    assert.equal(validateManifest(withField({ protocol: "anthropic" })).ok, true);
  });

  test("②i 认证方式：只许 apikey / bearer / none", () => {
    assert.deepEqual([...AUTH_SCHEMES], ["apikey", "bearer", "none"]);
    for (const a of AUTH_SCHEMES) {
      assert.equal(validateManifest(withField({ auth: a })).ok, true, `${a} 应当合法`);
    }
    const v = validateManifest(withField({ auth: "oauth" }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "auth" && /不认/.test(e.message)));
  });

  test("②j 模型清单：非空、不重复、都是文字", () => {
    assert.equal(validateManifest(withField({ models: [] })).ok, false);
    const dup = validateManifest(withField({ models: ["a", "a"] }));
    assert.equal(dup.ok, false);
    assert.ok(dup.errors.some((e) => e.field === "models" && /重复/.test(e.message)));
    assert.equal(validateManifest(withField({ models: "acme-pro" })).ok, false);
    assert.equal(validateManifest(withField({ models: ["", "x"] })).ok, false);
  });

  test("②k 档位映射：四档都得有", () => {
    assert.equal(TIER_KEYS.length, 4);
    for (const t of TIER_KEYS) {
      assert.ok(GOOD.mapping[t] !== undefined, `基准声明里应当有 ${t}`);
    }
    const missing = { ...GOOD.mapping };
    delete missing["claude-opus-5"];
    const v = validateManifest(withField({ mapping: missing }));
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.field === "mapping.claude-opus-5" && /少了/.test(e.message)),
      "要指名道姓地说少了哪一档"
    );
  });

  test("②l 档位映射：指向的模型必须在清单里", () => {
    /* 中转按「模型名 → 可用清单」认它 —— 清单里没有的模型会被当不认识，
       那这一档等于没配。 */
    const v = validateManifest(withField({
      mapping: { ...GOOD.mapping, "claude-opus-5": "acme-typo" },
    }));
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.field === "mapping.claude-opus-5" && /不在模型清单/.test(e.message)),
      "要说明是模型清单里没有它"
    );
  });

  test("②m 档位映射：不认识的档位也要报错", () => {
    const v = validateManifest(withField({
      mapping: { ...GOOD.mapping, "claude-opus-9": "acme-pro" },
    }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "mapping.claude-opus-9" && /不认识的档位/.test(e.message)));
  });

  test("②n 不认识的字段要报错（不是静默忽略）", () => {
    const v = validateManifest(withField({ uplstream: "https://x.example" }));
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.field === "uplstream" && /不认识的字段/.test(e.message)),
      "手误字段要单独点名，否则作者会绕远路"
    );
  });

  test("②o 中转端口：不许撞出厂渠道占着的那些", () => {
    const v = validateManifest(withField({ relayPort: 15722 }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "relayPort" && /占着/.test(e.message)));
    assert.equal(validateManifest(withField({ relayPort: 15802 })).ok, true);
    assert.equal(validateManifest(withField({ relayPort: 70000 })).ok, false);
    assert.equal(validateManifest(withField({ relayPort: 1.5 })).ok, false);
  });

  test("②p 一次报全所有问题（不是只报第一个）", () => {
    const v = validateManifest(withField({ id: "Acme", protocol: "grpc", auth: "oauth" }));
    assert.equal(v.ok, false);
    const fields = v.errors.map((e) => e.field);
    assert.ok(fields.includes("id"), "键的问题要报");
    assert.ok(fields.includes("protocol"), "协议的问题要报");
    assert.ok(fields.includes("auth"), "认证的问题要报");
  });

  test("②q 每条错都带字段名与中文消息（面板要标出哪一栏）", () => {
    const v = validateManifest(withField({ id: "Acme" }));
    for (const e of v.errors) {
      assert.equal(typeof e.field, "string");
      assert.equal(typeof e.message, "string");
      assert.ok(e.message.length > 0);
      assert.ok(/[一-龥]/.test(e.message), `「${e.message}」得是人话（中文）`);
    }
  });
});

/* ====================================================================== *
 * ③ 转换：形状要与 config.defaults.json 里的一家同构
 * ====================================================================== */
describe("③ 转换 —— 本仓内部的渠道形状", () => {
  test("③a config 与 config.defaults.json 里的渠道块同构", () => {
    const spec = toProviderSpec(GOOD);
    const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));

    /* 出厂没有哪一家跟插件的块**逐字一样**（各有各的历史字段：qd 有 tokenFile、
       wb 有 refreshToken、zen 有 transport），所以「同构」按两条口径验：
       ① 每家都有的那几项，插件也得有；② 插件不许有出厂谁都没有的字段。 */
    const CORE = ["upstream", "relayPort", "defaultModel", "availableModels", "mapping"];
    const builtInKeys = new Set();
    for (const v of Object.values(defaults)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      if (!CORE.every((c) => c in v)) continue;   // 只看渠道块（顶层的 bai 与 failover 不算）
      for (const k of Object.keys(v)) builtInKeys.add(k);
    }
    for (const c of CORE) {
      assert.ok(c in spec.config, `config 少了出厂每家都有的「${c}」`);
    }
    for (const k of Object.keys(spec.config)) {
      assert.ok(builtInKeys.has(k), `config 里出现了出厂渠道都没有的字段「${k}」`);
    }
    assert.equal(spec.config.upstream, GOOD.upstream);
    assert.equal(spec.config.availableModels.length, 2);
    assert.equal(spec.config.defaultModel, "acme-lite", "没写 defaultModel 时取 fable 档的目标");
    assert.equal(spec.config.useProxy, false);
  });

  test("③b 档位映射统一成 {target, label}", () => {
    const spec = toProviderSpec(GOOD);
    assert.deepEqual(spec.mapping["claude-haiku-4-5"], { target: "acme-lite", label: "Acme Lite" });
    /* 没写 label 的那条：显示名退回模型 id（面板上至少认得出是哪个模型） */
    assert.deepEqual(spec.mapping["claude-opus-5"], { target: "acme-pro", label: "acme-pro" });
    assert.deepEqual(spec.config.mapping["claude-opus-5"], { target: "acme-pro", label: "acme-pro" });
  });

  test("③c slice 是 sliceOf 那种统一形状", () => {
    const spec = toProviderSpec(GOOD);
    assert.deepEqual(
      Object.keys(spec.slice).sort(),
      ["availableModels", "defaultModel", "key", "mapping", "p", "relayPort", "upstream", "useProxy", "zh"].sort()
    );
    assert.equal(spec.slice.p, "acme");
    assert.equal(spec.slice.zh, "Acme LLM");
    assert.equal(spec.slice.key, "", "凭据由用户在面板里填，现在当然是空的");
  });

  test("③d 协议决定 relayOpts（与 server.mjs 的 relaySpec 同形）", () => {
    assert.deepEqual(toProviderSpec(withField({ protocol: "openai" })).relayOpts, { openai: true });
    assert.deepEqual(toProviderSpec(withField({ protocol: "anthropic" })).relayOpts, {});
  });

  test("③e 认证方式决定凭据字段与请求头", () => {
    const k = toProviderSpec(withField({ auth: "apikey" }));
    assert.equal(k.credentialField, "apiKey");
    assert.equal(k.authHeader, "x-api-key");
    assert.equal(k.config.apiKey, "");

    const b = toProviderSpec(withField({ auth: "bearer" }));
    assert.equal(b.credentialField, "accessToken");
    assert.equal(b.authHeader, "authorization");
    assert.equal(b.config.accessToken, "");

    const n = toProviderSpec(withField({ auth: "none" }));
    assert.equal(n.credentialField, null);
    assert.equal(n.authHeader, null);
    assert.ok(!("apiKey" in n.config), "不要凭据的渠道就不该有凭据字段");
  });

  test("③f 缺省的 defaultModel 取 fable 档的目标（出厂八家都这样）", () => {
    const spec = toProviderSpec(GOOD);
    assert.equal(spec.defaultModel, "acme-lite");
    assert.equal(spec.config.defaultModel, "acme-lite");
  });

  test("③g 不给的 relayPort 是 0（待分配），不是随便一个数", () => {
    const spec = toProviderSpec(GOOD);
    assert.equal(spec.relayPort, 0);
    assert.equal(spec.config.relayPort, 0);
  });

  test("③h 没验过的声明不许转（转了就是错的配置）", () => {
    assert.throws(
      () => toProviderSpec(withField({ id: "Acme" })),
      (e) => /没通过校验/.test(e.message),
      "错的声明要在这里就炸，而不是变成一份错的配置"
    );
  });

  test("③i 返回值是副本：改了它改不坏原件", () => {
    const spec = toProviderSpec(GOOD);
    spec.availableModels.push("偷偷加的");
    spec.mapping["claude-opus-5"].target = "偷偷改的";
    const again = toProviderSpec(GOOD);
    assert.equal(again.availableModels.length, 2);
    assert.equal(again.mapping["claude-opus-5"].target, "acme-pro");
  });
});

/* ====================================================================== *
 * ④ 注册表：列、取、按名查、冲突报错
 * ====================================================================== */
describe("④ 注册表", () => {
  test("④a 装上、能列、能按键取、能按名字查", () => {
    const reg = createRegistry();
    const spec = reg.register(GOOD, { now: 1_700_000_000_000 });
    assert.equal(spec.id, "acme");
    assert.equal(reg.list().length, 1);
    assert.equal(reg.get("acme").name, "Acme LLM");
    assert.equal(reg.findByName("Acme LLM").id, "acme");
    assert.equal(reg.findByName("  acme llm  ").id, "acme", "按名字查不该挑空格与大小写");
    assert.equal(reg.get("nope"), null);
    assert.equal(reg.findByName("没有这家"), null);
    assert.equal(reg.has("acme"), true);
  });

  test("④b 时间由调用方给（模块自己不取时钟）", () => {
    const reg = createRegistry();
    assert.equal(reg.register(GOOD, { now: 123 }).loadedAt, 123);
    assert.equal(reg.register({ ...GOOD, id: "acme2", name: "Acme 2" }).loadedAt, null,
      "没给时刻就是 null，不是「现在」");
  });

  test("④c 与出厂渠道撞 ⇒ 报错，不许覆盖", () => {
    const reg = createRegistry();
    assert.throws(
      () => reg.register(withField({ id: "bai" })),
      (e) => /出厂渠道/.test(e.message),
      "覆盖出厂渠道等于让插件改掉用户的 bai 配置"
    );
    assert.equal(reg.list().length, 0, "撞了就不该装进去");
  });

  test("④d 同一个渠道键装两次 ⇒ 报错", () => {
    const reg = createRegistry();
    reg.register(GOOD);
    assert.throws(
      () => reg.register(GOOD),
      (e) => /已经有一个插件/.test(e.message)
    );
    assert.equal(reg.list().length, 1);
  });

  test("④e 显示名重名 ⇒ 报错（按名字查要能唯一）", () => {
    const reg = createRegistry();
    reg.register(GOOD);
    assert.throws(
      () => reg.register({ ...GOOD, id: "acme2" }),
      (e) => /已经有插件叫/.test(e.message)
    );
  });

  test("④f 两个插件抢同一个端口 ⇒ 报错", () => {
    const reg = createRegistry();
    reg.register(withField({ relayPort: 15802 }));
    assert.throws(
      () => reg.register(withField({ id: "other", name: "Other", relayPort: 15802 })),
      (e) => /已经被插件/.test(e.message)
    );
  });

  test("④g check 只查不装（面板要知道能不能装）", () => {
    const reg = createRegistry();
    const okRes = reg.check(GOOD);
    assert.equal(okRes.ok, true);
    assert.equal(reg.list().length, 0, "check 不该装东西");

    const bad = reg.check(withField({ id: "bai" }));
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /出厂渠道/.test(e.message)));
  });

  test("④h 卸掉之后能再装同一个键", () => {
    const reg = createRegistry();
    reg.register(GOOD);
    assert.equal(reg.unregister("acme").id, "acme");
    assert.equal(reg.list().length, 0);
    assert.equal(reg.findByName("Acme LLM"), null);
    assert.doesNotThrow(() => reg.register(GOOD));
  });

  test("④i 装一份不合法的声明 ⇒ 抛错且说清哪一条", () => {
    const reg = createRegistry();
    assert.throws(
      () => reg.register(withField({ protocol: "grpc" })),
      (e) => /协议/.test(e.message)
    );
    assert.equal(reg.list().length, 0);
  });
});

/* ====================================================================== *
 * ⑤ 凭据不进清单
 * ====================================================================== */
describe("⑤ 秘密处理 —— 清单里不许带凭据", () => {
  test("⑤a 带 apiKey 的清单被明确拒绝", () => {
    const v = validateManifest(withField({ apiKey: "sk-abcdef0123456789" }));
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.field === "apiKey" && /凭据/.test(e.message)),
      "报错要说明这是凭据的事（不是「不认识的字段」）"
    );
    assert.ok(
      v.errors.some((e) => /插件是要分发给别人的东西/.test(e.message)),
      "报错要说明为什么不行"
    );
  });

  test("⑤b 各种凭据字段名都被拒", () => {
    for (const f of ["apiKey", "token", "accessToken", "secret", "password", "credential", "authorization"]) {
      const v = validateManifest(withField({ [f]: "whatever" }));
      assert.equal(v.ok, false, `「${f}」不该通过`);
      assert.ok(v.errors.some((e) => e.field === f && /凭据/.test(e.message)), `「${f}」要单独点名`);
    }
  });

  test("⑤c 报错里不回显凭据的值", () => {
    const v = validateManifest(withField({ apiKey: "sk-SUPERSECRET1234567890" }));
    const text = formatErrors(v.errors);
    assert.ok(!text.includes("SUPERSECRET"), "错误消息会被写进日志与面板，不能带出凭据");
  });

  test("⑤d 转出来的 config 里凭据字段是空的（等用户填）", () => {
    const spec = toProviderSpec(GOOD);
    assert.equal(spec.config.apiKey, "");
    assert.equal(spec.slice.key, "");
  });
});

/* ====================================================================== *
 * ⑥ 零依赖 + 防漂移（源码锚点断言）
 * ====================================================================== */
describe("⑥ 零依赖与防漂移", () => {
  test("⑥a plugin.mjs 不 import 仓库里任何模块、也不用任何包", () => {
    const src = fs.readFileSync(PLUGIN_PATH, "utf8");
    assert.ok(!/\bfrom\s+["']/.test(src), "不许有相对/绝对 import");
    assert.ok(!/\brequire\s*\(/.test(src), "不许有 require");
    assert.ok(!/\bimport\s*\(/.test(src), "不许有动态 import");
  });

  test("⑥b 出厂渠道名单与 server.mjs 的 CHANNELS 一致", () => {
    const src = fs.readFileSync(SERVER_PATH, "utf8");
    const m = /const CHANNELS = \[([^\]]*)\]/.exec(src);
    assert.ok(m, "server.mjs 里找不到 CHANNELS —— 名单改了形状就得同步改这份断言");
    const live = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual([...FACTORY_CHANNELS], live, "plugin.mjs 的出厂渠道名单漂移了");
  });

  test("⑥c 档位名单与 server.mjs 的 TIERS 一致", () => {
    const src = fs.readFileSync(SERVER_PATH, "utf8");
    const m = /const TIERS = \[([\s\S]*?)\n\];/.exec(src);
    assert.ok(m, "server.mjs 里找不到 TIERS");
    const live = [...m[1].matchAll(/key:\s*"([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual([...TIER_KEYS], live, "plugin.mjs 的档位名单漂移了");
  });

  test("⑥d 占用的端口与 config.defaults.json 一致", () => {
    const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));
    const live = new Set();
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if ((k === "relayPort" || k === "panelPort" || k === "gatewayPort") && Number.isInteger(v)) live.add(v);
        else walk(v);
      }
    };
    walk(defaults);
    assert.deepEqual([...RESERVED_PORTS].sort((a, b) => a - b), [...live].sort((a, b) => a - b),
      "plugin.mjs 的占用端口名单漂移了");
  });

  test("⑥e 格式版本常量与自己的一致", () => {
    assert.equal(MANIFEST_VERSION, 1);
    assert.equal(validateManifest(GOOD).manifest.manifestVersion, MANIFEST_VERSION);
  });
});

/* ====================================================================== *
 * ⑦ 反向对照：把实现改坏，对应的断言必须真的会红
 * ====================================================================== */

/* 改坏的办法：把 plugin.mjs 复制一份到临时目录，改掉其中一处，再 import 进来。
   复制件没有 import（零依赖），所以单独放着也能跑。 */
const SABOTAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bai-plugin-sabotage-"));
process.on("exit", () => {
  try { fs.rmSync(SABOTAGE_DIR, { recursive: true, force: true }); } catch { /* 临时目录留着也无妨 */ }
});
let sabotageSeq = 0;
async function sabotaged(replacements) {
  const src = fs.readFileSync(PLUGIN_PATH, "utf8");
  let next = src;
  for (const [from, to] of replacements) {
    const found = from instanceof RegExp ? from.test(next) : next.includes(from);
    assert.ok(found, `改坏的锚点找不到了：${from}`);
    next = next.replace(from, to);
  }
  assert.notEqual(next, src, "改动没生效");
  const file = path.join(SABOTAGE_DIR, `plugin-${sabotageSeq++}.mjs`);
  fs.writeFileSync(file, next, "utf8");
  return import(pathToFileURL(file).href);
}

/* 「这条断言在改坏之后必须会红」—— 不红就说明它是恒真的，等于没写。 */
function assertGoesRed(fn, why) {
  let threw = false;
  let msg = "";
  try { fn(); } catch (e) { threw = true; msg = String((e && e.message) || e); }
  assert.equal(threw, true, `${why}：改坏之后这条断言居然还是绿的，说明它是恒真的`);
  return msg;
}

describe("⑦ 反向对照 —— 改坏实现，对应断言必须红", () => {
  test("⑦a 把渠道键规则放宽 ⇒ ②c 的断言会红", async () => {
    const mod = await sabotaged([
      ["CHANNEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/", "CHANNEL_KEY_RE = /^.{1,40}$/"],
    ]);
    const check = (m) => () => {
      const v = m.validateManifest(withField({ id: "Acme" }));
      assert.equal(v.ok, false, "大写的渠道键必须被拒");
      assert.ok(v.errors.some((e) => e.field === "id" && /不合法/.test(e.message)));
    };
    check(REAL)();          // 真的实现：断言成立
    assertGoesRed(check(mod), "放宽了渠道键规则");  // 改坏：断言红
  });

  test("⑦b 把凭据检查去掉 ⇒ ⑤a 的断言会红", async () => {
    const mod = await sabotaged([
      ["if (CREDENTIAL_FIELDS.includes(k)) {", "if (false) {"],
      ['"models", "defaultModel", "mapping", "relayPort", "useProxy",',
       '"models", "defaultModel", "mapping", "relayPort", "useProxy", "apiKey",'],
    ]);
    const check = (m) => () => {
      const v = m.validateManifest(withField({ apiKey: "sk-abcdef0123456789" }));
      assert.equal(v.ok, false, "带凭据的清单必须被拒");
      assert.ok(v.errors.some((e) => e.field === "apiKey" && /凭据/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了凭据检查");
  });

  test("⑦c 把 URL 协议检查去掉 ⇒ ②f 的断言会红", async () => {
    const mod = await sabotaged([
      ['} else if (u.protocol !== "http:" && u.protocol !== "https:") {', '} else if (false) {'],
    ]);
    const check = (m) => () => {
      const v = m.validateManifest(withField({ upstream: "ftp://acme.example/v1" }));
      assert.equal(v.ok, false, "ftp 不是 http/https，必须被拒");
      assert.ok(v.errors.some((e) => e.field === "upstream" && /只许 http 或 https/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了协议检查");
  });

  test("⑦d 把「档位目标必须在模型清单里」去掉 ⇒ ②l 的断言会红", async () => {
    const mod = await sabotaged([
      ["if (modelsOk && !models.includes(target)) {", "if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateManifest(withField({
        mapping: { ...GOOD.mapping, "claude-opus-5": "acme-typo" },
      }));
      assert.equal(v.ok, false, "指向清单外的模型必须被拒");
      assert.ok(v.errors.some((e) => e.field === "mapping.claude-opus-5" && /不在模型清单/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了模型清单的归属检查");
  });

  test("⑦e 把「四档都得有」去掉 ⇒ ②k 的断言会红", async () => {
    const mod = await sabotaged([
      ["if (!(tier in obj.mapping)) {", "if (false) {"],
    ]);
    const check = (m) => () => {
      const missing = { ...GOOD.mapping };
      delete missing["claude-opus-5"];
      const v = m.validateManifest(withField({ mapping: missing }));
      assert.equal(v.ok, false, "少一档必须被拒");
      assert.ok(v.errors.some((e) => e.field === "mapping.claude-opus-5" && /少了/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了缺档检查");
  });

  test("⑦f 把出厂渠道名单清空 ⇒ ④c 的断言会红", async () => {
    const mod = await sabotaged([
      [/export const FACTORY_CHANNELS = Object\.freeze\(\[[^\]]*\]\);/,
       "export const FACTORY_CHANNELS = Object.freeze([]);"],
    ]);
    const check = (m) => () => {
      const reg = m.createRegistry();
      assert.throws(
        () => reg.register(withField({ id: "bai" })),
        (e) => /出厂渠道/.test(e.message),
        "插件不许占用出厂渠道的键"
      );
    };
    check(REAL)();
    assertGoesRed(check(mod), "清空了出厂渠道名单");
  });

  test("⑦g 把「不认识的字段」检查去掉 ⇒ ②n 的断言会红", async () => {
    const mod = await sabotaged([
      ["if (!KNOWN_FIELDS.includes(k) && !CREDENTIAL_FIELDS.includes(k)) {", "if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateManifest(withField({ uplstream: "https://x.example" }));
      assert.equal(v.ok, false, "手误字段必须被拒");
      assert.ok(v.errors.some((e) => e.field === "uplstream" && /不认识的字段/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了未知字段检查");
  });
});
