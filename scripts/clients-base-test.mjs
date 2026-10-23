/**
 * 客户端接线的底座（src/server/clients/base.mjs）
 *
 * ## 测什么
 *
 *   ★ ① 接线：说好的键路径真的写进去了，写进去的值是对的
 *   ★ ② **断开：原样还原** —— 我们写的那几处回到原值，用户文件里的**其它内容
 *      一个字没动**（这是这一层最容易出事的地方）
 *   ★ ③ **读不懂就不写** —— 配置文件存在但解析失败 ⇒ 报错、中止，**用户的文件
 *      一个字节都没被改**
 *   ★ ④ 没有备份时还原 ⇒ 如实说「不是我们接的」，不碰用户文件
 *   ★ ⑤ 格式注册表：registerFormat / formatOf；没注册的格式 ⇒ 如实报错
 *   ★ ⑥ **反向对照**：改坏「先备份再写」⇒ 判据必须红
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的用户 home**。
 * 🔴 全文没有一个真实令牌/API key（夹具里的凭据形态串是明显假的占位串）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyClient, revertClient, clientStatus, registerFormat, formatOf, readFileText,
} from "../src/server/clients/base.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-clients-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `c${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const CTX = {
  home: "",
  baseUrl: "http://127.0.0.1:15799",
  apiKey: "test-placeholder-key",
  models: [{ id: "sn/claude-opus-5", label: "Claude Opus 5" }],
  providerId: "bai",
  providerName: "B.AI",
};

/* ⚠ 真实客户端的配置在**两级**目录下（~/.zcode/v2/config.json、~/.cline/data/settings/…），
 *   而「装没装」的判据是**配置文件的父目录在不在** ⇒ 夹具也必须有两级，
 *   否则「父目录在不在」这个判据在测试里没有区分度。 */
const cfgPath = (home) => path.join(home, "app", "cfg.json");
/** 写配置文件（自动建父目录）。 */
function writeCfg(home, text) {
  fs.mkdirSync(path.dirname(cfgPath(home)), { recursive: true });
  fs.writeFileSync(cfgPath(home), text, "utf8");
}
/** 一个最小的假客户端：往 `<home>/cfg.json` 的 `providers.bai` 写一块。 */
function fakeClient(home, opts = {}) {
  return {
    id: opts.id || "fake",
    name: "假客户端",
    protocol: "chat",
    files: () => [
      {
        path: cfgPath(home),
        format: opts.format || "json",
        writes: () => [
          { path: "providers.bai", value: { baseUrl: CTX.baseUrl, models: CTX.models.map((m) => m.id) } },
        ],
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "providers.bai");
          return !!(r && r.ok && r.found);
        },
      },
    ],
  };
}

/* ====================================================================== *
 * ① 接线
 * ====================================================================== */
