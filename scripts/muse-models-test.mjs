/* Muse Code 模型清单（src/server/clients/muse-models.mjs）的口径测试。
 *
 * ## 这一层为什么存在
 *
 * Muse Code **不从 /v1/models 拉清单** —— 它在每次会话前问
 * `<base_url 的主机>/muse-code/models`。我们不提供这个路径 ⇒ Muse 的清单里
 * 没有我们的模型 ⇒ 用户选不到任何档位（哪怕接线把配置都写好了）。
 * 形状逐字照 magpie 的 internal/gateway/muse.go 的 museModels。
 *
 * ## 测的是这几条不可让步的性质
 *
 *   ① **形状逐字照 magpie**：顶层 object=list，每行 object=model/created=0，
 *      metadata["muse-code"] 里那十来个键一个不少、值对。
 *   ② **id 逐字原样**：`provider/档位` 不能改 —— Muse 会把它原样送回
 *      /v1/responses 当 model，改了它就会问一个网关不认识的模型。
 *   ③ **limit 必须有，且两个数都是正数**：Muse 会**隐藏**没有 limit
 *      （或 limit 缺一半）的模型 —— 隐藏了用户就选不到它。这是本模块存在的理由。
 *      兜底值是 magpie 的 museContext / museOutput（128000 / 32000），
 *      ⚠ 是**兜底**，不是真实上限。
 *   ④ **干净**：不改调用方的 entries；凭据不进 payload（这份清单是公开可拉的）。
 *
 * 反向对照在最后一节：把实现改坏（复制到临时目录改一改再 import 进来），
 * 证明前面那些断言**真的会红** —— 不会红的断言等于没写。
 *
 * 网络/IO/时钟一律不碰：本模块是纯逻辑，测试也不发请求、不取时刻。
 * 夹具里没有任何凭据（只有模型 id 与档位名）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildMuseModels,
  MUSE_CONTEXT_FALLBACK,
  MUSE_OUTPUT_FALLBACK,
} from "../src/server/clients/muse-models.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "server", "clients", "muse-models.mjs");

/* 夹具：形状照 gatewayModelEntries()（id 已是 provider/档位）。 */
const ENTRIES = [
  { id: "sn/claude-opus-5", ownedBy: "sn", displayName: "Claude Opus 5" },
  { id: "qd/claude-sonnet-5", ownedBy: "qd", displayName: "Claude Sonnet 5" },
];

const metaOf = (payload, i = 0) => payload.data[i].metadata["muse-code"];

/* ====================================================================== *
 * ① 形状：逐字照 magpie
 * ====================================================================== */
describe("① 清单的形状逐字照 magpie", () => {
  const payload = buildMuseModels(ENTRIES);

  test("①a 顶层是 object=list + data 数组", () => {
    assert.equal(payload.object, "list");
    assert.ok(Array.isArray(payload.data));
    assert.equal(payload.data.length, ENTRIES.length);
  });

  test("①b 每行是 object=model / created=0 / owned_by=provider", () => {
    for (let i = 0; i < payload.data.length; i++) {
      const row = payload.data[i];
      assert.equal(row.object, "model");
      assert.equal(row.created, 0);
      assert.equal(row.owned_by, ENTRIES[i].ownedBy);
    }
  });

  test("①c metadata['muse-code'] 里我们知道的键都在；不知道的键**不写**", () => {
    const m = metaOf(payload, 0);
    assert.equal(m.name, "Claude Opus 5");
    assert.equal(m.family, "sn", "family 是渠道 id（magpie: e.Provider.ID）");
    assert.equal(m.is_hidden, false);
    /* ⚠ **「我们不知道」⇒ 那个键干脆不写**（不是写 false）。
     *   我们的模型 id 是**档位**（provider 无关），能力由映射到哪家上游决定
     *   （claude-opus-5 在 sn 映射到 glm-5.2、在 wb 映射到 hy3，逐家不同）⇒
     *   写 true 是撒谎；写 false 是在**断言**「不支持」—— 而我们只是不知道。
     *   Go 写的客户端读不到就是零值 false ⇒ 效果与写 false 一样，但那个**位置
     *   空着**：将来有了真值是「加一个键」，而不是逐个把假值改成真值。
     *   ⚠ 更不能写 true —— 那会让用户真去发一张上游收不下的图，当场报错。 */
    assert.equal("attachment" in m, false, "★ 写了 attachment（我们在断言「不支持」，其实只是不知道）");
    assert.equal("reasoning" in m, false, "★ 写了 reasoning（同上）");
    assert.equal("temperature" in m, false, "★ 写了 temperature（同上）");
    assert.equal(m.tool_call, true, "工具调用是**真知道**的（档位都是聊天模型）");
    assert.deepEqual(m.modalities, { input: ["text"], output: ["text"] });
    assert.deepEqual(m.options, { include: [] });
    assert.deepEqual(m.variants, {});
    assert.equal(m.description, "Claude Opus 5 via B.AI");
  });

  test("①d id 逐字原样（provider/档位）—— Muse 会把它原样送回 /v1/responses", () => {
    assert.equal(payload.data[0].id, "sn/claude-opus-5");
    assert.equal(payload.data[1].id, "qd/claude-sonnet-5");
  });

  test("①e description 署我们的名", () => {
    assert.equal(metaOf(payload, 1).description, "Claude Sonnet 5 via B.AI");
    const other = buildMuseModels(ENTRIES, { via: "X" });
    assert.equal(metaOf(other, 0).description, "Claude Opus 5 via X", "via 可以换");
  });
});

