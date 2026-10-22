/* 声明式 middleware 层（src/server/middleware.mjs）的口径测试。
 *
 * 这一层是「对标 magpie 的网关中间件」的**声明式一档**：magpie 的中间件是
 * 一段真代码（在网关进程内的 moejs 里跑），本仓的中间件是**一份 JSON 声明**
 * ——能描述「改什么」，不能执行代码。测的是六条硬规矩：
 *
 *   ① 声明只吃 JSON（YAML 解析器是外部依赖，本仓不引新依赖）；
 *   ② 校验逐项给**人话**错误（不是 "invalid schema"）；
 *   ③ 匹配：条件之间是「与」、同一个条件写成数组是「或」；
 *   ④ 顺序：规则按声明顺序、后面覆盖前面、且是**渐进**的；
 *   ⑤ **不许碰凭据**（能改凭据的插件 = 能把你的 key 发到别处的插件）；
 *   ⑥ 改写后必须仍然合法：模型改成这家没有的 ⇒ **拒绝并说清原因**，
 *      不许静默改坏（与 magpie 的 fail-open 有意不同）。
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
  MIDDLEWARE_MANIFEST_VERSION,
  TIER_KEYS,
  PROTOCOLS,
  CHANNEL_KEY_RE,
  CREDENTIAL_HEADERS,
  parseMiddlewareManifest,
  validateMiddlewareManifest,
  compileRules,
  applyRequest,
  applyResponse,
  responseContextOf,
  createMiddlewareRegistry,
  formatErrors,
} from "../src/server/middleware.mjs";

/* 防漂移用：plugin.mjs 那边有一份同形的名单（档位、渠道键的形状）。 */
import {
  TIER_KEYS as PLUGIN_TIER_KEYS,
  CHANNEL_KEY_RE as PLUGIN_CHANNEL_KEY_RE,
} from "../src/server/plugin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MW_PATH = path.join(ROOT, "src", "server", "middleware.mjs");

/* 一份合法的声明（后面的用例都从它改出来）。 */
const GOOD = Object.freeze({
  manifestVersion: 1,
  id: "my-rules",
  name: "我的规则",
  rules: [
    {
      when: { provider: "sn", tier: "claude-opus-5" },
      request: {
        setHeaders: { "X-Foo": "bar" },
        model: "glm-5.2",
        setParams: { temperature: 0.2 },
      },
    },
    {
      when: { provider: "wb" },
      response: { setHeaders: { "X-Budget": "on" } },
    },
  ],
});

/** 改一份声明（浅拷贝，够用）。 */
const withField = (patch) => ({ ...GOOD, ...patch });

/** 一次请求的上下文。 */
const ctx = (patch = {}) => ({
  provider: "sn",
  tier: "claude-opus-5",
  model: "glm-5.2",
  protocol: "anthropic",
  path: "/v1/messages",
  stream: true,
  headers: { "x-api-key": "sk-secret", "content-type": "application/json" },
  params: { temperature: 0.7, max_tokens: 4096 },
  availableModels: ["glm-5.2", "sensenova-6.8"],
  ...patch,
});

/** 真实现成的「模块视角」—— 反向对照里拿它跟改坏的副本对照。 */
const REAL = { applyRequest, applyResponse, validateMiddlewareManifest, createMiddlewareRegistry };

/* ====================================================================== *
 * ① 解析：只吃 JSON
 * ====================================================================== */
