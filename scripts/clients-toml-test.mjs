// scripts/clients-toml-test.mjs —— TOML / YAML 家族客户端接线的测试
//
// ## 这个测试在证明什么
//
// ① **格式读写器本身**：点分路径能读能写能删；写完再读回来值要对；
//    **没写的键一个字不动**；读不懂就报错（不当空配置、不抛异常）。
// ② **每个客户端**：接上以后配置文件里该有的路径真的有了；断开以后
//    **原样还原**（用户自己写的东西一个字没动）；配置读不懂的时候
//    **一个字节都不写**。
// ③ **反向对照**：把判据本身弄坏（删掉「写模型列表」那段、把 YAML 的缩进
//    判断去掉），对应的判据**必须变红** —— 否则那些断言就是恒真的，
//    什么都没证明。
//
// ## 落盘纪律
//
// **只落盘在 os.tmpdir() 下的临时目录**。绝不碰真实的 %APPDATA% / %LOCALAPPDATA%
// / 用户 home —— 所以每个用例都把那几个环境变量指到临时目录（GOOSE / HERMES /
// REASONIX 在 Windows 上会读 %APPDATA% / %LOCALAPPDATA%），用完还原。
//
// ## 不改 package.json
//
// 测试的注册由仓库维护者做（`node --test scripts/clients-toml-test.mjs` 也能直接跑）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CLIENTS_DIR = path.join(ROOT, "src", "server", "clients");

/* 格式读写器靠**副作用**注册自己 —— 必须 import 才会注册上。 */
import "../src/server/clients/formats-toml.mjs";
import "../src/server/clients/formats-yaml.mjs";
import "../src/server/clients/formats-dotenv.mjs";

import { applyClient, revertClient, clientStatus, formatOf } from "../src/server/clients/base.mjs";
import { kimiCodeClient } from "../src/server/clients/kimi-code.mjs";
import { minimaxCodeClient } from "../src/server/clients/minimax-code.mjs";
import { gooseClient } from "../src/server/clients/goose.mjs";
import { jcodeClient } from "../src/server/clients/jcode.mjs";
import { ompClient } from "../src/server/clients/omp.mjs";
import { hermesClient } from "../src/server/clients/hermes.mjs";
import { morphClient } from "../src/server/clients/morph.mjs";
import { stepcodeClient } from "../src/server/clients/stepcode.mjs";
import { reasonixClient } from "../src/server/clients/reasonix.mjs";
import { grokClient } from "../src/server/clients/grok.mjs";

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 一个临时目录（只落盘在 os.tmpdir() 下）。 */
function tmpHome(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bai-clients-" + tag + "-"));
}

/** 接线用的 ctx（key 是占位串，不是真凭据）。 */
function ctxOf(home) {
  return {
    home,
    baseUrl: "http://127.0.0.1:15799",
    apiKey: "test-key-placeholder",
    models: [{ id: "sn/claude-opus-5", label: "Claude Opus 5" }],
    providerId: "bai",
    providerName: "B.AI",
  };
}