describe("① 接线：说好的键路径真的写进去了", () => {
  test("①a 文件写出来了，那块内容也对", () => {
    const home = tmpDir();
    const def = fakeClient(home);
    const r = applyClient(def, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, `接线失败：${r.detail}`);
    const file = cfgPath(home);
    assert.ok(fs.existsSync(file), "配置文件没写出来");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(j.providers.bai.baseUrl, "http://127.0.0.1:15799");
    assert.deepEqual(j.providers.bai.models, ["sn/claude-opus-5"]);
  });

  test("①b 原本没有这个文件 ⇒ 从零建一个（合法的「从空开始」）", () => {
    const home = tmpDir();
    const r = applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    assert.ok(fs.existsSync(cfgPath(home)));
  });

  test("①c 状态：接完就是「已接到 B.AI」", () => {
    const home = tmpDir();
    const def = fakeClient(home);
    applyClient(def, { ...CTX, home }, { dataDir: home });
    const st = clientStatus(def, { ...CTX, home }, { dataDir: home });
    assert.equal(st.wired, true, `状态不对：${JSON.stringify(st)}`);
  });

  test("①d 装了但没接（配置文件在、里面没有我们那块）⇒ 「还没接」", () => {
    /* ⚠ 这是最常见的状态：客户端装了、跑过、配置也在，但没接 B.AI。
     *   它**不是**「没装」—— 说成「没装」会让用户以为要去下载。 */
    const home = tmpDir();
    writeCfg(home, JSON.stringify({ theme: "dark", provider: { other: { baseUrl: "https://example.com" } } }));
    const st = clientStatus(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(st.wired, false, "没接就是没接");
    assert.equal(st.configured, false, "里面没有我们那块");
    assert.equal(st.missing, undefined, "★ 说成了「没装」—— 用户会以为要去下载客户端");
    assert.match(String(st.detail || ""), /还没接/, "要说清是「还没接」");
  });
});

/* ====================================================================== *
 * ② 断开：原样还原
 * ====================================================================== */
describe("② 断开：只还原我们写过的那几处", () => {
  test("②a 我们写的那块回到原值", () => {
    const home = tmpDir();
    const file = cfgPath(home);
    writeCfg(home, JSON.stringify({ providers: { bai: { baseUrl: "旧的", models: ["old"] } } }), "utf8");
    const def = fakeClient(home);
    applyClient(def, { ...CTX, home }, { dataDir: home });
    const r = revertClient(def, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(j.providers.bai.baseUrl, "旧的", "原来那个值必须回来");
    assert.deepEqual(j.providers.bai.models, ["old"]);
  });

  test("②b **用户文件里的其它内容一个字没动**", () => {
    const home = tmpDir();
    const file = cfgPath(home);
    const original = {
      theme: "dark",
      providers: { bai: { baseUrl: "旧的", models: ["old"] } },
      other: { keep: [1, 2, 3], nested: { deep: true } },
    };
    const before = JSON.stringify(original);
    writeCfg(home, before, "utf8");
    const def = fakeClient(home);
    applyClient(def, { ...CTX, home }, { dataDir: home });
    revertClient(def, { dataDir: home });
    assert.equal(fs.readFileSync(file, "utf8"), before,
      "★ 断开的动作动到了用户没让我们碰的地方");
  });

  test("②c 原来**没有**那块 ⇒ 断开后那块被删掉（不是留个空壳）", () => {
    const home = tmpDir();
    const file = cfgPath(home);
    writeCfg(home, JSON.stringify({ theme: "dark" }), "utf8");
    const def = fakeClient(home);
    applyClient(def, { ...CTX, home }, { dataDir: home });
    assert.ok(fs.readFileSync(file, "utf8").includes("providers"), "接线后那块应该在");
    revertClient(def, { dataDir: home });
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(j.providers, undefined, "★ 我们新增的那块断开后应该没了");
    assert.equal(j.theme, "dark", "用户的其它内容必须还在");
  });

  test("②d 断开两次：第二次如实说「没有备份」，不碰文件", () => {
    const home = tmpDir();
    const file = cfgPath(home);
    const def = fakeClient(home);
    applyClient(def, { ...CTX, home }, { dataDir: home });
    assert.equal(revertClient(def, { dataDir: home }).ok, true);
    const snapshot = fs.readFileSync(file, "utf8");
    const again = revertClient(def, { dataDir: home });
    assert.equal(again.ok, false, "第二次断开必须说不成");
    assert.match(again.detail, /不是我们接的|没有/);
    assert.equal(fs.readFileSync(file, "utf8"), snapshot, "★ 失败的断开动了用户的文件");
  });
});

/* ====================================================================== *
 * ③ 读不懂就不写
 * ====================================================================== */
describe("③ 读不懂的配置 ⇒ 中止，用户文件一个字节都没被改", () => {
  test("③a 文件在但 JSON 坏了 ⇒ 报错、不写", () => {
    const home = tmpDir();
    const file = cfgPath(home);
    const broken = '{ this is not json ';
    writeCfg(home, broken, "utf8");
    const r = applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, false, "坏文件不该被接线");
    assert.match(r.detail, /读不懂|读不了/);
    assert.equal(fs.readFileSync(file, "utf8"), broken, "★ 用户的坏文件被改写了");
  });

  test("③b 失败时**不留下备份**（免得下次还原时拿它当原值）", () => {
    const home = tmpDir();
    writeCfg(home, "{ broken", "utf8");
    applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    const bf = path.join(home, "client-backups", "fake.json");
    assert.equal(fs.existsSync(bf), false, "★ 失败的接线留下了备份 —— 还原时会拿错误的原值覆盖用户文件");
  });

  test("③c 空文件不是「坏文件」⇒ 正常接线", () => {
    const home = tmpDir();
    writeCfg(home, "", "utf8");
    const r = applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, `空文件不该报错：${r.detail}`);
  });
});

/* ====================================================================== *
 * ④ 没有备份时还原
 * ====================================================================== */