describe("① 解析 —— 只吃 JSON", () => {
  test("①a 合法 JSON 读成对象", () => {
    const obj = parseMiddlewareManifest(JSON.stringify(GOOD));
    assert.equal(obj.id, "my-rules");
    assert.equal(obj.rules.length, 2);
  });

  test("①b 语法错 ⇒ 人话（说清在哪、缺了什么）", () => {
    /* ⚠ 断言只查「是不是人话 + 有没有位置」，**不查 Node 的具体措辞** ——
       Node 各版本的 JSON 报错文本不一样，把措辞写进断言等于给 Node 上了锁。 */
    for (const bad of ['{"id": "my-rules",}', '{"id": "my-rules"']) {
      assert.throws(
        () => parseMiddlewareManifest(bad),
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
      () => parseMiddlewareManifest("id: my-rules\nrules: []\n"),
      (e) => /JSON/.test(e.message) && /YAML/.test(e.message),
      "要说清是格式不支持（而不是声明写错了）"
    );
  });

  test("①d 空文件与顶层不是对象 ⇒ 拒收", () => {
    assert.throws(() => parseMiddlewareManifest("   "), (e) => /空的/.test(e.message));
    assert.throws(() => parseMiddlewareManifest("[1,2,3]"), (e) => /顶层/.test(e.message));
    assert.throws(() => parseMiddlewareManifest('"my-rules"'), (e) => /顶层/.test(e.message));
    assert.throws(() => parseMiddlewareManifest(42), (e) => /字符串/.test(e.message));
  });
});

/* ====================================================================== *
 * ② 校验：逐项 + 人话
 * ====================================================================== */
describe("② 校验 —— 逐项给人话", () => {
  test("②a 合法声明全过", () => {
    const v = validateMiddlewareManifest(GOOD);
    assert.equal(v.ok, true, formatErrors(v.errors));
    assert.deepEqual(v.errors, []);
    assert.equal(v.manifest.id, "my-rules");
    assert.equal(v.manifest.name, "我的规则");
  });

  test("②b 头注释里的那个例子本身就是合法声明（文档即契约）", () => {
    const v = validateMiddlewareManifest({
      manifestVersion: 1,
      id: "my-rules",
      name: "我的规则",
      rules: [
        {
          when: { provider: "sn", tier: "claude-opus-5" },
          request: {
            setHeaders: { "X-Foo": "bar" },
            model: "glm-5.2",
            setParams: { temperature: 0.2 },
          },
        },
        {
          when: { provider: "wb" },
          response: { setHeaders: { "X-Budget": "on" } },
        },
      ],
    });
    assert.equal(v.ok, true, formatErrors(v.errors));
  });

  test("②c 格式版本：缺了/不对/不认识，都要说人话", () => {
    const miss = validateMiddlewareManifest((() => { const o = { ...GOOD }; delete o.manifestVersion; return o; })());
    assert.equal(miss.ok, false);
    assert.ok(miss.errors.some((e) => e.field === "manifestVersion" && /缺少/.test(e.message)));

    const wrong = validateMiddlewareManifest(withField({ manifestVersion: 2 }));
    assert.equal(wrong.ok, false);
    assert.ok(wrong.errors.some((e) => e.field === "manifestVersion" && /只认 1/.test(e.message)));

    const notInt = validateMiddlewareManifest(withField({ manifestVersion: "1" }));
    assert.equal(notInt.ok, false);
    assert.ok(notInt.errors.some((e) => e.field === "manifestVersion" && /整数/.test(e.message)));
  });

  test("②d 声明的键：只许小写字母数字与短横线", () => {
    assert.ok(CHANNEL_KEY_RE.test("my-rules"));
    assert.ok(CHANNEL_KEY_RE.test("rule2"));
    for (const bad of ["My-Rules", "my_rules", "my rules", "-rules", "rules!"]) {
      const v = validateMiddlewareManifest(withField({ id: bad }));
      assert.equal(v.ok, false, `「${bad}」不该通过`);
      assert.ok(
        v.errors.some((e) => e.field === "id" && /不合法/.test(e.message)),
        `「${bad}」的报错要说的是「键不合法」`
      );
    }
  });

  test("②e 显示名：可以不给（退回 id），给了就不能空、不能太长", () => {
    const noName = validateMiddlewareManifest((() => { const o = { ...GOOD }; delete o.name; return o; })());
    assert.equal(noName.ok, true, formatErrors(noName.errors));
    assert.equal(noName.manifest.name, "my-rules", "没给显示名就退回 id");

    assert.equal(validateMiddlewareManifest(withField({ name: "  " })).ok, false);
    const long = validateMiddlewareManifest(withField({ name: "x".repeat(61) }));
    assert.equal(long.ok, false);
    assert.ok(long.errors.some((e) => e.field === "name" && /太长/.test(e.message)));
  });

  test("②f 规则清单：缺了/不是数组/是空的都要报错", () => {
    const miss = validateMiddlewareManifest((() => { const o = { ...GOOD }; delete o.rules; return o; })());
    assert.equal(miss.ok, false);
    assert.ok(miss.errors.some((e) => e.field === "rules" && /缺少/.test(e.message)));

    assert.equal(validateMiddlewareManifest(withField({ rules: {} })).ok, false);
    const empty = validateMiddlewareManifest(withField({ rules: [] }));
    assert.equal(empty.ok, false);
    assert.ok(empty.errors.some((e) => e.field === "rules" && /空的/.test(e.message)));
  });

  test("②g 不认识的字段要报错（不是静默忽略）", () => {
    const v = validateMiddlewareManifest(withField({ uplstream: "https://x.example" }));
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.field === "uplstream" && /不认识的字段/.test(e.message)),
      "手误字段要单独点名，否则作者会绕远路"
    );
  });

  test("②h 规则里不认识的字段也要报错", () => {
    const whenBad = validateMiddlewareManifest(withField({
      rules: [{ when: { provder: "sn" }, request: { setHeaders: {} } }],
    }));
    assert.equal(whenBad.ok, false);
    assert.ok(whenBad.errors.some((e) => e.field === "rules[0].when.provder" && /不认识的字段/.test(e.message)));

    const reqBad = validateMiddlewareManifest(withField({
      rules: [{ request: { setHeders: { "X-A": "b" } } }],
    }));
    assert.equal(reqBad.ok, false);
    assert.ok(reqBad.errors.some((e) => e.field === "rules[0].request.setHeders" && /不认识的字段/.test(e.message)));

    const respBad = validateMiddlewareManifest(withField({
      rules: [{ response: { setBody: "x" } }],
    }));
    assert.equal(respBad.ok, false);
    assert.ok(respBad.errors.some((e) => e.field === "rules[0].response.setBody" && /不认识的字段/.test(e.message)));
  });

  test("②i 一条规则既没 request 也没 response ⇒ 报错（它什么也不做）", () => {
    const v = validateMiddlewareManifest(withField({ rules: [{ when: { provider: "sn" } }] }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "rules[0]" && /什么也不做/.test(e.message)));
  });

  test("②j 档位与协议是有限集合：写错要报错（否则规则永远不命中）", () => {
    const tier = validateMiddlewareManifest(withField({
      rules: [{ when: { tier: "claude-opus-9" }, request: { setHeaders: {} } }],
    }));
    assert.equal(tier.ok, false);
    assert.ok(tier.errors.some((e) => e.field === "rules[0].when.tier" && /不认/.test(e.message)));

    const proto = validateMiddlewareManifest(withField({
      rules: [{ when: { protocol: "grpc" }, request: { setHeaders: {} } }],
    }));
    assert.equal(proto.ok, false);
    assert.ok(proto.errors.some((e) => e.field === "rules[0].when.protocol" && /不认/.test(e.message)));

    assert.deepEqual([...PROTOCOLS], ["anthropic", "responses", "gemini"]);
    assert.deepEqual([...TIER_KEYS].sort(), [
      "claude-fable-5", "claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5",
    ]);
  });

  test("②k 请求头名与头值都要过关（头名是 token、头值不许带换行）", () => {
    const badName = validateMiddlewareManifest(withField({
      rules: [{ request: { setHeaders: { "X Foo": "bar" } } }],
    }));
    assert.equal(badName.ok, false);
    assert.ok(badName.errors.some((e) => /头名/.test(e.message)));

    const crlf = validateMiddlewareManifest(withField({
      rules: [{ request: { setHeaders: { "X-Foo": "bar\r\nX-Evil: 1" } } }],
    }));
    assert.equal(crlf.ok, false);
    assert.ok(crlf.errors.some((e) => /换行/.test(e.message)), "带换行的头值是头注入，必须挡住");

    const badType = validateMiddlewareManifest(withField({
      rules: [{ request: { setHeaders: { "X-Foo": { a: 1 } } } }],
    }));
    assert.equal(badType.ok, false);
  });

  test("②l 已知参数要有类型与范围（temperature 越界要报错）", () => {
    const hot = validateMiddlewareManifest(withField({
      rules: [{ request: { setParams: { temperature: 5 } } }],
    }));
    assert.equal(hot.ok, false);
    assert.ok(hot.errors.some((e) => /temperature/.test(e.message) && /不在/.test(e.message)));

    const neg = validateMiddlewareManifest(withField({
      rules: [{ request: { setParams: { max_tokens: 0 } } }],
    }));
    assert.equal(neg.ok, false);

    const notInt = validateMiddlewareManifest(withField({
      rules: [{ request: { setParams: { max_tokens: 1.5 } } }],
    }));
    assert.equal(notInt.ok, false);

    const badArr = validateMiddlewareManifest(withField({
      rules: [{ request: { setParams: { stop: [1, 2] } } }],
    }));
    assert.equal(badArr.ok, false);
  });

  test("②m 同一个东西又删又设 ⇒ 报错（作者自己也不确定要哪个）", () => {
    const head = validateMiddlewareManifest(withField({
      rules: [{ request: { setHeaders: { "X-Foo": "a" }, removeHeaders: ["X-Foo"] } }],
    }));
    assert.equal(head.ok, false);
    assert.ok(head.errors.some((e) => /又删又设/.test(e.message)));

    const param = validateMiddlewareManifest(withField({
      rules: [{ request: { setParams: { temperature: 0.2 }, removeParams: ["temperature"] } }],
    }));
    assert.equal(param.ok, false);
    assert.ok(param.errors.some((e) => /又删又设/.test(e.message)));
  });

  test("②n 一次报全所有问题（不是只报第一个）", () => {
    const v = validateMiddlewareManifest(withField({
      id: "My-Rules",
      rules: [{ when: { tier: "claude-opus-9" }, request: { setParams: { temperature: 5 } } }],
    }));
    assert.equal(v.ok, false);
    const fields = v.errors.map((e) => e.field);
    assert.ok(fields.includes("id"), "键的问题要报");
    assert.ok(fields.includes("rules[0].when.tier"), "档位的问题要报");
    assert.ok(fields.includes("rules[0].request.setParams.temperature"), "参数的问题要报");
  });

  test("②o 每条错都带字段名与中文消息（面板要标出哪一栏）", () => {
    const v = validateMiddlewareManifest(withField({ id: "My-Rules" }));
    for (const e of v.errors) {
      assert.equal(typeof e.field, "string");
      assert.equal(typeof e.message, "string");
      assert.ok(e.message.length > 0);
      assert.ok(/[一-龥]/.test(e.message), `「${e.message}」得是人话（中文）`);
    }
  });

  test("②p 编译后的声明是归一化的（字符串或数组统一成数组）", () => {
    const c = compileRules(GOOD);
    assert.equal(c.compiled, true);
    assert.deepEqual(c.rules[0].when.provider, ["sn"]);
    assert.deepEqual(c.rules[0].when.tier, ["claude-opus-5"]);
    assert.deepEqual(c.rules[0].when.protocol, []);
    assert.equal(c.rules[0].when.stream, null);
    assert.deepEqual(Object.keys(c.rules[0].request.setHeaders), ["x-foo"], "头名一律小写化");
  });

  test("②q 没验过的声明不许直接用（compileRules 自己先验一遍）", () => {
    assert.throws(
      () => compileRules(withField({ id: "My-Rules" })),
      (e) => /没通过校验/.test(e.message),
      "错的声明要在这里就炸，而不是变成一次错的改写"
    );
    assert.throws(
      () => compileRules(validateMiddlewareManifest(withField({ id: "My-Rules" }))),
      (e) => /没通过校验/.test(e.message)
    );
  });
});

