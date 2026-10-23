/**
 * 客户端接线的「接上 → 读回 → 断言」一致性核对（scripts/clients-all-test.mjs）
 *
 * ## 为什么要有这一条
 *
 * 「配置写好了」≠「客户端会走」—— 这一轮已经吃过两次亏（Hermes 的键名版本差异、
 * TOML 重复定义父表）。所以**别再靠「我照抄了 magpie」来判断对错**：
 * 每个客户端接上以后，把它的配置文件**当纯文本读回来**，看里面到底写了什么。
 *
 * ## 测什么（对**每一个**客户端，一视同仁）
 *
 * ★ ① **接上**：applyClient 必须 ok。
 * ★ ② **读回**（把配置文件当纯文本读）：
 *   · 里面出现了**我们的网关地址**；
 *   · **这个客户端的拼法对不对** —— 它写的那个 base 加上「它自己会拼的那一截」，
 *     必须落在**统一网关答的路径**上（见下面 APPENDS / SERVED）；
 *   · **没有**出现「/v1/v1」这种拼错的地址；
 *   · 里面出现的**模型 id 是 provider/档位 形状**（`sn/claude-opus-5`）——
 *     拿档位当模型 id 写出去，网关那边会静默落到默认模型；
 *   · **没有残留的凭据**：除了 ctx.apiKey，不该有别的长串。
 * ★ ③ **断开**：revertClient 必须 ok，且**用户的文件逐字回到接上之前**。
 * ★ ④ 面板的状态也得对：接完 clientStatus 说「已接到 B.AI」。
 *
 * ## 客户端清单从哪儿来
 *
 * `allClients()`（clients/registry.mjs）—— **不写死名单**：以后加了新的客户端，
 * 它自动被测到。配置文件的路径也**从声明里取**（`def.files(ctx)`），
 * 不在本文件里复述一遍（复述一遍就会漏）。
 *
 * ## 「这个客户端的拼法」那张表从哪儿来
 *
 * APPENDS 写的是**客户端自己会在 base 后面拼的那一截** —— 事实来源是 magpie 的
 * `internal/agent/<name>.go`（它给每个客户端写死了 base_url 与那家客户端的拼法）。
 * 本仓的统一网关答哪些路径见 SERVED。两者对不上 ⇒ 这个客户端接上了也走不通。
 *
 * ## 「用户自己的配置」怎么造
 *
 * 每个客户端照它**真实的形状**造：先问它「你要写哪几处」（`f.writes(ctx)`），
 * 再在那几处各放一个**用户自己的值**（形状相同、内容明显是用户的），
 * 另加一个与接线无关的用户键。断开的判据是**逐字**回到这份夹具 ——
 * 用户的键还在、用户的值还在、连排版都没变。
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的 ~/.claude、~/.codex、
 *    %APPDATA%…**（那些文件里有真凭据）。所以：ctx.home 指到临时目录，
 *    且 APPDATA / LOCALAPPDATA 也指到临时目录（Windows 上那几个客户端按
 *    %APPDATA% 找自己的配置 —— 不改就会写到真目录去）。
 * 🔴 全文没有一个真实令牌/API key（夹具里的凭据形态串是明显假的占位串）。
 * 🔴 **不读用户的真实配置文件**（里面有真 key）—— 要核形状就在临时目录里造。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { applyClient, revertClient, clientStatus, formatOf } from "../src/server/clients/base.mjs";
import { allClients } from "../src/server/clients/registry.mjs";
import { claudeCodeEdits } from "../src/server/clients/claude-code-edits.mjs";

/* ------------------------------------------------------------------ *
 * 统一网关答哪些路径
 * ------------------------------------------------------------------ */

const SERVED = [
  "/chat/completions",
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/responses",
  "/v1/models",
];
/** 前缀算命中（Gemini 的模型名在路径里）。 */
const SERVED_PREFIX = ["/v1beta/"];

/**
 * APPENDS —— **每个客户端自己会在 base 后面拼的那一截**（magpie 的 .go 是来源）。
 *
 *   · 字符串 ⇒ base + 它 必须落在网关答的路径上；
 *   · { complete: true }  ⇒ 客户端写的是**完整地址**（它不自己拼），那地址
 *     本身必须落在网关答的路径上；
 *   · { none: true }      ⇒ 这个客户端**不写地址**（magpie 也没写）——
 *     文件里**不许**冒出网关地址。
 */