/** 临时改一批环境变量；返回还原函数（null 表示「把这个变量删掉」）。 */
function withEnv(vars) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    if (v === null || v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** 写一个文件（父目录一起建）。 */
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/* ------------------------------------------------------------------ *
 * ① 格式读写器本身
 * ------------------------------------------------------------------ */

test("TOML：点分路径能读能写能删，没写的键一个字不动", () => {
  const fmt = formatOf("toml");
  assert.ok(fmt, "toml 格式没有注册上");
  const src = [
    "# 用户自己的注释",
    'default_model = "kimi/glm-4"',
    "",
    "[providers.kimi]",
    'type = "kimi"   # 行尾注释',
    'base_url = "http://127.0.0.1:15799"',
    "",
    '[models."bai/sn/claude-opus-5"]',
    'provider = "bai"',
    "",
  ].join("\n");

  /* 读 */
  const got = fmt.getPath(src, 'models."bai/sn/claude-opus-5".provider');
  assert.equal(got.ok, true);
  assert.equal(got.found, true);
  assert.equal(got.value, "bai");
  const miss = fmt.getPath(src, "providers.kimi.nope");
  assert.equal(miss.ok, true);
  assert.equal(miss.found, false, "不存在的路径要说「没有」，不能当成有");

  /* 写 */
  const w = fmt.setPath(src, "providers.bai.base_url", "http://127.0.0.1:15999");
  assert.equal(w.ok, true, w.error);
  const back = fmt.getPath(w.text, "providers.bai.base_url");
  assert.equal(back.ok, true);
  assert.equal(back.value, "http://127.0.0.1:15999");
  /* 没写的键还在 */
  assert.equal(fmt.getPath(w.text, "default_model").value, "kimi/glm-4");
  assert.equal(fmt.getPath(w.text, "providers.kimi.type").value, "kimi");
  /* 注释还在 */
  assert.match(w.text, /# 用户自己的注释/);
  assert.match(w.text, /# 行尾注释/);

  /* 删 */
  const d = fmt.delPath(w.text, "providers.bai.base_url");
  assert.equal(d.ok, true, d.error);
  assert.equal(fmt.getPath(d.text, "providers.bai.base_url").found, false);
  assert.equal(fmt.getPath(d.text, "providers.kimi.type").value, "kimi");
});

test("TOML：读不懂就报错，不当空配置、不抛异常", () => {
  const fmt = formatOf("toml");
  for (const bad of ["a = = 1", "[unclosed", 'x = "没闭合', "= 5"]) {
    const r = fmt.getPath(bad, "a");
    assert.equal(r.ok, false, `这份坏 TOML（${bad}）居然读通了`);
    assert.ok(r.error, "报错要带一句人话");
    const w = fmt.setPath(bad, "a", 1);
    assert.equal(w.ok, false, `这份坏 TOML（${bad}）居然写进去了`);
  }
});

test("YAML：点分路径能读能写能删，没写的键一个字不动", () => {
  const fmt = formatOf("yaml");
  const src = [
    "# 用户自己的注释",
    'active_provider: other',
    "providers:",
    "  other:",
    "    enabled: true",
    '    model: "x/y"',
    "",
  ].join("\n");

  const got = fmt.getPath(src, "providers.other.model");
  assert.equal(got.ok, true);
  assert.equal(got.value, "x/y");
  assert.equal(fmt.getPath(src, "nope.nope").found, false);

  const w = fmt.setPath(src, "providers.bai.base_url", "http://127.0.0.1:15799/v1");
  assert.equal(w.ok, true, w.error);
  assert.equal(fmt.getPath(w.text, "providers.bai.base_url").value, "http://127.0.0.1:15799/v1");
  assert.equal(fmt.getPath(w.text, "providers.other.model").value, "x/y");
  assert.match(w.text, /# 用户自己的注释/);

  const d = fmt.delPath(w.text, "providers.bai.base_url");
  assert.equal(d.ok, true, d.error);
  assert.equal(fmt.getPath(d.text, "providers.bai.base_url").found, false);
  assert.equal(fmt.getPath(d.text, "providers.other.enabled").value, true);
});

test("YAML：行内集合读得出来，空值当映射时子键插在它下面", () => {
  const fmt = formatOf("yaml");
  /* 行内数组与行内映射 */
  const flow = "x: [1, 2]\ny: {a: 1}\n";
  assert.deepEqual(fmt.getPath(flow, "x").value, [1, 2]);
  assert.deepEqual(fmt.getPath(flow, "y").value, { a: 1 });

  /* 「key:」后面没东西 ⇒ 它是个空映射，子键要插在**它下面**（不是文件末尾） */
  const w = fmt.setPath("a:\nb: 2\n", "a.c", 1);
  assert.equal(w.ok, true, w.error);
  assert.match(w.text, /^a:\n {2}c: 1\n/m, "空值下面插不进子键：\n" + w.text);
  assert.equal(fmt.getPath(w.text, "a.c").value, 1);
  assert.equal(fmt.getPath(w.text, "b").value, 2);
});

test("YAML：缩进坏了必须报错，不许猜", () => {
  const fmt = formatOf("yaml");
  const bad = "a:\n  b: 1\n   c: 2\n";
  const r = fmt.getPath(bad, "a.b");
  assert.equal(r.ok, false, "缩进多了一层居然读通了");
  assert.ok(r.error);
  const w = fmt.setPath(bad, "a.b", 1);
  assert.equal(w.ok, false, "缩进坏了居然写进去了");
});

test(".env：读/写/删，其余行原样保留", () => {
  const fmt = formatOf("dotenv");
  const src = "# 用户自己的注释\nOTHER_KEY=keep-me\n\nBAI_TEST=old\n";
  assert.equal(fmt.getPath(src, "OTHER_KEY").value, "keep-me");
  assert.equal(fmt.getPath(src, "BAI_TEST").value, "old");

  const w = fmt.setPath(src, "BAI_TEST", "new-value");
  assert.equal(w.ok, true, w.error);
  assert.equal(fmt.getPath(w.text, "BAI_TEST").value, "new-value");
  assert.equal(fmt.getPath(w.text, "OTHER_KEY").value, "keep-me");
  assert.match(w.text, /# 用户自己的注释/);

  const d = fmt.delPath(w.text, "BAI_TEST");
  assert.equal(d.ok, true, d.error);
  assert.equal(fmt.getPath(d.text, "BAI_TEST").found, false);
  assert.equal(fmt.getPath(d.text, "OTHER_KEY").value, "keep-me");
});

/* ------------------------------------------------------------------ *
 * 边界：这些坑都是真踩过的（有据可查的复现见每一条的注释）
 * ------------------------------------------------------------------ */

test("边界：不能崩、不能把用户的东西弄坏、不能把坏文件当好的", () => {
  const toml = formatOf("toml");
  const yaml = formatOf("yaml");
  const dotenv = formatOf("dotenv");

  /* ① 列表可以跟它的键齐平（YAML 最常见的两种列表写法之一）：
        servers:
        - name: a
     认错了的话，后面那些键会整个消失。 */
  const seq = "servers:\n- name: a\n- name: b\nother: 1\n";
  assert.deepEqual(yaml.getPath(seq, "servers").value, [{ name: "a" }, { name: "b" }]);
  assert.equal(yaml.getPath(seq, "other").value, 1);
  /* 往序列里按名写是**做不到**的 ⇒ 如实报错，绝不产出一份坏 YAML */
  const intoSeq = yaml.setPath(seq, "servers.bai.enabled", true);
  assert.equal(intoSeq.ok, false, "往序列里按名写竟然成功了 —— 那写出来的 YAML 是坏的");

  /* ② 父键后面跟一句注释（手写配置里很常见）不算「值」 */
  const withComment = "providers:   # 我家的 provider\n  bai:\n    x: 1\n";
  assert.equal(yaml.getPath(withComment, "providers.bai.x").value, 1);

  /* ③ 根块后面还有内容 ⇒ 我们没读全 ⇒ 如实报错（读不全还照样写就是错的） */
  assert.equal(yaml.getPath("a: 1\n- b\n", "a").ok, false);

  /* ④ TOML 段与键冲突（`a = 1` 之后又 `[a.b]`）—— **不许崩**，
        崩了底座就会给用户一个 500，而不是「读不懂，宁可不接」 */
  const conflict = "a = 1\n[a.b]\nx = 2\n";
  assert.equal(toml.getPath(conflict, "a").ok, false);
  assert.equal(toml.setPath(conflict, "a", 1).ok, false);
  assert.equal(toml.delPath(conflict, "a").ok, false);

  /* ⑤ TOML 的日期与时间（用户配置里一个日期就把接线堵死，是常事） */
  assert.equal(toml.getPath("d = 1979-05-27\n", "d").value, "1979-05-27");
  assert.equal(toml.getPath("t = 07:32:00\n", "t").value, "07:32:00");

  /* ⑥ 段头后面还有别的东西 —— 不是合法的 TOML */
  assert.equal(toml.getPath("[a] xyz = 1\n", "a").ok, false);

  /* ⑦ 引号风格：TOML 的字符串**总是**带引号 ⇒ 沿用原来那个引号字符，
        断开时才能逐字节还原；YAML 的字符串**可能**是裸的 ⇒ 新的值不需要
        引号时写规范形式（多留一对引号就与用户原来那份不一样了） */
  const quoted = toml.setPath("x = 'old'\n", "x", "new");
  assert.match(quoted.text, /x = 'new'/);
  const dquoted = yaml.setPath("x: 'old'\n", "x", "new");
  assert.match(dquoted.text, /x: new$/m, "YAML 里不需要引号的值不该多留一对引号");
  const dquoted2 = yaml.setPath("x: 'old'\n", "x", "two words");
  assert.match(dquoted2.text, /x: 'two words'/, "需要引号时沿用原来的引号字符");
  /* ⚠ **已知的一处不逐字节**：用户原来给一个**不需要引号**的字符串加了引号
     （`x: "old"`），断开后那对引号没了（值一样，格式差一对引号）。
     原因：备份里存的是**解析后的值**（不是原文），引号风格无从得知 ——
     只能按规范形式写回（那是最常见的手写样子）。 */
  const unq = yaml.setPath('x: "old"\n', "x", "new");
  assert.match(unq.text, /x: new$/m);

  /* ⑧ 行尾与末尾换行照原文件（CRLF 的文件还原回去还是 CRLF） */
  assert.equal(toml.setPath("a = 1\r\nb = 2\r\n", "c", 3).text, "a = 1\r\nb = 2\r\nc = 3\r\n");
  assert.equal(yaml.setPath("a: 1\r\nb: 2\r\n", "c", 3).text, "a: 1\r\nb: 2\r\nc: 3\r\n");
  /* 原本没有末尾换行的，加一个键也不能凭空多一个换行 */
  assert.equal(toml.setPath("a = 1", "b", 2).text, "a = 1\nb = 2");

  /* ⑨ .env：引号里的值 + 行尾注释 —— 读的时候不能把引号算进值里，
        写的时候注释与引号风格都得留着 */
  const envQuoted = 'K = "old"  # 注释\n';
  assert.equal(dotenv.getPath(envQuoted, "K").value, "old");
  const envWritten = dotenv.setPath(envQuoted, "K", "new");
  assert.match(envWritten.text, /# 注释/);
  assert.match(envWritten.text, /"new"/);
  assert.equal(dotenv.getPath(envWritten.text, "K").value, "new");

  /* ⑩ .env 的 export 前缀与空格风格也要留着 */
  assert.equal(dotenv.setPath("export K=old  # c\n", "K", "new").text, "export K=new  # c\n");

  /* ⑪ .env 里同一个键写两遍：读最后一个、写最后一个、**删也只删最后一个**
        （否则「写」与「删」不是互逆的） */
  assert.equal(dotenv.getPath("K=one\nK=two\n", "K").value, "two");
  assert.equal(dotenv.delPath("K=one\nK=two\n", "K").text, "K=one\n");

  /* ⑫ .env 里的反斜杠要原样往返（先 replace("\\n") 再 replace("\\\\")
        的写法会把 `C:\\new dir` 里的 \\n 吃掉） */
  const bs = "C:" + String.fromCharCode(92) + "new dir";
  const bsOut = dotenv.setPath("K=x\n", "K", bs);
  assert.equal(dotenv.getPath(bsOut.text, "K").value, bs);

  /* ⑬ YAML 整块替换时，键那一行的行尾注释要留着 */
  const blockComment = yaml.setPath("providers:\n  bai:   # 我家的\n    x: 1\n", "providers.bai", { z: 1 });
  assert.match(blockComment.text, /# 我家的/);
});

/**
 * dupTables —— 这份 TOML 里被定义了两次的表。
 *
 * TOML 的规矩：一张表只能被**显式**定义一次。`[model_providers.other]` 已经
 * **隐式**定义了 `model_providers`，后面再写 `[model_providers]` 就是定义两次
 * ⇒ 解析器报错 ⇒ 用户整个 config.toml 读不了。
 *
 * ⚠ 但**两个段隐式定义同一个父表不算重复**（`[a.b]` 与 `[a.c]` 都隐式定义 a，
 *   那还是同一张表）—— 只有「显式的段头撞上已被隐式定义的表」才算。
 */
function dupTables(text) {
  const explicit = new Set();
  const implicit = new Set();
  const dup = [];
  for (const line of text.split("\n")) {
    const m = /^\s*\[([^\[\]]+)\]/.exec(line);
    if (!m) continue;               /* [[数组的表]] 可以重复，不算 */
    const segs = m[1].split(".").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    for (let k = 1; k < segs.length; k++) implicit.add(segs.slice(0, k).join("."));
    const name = segs.join(".");
    if (explicit.has(name) || implicit.has(name)) {
      if (!dup.includes(name)) dup.push(name);
    } else {
      explicit.add(name);
    }
  }
  return dup;
}

test("TOML：写一张表 ⇒ 展开成它自己的段，不写父表段（否则「表定义两次」）", () => {
  const toml = formatOf("toml");
  const src = [
    'model = "gpt-5"',
    "",
    "[model_providers.other]",
    'name = "Other"',
    'base_url = "https://example.com/v1"',
    "",
    "[mcp_servers.playwright]",
    'command = "npx"',
    "",
  ].join("\n");

  const w = toml.setPath(src, "model_providers.bai", { name: "B.AI", wire_api: "responses" });
  assert.equal(w.ok, true, w.error);
  /* ① 父表已被 [model_providers.other] 隐式定义 ⇒ 不能再写 [model_providers] */
  assert.doesNotMatch(w.text, /^\[model_providers\]$/m,
    "写出了 [model_providers] 段 —— 父表会被定义两次，整个 config.toml 就读不了了");
  assert.match(w.text, /^\[model_providers\.bai\]$/m, "应该是 [model_providers.bai] 这一段");
  /* ② 输出的表一个都不能被定义两次 */
  assert.deepEqual(dupTables(w.text), [], "输出里有被定义了两次的表");
  /* ③ 读得回来，用户的别的段也还在 */
  assert.equal(toml.getPath(w.text, "model_providers.bai.name").value, "B.AI");
  assert.equal(toml.getPath(w.text, "model_providers.bai.wire_api").value, "responses");
  assert.equal(toml.getPath(w.text, "model_providers.other.base_url").value, "https://example.com/v1");
  assert.equal(toml.getPath(w.text, "mcp_servers.playwright.command").value, "npx");

  /* ④ 嵌套的对象再往下展开一层（还是子段，不是父段） */
  const deep = toml.setPath(src, "model_providers.bai", { name: "B.AI", options: { http_headers: { "X-A": "1" } } });
  assert.equal(deep.ok, true, deep.error);
  assert.deepEqual(dupTables(deep.text), [], "嵌套展开后有被定义了两次的表");
  assert.match(deep.text, /^\[model_providers\.bai\.options\.http_headers\]$/m);
});

test("YAML：列表里的元素按名字改（找得到就改、找不到就追加、用户自己的条目不碰）", () => {
  const yaml = formatOf("yaml");
  const src = [
    "custom_providers:",
    "- name: xiaomi",
    "  base_url: http://old",
    "  model: mimo-v2.5-pro",
    "model:",
    "  provider: xiaomi",
    "",
  ].join("\n");

  assert.equal(yaml.getPath(src, "custom_providers[name=xiaomi].base_url").value, "http://old");
  assert.equal(yaml.getPath(src, "custom_providers[name=bai]").found, false);

  /* 追加我们那一条 */
  let t = yaml.setPath(src, "custom_providers[name=bai].name", "bai");
  assert.equal(t.ok, true, t.error);
  t = yaml.setPath(t.text, "custom_providers[name=bai].base_url", "http://127.0.0.1:15799/v1");
  assert.equal(t.ok, true, t.error);
  assert.equal(yaml.getPath(t.text, "custom_providers[name=bai].base_url").value, "http://127.0.0.1:15799/v1");
  /* 用户自己那一条一个字不动 */
  assert.equal(yaml.getPath(t.text, "custom_providers[name=xiaomi].base_url").value, "http://old");
  assert.equal(yaml.getPath(t.text, "custom_providers[name=xiaomi].model").value, "mimo-v2.5-pro");

  /* 改我们那一条已有的键（不是追加） */
  const again = yaml.setPath(t.text, "custom_providers[name=bai].base_url", "http://127.0.0.1:15800");
  assert.equal(yaml.getPath(again.text, "custom_providers[name=bai].base_url").value, "http://127.0.0.1:15800");
  assert.equal(again.text.split("\n").filter((l) => l.trim() === "- name: bai").length, 1,
    "追加了不止一个我们那一条");
});

test("模型 id 里带点（glm-5.2 这种）：引号段原样保住，接上与断开都逐字节", () => {
  const home = tmpHome("dotted-id");
  const restore = withEnv({ KIMI_SHARE_DIR: path.join(home, "kimi") });
  try {
    const file = path.join(home, "kimi", "config.toml");
    writeFile(file, '# 用户自己的注释\n[providers.kimi]\ntype = "kimi"\n');
    const before = fs.readFileSync(file, "utf8");
    const ctx = { ...ctxOf(home), models: [{ id: "sn/glm-5.2", label: "GLM 5.2" }] };
    const ap = applyClient(kimiCodeClient, ctx, { dataDir: path.join(home, "_data") });
    assert.equal(ap.ok, true, ap.detail);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^\[models\."bai\/sn\/glm-5\.2"\]$/m, "带点的模型 id 要落在引号段里");
    assert.equal(formatOf("toml").getPath(text, 'models."bai/sn/glm-5.2".model').value, "sn/glm-5.2");
    const rv = revertClient(kimiCodeClient, { dataDir: path.join(home, "_data") });
    assert.equal(rv.ok, true, rv.detail);
    assert.equal(fs.readFileSync(file, "utf8"), before, "断开以后没有逐字还原");
  } finally {
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("写一个**和原来一样**的值 ⇒ 那一行一个字不动（引号、注释都留着）", () => {
  const yaml = formatOf("yaml");
  const y = yaml.setPath('x: "same"  # 注释\n', "x", "same");
  assert.equal(y.changed, false, "值一样却说改了");
  assert.equal(y.text, 'x: "same"  # 注释\n', "值一样却把那一行改了（引号/注释没了）");
  const toml = formatOf("toml");
  const t = toml.setPath("x = 'same'  # 注释\n", "x", "same");
  assert.equal(t.changed, false, "值一样却说改了");
  assert.equal(t.text, "x = 'same'  # 注释\n", "值一样却把那一行改了");
});

test("Hermes：配置目录按「哪个存在就用哪个」（本机在 ~/.hermes，不在 %LOCALAPPDATA%）", () => {
  const home = tmpHome("hermes-dir");
  const restore = withEnv({ HERMES_HOME: null, LOCALAPPDATA: path.join(home, "localappdata") });
  try {
    /* 本机这版：~/.hermes/ 下面才有 config.yaml（magpie 写的是 %LOCALAPPDATA%\hermes） */
    fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
    const file = hermesClient.files(ctxOf(home))[0].path;
    assert.equal(file, path.join(home, ".hermes", "config.yaml"),
      "Hermes 的配置目录找错了（本机这版在 ~/.hermes）");
    /* ~/.hermes 不在 ⇒ 退回 %LOCALAPPDATA%\hermes（magpie 那版的位置，兼容别的机器） */
    fs.rmSync(path.join(home, ".hermes"), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, "localappdata", "hermes"), { recursive: true });
    const file2 = hermesClient.files(ctxOf(home))[0].path;
    assert.equal(file2, path.join(home, "localappdata", "hermes", "config.yaml"),
      "~/.hermes 不在时没有退回 %LOCALAPPDATA%\\hermes");
  } finally {
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * ② 每个客户端
 * ------------------------------------------------------------------ */

/**
 * CASES —— 每个客户端：它碰哪些文件、每个文件里该有什么、原来长什么样。
 *
 * `files` 里每一项：
 *   · rel   —— 相对于临时 home 的路径
 *   · fmt   —— 用哪个格式读写器
 *   · seed  —— 用户原来就有的内容（接线前写进去）
 *   · bad   —— 一份**读不懂**的内容（用来验「读不懂就不写」）；不给就不测这条
 *   · expect—— 接线以后该读得到什么（[键路径, 期望值]）
 */
const CASES = [
  {
    id: "kimi-code",
    def: kimiCodeClient,
    env: (home) => ({ KIMI_SHARE_DIR: path.join(home, "kimi") }),
    files: [
      {
        rel: path.join("kimi", "config.toml"),
        fmt: "toml",
        seed: [
          "# Kimi Code 的配置（用户自己改过）",
          'default_model = "kimi/glm-4"',
          "",
          "[providers.kimi]",
          'type = "kimi"',
          "",
        ].join("\n"),
        bad: "default_model = = 1\n",
        expect: [
          ["providers.bai.type", "kimi"],
          ["providers.bai.base_url", "http://127.0.0.1:15799/v1"],
          ["providers.bai.api_key", "test-key-placeholder"],
          ['models."bai/sn/claude-opus-5".provider', "bai"],
          ['models."bai/sn/claude-opus-5".model', "sn/claude-opus-5"],
          ['models."bai/sn/claude-opus-5".display_name', "Claude Opus 5"],
          ["default_model", "bai/sn/claude-opus-5"],
        ],
      },
    ],
  },
  {
    id: "minimax-code",
    def: minimaxCodeClient,
    env: (home) => ({ MINIMAX_DATA_DIR: path.join(home, "minimax") }),
    files: [
      {
        rel: path.join("minimax", "config.yaml"),
        fmt: "yaml",
        seed: [
          "# MiniMax Code 的配置",
          "defaultModel: minimax/MiniMax-M2",
          "custom_provider:",
          "  minimax:",
          "    name: minimax",
          "    kind: official",
          "",
        ].join("\n"),
        bad: "a:\n  b: 1\n   c: 2\n",
        expect: [
          ["custom_provider.bai.kind", "custom"],
          ["custom_provider.bai.enabled", true],
          ["custom_provider.bai.api", "openai-completions"],
          ["custom_provider.bai.options.baseURL", "http://127.0.0.1:15799"],
          ["custom_provider.bai.options.apiKey", "test-key-placeholder"],
          ['custom_provider.bai.models."sn/claude-opus-5".name', "Claude Opus 5"],
          ["defaultModel", "custom_provider:bai/sn/claude-opus-5"],
        ],
      },
    ],
  },
  {
    id: "goose",
    def: gooseClient,
    env: (home) => ({ APPDATA: path.join(home, "appdata") }),
    files: [
      {
        rel: process.platform === "win32"
          ? path.join("appdata", "Block", "goose", "config", "config.yaml")
          : path.join(".config", "goose", "config.yaml"),
        fmt: "yaml",
        seed: [
          "# Goose 的配置",
          "active_provider: other",
          "providers:",
          "  other:",
          "    enabled: true",
          "",
        ].join("\n"),
        bad: "a:\n  b: 1\n   c: 2\n",
        expect: [
          ["active_provider", "bai"],
          ["providers.bai.enabled", true],
          ["providers.bai.model", "sn/claude-opus-5"],
          ["providers.bai.configured", true],
        ],
      },
      {
        rel: process.platform === "win32"
          ? path.join("appdata", "Block", "goose", "config", "custom_providers", "bai.json")
          : path.join(".config", "goose", "custom_providers", "bai.json"),
        fmt: "json",
        seed: [
          "{",
          '  "display_name": "用户自己写的名字"',
          "}",
          "",
        ].join("\n"),
        expect: [
          ["base_url", "http://127.0.0.1:15799/v1"],
          ["engine", "openai"],
          /* ⚠ **没有 reasoning 这个键**：我们不知道这一档支不支持思考 ——
             「不知道」的正确表达是**不写**（写 false 是在断言，写 true 是撒谎）。 */
          ["models", [{ name: "sn/claude-opus-5", context_limit: 128000 }]],
        ],
      },
    ],
  },
  {
    id: "jcode",
    def: jcodeClient,
    env: (home) => ({ JCODE_HOME: path.join(home, "jcode") }),
    files: [
      {
        rel: path.join("jcode", "config.toml"),
        fmt: "toml",
        seed: [
          "# jcode 的配置",
          "[provider]",
          'default_provider = "mine"',
          'default_model = "my-model"',
          "",
          "[providers.mine]",
          'type = "openai-compatible"',
          "",
        ].join("\n"),
        bad: "a = = 1\n",
        expect: [
          ["providers.bai.type", "openai-compatible"],
          ["providers.bai.base_url", "http://127.0.0.1:15799/v1"],
          ["providers.bai.requires_api_key", true],
          ["provider.default_provider", "bai"],
          ["provider.default_model", "sn/claude-opus-5"],
        ],
      },
    ],
  },
  {
    id: "omp",
    def: ompClient,
    env: () => ({ PI_CONFIG_DIR: null, OMP_PROFILE: null, PI_PROFILE: null }),
    files: [
      {
        rel: path.join(".omp", "agent", "config.yml"),
        fmt: "yaml",
        seed: [
          "# omp 的配置",
          "modelRoles:",
          "  plan: my-own/plan-model",
          "",
        ].join("\n"),
        bad: "a:\n  b: 1\n   c: 2\n",
        expect: [
          ["modelRoles.default", "bai/sn/claude-opus-5"],
          ["modelRoles.plan", "my-own/plan-model"],
        ],
      },
      {
        rel: path.join(".omp", "agent", "models.yml"),
        fmt: "yaml",
        seed: [
          "# 用户自己的 provider",
          "providers:",
          "  mine:",
          "    baseUrl: http://127.0.0.1:9999/v1",
          "",
        ].join("\n"),
        expect: [
          ["providers.bai.baseUrl", "http://127.0.0.1:15799/v1"],
          ["providers.bai.api", "openai-completions"],
          ["providers.bai.auth", "none"],
          ["providers.mine.baseUrl", "http://127.0.0.1:9999/v1"],
        ],
      },
    ],
  },
  {
    id: "hermes",
    def: hermesClient,
    env: (home) => ({
      HERMES_HOME: path.join(home, "hermes"),
      LOCALAPPDATA: path.join(home, "localappdata"),
    }),
    files: [
      {
        /* 本机这版的真实形状：provider 是一个**数组**（custom_providers），
           每条自带默认模型 model:（夹具里的值是占位串，不是真凭据） */
        rel: path.join("hermes", "config.yaml"),
        fmt: "yaml",
        seed: [
          "# Hermes 的配置（本机这版：provider 是数组）",
          "custom_providers:",
          "- name: xiaomi",
          "  base_url: http://127.0.0.1:9999/v1",
          "  api_key: placeholder-not-a-real-key",
          "  api_mode: anthropic_messages",
          "  models:",
          "    mimo-v2.5-pro:",
          "      name: MiMo v2.5 Pro",
          "  model: mimo-v2.5-pro",
          "model:",
          "  default: mimo-v2.5-pro",
          "  provider: xiaomi",
          "",
        ].join("\n"),
        bad: "a:\n  b: 1\n   c: 2\n",
        expect: [
          ["custom_providers[name=bai].name", "bai"],
          ["custom_providers[name=bai].base_url", "http://127.0.0.1:15799/v1"],
          ["custom_providers[name=bai].api_key", "test-key-placeholder"],
          ["custom_providers[name=bai].api_mode", "chat_completions"],
          ["custom_providers[name=bai].model", "sn/claude-opus-5"],
          ["custom_providers[name=bai].models", ["sn/claude-opus-5"]],
          ["model.provider", "bai"],
          ["model.default", "sn/claude-opus-5"],
          /* 用户自己那一条一个字不动 */
          ["custom_providers[name=xiaomi].api_key", "placeholder-not-a-real-key"],
          ["custom_providers[name=xiaomi].model", "mimo-v2.5-pro"],
        ],
      },
    ],
  },
  {
    /* magpie 的老形状：provider 是一个**映射**（providers）—— 也要能用 */
    id: "hermes-map",
    def: hermesClient,
    env: (home) => ({
      HERMES_HOME: path.join(home, "hermes"),
      LOCALAPPDATA: path.join(home, "localappdata"),
    }),
    files: [
      {
        rel: path.join("hermes", "config.yaml"),
        fmt: "yaml",
        seed: [
          "# Hermes 的配置（老形状：provider 是映射）",
          "model:",
          "  provider: mine",
          "  default: my-own-model",
          "providers:",
          "  mine:",
          "    name: mine",
          "    base_url: http://127.0.0.1:9999/v1",
          "",
        ].join("\n"),
        bad: "a:\n  b: 1\n   c: 2\n",
        expect: [
          ["providers.bai.name", "bai"],
          ["providers.bai.base_url", "http://127.0.0.1:15799/v1"],
          ["providers.bai.api_mode", "chat_completions"],
          ["providers.bai.model", "sn/claude-opus-5"],
          ["providers.bai.models", ["sn/claude-opus-5"]],
          ["model.provider", "bai"],
          ["model.default", "sn/claude-opus-5"],
          /* 用户自己的 provider 不动 */
          ["providers.mine.base_url", "http://127.0.0.1:9999/v1"],
        ],
      },
    ],
  },
  {
    id: "morph",
    def: morphClient,
    env: (home) => ({ MISTER_MORPH_CONFIG: path.join(home, "morph", "config.yaml") }),
    files: [
      {
        rel: path.join("morph", "config.yaml"),
        fmt: "yaml",
        seed: [
          "# morph 的配置",
          "llm:",
          "  endpoint: http://127.0.0.1:9999/v1",
          "  profiles:",
          "    mine:",
          "      model: other-model",
          "",
        ].join("\n"),
        bad: "a:\n  b: 1\n   c: 2\n",
        expect: [
          ["llm.inference_provider", "openai_response_compatible"],
          ["llm.endpoint", "http://127.0.0.1:15799/v1"],
          ["llm.model", "sn/claude-opus-5"],
          ["llm.profiles.mine.model", "other-model"],
        ],
      },
    ],
  },
  {
    id: "stepcode",
    def: stepcodeClient,
    env: (home) => ({ STEPCODE_CONFIG_DIR: path.join(home, "stepcode") }),
    files: [
      {
        rel: path.join("stepcode", "config.toml"),
        fmt: "toml",
        seed: [
          "# StepCode 的配置",
          'defaultProvider = "mine"',
          'defaultModel = "my-model"',
          "",
        ].join("\n"),
        bad: "a = = 1\n",
        expect: [
          ["defaultProvider", "bai"],
          ["defaultModel", "sn/claude-opus-5"],
        ],
      },
      {
        rel: path.join("stepcode", "models.json"),
        fmt: "json",
        seed: [
          "{",
          '  "providers": {',
          '    "mine": { "name": "我自己的" }',
          "  }",
          "}",
          "",
        ].join("\n"),
        expect: [
          ["providers.bai.baseUrl", "http://127.0.0.1:15799/v1"],
          ["providers.bai.api", "openai-completions"],
          ["providers.mine.name", "我自己的"],
        ],
      },
    ],
  },
  {
    id: "reasonix",
    def: reasonixClient,
    env: (home) => ({ REASONIX_HOME: path.join(home, "reasonix") }),
    files: [
      {
        rel: path.join("reasonix", "config.toml"),
        fmt: "toml",
        seed: [
          "# Reasonix 的配置",
          'default_model = "mine/my-model"',
          "",
          "[[providers]]",
          'name = "mine"',
          'kind = "openai"',
          "",
        ].join("\n"),
        bad: "a = = 1\n",
        expect: [
          ["providers[name=bai].name", "bai"],
          ["providers[name=bai].base_url", "http://127.0.0.1:15799/v1"],
          ["providers[name=bai].api_key_env", "BAI_REASONIX_API_KEY"],
          ["providers[name=bai].models", ["sn/claude-opus-5"]],
          ["default_model", "bai/sn/claude-opus-5"],
          ["agent.planner_model", "bai/sn/claude-opus-5"],
          ["desktop.provider_access", ["bai"]],
          ["providers[name=mine].kind", "openai"],
        ],
      },
      {
        rel: path.join("reasonix", ".env"),
        fmt: "dotenv",
        seed: "# 用户自己的 .env\nOTHER_KEY=keep-me\n",
        expect: [
          ["BAI_REASONIX_API_KEY", "test-key-placeholder"],
          ["OTHER_KEY", "keep-me"],
        ],
      },
    ],
  },
  {
    id: "grok",
    def: grokClient,
    env: (home) => ({ GROK_HOME: path.join(home, "grok") }),
    files: [
      {
        rel: path.join("grok", "config.toml"),
        fmt: "toml",
        seed: [
          "# Grok Build 的配置",
          "[models]",
          'default = "grok/grok-4"',
          "",
        ].join("\n"),
        bad: "a = = 1\n",
        expect: [
          ['model."bai/sn/claude-opus-5".model', "sn/claude-opus-5"],
          ['model."bai/sn/claude-opus-5".base_url', "http://127.0.0.1:15799/v1"],
          ['model."bai/sn/claude-opus-5".api_backend', "chat_completions"],
          ["models.default", "bai/sn/claude-opus-5"],
          ["features.campaigns", false],
        ],
      },
    ],
  },
];

/** 跑一个客户端的完整一轮：接线 → 检查 → 断开 → 检查还原。 */
function wireAndRevert(c, home) {
  const ctx = ctxOf(home);
  const dataDir = path.join(home, "_data");
  const files = c.files.map((f) => ({ ...f, abs: path.join(home, f.rel) }));
  for (const f of files) writeFile(f.abs, f.seed);

  const ap = applyClient(c.def, ctx, { dataDir });
  assert.equal(ap.ok, true, `${c.id} 接线失败：${ap.detail}`);

  /* ① 接线以后该有的路径真的有了 */
  for (const f of files) {
    const fmt = formatOf(f.fmt);
    const text = fs.readFileSync(f.abs, "utf8");
    for (const [p, want] of f.expect || []) {
      const r = fmt.getPath(text, p);
      assert.equal(r.ok, true, `${c.id}：${p} 读不出来（${r.error}）`);
      assert.equal(r.found, true, `${c.id}：${p} 不在文件里`);
      assert.deepEqual(r.value, want, `${c.id}：${p} 的值不对`);
    }
    /* ⚠ **我们不知道的能力项，一个键都不许写** ——
       我们的模型 id 是**档位**（provider 无关），能力由映射到哪家上游决定
       （同一档位在 sn 映射到 glm-5.2、在 wb 映射到 hy3，图片与思考逐家不同）
       ⇒ 断言「不支持」是替**所有**上游下结论。
       「不写」与「写 false」对 Go 客户端等价（读不到 ⇒ 零值），但「不写」把位置
       空着 ⇒ 将来有了真值是「加一个键」；⚠ 写 true 更糟：用户真去发上游收不下的
       思考参数，当场报错。 */
    assert.doesNotMatch(text, /reasoning|supportsImages|supportsReasoning/,
      `${c.id}：写了「我们不知道」的能力项 —— 那是替所有上游下结论`);
  }

  /* 状态：接上了 */
  const st = clientStatus(c.def, ctx, { dataDir });
  assert.equal(st.wired, true, `${c.id}：接上了却说没接 —— ${st.detail}`);

  /* ② 断开以后原样还原 */
  const rv = revertClient(c.def, { dataDir });
  assert.equal(rv.ok, true, `${c.id} 断开失败：${rv.detail}`);
  for (const f of files) {
    const after = fs.readFileSync(f.abs, "utf8");
    assert.equal(after, f.seed, `${c.id}：断开以后 ${f.rel} 没有原样还原`);
  }
}

for (const c of CASES) {
  test(`${c.id}：接上以后该有的路径都在 / 断开以后原样还原`, () => {
    const home = tmpHome(c.id);
    const restore = withEnv({ ...c.env(home), APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata") });
    try {
      wireAndRevert(c, home);
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("读不懂的配置不写：解析失败就中止，用户的文件一个字不动", () => {
  let covered = 0;
  for (const c of CASES) {
    const withBad = c.files.find((f) => f.bad);
    if (!withBad) continue;
    covered += 1;
    const home = tmpHome(c.id + "-bad");
    const restore = withEnv({ ...c.env(home), APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata") });
    try {
      const dataDir = path.join(home, "_data");
      const files = c.files.map((f) => ({ ...f, abs: path.join(home, f.rel) }));
      for (const f of files) writeFile(f.abs, f.rel === withBad.rel ? f.bad : f.seed);
      const before = files.map((f) => fs.readFileSync(f.abs, "utf8"));

      const ap = applyClient(c.def, ctxOf(home), { dataDir });
      assert.equal(ap.ok, false, `${c.id}：配置读不懂却报「接好了」`);
      assert.ok(ap.detail, "中止时要有一句人话");

      for (let i = 0; i < files.length; i++) {
        const after = fs.readFileSync(files[i].abs, "utf8");
        assert.equal(after, before[i], `${c.id}：读不懂却还是写了 ${files[i].rel}`);
      }
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  /* 每个客户端都得被这一条覆盖到 —— 少一个就说明那个客户端没测「读不懂就不写」 */
  assert.equal(covered, CASES.length, `只有 ${covered}/${CASES.length} 个客户端测了「读不懂就不写」`);
});

/* ------------------------------------------------------------------ *
 * ③ 反向对照 —— 判据不许是恒真的
 * ------------------------------------------------------------------ */

/**
 * 把声明弄坏：去掉「写模型列表」那几行。
 *
 * 断完之后，「模型在文件里」这条判据**必须变红** —— 它若还绿，说明这条判据
 * 什么都没证明。
 */
test("反向对照 A：把「写模型列表」那段删掉，模型那条判据必须变红", () => {
  const c = CASES.find((x) => x.id === "kimi-code");
  const home = tmpHome("reverse-a");
  const restore = withEnv({ ...c.env(home), APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata") });
  try {
    const broken = {
      ...c.def,
      files: (ctx) => c.def.files(ctx).map((f) => ({
        ...f,
        /* 坏在「模型表不写了」这一段上 */
        writes: (c2) => (f.writes(c2) || []).filter((w) => !w.path.startsWith("models.")),
      })),
    };
    const file = path.join(home, c.files[0].rel);
    writeFile(file, c.files[0].seed);
    const ap = applyClient(broken, ctxOf(home), { dataDir: path.join(home, "_data") });
    assert.equal(ap.ok, true, ap.detail);

    const fmt = formatOf("toml");
    const text = fs.readFileSync(file, "utf8");
    const r = fmt.getPath(text, 'models."bai/sn/claude-opus-5".model');
    assert.equal(r.found, false, "删掉「写模型列表」之后模型还在文件里 —— 那条判据是恒真的");
    /* 别的判据还是绿的（provider 块照写）—— 说明坏的是这一段，不是整个声明 */
    assert.equal(fmt.getPath(text, "providers.bai.base_url").found, true,
      "provider 块应该照写 —— 反向对照要坏在点子上");
  } finally {
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * 把 YAML 解析器的缩进判断去掉（**副本**，原文件不动）。
 *
 * 断完之后，「缩进坏了必须报错」这条判据**必须变红** —— 它若还绿，说明
 * 我们的解析器其实没在管缩进。
 */
test("反向对照 B：把 YAML 的缩进判断去掉，那条判据必须变红", async () => {
  const src = fs.readFileSync(path.join(CLIENTS_DIR, "formats-yaml.mjs"), "utf8");
  const abs = (name) => pathToFileURL(path.join(CLIENTS_DIR, name)).href;

  let broken = src
    /* 相对 import 改成绝对路径（副本落在临时目录里） */
    .split('"./base.mjs"').join(JSON.stringify(abs("base.mjs")))
    .split('"./paths.mjs"').join(JSON.stringify(abs("paths.mjs")))
    /* 换个格式名注册，免得把好的那个顶掉 */
    .split('registerFormat("yaml"').join('registerFormat("yaml-broken"')
    /* ★ 坏在点子上：多出来的缩进不再报错 */
    .split('if (L.indent > indent) return { error: { error: "缩进多了一层", line: i + 1 } };')
    .join('if (L.indent > indent) { /* 反向对照：故意放过多出来的缩进 */ }');

  assert.notEqual(broken, src, "反向对照的替换没生效 —— YAML 解析器的源码形状变了？");

  const home = tmpHome("reverse-b");
  const file = path.join(home, "formats-yaml-broken.mjs");
  fs.writeFileSync(file, broken, "utf8");

  try {
    const mod = await import(pathToFileURL(file).href);
    const bad = "a:\n  b: 1\n   c: 2\n";

    /* 好的解析器：拒 */
    const good = formatOf("yaml").getPath(bad, "a.b");
    assert.equal(good.ok, false, "好的解析器居然读通了缩进坏的文件");

    /* 坏掉的副本：放行 ⇒ 那条判据变红了 */
    const r = mod.yamlGetPath(bad, "a.b");
    assert.equal(r.ok, true,
      "去掉缩进判断之后，坏 YAML 竟然还是被拒 —— 判据不是恒真的？那它到底在判什么");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * 把 TOML 解析器「读不懂的值」那条路改掉（**副本**，原文件不动）。
 *
 * 断完之后，「读不懂就报错」这条判据**必须变红** —— 它若还绿，说明我们的
 * TOML 解析器其实没在管「这个值认不认得」。
 */
test("反向对照 C：把 TOML 的「值认不出来」那条路改掉，判据必须变红", async () => {
  const src = fs.readFileSync(path.join(CLIENTS_DIR, "formats-toml.mjs"), "utf8");
  const abs = (name) => pathToFileURL(path.join(CLIENTS_DIR, name)).href;

  let broken = src
    .split('"./base.mjs"').join(JSON.stringify(abs("base.mjs")))
    .split('"./paths.mjs"').join(JSON.stringify(abs("paths.mjs")))
    .split('registerFormat("toml"').join('registerFormat("toml-broken"')
    /* ★ 坏在点子上：认不出来的值不再报错，硬当成一个字符串 */
    .split('return { ok: false, error: "这里不是一个能认出来的值", at: i };')
    .join('return { ok: true, value: { type: "string", value: "???" }, end: i + 3 };');

  assert.notEqual(broken, src, "反向对照的替换没生效 —— TOML 解析器的源码形状变了？");

  const home = tmpHome("reverse-c");
  const file = path.join(home, "formats-toml-broken.mjs");
  fs.writeFileSync(file, broken, "utf8");

  try {
    const mod = await import(pathToFileURL(file).href);
    const bad = "a = ???";

    /* 好的解析器：拒 */
    const good = formatOf("toml").getPath(bad, "a");
    assert.equal(good.ok, false, "好的解析器居然读通了认不出来的值");

    /* 坏掉的副本：放行 ⇒ 那条判据变红了 */
    const r = mod.tomlGetPath(bad, "a");
    assert.equal(r.ok, true,
      "把「值认不出来」那条路改掉之后，坏 TOML 竟然还是被拒 —— 判据不是恒真的？");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