/* ====================================================================== *
 * ③ 凭据不许碰
 * ====================================================================== */
describe("③ 凭据 —— middleware 不许改凭据", () => {
  test("③a 声明顶层不许带凭据字段", () => {
    const v = validateMiddlewareManifest(withField({ apiKey: "sk-abcdef0123456789" }));
    assert.equal(v.ok, false);
    assert.ok(
      v.errors.some((e) => e.field === "apiKey" && /凭据/.test(e.message)),
      "报错要说明这是凭据的事（不是「不认识的字段」）"
    );
    assert.ok(
      v.errors.some((e) => /声明是要分发给别人的东西/.test(e.message)),
      "报错要说明为什么不行"
    );
  });

  test("③b 不许设置凭据头", () => {
    for (const h of CREDENTIAL_HEADERS) {
      const v = validateMiddlewareManifest(withField({
        rules: [{ request: { setHeaders: { [h]: "Bearer whatever" } } }],
      }));
      assert.equal(v.ok, false, `「${h}」不该通过`);
      assert.ok(
        v.errors.some((e) => /凭据/.test(e.message)),
        `「${h}」要单独点名（且要说清是凭据）`
      );
    }
  });

  test("③c 不许删除凭据头", () => {
    const v = validateMiddlewareManifest(withField({
      rules: [{ request: { removeHeaders: ["authorization"] } }],
    }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /凭据/.test(e.message)));
  });

  test("③d 不许拿凭据头当匹配条件（条件是要分发给别人看的）", () => {
    const v = validateMiddlewareManifest(withField({
      rules: [{ when: { header: { "x-api-key": "sk-..." } }, request: { setHeaders: {} } }],
    }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "rules[0].when.header.x-api-key" && /凭据/.test(e.message)));
  });

  test("③e 不许把凭据写进参数（参数名像凭据）", () => {
    const v = validateMiddlewareManifest(withField({
      rules: [{ request: { setParams: { api_key: "sk-..." } } }],
    }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /凭据/.test(e.message)));
  });

  test("③f 凭据头的大小写变体也拦得住", () => {
    const v = validateMiddlewareManifest(withField({
      rules: [{ request: { setHeaders: { "Authorization": "Bearer x" } } }],
    }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /凭据/.test(e.message)));
  });

  test("③g 报错里不回显凭据的值", () => {
    const v = validateMiddlewareManifest(withField({
      rules: [{ request: { setHeaders: { authorization: "sk-SUPERSECRET1234567890" } } }],
    }));
    const text = formatErrors(v.errors);
    assert.ok(!text.includes("SUPERSECRET"), "错误消息会被写进日志与面板，不能带出凭据");
  });

  test("③h 没被改动的凭据头原样留着（middleware 只加不减）", () => {
    const r = applyRequest(compileRules(GOOD), ctx());
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(r.request.headers["x-api-key"], "sk-secret");
  });
});