const APPENDS = {
  "claude-code": "/v1/messages",
  "claude-desktop": "/v1/messages",
  cline: "/chat/completions",
  codebuddy: { complete: true },
  codex: "/responses",
  "cursor-cli": { none: true },
  droid: "/chat/completions",
  empryo: "/chat/completions",
  "gemini-cli": "/v1beta/models/{model}:generateContent",
  goose: "/chat/completions",
  grok: "/chat/completions",
  hermes: "/chat/completions",
  jcode: "/chat/completions",
  "kimi-code": "/chat/completions",
  "minimax-code": "/v1/chat/completions",
  morph: "/responses",
  muse: "/responses",
  omp: "/chat/completions",
  opencode: "/chat/completions",
  pi: "/chat/completions",
  qoder: "/chat/completions",
  "qoder-cn": "/chat/completions",
  "qwen-code": "/chat/completions",
  reasonix: "/chat/completions",
  stepcode: "/chat/completions",
  workbuddy: { complete: true },
  "workbuddy-ai": { complete: true },
  /* ZCode 两份文件都写 anthropic-messages（magpie 的默认）⇒ Anthropic 的 SDK
   * 自己拼那个 /v1（网关答 /v1/messages ✓）。 */
  zcode: "/v1/messages",
};

/** 某个路径是不是网关答的。 */
function isServed(p) {
  const s = String(p || "");
  if (SERVED.includes(s)) return true;
  return SERVED_PREFIX.some((x) => s.startsWith(x));
}