describe("④ 没有备份 ⇒ 如实说，不碰用户文件", () => {
  test("④a 没有备份文件 ⇒ 报错且文件没动", () => {
    const home = tmpDir();
    const file = cfgPath(home);
    const before = '{"theme":"dark"}';
    writeCfg(home, before, "utf8");
    const r = revertClient(fakeClient(home), { dataDir: home });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

/* ====================================================================== *
 * ④b「没装」与「装了但没配置」必须分开说
 * ====================================================================== */
describe("④b 装没装：看目录，不只看那个配置文件在不在", () => {
  test("④b-1 配置文件不在、**父目录也不在** ⇒ missing（真没装）", () => {
    const home = tmpDir();
    const st = clientStatus(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(st.missing, true, "连目录都不在 ⇒ 就是没装");
    assert.equal(st.notConfigured, undefined, "不该同时说「没生成过配置」");
  });

  test("④b-2 配置文件不在、**父目录在** ⇒ 装了但没配置（不是「没装」）", () => {
    /* 真实场景：用户装了 ZCode，但**还没运行过** ⇒ `~/.zcode/v2/config.json`
     * 还没生成。早先一律报「这个客户端可能没装」⇒ 用户以为要去下载。 */
    const home = tmpDir();
    fs.mkdirSync(path.join(home, "cfg.json", ".."), { recursive: true });
    fs.mkdirSync(path.join(home, "app"), { recursive: true });
    const st = clientStatus(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(st.notConfigured, true, "父目录在 ⇒ 是「装了没配置」");
    assert.equal(st.missing, undefined, "★ 说成了「没装」—— 用户会以为要去下载客户端");
    assert.match(String(st.detail || ""), /还没生成|运行一次/, "要说清下一步：先运行一次客户端");
  });

  test("④b-3 反向对照：把判据改回「只看文件在不在」⇒ ④b-2 必须失效", async () => {
    const dir = path.join(TMPROOT, "broken-status");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "base.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      "    const installed = fs.existsSync(dir);",
      "    const installed = false;   // SABOTAGE：只看文件在不在",
    );
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "base.mjs"), broken, "utf8");
    fs.copyFileSync(path.join(REPO, "src", "server", "edit-json.mjs"), path.join(TMPROOT, "edit-json.mjs"));
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(path.join(dir, "base.mjs")).href + `?v=${Date.now()}`);
    const home = tmpDir();
    fs.mkdirSync(path.join(home, "app"), { recursive: true });
    const st = mod.clientStatus(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(st.notConfigured, undefined,
      "★ 改坏之后仍判成「装了没配置」—— 那 ④b-2 的判据是恒真的，测了个寂寞");
  });
});

/* ====================================================================== *
 * ④c 键里带点（模型 id 当表名）—— 路径的转义语法随格式而变
 * ====================================================================== */
describe("④c 键里带点：写进去的是一个键，还原得逐字相同", () => {
  /* ⚠ **键里可以带点**：有的客户端把模型 id 当表名（`models."bai/wb/glm-5.2"`），
   *   而本仓档位目录里就有 `glm-5.2` / `deepseek-v4.1-flash` / `qwen3.8-flash`
   *   这类带点的 id。
   *   ⚠ **路径的转义语法随格式而变**：
   *     · JSON   → **反斜杠**转义（edit-json.mjs 的 splitPath/unescapeKey）：
   *                 `models.bai\/wb\/glm-5\.2.provider`
   *     · TOML/YAML → **引号段**（clients/paths.mjs 的 splitPathParts）：
   *                 `models."bai/wb/glm-5.2".provider`
   *   用错了就是「键被切成三段」⇒ 写出一坨嵌套的怪东西。
   *   这一条测 JSON 的写法（TOML/YAML 的由那个格式自己的测试管）。 */
  const KEY = "bai/wb/glm-5.2";
  const dotted = (leaf) => "models." + KEY.replace(/([.\\])/g, "\\$1") + (leaf ? "." + leaf : "");

  const dottedClient = (home) => ({
    id: "dotted",
    name: "带点的",
    protocol: "chat",
    files: () => [{
      path: cfgPath(home),
      format: "json",
      writes: (ctx) => [
        { path: dotted("provider"), value: "bai" },
        { path: dotted("baseUrl"), value: ctx.baseUrl },
      ],
      wired: (text, fmt) => {
        const r = fmt.getPath(text, dotted("provider"));
        return !!(r && r.ok && r.found);
      },
    }],
  });

  test("④c-1 带点的键被写成**一个**键（不是被切成三段的嵌套）", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({ models: { [KEY]: { note: "用户自己的" } }, theme: "dark" }));
    const r = applyClient(dottedClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, `接线失败：${r.detail}`);
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.ok(j.models && j.models[KEY], `★ 带点的键没被写成**一个**键：${JSON.stringify(j.models)}`);
    assert.equal(j.models[KEY].provider, "bai");
    assert.equal(j.models[KEY].baseUrl, CTX.baseUrl);
    assert.equal(j.models[KEY].note, "用户自己的", "用户自己那个键必须保住");
    assert.equal(j.theme, "dark");
  });

  test("④c-2 断开后逐字还原", () => {
    const home = tmpDir();
    const before = JSON.stringify({ models: { [KEY]: { note: "用户自己的" } }, theme: "dark" });
    writeCfg(home, before);
    const def = dottedClient(home);
    applyClient(def, { ...CTX, home }, { dataDir: home });
    const back = revertClient(def, { dataDir: home });
    assert.equal(back.ok, true, back.detail);
    assert.equal(fs.readFileSync(cfgPath(home), "utf8"), before, "★ 还原后与原来不逐字相同");
  });
});

/* ====================================================================== *
 * ⑤ 格式注册表
 * ====================================================================== */
describe("⑤ 格式注册表", () => {
  test("⑤a json 是内置的", () => {
    assert.ok(formatOf("json"), "JSON 必须内置");
    assert.ok(formatOf(), "不指定格式时默认是 JSON");
  });

  test("⑤b 没注册的格式 ⇒ 如实说「不会」，不崩", () => {
    const home = tmpDir();
    const def = fakeClient(home, { format: "toml" });
    const r = applyClient(def, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, false);
    assert.match(r.detail, /toml/);
  });

  test("⑤c 注册一个假格式 ⇒ 立刻能用", () => {
    const home = tmpDir();
    registerFormat("testfmt", {
      getPath: (text, p) => ({ ok: true, value: p === "providers.bai" ? { v: 1 } : undefined, found: p === "providers.bai" }),
      setPath: (text, p, v) => ({ ok: true, text: text + JSON.stringify({ [p]: v }), changed: true }),
      delPath: (text) => ({ ok: true, text: "", changed: true }),
    });
    assert.ok(formatOf("testfmt"));
    const r = applyClient(fakeClient(home, { format: "testfmt" }), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
  });

  test("⑤d 缺函数的读写器 ⇒ 注册时就该抛（不等到用的时候才崩）", () => {
    assert.throws(() => registerFormat("bad", { getPath: () => ({}) }), /getPath|setPath|delPath/);
  });
});

/* ====================================================================== *
 * ⑥ 反向对照
 * ====================================================================== */
describe("⑥ 反向对照：改坏 ⇒ 判据必须红", () => {
  test("⑥a 把「备份里存原值」改成「存新值」⇒ ②a 必须失效", async () => {
    /* 手法：把 base.mjs 复制到临时目录，在**副本**上让备份存**写后的新值**
       （等价于「先写再备份」那个事故），再 import 副本跑一遍 ②a 的判据 ——
       它必须抓不到「还原成原值」这件事。
       ⚠ 改的是副本，仓库源码一个字不动。 */
    const dir = path.join(TMPROOT, "broken-base");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "base.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      "        value: e.before.existed === true ? e.before.value : null,\n      })),",
      "        value: e.value,   // SABOTAGE：备份里存的是写后的新值\n      })),",
    );
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "base.mjs"), broken, "utf8");
    /* 副本要能 import 到 edit-json.mjs：副本在 TMPROOT/broken-base/，
       它的 "../edit-json.mjs" 落在 **TMPROOT/edit-json.mjs**（文件，不是目录）。 */
    fs.copyFileSync(
      path.join(REPO, "src", "server", "edit-json.mjs"),
      path.join(TMPROOT, "edit-json.mjs"),
    );
    const mod = await import(pathToFileURL(path.join(dir, "base.mjs")).href + `?v=${Date.now()}`);
    const home = tmpDir();
    const file = cfgPath(home);
    writeCfg(home, JSON.stringify({ providers: { bai: { baseUrl: "旧的" } } }), "utf8");
    const def = fakeClient(home);
    mod.applyClient(def, { ...CTX, home }, { dataDir: home });
    mod.revertClient(def, { dataDir: home });
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.notEqual(j.providers.bai.baseUrl, "旧的",
      "★ 改坏之后仍然还原成功 —— 那 ②a 的判据是恒真的，测了个寂寞");
  });
});