/* ====================================================================== *
 * ④ 匹配
 * ====================================================================== */
describe("④ 匹配 —— 条件之间是与、同条件是或", () => {
  const one = (when) => ({ manifestVersion: 1, id: "m", rules: [{ when, request: { setHeaders: { "X-Hit": "1" } } }] });
  const hit = (when, c) => {
    const r = applyRequest(compileRules(one(when)), c);
    assert.equal(r.ok, true, formatErrors(r.errors));
    return r.request.headers["x-hit"] === "1";
  };

  test("④a 每个维度都能单独命中", () => {
    assert.equal(hit({ provider: "sn" }, ctx()), true);
    assert.equal(hit({ provider: "wb" }, ctx()), false);
    assert.equal(hit({ tier: "claude-opus-5" }, ctx()), true);
    assert.equal(hit({ tier: "claude-sonnet-5" }, ctx()), false);
    assert.equal(hit({ model: "glm-5.2" }, ctx()), true);
    assert.equal(hit({ model: "glm-9.9" }, ctx()), false);
    assert.equal(hit({ protocol: "anthropic" }, ctx()), true);
    assert.equal(hit({ protocol: "gemini" }, ctx()), false);
    assert.equal(hit({ path: "/v1/messages" }, ctx()), true);
    assert.equal(hit({ path: "/v1/chat" }, ctx()), false);
    assert.equal(hit({ stream: true }, ctx()), true);
    assert.equal(hit({ stream: false }, ctx()), false);
  });

  test("④b 同一个维度写成数组 ⇒ 是（或）", () => {
    assert.equal(hit({ provider: ["wb", "sn"] }, ctx()), true);
    assert.equal(hit({ provider: ["wb", "zen"] }, ctx()), false);
    assert.equal(hit({ tier: ["claude-sonnet-5", "claude-opus-5"] }, ctx()), true);
  });

  test("④c 多个维度之间 ⇒ 是（与）", () => {
    assert.equal(hit({ provider: "sn", tier: "claude-opus-5" }, ctx()), true);
    assert.equal(hit({ provider: "sn", tier: "claude-sonnet-5" }, ctx()), false);
    assert.equal(hit({ provider: ["sn", "wb"], tier: "claude-opus-5", stream: true }, ctx()), true);
    assert.equal(hit({ provider: ["sn", "wb"], tier: "claude-opus-5", stream: false }, ctx()), false);
  });

  test("④d 不写某个条件就是不管它", () => {
    assert.equal(hit({}, ctx()), true);
    assert.equal(hit({ provider: "sn" }, ctx({ provider: "" })), false);
  });

  test("④e 请求头条件：头名大小写不敏感、头值要对得上", () => {
    assert.equal(hit({ header: { "content-type": "application/json" } }, ctx()), true);
    assert.equal(hit({ header: { "Content-Type": "application/json" } }, ctx()), true);
    assert.equal(hit({ header: { "content-type": "text/plain" } }, ctx()), false);
    assert.equal(hit({ header: { "x-not-there": "1" } }, ctx()), false, "没这个头就不该命中");
    assert.equal(hit({ header: { "content-type": ["text/plain", "application/json"] } }, ctx()), true);
  });

  test("④f 缺头的请求不会因为有头条件而崩", () => {
    const r = applyRequest(compileRules(one({ header: { "x-a": "1" } })), ctx({ headers: {} }));
    assert.equal(r.ok, true);
    assert.equal(r.request.headers["x-hit"], undefined);
  });
});

/* ====================================================================== *
 * ⑤ 改写与顺序
 * ====================================================================== */