/* ------------------------------------------------------------------ *
 * 临时环境
 * ------------------------------------------------------------------ */

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-clients-all-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `c${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 动态挑一个空闲端口（全程不连网关，但地址得像个真的）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * 客户端各自读的环境变量 —— **一律清空**（本机若设了，路径就跑到真目录去了）。
 * APPDATA / LOCALAPPDATA 反过来**指到临时目录**：Windows 上 goose / hermes /
 * reasonix 按 %APPDATA% 找自己的配置，不指走就会写到真目录。
 */
const CLIENT_ENV = [
  "QWEN_HOME", "QODER_CONFIG_DIR", "QODERCN_CONFIG_DIR", "CLINE_DIR", "CLINE_DATA_DIR",
  "FACTORY_HOME_OVERRIDE", "CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR",
  "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "STEP_CODING_AGENT_DIR", "STEPCODE_CONFIG_DIR",
  "KIMI_SHARE_DIR", "GROK_HOME", "GROK_APP_HOME", "HERMES_HOME", "REASONIX_HOME",
  "ATOMCODE_HOME", "MINIMAX_DATA_DIR", "DEVECO_CONFIG_DIR", "OPENCODE_CONFIG_DIR",
  "MORPH_CONFIG", "MISTER_MORPH_CONFIG", "DSH_HOME", "CLAUDE_CONFIG_DIR",
];
const savedEnv = {};
for (const k of CLIENT_ENV) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}
for (const k of ["APPDATA", "LOCALAPPDATA"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(TMPROOT, k);
  fs.mkdirSync(process.env[k], { recursive: true });
}
process.on("exit", () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const PORT = await freePort();
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** 明显是假的凭据占位串（本地网关不校验 key，但客户端多半要求非空）。 */
const API_KEY = "test-placeholder-key";

/** 我们的模型 id —— **provider/档位** 的完整写法。 */
const MODELS = [
  { id: "sn/claude-opus-5", label: "Claude Opus 5" },
  { id: "wb/glm-5.2", label: "GLM 5.2" },
];

const CTX_BASE = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  models: MODELS,
  providerId: "bai",
  providerName: "B.AI",
  /* ⚠ Claude Code 那条线**复用**既有的接线逻辑（纯函数 claudeCodeEdits）——
   *   这里传**真的**那个函数、给假的事实 ⇒ 测的是真的逻辑，不是抄一份。
   *   （原来那段逻辑住在 server.mjs 里，而 server.mjs 一 import 就起服务 ⇒
   *   测试没法用；已抽成纯函数，见 clients/claude-code-edits.mjs。） */
  cli: {
    editsFor: () => claudeCodeEdits({
      tiers: [
        { key: "claude-fable-5", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL" },
        { key: "claude-sonnet-5", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
        { key: "claude-opus-5", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
        { key: "claude-haiku-4-5", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
      ],
      gw: true,
      gatewayBaseUrl: BASE_URL,
      cliBaseUrl: BASE_URL,
      viaLocalRelay: false,
      proxyManagedToken: "test-placeholder-proxy",
      providerId: "bai",
      channelId: "bai",
      key: API_KEY,
      mapping: { "claude-opus-5": { target: "test-target-opus", label: "档·Opus" } },
      defaultModel: "test-target-default",
      proxy: "http://127.0.0.1:7897",
    }),
  },
};

/* ------------------------------------------------------------------ *
 * 「用户自己的配置」怎么造
 * ------------------------------------------------------------------ */

/**
 * userValueFor —— 在某个键路径上放一个「用户自己的」值。
 *
 * **形状照着我们本来要写的那个值**（数组放数组、对象放对象、字符串放字符串），
 * 内容是明显的用户自己的东西（`user-own-…`）—— 这样「断开后原样还原」
 * 才有意义：还原的必须是**用户那个值**，不是我们那个。
 */
function userValueFor(value) {
  if (Array.isArray(value)) return [{ id: "user-own-entry" }];
  if (value && typeof value === "object") return { userOwn: "keep-me" };
  if (typeof value === "number") return 42;
  if (typeof value === "boolean") return false;
  return "user-own-value";
}

/**
 * buildFixture —— 一个文件里「用户自己的配置」。
 *
 * 造法：先问这个客户端「你要写哪几处」，再在那几处各放一个用户自己的值，
 * 另加一个与接线无关的用户键。
 */
function buildFixture(file, ctx) {
  const fmt = formatOf(file.format || "json");
  if (!fmt) return { text: "" };
  let writes = [];
  try {
    writes = (typeof file.writes === "function" ? file.writes(ctx) : file.writes) || [];
  } catch {
    return { text: "" };
  }
  let text = "";
  for (const w of writes) {
    const p = String(w.path || "");
    if (!p) continue;
    const r = fmt.setPath(text, p, userValueFor(w.value));
    if (!r.ok) continue;
    text = r.text;
  }
  /* 再加一个跟接线完全无关的用户键 —— 断开后它必须原样还在。 */
  const extra = fmt.setPath(text, "userOwnKey", "keep-me");
  if (extra.ok) text = extra.text;
  return { text };
}

/* ------------------------------------------------------------------ *
 * 读回之后的判据
 * ------------------------------------------------------------------ */

/** 文件里出现的所有「像地址」的串。 */
function urlsIn(text) {
  return [...text.matchAll(/https?:\/\/[^\s"',;)\]}]+/g)].map((m) => m[0]);
}

/** 文件里出现的所有引号内的串（JSON/TOML/YAML 都够用）。 */
function quotedIn(text) {
  return [...text.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
}

/**
 * 凭据形态的长串（纯字母数字 20 位以上 —— JWT 段、base64 段那种）。
 *
 * ⚠ **键名不算**：JSON 的 `"sessionDefaultSettings": {` 里的那个词是键名，
 *   不是凭据 —— 键后面跟着（可能先跟一个引号）":"（或 "="）的一律跳过。
 */
function credentialish(text) {
  const out = [];
  for (const m of text.matchAll(/[A-Za-z0-9]{20,}/g)) {
    const after = text.slice(m.index + m[0].length).replace(/^["'\s]*/, "");
    if (after.startsWith(":") || after.startsWith("=")) continue;   // 键名
    out.push(m[0]);
  }
  return out;
}

/**
 * hasDottedKey —— 这个客户端的写路径里有没有「键里带点」的。
 *
 * magpie 那一族里，kimi / grok / minimax 把**模型 id 当表名**（`[models."bai/wb/glm-5.2"]`），
 * 而模型 id 里带点（本仓的档位目录里就有 glm-5.2、deepseek-v4.1-flash…）。
 *
 * ⚠ **底座算父路径时用的是 `p.split(".")`** —— 点被当成了分隔符，于是
 *   `models."bai/wb/glm-5.2".model` 的父路径被算成 `models."bai/wb/glm-5`
 *   （引号也就此不闭合）⇒ 取那个值时直接抛错 ⇒ **整个客户端接不上**。
 */
function hasDottedKey(def, ctx) {
  for (const f of def.files(ctx) || []) {
    let ws = [];
    try {
      ws = (typeof f.writes === "function" ? f.writes(ctx) : f.writes) || [];
    } catch {
      continue;
    }
    for (const w of ws) {
      for (const seg of String(w.path || "").match(/"[^"]*"/g) || []) {
        if (seg.includes(".")) return true;
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 逐个客户端
 * ------------------------------------------------------------------ */

const clients = await allClients();

/** 汇总表：每个客户端实际写出来的地址 —— 报告里那张「/v1 带不带」的表。 */
const summary = [];

describe("客户端接线：每一个都接上 → 读回 → 断开", () => {
  for (const def of clients) {
    test(`${def.id}：接上 → 读回 → 断开`, () => {
      /* 先入册 —— 哪怕后面断言红了，这个客户端也要出现在汇总表里
         （汇总表是报告的底料：红了的那个也得在）。 */
      const rec = { id: def.id, protocol: def.protocol || "", urls: [], files: [] };
      summary.push(rec);

      const home = tmpDir();
      const ctx = { ...CTX_BASE, home };
      const files = (def.files(ctx) || []).filter((f) => f && f.path);
      assert.ok(files.length, `${def.id}：声明里没有配置文件`);

      /* ① 造「用户自己的配置」 */
      const fixtures = files.map((f) => ({ f, ...buildFixture(f, ctx) }));
      for (const fx of fixtures) {
        fs.mkdirSync(path.dirname(fx.f.path), { recursive: true });
        fs.writeFileSync(fx.f.path, fx.text, "utf8");
      }

      /* ② 接上 */
      const r = applyClient(def, ctx, { dataDir: home });
      assert.equal(r.ok, true, `${def.id}：接线失败：${r.detail}${hasDottedKey(def, ctx)
        ? "\n   ⚠ 这个客户端的写路径里有「键里带点」的（模型 id 当表名）。"
        + "底座 base.mjs 算父路径时用的是 `p.split(\".\")` —— 点被当成分隔符，"
        + "于是 `models.\"bai/wb/glm-5.2\".model` 的父路径被算成 `models.\"bai/wb/glm-5\"`"
        + "（引号就此不闭合）⇒ 取那个值时抛错 ⇒ 整个客户端接不上。"
        + "修法：base.mjs 用**格式自己的**分路径器算父路径（paths.mjs 的 splitPathParts / "
        + "edit-json.mjs 的 splitPath），别用 p.split(\".\")。"
        : ""}`);

      /* ③ 读回：把配置文件当纯文本读 */
      const written = [];
      for (const fx of fixtures) {
        assert.ok(fs.existsSync(fx.f.path), `${def.id}：${fx.f.path} 没写出来`);
        const text = fs.readFileSync(fx.f.path, "utf8");
        written.push({ file: fx.f, text });

        /* · 没有把 /v1 拼两遍（那是地址写错的样子） */
        assert.ok(!text.includes(`${BASE_URL}/v1/v1`),
          `${def.id}：${fx.f.path} 里出现了 /v1/v1（地址拼错了）`);

        /* · 模型 id 是 provider/档位 形状（客户端自己拼的那层 provider 前缀
           *   也认：「bai/sn/claude-opus-5」是「客户端的 provider + 我们的 id」） */
        for (const s of quotedIn(text)) {
          if (!/^[a-z0-9]+\//.test(s)) continue;
          assert.match(s, /^[a-z0-9]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,
            `${def.id}：${fx.f.path} 里有个不像 provider/档位 的模型 id：「${s}」`);
        }
        /* · 档位不许单独出现（拿档位当模型 id 写出去，网关会静默落到默认模型）
         *   ⚠ 前缀**不必是 MODELS 里那一个**：Claude Code 这类**不能自己挑模型**
         *   的客户端接的是「用户当前选中的渠道」，前缀是那一家（可能是 bai/sn/wb…）。
         *   判据是「前面有**某个** provider 前缀」，不是「有**那个** provider 前缀」。 */
        for (const m of MODELS) {
          const tier = m.id.slice(m.id.indexOf("/") + 1);
          let at = text.indexOf(tier);
          while (at >= 0) {
            const before = text.slice(Math.max(0, at - 60), at);
            assert.ok(/[a-z0-9]+\/$/.test(before),
              `${def.id}：${fx.f.path} 里档位「${tier}」单独出现了（前面没有 provider 前缀）`);
            at = text.indexOf(tier, at + 1);
          }
        }

        /* · 除了 ctx.apiKey，不该有别的凭据形态长串 */
        for (const tok of credentialish(text)) {
          assert.ok(API_KEY.includes(tok) || tok === API_KEY,
            `${def.id}：${fx.f.path} 里有个不该出现的凭据形态长串：「${tok}」`);
        }
      }

      /* ③b 这个客户端的**拼法**对不对：base + 它自己会拼的那一截，
         必须落在统一网关答的路径上。 */
      const allText = written.map((w) => w.text).join("\n");
      const urls = [...new Set(urlsIn(allText))].filter((u) => u.startsWith(BASE_URL));
      const spec = APPENDS[def.id];
      assert.ok(spec, `${def.id}：APPENDS 表里没有这个客户端 —— 补上它的拼法再测`);
      if (spec.none) {
        assert.equal(urls.length, 0,
          `${def.id}：这个客户端不该写地址（magpie 也没写），却写了 ${JSON.stringify(urls)}`);
      } else {
        assert.ok(urls.length, `${def.id}：文件里没有网关地址 ${BASE_URL}`);
        for (const u of urls) {
          let p;
          try { p = new URL(u).pathname; } catch { p = "/"; }
          /* 这个地址**本身就是**一个完整端点（模型清单之类）⇒ 它自己就该是
             网关答的路径；否则它是 base，后面还要由客户端自己拼一截。 */
          if (spec.complete || isServed(p)) {
            assert.ok(isServed(p),
              `${def.id}：写出来的完整地址 ${u} 不是网关答的路径`);
          } else {
            const final = (p === "/" ? "" : p) + spec;
            assert.ok(isServed(final.replace("{model}", "sn/claude-opus-5")),
              `${def.id}：base ${u} + 客户端自己拼的 ${spec} = ${final} —— 网关不答这个路径`);
          }
        }
      }

      /* ④ 面板的状态也得说「已接到 B.AI」 */
      const st = clientStatus(def, ctx, { dataDir: home });
      assert.equal(st.wired, true, `${def.id}：接上了但状态说没接：${JSON.stringify(st)}`);

      /* ⑤ 断开：逐字回到接上之前 */
      const rv = revertClient(def, { dataDir: home });
      assert.equal(rv.ok, true, `${def.id}：断开失败：${rv.detail}`);
      for (const fx of fixtures) {
        const after = fs.readFileSync(fx.f.path, "utf8");
        assert.equal(after, fx.text,
          `★ ${def.id}：${fx.f.path} 断开后与用户的原文件不一样\n---- 接上之前 ----\n${fx.text}\n---- 断开之后 ----\n${after}\n----`);
      }

      /* 记进汇总表（报告里那张表） */
      rec.urls = urls;
      rec.files = written.map((w) => w.file.path.replace(home, "~"));
      rec.ok = true;
    });
  }
});

describe("汇总：每一个客户端都测到了", () => {
  test("① 名录里的客户端一个都没漏", () => {
    assert.ok(clients.length >= 20, `名录里才 ${clients.length} 个客户端，不对劲`);
    assert.equal(summary.length, clients.length,
      `测了 ${summary.length} 个，名录里有 ${clients.length} 个 —— 漏了`);
  });

  test("② 每个客户端的地址都落在一个网关答的路径上", () => {
    for (const s of summary) {
      if (!s.ok) continue;                 // 这个客户端自己那条已经红了（原因见那条）
      const spec = APPENDS[s.id];
      if (!spec || spec.none) continue;
      assert.ok(s.urls.length, `${s.id}：写出来的地址里没有网关地址`);
    }
  });

  test("③ 「/v1 带不带」那张表（报告用）", () => {
    const rows = summary.map((s) => {
      const spec = APPENDS[s.id] || {};
      const u = s.urls[0] || "（没写地址）";
      const p = (() => {
        try { return new URL(u).pathname; } catch { return "?"; }
      })();
      const v1 = p.includes("/v1") ? "带 /v1" : (p === "/" || p === "" ? "不带" : `其它(${p})`);
      return `${s.id.padEnd(14)} ${String(s.protocol).padEnd(10)} ${v1.padEnd(12)} ${u}`;
    });
    console.log(`\n---- 每个客户端写出来的地址 ----\n${rows.join("\n")}\n----------------------------`);
    assert.ok(rows.length === clients.length);
  });
});