/* ====================================================================== *
 * ② limit：必须有，且两个数都是正数
 * ====================================================================== */
describe("② limit 必须有 —— Muse 会隐藏没有 limit 的模型", () => {
  test("②a 兜底值是 magpie 的 museContext / museOutput", () => {
    const m = metaOf(buildMuseModels(ENTRIES));
    assert.equal(m.limit.context, 128000);
    assert.equal(m.limit.output, 32000);
    assert.equal(MUSE_CONTEXT_FALLBACK, 128000);
    assert.equal(MUSE_OUTPUT_FALLBACK, 32000);
  });

  test("②b 每一行都得有 limit，且两个数都是正数（缺一半也会被隐藏）", () => {
    const payload = buildMuseModels(ENTRIES);
    for (let i = 0; i < payload.data.length; i++) {
      const lim = metaOf(payload, i).limit;
      assert.ok(lim, "没有 limit 的模型会被 Muse 隐藏");
      assert.ok(Number.isFinite(lim.context) && lim.context > 0, "limit.context 必须是正数");
      assert.ok(Number.isFinite(lim.output) && lim.output > 0, "limit.output 必须是正数");
    }
  });

  test("②c 知道真实上限时用真的（opts.limits 顶掉兜底）", () => {
    const payload = buildMuseModels(ENTRIES, {
      limits: { "sn/claude-opus-5": { context: 200000, output: 64000 } },
    });
    assert.equal(metaOf(payload, 0).limit.context, 200000);
    assert.equal(metaOf(payload, 0).limit.output, 64000);
    assert.equal(metaOf(payload, 1).limit.context, 128000, "没给的那一行仍用兜底");
  });

  test("②d 只知道窗口时，输出上限不超过窗口（magpie 同样 min(museOutput, ctx)）", () => {
    const payload = buildMuseModels(ENTRIES, {
      limits: { "sn/claude-opus-5": { context: 8000 } },
    });
    assert.equal(metaOf(payload, 0).limit.context, 8000);
    assert.equal(metaOf(payload, 0).limit.output, 8000, "输出上限比窗口还大，那个数就是假的");
  });

  test("②e 兜底值也不许超过窗口", () => {
    /* 兜底 context=128000 > 32000，所以 output 取 32000。 */
    assert.ok(MUSE_OUTPUT_FALLBACK <= MUSE_CONTEXT_FALLBACK);
  });
});

/* ====================================================================== *
 * ③ 边界与干净
 * ====================================================================== */
describe("③ 边界与干净", () => {
  test("③a 空清单 / 非数组 ⇒ 空列表（不是 null）", () => {
    assert.deepEqual(buildMuseModels([]), { object: "list", data: [] });
    assert.deepEqual(buildMuseModels(null), { object: "list", data: [] });
    assert.deepEqual(buildMuseModels(undefined), { object: "list", data: [] });
  });

  test("③b 没 id 的条目丢掉（Muse 按 id 选模型）", () => {
    const payload = buildMuseModels([
      { id: "", ownedBy: "sn", displayName: "空的" },
      { id: "   ", ownedBy: "sn" },
      null,
      { id: "sn/claude-opus-5", ownedBy: "sn", displayName: "Claude Opus 5" },
    ]);
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].id, "sn/claude-opus-5");
  });

  test("③c 缺 ownedBy / displayName 时从 id 推", () => {
    const payload = buildMuseModels([{ id: "qd/claude-sonnet-5" }]);
    const row = payload.data[0];
    assert.equal(row.owned_by, "qd");
    assert.equal(metaOf(payload, 0).family, "qd");
    assert.equal(metaOf(payload, 0).name, "claude-sonnet-5");
  });

  test("③d 不改调用方给进来的 entries（纯读）", () => {
    const entries = [{ id: "sn/claude-opus-5", ownedBy: "sn", displayName: "Claude Opus 5" }];
    const before = JSON.stringify(entries);
    buildMuseModels(entries);
    assert.equal(JSON.stringify(entries), before, "纯逻辑模块不许改调用方的数据");
  });

  test("③e 凭据不进 payload（这份清单是公开可拉的）", () => {
    const payload = buildMuseModels([
      { id: "sn/claude-opus-5", ownedBy: "sn", displayName: "Claude Opus 5", apiKey: "sk-fake-000000-not-real" },
    ]);
    assert.ok(!JSON.stringify(payload).includes("sk-fake-000000-not-real"),
      "清单里不许带凭据");
  });
});

/* ====================================================================== *
 * ④ 源码纪律：纯逻辑、零依赖、零时钟
 * ====================================================================== */