describe("⑤ 改写与顺序", () => {
  test("⑤a 基准声明改出该改的东西", () => {
    const r = applyRequest(compileRules(GOOD), ctx());
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(r.request.headers["x-foo"], "bar");
    assert.equal(r.request.params.temperature, 0.2);
    assert.equal(r.request.model, "glm-5.2");
    assert.ok(r.applied.length >= 3, "改了什么要记账");
    assert.ok(r.applied.some((a) => a.action === "setHeaders" && a.key === "x-foo"));
  });

  test("⑤b 没命中的规则不动手", () => {
    const r = applyRequest(compileRules(GOOD), ctx({ provider: "wb" }));
    assert.equal(r.ok, true);
    assert.equal(r.request.headers["x-foo"], undefined);
    assert.equal(r.request.params.temperature, 0.7, "没命中的规则不许改参数");
  });

  test("⑤c 多条规则命中时：按声明顺序，后面的覆盖前面的", () => {
    const decl = {
      manifestVersion: 1,
      id: "order",
      rules: [
        { request: { setHeaders: { "X-Who": "first" } } },
        { request: { setHeaders: { "X-Who": "second" } } },
      ],
    };
    const r = applyRequest(compileRules(decl), ctx());
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(r.request.headers["x-who"], "second", "后写的赢");
    assert.equal(r.applied.length, 2);
  });

  test("⑤d 规则是**渐进**的：后一条看到的是前面改过之后的请求", () => {
    const decl = {
      manifestVersion: 1,
      id: "cascade",
      rules: [
        { request: { model: "glm-5.2" } },
        { when: { model: "glm-5.2" }, request: { setHeaders: { "X-Saw": "yes" } } },
      ],
    };
    const r = applyRequest(compileRules(decl), ctx({ model: "glm-4.6" }));
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(r.request.model, "glm-5.2");
    assert.equal(r.request.headers["x-saw"], "yes", "后一条规则要看到改过的模型");
  });

  test("⑤e 一条规则内部：先定模型、再改参数、最后贴头", () => {
    const decl = {
      manifestVersion: 1,
      id: "inner",
      rules: [{
        request: {
          setHeaders: { "X-Model": "glm-5.2" },
          setParams: { temperature: 0.2 },
          model: "glm-5.2",
        },
      }],
    };
    const r = applyRequest(compileRules(decl), ctx());
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.deepEqual(
      r.applied.map((a) => a.action),
      ["model", "setParams", "setHeaders"],
      "一条规则内部的次序是固定的：模型 → 参数 → 头"
    );
  });

  test("⑤f 删参数、删头都能删", () => {
    const decl = {
      manifestVersion: 1,
      id: "rm",
      rules: [{
        request: {
          removeParams: ["max_tokens"],
          removeHeaders: ["content-type"],
          setHeaders: { "X-Added": "1" },
        },
      }],
    };
    const r = applyRequest(compileRules(decl), ctx());
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(r.request.params.max_tokens, undefined);
    assert.equal(r.request.headers["content-type"], undefined);
    assert.equal(r.request.headers["x-added"], "1");
  });

  test("⑤g 头名一律小写化（HTTP 头名大小写不敏感）", () => {
    const decl = {
      manifestVersion: 1,
      id: "case",
      rules: [{ request: { setHeaders: { "X-MiXeD": "1" } } }],
    };
    const r = applyRequest(compileRules(decl), ctx());
    assert.equal(r.ok, true);
    assert.equal(r.request.headers["x-mixed"], "1");
    assert.equal(r.request.headers["X-MiXeD"], undefined);
  });

  test("⑤h 返回的是副本：改了返回值改不坏原件", () => {
    const c = ctx();
    const r = applyRequest(compileRules(GOOD), c);
    assert.equal(r.ok, true);
    r.request.headers["x-foo"] = "我自己改的";
    r.request.params.temperature = 9;
    assert.equal(c.headers["x-foo"], undefined, "原来的请求不许被改");
    assert.equal(c.params.temperature, 0.7);
  });

  test("⑤i 改模型不改档位（档位是用户的意图，故障转移靠它）", () => {
    const r = applyRequest(compileRules(GOOD), ctx());
    assert.equal(r.ok, true);
    assert.equal(r.request.tier, "claude-opus-5");
  });
});

/* ====================================================================== *
 * ⑥ 合法性：改坏了要拒绝，不许静默改坏
 * ====================================================================== */
describe("⑥ 合法性 —— 改完还得是合法的", () => {
  test("⑥a 模型改成这家没有的 ⇒ 拒绝并说清能用的是哪几个", () => {
    const decl = {
      manifestVersion: 1,
      id: "bad-model",
      rules: [{ request: { model: "glm-9.9" } }],
    };
    const r = applyRequest(compileRules(decl), ctx());
    assert.equal(r.ok, false, "改坏模型必须被拒");
    assert.equal(r.request, null, "不许给半改的结果");
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].field, "rules[0].request.model");
    assert.ok(/不在渠道/.test(r.errors[0].message), "要说清是清单里没有它");
    assert.ok(/glm-5\.2/.test(r.errors[0].message), "要说清这家能用哪些");
  });

  test("⑥b 没有模型清单 ⇒ 不敢改模型（宁可不动也不改坏）", () => {
    const decl = {
      manifestVersion: 1,
      id: "no-catalog",
      rules: [{ request: { model: "glm-5.2" } }],
    };
    const r = applyRequest(compileRules(decl), ctx({ availableModels: [] }));
    assert.equal(r.ok, false);
    assert.ok(/没有渠道/.test(r.errors[0].message));
  });

  test("⑥c 不知道是哪一家 ⇒ 不敢改模型", () => {
    const decl = {
      manifestVersion: 1,
      id: "no-provider",
      rules: [{ request: { model: "glm-5.2" } }],
    };
    const r = applyRequest(compileRules(decl), ctx({ provider: "" }));
    assert.equal(r.ok, false);
    assert.ok(/provider/.test(r.errors[0].message));
  });

  test("⑥d 模型的大小写不一致 ⇒ 归一到清单里的写法（上游的 id 大小写敏感）", () => {
    const decl = {
      manifestVersion: 1,
      id: "case-model",
      rules: [{ request: { model: "minimax-m3.1-flash" } }],
    };
    const r = applyRequest(compileRules(decl), ctx({
      provider: "mm",
      availableModels: ["MiniMax-M3.1-Flash"],
    }));
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(r.request.model, "MiniMax-M3.1-Flash");
  });

  test("⑥e 前面的规则改坏了，后面的规则不许接着改（整体拒绝）", () => {
    const decl = {
      manifestVersion: 1,
      id: "cascade-bad",
      rules: [
        { request: { model: "glm-9.9" } },
        { request: { setHeaders: { "X-Never": "1" } } },
      ],
    };
    const r = applyRequest(compileRules(decl), ctx());
    assert.equal(r.ok, false);
    assert.equal(r.request, null);
    assert.equal(r.request === null, true);
  });

  test("⑥f 报出来的错要能拼成人话（面板直接显示）", () => {
    const decl = {
      manifestVersion: 1,
      id: "bad-model-2",
      rules: [{ request: { model: "glm-9.9" } }],
    };
    const r = applyRequest(compileRules(decl), ctx());
    const text = formatErrors(r.errors);
    assert.ok(text.length > 10);
    assert.ok(/[一-龥]/.test(text));
  });
});

/* ====================================================================== *
 * ⑦ 应答
 * ====================================================================== */
describe("⑦ 应答 —— 只改头", () => {
  test("⑦a 响应头能设能删", () => {
    const decl = {
      manifestVersion: 1,
      id: "resp",
      rules: [{
        when: { provider: "wb" },
        response: { setHeaders: { "X-Budget": "on" }, removeHeaders: ["x-secret-echo"] },
      }],
    };
    const r = applyResponse(compileRules(decl), {
      provider: "wb",
      headers: { "x-secret-echo": "1", "content-type": "application/json" },
    });
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(r.response.headers["x-budget"], "on");
    assert.equal(r.response.headers["x-secret-echo"], undefined);
    assert.equal(r.response.headers["content-type"], "application/json");
  });

  test("⑦b 应答规则按 when 挑：渠道不对就不动手", () => {
    const decl = {
      manifestVersion: 1,
      id: "resp-when",
      rules: [{ when: { provider: "wb" }, response: { setHeaders: { "X-Budget": "on" } } }],
    };
    const r = applyResponse(compileRules(decl), { provider: "sn", headers: {} });
    assert.equal(r.ok, true);
    assert.equal(r.response.headers["x-budget"], undefined);
  });

  test("⑦c 应答侧也不许碰凭据头", () => {
    const v = validateMiddlewareManifest({
      manifestVersion: 1,
      id: "resp-cred",
      rules: [{ response: { setHeaders: { "set-cookie": "a=b" } } }],
    });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /凭据/.test(e.message)));
  });

  test("⑦d 应答上下文由改过的请求拼出来（模型改了，应答要看到改后的）", () => {
    const c = responseContextOf({ provider: "sn", tier: "claude-opus-5", model: "glm-5.2", protocol: "anthropic" }, {
      status: 201,
      headers: { "content-type": "application/json" },
    });
    assert.equal(c.model, "glm-5.2");
    assert.equal(c.status, 201);
    assert.equal(c.headers["content-type"], "application/json");
  });

  test("⑦e 请求改过模型后，应答的 when 看到的是改过的模型", () => {
    const decl = {
      manifestVersion: 1,
      id: "resp-model",
      rules: [
        { request: { model: "sensenova-6.8" } },
        { when: { model: "sensenova-6.8" }, response: { setHeaders: { "X-Saw": "yes" } } },
      ],
    };
    const req = applyRequest(compileRules(decl), ctx());
    assert.equal(req.ok, true, formatErrors(req.errors));
    const resp = applyResponse(compileRules(decl), responseContextOf(req.request, { headers: {} }));
    assert.equal(resp.ok, true, formatErrors(resp.errors));
    assert.equal(resp.response.headers["x-saw"], "yes");
  });
});

/* ====================================================================== *
 * ⑧ 注册表
 * ====================================================================== */
describe("⑧ 注册表", () => {
  test("⑧a 装上、能列、能按键取、能卸", () => {
    const reg = createMiddlewareRegistry();
    const e = reg.register(GOOD, { now: 1_700_000_000_000 });
    assert.equal(e.id, "my-rules");
    assert.equal(e.loadedAt, 1_700_000_000_000);
    assert.equal(reg.list().length, 1);
    assert.equal(reg.get("my-rules").name, "我的规则");
    assert.equal(reg.get("nope"), null);
    assert.equal(reg.has("my-rules"), true);
    assert.equal(reg.unregister("my-rules").id, "my-rules");
    assert.equal(reg.list().length, 0);
  });

  test("⑧b 时间由调用方给（模块自己不取时钟）", () => {
    const reg = createMiddlewareRegistry();
    assert.equal(reg.register(GOOD).loadedAt, null, "没给时刻就是 null，不是「现在」");
  });

  test("⑧c 同一个 id 装两次 ⇒ 报错（不许悄悄覆盖）", () => {
    const reg = createMiddlewareRegistry();
    reg.register(GOOD);
    assert.throws(
      () => reg.register(GOOD),
      (e) => /已经装过/.test(e.message)
    );
    assert.equal(reg.list().length, 1);
  });

  test("⑧d 装一份不合法的声明 ⇒ 抛错且说清哪一条", () => {
    const reg = createMiddlewareRegistry();
    assert.throws(
      () => reg.register(withField({ id: "My-Rules" })),
      (e) => /装不上/.test(e.message) && /id/.test(e.message),
      "错的声明要在这里就炸（而不是变成一份错的规则）"
    );
    assert.equal(reg.list().length, 0);
  });

  test("⑧e 多份声明按**登记顺序**依次作用，后面的覆盖前面的", () => {
    const reg = createMiddlewareRegistry();
    reg.register({
      manifestVersion: 1,
      id: "first",
      rules: [{ request: { setHeaders: { "X-Who": "first" } } }],
    });
    reg.register({
      manifestVersion: 1,
      id: "second",
      rules: [{ request: { setHeaders: { "X-Who": "second" } } }],
    });
    const r = reg.applyRequest(ctx());
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(r.request.headers["x-who"], "second");
    assert.equal(r.applied.length, 2);
    assert.equal(r.applied[0].id, "first");
    assert.equal(r.applied[1].id, "second");
  });

  test("⑧f 一份声明改坏了 ⇒ 整体拒绝，并说清是哪一份", () => {
    const reg = createMiddlewareRegistry();
    reg.register(GOOD);
    reg.register({
      manifestVersion: 1,
      id: "bad",
      rules: [{ request: { model: "glm-9.9" } }],
    });
    const r = reg.applyRequest(ctx());
    assert.equal(r.ok, false);
    assert.equal(r.request, null);
    assert.ok(/bad/.test(r.errors[0].field), "要说清是哪一份声明改坏了");
  });

  test("⑧g check 只查不装（面板要知道能不能装）", () => {
    const reg = createMiddlewareRegistry();
    assert.equal(reg.check(GOOD).ok, true);
    assert.equal(reg.list().length, 0, "check 不该装东西");
    const bad = reg.check(withField({ id: "My-Rules" }));
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length > 0);
  });
});