describe("④ 源码纪律", () => {
  const src = readFileSync(SRC, "utf8");

  /** 去掉注释再查 —— 注释里写着「不许 Date.now()」这句话本身不该被当成调用。 */
  function stripComments(s) {
    return s
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  test("④a 不 import 本仓库任何别的模块（纯逻辑、零依赖）", () => {
    const code = stripComments(src);
    assert.equal(/^\s*import\s/m.test(code), false, "本模块不许 import 任何模块");
    assert.equal(/\brequire\s*\(/m.test(code), false);
  });

  test("④b 内部不取时刻（零时钟）", () => {
    const code = stripComments(src);
    assert.equal(code.includes("Date.now("), false);
    assert.equal(/\bnew Date\s*\(\s*\)/.test(code), false);
  });

  test("④c 不碰 IO（不发请求、不读文件）", () => {
    const code = stripComments(src);
    assert.equal(/\bfetch\s*\(/.test(code), false, "本模块不许发请求");
    assert.equal(/from\s*"node:fs"/.test(code), false, "本模块不许读文件");
  });

  test("④d UTF-8 且无 BOM、行尾是 LF", () => {
    const bytes = readFileSync(SRC);
    assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false, "不许带 BOM");
    assert.equal(src.includes(String.fromCharCode(0xfffd)), false, "必须是合法的 UTF-8");
    assert.equal(/\r\n/.test(src), false, "行尾必须保持 LF");
  });
});

/* ====================================================================== *
 * ⑤ 反向对照：把实现改坏，证明前面的断言真的会红
 * ====================================================================== */

/**
 * 复制一份源码到临时目录、按锚点改坏，再 import 进来。
 *
 * ⚠ 锚点必须真的在源码里（改不到就当场炸）—— 否则「改坏」这一步悄悄没生效，
 *   后面的「断言会红」就成了自欺欺人。
 */
async function mutant(replacements) {
  const src = readFileSync(SRC, "utf8");
  let out = src;
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `改坏用的锚点不在源码里：${JSON.stringify(from)}`);
    out = out.replace(from, to);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "muse-models-mutant-"));
  const file = path.join(dir, "muse-models.mjs");
  writeFileSync(file, out, "utf8");
  return import(pathToFileURL(file).href);
}

/** 断言「改坏之后这条检查会红」。 */
async function mustGoRed(mod, check, why) {
  let threw = false;
  try {
    await check(mod);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, `改坏之后这条断言竟然还过：${why}`);
}

describe("⑤ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑤a 把 limit 整个去掉 ⇒ ②b 会红（Muse 隐藏没 limit 的模型）", async () => {
    const mod = await mutant([
      ["limit: limitFor(id, limits),", "limit: undefined,"],
    ]);
    await mustGoRed(mod, async (m) => {
      const payload = m.buildMuseModels(ENTRIES);
      for (let i = 0; i < payload.data.length; i++) {
        const lim = payload.data[i].metadata["muse-code"].limit;
        assert.ok(lim, "没有 limit 的模型会被 Muse 隐藏");
        assert.ok(Number.isFinite(lim.context) && lim.context > 0);
        assert.ok(Number.isFinite(lim.output) && lim.output > 0);
      }
    }, "limit 被去掉之后，②b 竟然还过");
  });

  test("⑤b 把输出上限弄成 0 ⇒ ②b 会红（缺一半也会被隐藏）", async () => {
    const mod = await mutant([
      ["Math.min(MUSE_OUTPUT_FALLBACK, ctx)", "0"],
    ]);
    await mustGoRed(mod, async (m) => {
      const payload = m.buildMuseModels(ENTRIES);
      const lim = payload.data[0].metadata["muse-code"].limit;
      assert.ok(Number.isFinite(lim.output) && lim.output > 0, "limit.output 必须是正数");
    }, "输出上限被弄成 0 之后，②b 竟然还过");
  });

  test("⑤c 把 id 改写 ⇒ ①d 会红（Muse 会把 id 原样送回 /v1/responses）", async () => {
    const mod = await mutant([
      ["      id,\n      object: \"model\",", "      id: \"bai:\" + id,\n      object: \"model\","],
    ]);
    await mustGoRed(mod, async (m) => {
      const payload = m.buildMuseModels(ENTRIES);
      assert.equal(payload.data[0].id, "sn/claude-opus-5", "id 必须逐字原样");
    }, "id 被改写之后，①d 竟然还过");
  });

  test("⑤d 把兜底值换成 0 ⇒ ②a 会红（兜底值也得是正数）", async () => {
    const mod = await mutant([
      ["export const MUSE_CONTEXT_FALLBACK = 128000;", "export const MUSE_CONTEXT_FALLBACK = 0;"],
    ]);
    await mustGoRed(mod, async (m) => {
      const payload = m.buildMuseModels(ENTRIES);
      const lim = payload.data[0].metadata["muse-code"].limit;
      assert.ok(Number.isFinite(lim.context) && lim.context > 0, "limit.context 必须是正数");
    }, "兜底值被换成 0 之后，②a 竟然还过");
  });
});