/* ====================================================================== *
 * ⑨ 零依赖 + 防漂移（源码锚点断言）
 * ====================================================================== */
describe("⑨ 零依赖与防漂移", () => {
  test("⑨a middleware.mjs 不 import 仓库里任何模块、也不用任何包", () => {
    const src = fs.readFileSync(MW_PATH, "utf8");
    assert.ok(!/\bfrom\s+["']/.test(src), "不许有相对/绝对 import");
    assert.ok(!/\brequire\s*\(/.test(src), "不许有 require");
    assert.ok(!/\bimport\s*\(/.test(src), "不许有动态 import");
  });

  test("⑨b 档位名单与 plugin.mjs 一致", () => {
    assert.deepEqual([...TIER_KEYS], [...PLUGIN_TIER_KEYS], "middleware.mjs 的档位名单漂移了");
  });

  test("⑨c 渠道键的形状与 plugin.mjs 一致", () => {
    assert.equal(CHANNEL_KEY_RE.source, PLUGIN_CHANNEL_KEY_RE.source, "渠道键的形状漂移了");
  });

  test("⑨d 格式版本常量与自己的一致", () => {
    assert.equal(MIDDLEWARE_MANIFEST_VERSION, 1);
    assert.equal(compileRules(GOOD).manifestVersion, MIDDLEWARE_MANIFEST_VERSION);
  });

  test("⑨e 文件是 UTF-8 且**没有 BOM**", () => {
    const buf = fs.readFileSync(MW_PATH);
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), "BOM 会让第一个标识符带上看不见的字符");
  });
});

/* ====================================================================== *
 * ⑩ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */

/* 改坏的办法：把 middleware.mjs 复制一份到临时目录，改掉其中一处，再 import 进来。
   复制件没有 import（零依赖），所以单独放着也能跑。 */
const SABOTAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bai-middleware-sabotage-"));
process.on("exit", () => {
  try { fs.rmSync(SABOTAGE_DIR, { recursive: true, force: true }); } catch { /* 临时目录留着也无妨 */ }
});
let sabotageSeq = 0;
async function sabotaged(replacements) {
  const src = fs.readFileSync(MW_PATH, "utf8");
  let next = src;
  for (const [from, to] of replacements) {
    const found = from instanceof RegExp ? from.test(next) : next.includes(from);
    assert.ok(found, `改坏的锚点找不到了：${from}`);
    next = next.replace(from, to);
  }
  assert.notEqual(next, src, "改动没生效");
  const file = path.join(SABOTAGE_DIR, `middleware-${sabotageSeq++}.mjs`);
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

describe("⑩ 反向对照 —— 改坏实现，对应断言必须红", () => {
  test("⑩a 去掉凭据头检查 ⇒ ③b 的断言会红", async () => {
    const mod = await sabotaged([
      [
        "    if (CREDENTIAL_HEADERS.includes(lname)) {\n      fail(`${field}.${name}`, `middleware 不许${verb}凭据头「${lname}」：",
        "    if (false) {\n      fail(`${field}.${name}`, `middleware 不许${verb}凭据头「${lname}」：",
      ],
    ]);
    const check = (m) => () => {
      const v = m.validateMiddlewareManifest({
        manifestVersion: 1,
        id: "x",
        rules: [{ request: { setHeaders: { authorization: "Bearer whatever" } } }],
      });
      assert.equal(v.ok, false, "凭据头必须被拒");
      assert.ok(v.errors.some((e) => /凭据/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了凭据头检查");
  });

  test("⑩b 去掉「模型必须在清单里」⇒ ⑥a 的断言会红", async () => {
    const mod = await sabotaged([
      [
        "  return {\n    ok: false,\n    message: `模型「${m}」不在渠道「${cur.provider}」能用的清单里`",
        "  return {\n    ok: true,\n    model: m,\n    message: `模型「${m}」不在渠道「${cur.provider}」能用的清单里`",
      ],
    ]);
    const check = (m) => () => {
      const decl = { manifestVersion: 1, id: "x", rules: [{ request: { model: "glm-9.9" } }] };
      const r = m.applyRequest(decl, {
        provider: "sn",
        availableModels: ["glm-5.2", "sensenova-6.8"],
      });
      assert.equal(r.ok, false, "改坏模型必须被拒");
      assert.equal(r.request, null, "不许给半改的结果");
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了模型清单的归属检查");
  });

  test("⑩c 让「改坏了也给结果」⇒ ⑥a 的断言会红", async () => {
    const mod = await sabotaged([
      [
        "          request: null,\n          applied,\n          errors: [{ field: `rules[${i}].request.model`, message: chk.message }],",
        "          request: cur,\n          applied,\n          errors: [{ field: `rules[${i}].request.model`, message: chk.message }],",
      ],
    ]);
    const check = (m) => () => {
      const decl = { manifestVersion: 1, id: "x", rules: [{ request: { model: "glm-9.9" } }] };
      const r = m.applyRequest(decl, {
        provider: "sn",
        availableModels: ["glm-5.2", "sensenova-6.8"],
      });
      assert.equal(r.ok, false);
      assert.equal(r.request, null, "不许给半改的结果");
    };
    check(REAL)();
    assertGoesRed(check(mod), "改坏了也把结果给了出去");
  });

  test("⑩d 只让第一条规则生效 ⇒ ⑤c 的断言会红", async () => {
    const mod = await sabotaged([
      [
        "    for (const [k, v] of Object.entries(r.setHeaders)) {\n      cur.headers[k] = v;\n      applied.push({ id: c.id, rule: i, action: \"setHeaders\", key: k, value: v });\n    }\n  }",
        "    for (const [k, v] of Object.entries(r.setHeaders)) {\n      cur.headers[k] = v;\n      applied.push({ id: c.id, rule: i, action: \"setHeaders\", key: k, value: v });\n    }\n    break;\n  }",
      ],
    ]);
    const check = (m) => () => {
      const decl = {
        manifestVersion: 1,
        id: "order",
        rules: [
          { request: { setHeaders: { "X-Who": "first" } } },
          { request: { setHeaders: { "X-Who": "second" } } },
        ],
      };
      const r = m.applyRequest(decl, { provider: "sn" });
      assert.equal(r.ok, true);
      assert.equal(r.request.headers["x-who"], "second", "后写的赢");
    };
    check(REAL)();
    assertGoesRed(check(mod), "只让第一条规则生效");
  });

  test("⑩e 让匹配只看原始请求（不渐进）⇒ ⑤d 的断言会红", async () => {
    const mod = await sabotaged([
      [
        "  const cur = normalizeCtx(ctx);\n  const applied = [];\n  for (let i = 0; i < c.rules.length; i++) {",
        "  const cur = normalizeCtx(ctx);\n  const base = JSON.parse(JSON.stringify(cur));\n  const applied = [];\n  for (let i = 0; i < c.rules.length; i++) {",
      ],
      [
        "    const rule = c.rules[i];\n    if (!rule.request) continue;\n    if (!matchWhen(rule.when, cur)) continue;",
        "    const rule = c.rules[i];\n    if (!rule.request) continue;\n    if (!matchWhen(rule.when, base)) continue;",
      ],
    ]);
    const check = (m) => () => {
      const decl = {
        manifestVersion: 1,
        id: "cascade",
        rules: [
          { request: { model: "glm-5.2" } },
          { when: { model: "glm-5.2" }, request: { setHeaders: { "X-Saw": "yes" } } },
        ],
      };
      const r = m.applyRequest(decl, {
        provider: "sn",
        model: "glm-4.6",
        availableModels: ["glm-5.2"],
      });
      assert.equal(r.ok, true);
      assert.equal(r.request.headers["x-saw"], "yes", "后一条规则要看到改过的模型");
    };
    check(REAL)();
    assertGoesRed(check(mod), "匹配不渐进");
  });

  test("⑩f 去掉「删参数」⇒ ⑤f 的断言会红", async () => {
    const mod = await sabotaged([
      [
        "    for (const k of r.removeParams) {\n      delete cur.params[k];",
        "    for (const k of r.removeParams) {\n      void k;",
      ],
    ]);
    const check = (m) => () => {
      const decl = {
        manifestVersion: 1,
        id: "rm",
        rules: [{ request: { removeParams: ["max_tokens"] } }],
      };
      const r = m.applyRequest(decl, { provider: "sn", params: { max_tokens: 4096 } });
      assert.equal(r.ok, true);
      assert.equal(r.request.params.max_tokens, undefined, "删参数要真的删");
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了删参数");
  });

  test("⑩g 去掉「不认识的字段」检查 ⇒ ②g 的断言会红", async () => {
    const mod = await sabotaged([
      [
        "    if (!KNOWN_FIELDS.includes(k) && !CREDENTIAL_FIELDS.includes(k)) {",
        "    if (false) {",
      ],
    ]);
    const check = (m) => () => {
      const v = m.validateMiddlewareManifest({
        manifestVersion: 1,
        id: "x",
        uplstream: "https://x.example",
        rules: [{ request: { setHeaders: {} } }],
      });
      assert.equal(v.ok, false, "手误字段必须被拒");
      assert.ok(v.errors.some((e) => e.field === "uplstream" && /不认识的字段/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了未知字段检查");
  });

  test("⑩h 去掉档位校验 ⇒ ②j 的断言会红", async () => {
    const mod = await sabotaged([
      [
        "  for (const t of out.tier) {\n    if (!TIER_KEYS.includes(t)) {",
        "  for (const t of out.tier) {\n    if (false) {",
      ],
    ]);
    const check = (m) => () => {
      const v = m.validateMiddlewareManifest({
        manifestVersion: 1,
        id: "x",
        rules: [{ when: { tier: "claude-opus-9" }, request: { setHeaders: {} } }],
      });
      assert.equal(v.ok, false, "不认识的档位必须被拒");
      assert.ok(v.errors.some((e) => e.field === "rules[0].when.tier" && /不认/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了档位校验");
  });

  test("⑩i 去掉「同 id 不许装两次」⇒ ⑧c 的断言会红", async () => {
    const mod = await sabotaged([
      ["    if (byId.has(compiled.id)) {", "    if (false) {"],
    ]);
    const check = (m) => () => {
      const reg = m.createMiddlewareRegistry();
      reg.register(GOOD);
      assert.throws(
        () => reg.register(GOOD),
        (e) => /已经装过/.test(e.message),
        "同一个 id 不许装两次"
      );
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了同 id 冲突检查");
  });

  test("⑩j 去掉参数范围检查 ⇒ ②l 的断言会红", async () => {
    const mod = await sabotaged([
      ["      if (value < rule.min || value > rule.max) {", "      if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateMiddlewareManifest({
        manifestVersion: 1,
        id: "x",
        rules: [{ request: { setParams: { temperature: 5 } } }],
      });
      assert.equal(v.ok, false, "越界的参数必须被拒");
      assert.ok(v.errors.some((e) => /temperature/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了参数范围检查");
  });

  test("⑩k 去掉头值的换行检查 ⇒ ②k 的断言会红", async () => {
    const mod = await sabotaged([
      ["    if (HEADER_VALUE_BAD_RE.test(value)) {", "    if (false) {"],
    ]);
    const check = (m) => () => {
      const v = m.validateMiddlewareManifest({
        manifestVersion: 1,
        id: "x",
        rules: [{ request: { setHeaders: { "X-Foo": "bar\r\nX-Evil: 1" } } }],
      });
      assert.equal(v.ok, false, "带换行的头值必须被拒");
      assert.ok(v.errors.some((e) => /换行/.test(e.message)));
    };
    check(REAL)();
    assertGoesRed(check(mod), "去掉了头值换行检查");
  });
});
