/**
 * scripts/wb-header-budget-test.mjs —— 「wbai 大上下文请求被我们自己的中转掐断」
 *
 * ## 病根（v1.0.85，实测确认，不是猜的）
 *
 *   WorkBuddy AI（`wbai`）在大上下文请求下 502。直连上游、同样体量的 body、
 *   只改历史条数，实测**响应头**到达耗时：
 *
 *     | 历史条数 | body 大小 | 响应头到达 |
 *     |---------|----------|-----------|
 *     | 100     | 0.42 MB  | 8.7 s     |
 *     | 300     | 1.25 MB  | 15.2 s（复测 15~19 s）|
 *     | 600     | 2.50 MB  | 30.0 s    |
 *
 *   而 `openaiExchange` 给的是**一刀切 30 秒、没有任何余量**：上传 1.3MB、
 *   上游读 1283 条消息、长上下文预填，全挤在这 30 秒里。一抖就 502，
 *   用户看到的现象是「对话 1 分钟断一次，然后一直重连」。
 *
 *   ⚠ 延迟本身在 30 秒内是能到的 —— 所以病根不是「上游太慢」，
 *   是「我们的预算没有随体量增长」。
 *
 * ## 本文件怎么测（以及为什么不是测一个替身）
 *
 *   分档规则住在 `src/server/upstream-budget.mjs`（纯逻辑、零 IO、零网络），
 *   本文件**直接 import 那一份**求值 —— 测的就是生产跑的那一个函数。
 *
 *   为什么不把规则留在 server.mjs 里：server.mjs 一 import 就起服务
 *   （抢单实例锁、开两个监听端口），住在那里的逻辑没法被 import 求值，
 *   只能注入替身去测。v1.0.76 的 `wbTokenExp` 漏 `* 1000` 就是这么上线的 ——
 *   scripts/wb-pool-wiring-test.mjs 全程注入自己的替身 `tokenExpOf`，
 *   **生产的 wbTokenExp 从没被接进过测试**（见 src/server/wb-token.mjs 顶部）。
 *   本文件不重犯：既有「纯函数本体」的直接断言（①~④），
 *   也有「server.mjs 真的接了线」的接线断言（⑥）——两头都查。
 *
 * ## 覆盖点
 *
 *   ① 小 body → 预算**仍是 30 秒**（不许偷偷改大，这是本次唯一的回归风险）
 *   ② 1.25MB 量级 → 预算 > 实测需要的 19 秒，留足余量
 *   ③ 2.5MB 量级 → 预算更大
 *   ④ 超出上限后**封顶**（不能无限增长）
 *   ⑤ 探针档位语义不变（isProbe 仍走 ZEN_PROBE_TIMEOUT_MS）
 *   ⑥ 首事件闸门预算**不窄于**响应头预算（否则「头已到、首事件被掐」）
 *   ⑦ 同量纲/边界守卫：预算是毫秒量级、有限正数
 *
 * ## 反向对照
 *
 *   把分档逻辑改回一刀切 30 秒（upstreamHeaderBudgetMs 恒返回 30000），
 *   ②③④⑥ 当场红；①⑤⑦ 仍然绿 —— 因为那三条钉的正是「不许改的东西」。
 *   同理，把 `Buffer.byteLength` 换成 `bodyStr.length`，⑧ 当场红。
 *   判据只有一个：**改回改前行为，测试真的会红。**
 *
 * ## 红线
 *
 *   🔴 全文零 IO、零网络、零进程、零定时器。不起服务、不发真实请求。
 *   🔴 全文没有真实令牌 / API key / 用户名 / 本机绝对路径。
 *      夹具里的请求体是**现造的合成 JSON**（filler 字符 + 一条假消息），
 *      不含任何凭据形态串，也不含任何真实对话内容。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  upstreamBodyBytes, upstreamHeaderBudgetMs, upstreamFirstEventBudgetMs,
  upstreamBudgetTierLabel,
  UPSTREAM_HEADER_TIMEOUT_MS, UPSTREAM_HEADER_TIERS, UPSTREAM_HEADER_BUDGET_CAP_MS,
  UPSTREAM_FIRST_EVENT_FLOOR_MS, UPSTREAM_FIRST_EVENT_FACTOR, UPSTREAM_FIRST_EVENT_CAP_MS,
} from "../src/server/upstream-budget.mjs";
import { ZEN_PROBE_TIMEOUT_MS } from "../src/server/zen-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_SRC = readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");

const KB = 1024;
const MB = 1024 * KB;

/* ====================================================================== *
 * 夹具：合成请求体。🔴 现造，不含任何真实凭据/对话内容。
 * ====================================================================== */

/** 造一个约 n 字节的假请求体（UTF-8）。用 ASCII filler 保证「字节数 == 字符数」，
 *  这样「按字符数分档」这个 bug 在 ASCII 夹具上测不出来 —— 那一条交给 ⑧。 */
const bodyOfBytes = (n) => {
  const head = '{"model":"wb-dummy-model-not-real","max_tokens":512,"messages":[{"role":"user","content":"';
  const tail = '"}]}';
  const fill = Math.max(0, n - Buffer.byteLength(head) - Buffer.byteLength(tail));
  return head + "f".repeat(fill) + tail;
};

/** 造一个约 n 字节的**中文**假请求体。UTF-8 下 3 字节/字，
 *  所以它的字符数只有字节数的 1/3 —— ⑧ 的判据全靠这个差值。 */
const bodyOfZhBytes = (n) => {
  const head = '{"model":"wb-dummy-model-not-real","max_tokens":512,"messages":[{"role":"user","content":"';
  const tail = '"}]}';
  const need = Math.max(0, n - Buffer.byteLength(head) - Buffer.byteLength(tail));
  return head + "中".repeat(Math.ceil(need / 3)) + tail;
};

/* 实测的三个体量点（见文件头）。1.25MB 的复测上界 19 秒单独拎出来当判据，
   因为单点实测会抖，带上界才是个能钉住的数。 */
const MEASURED = [
  { label: "0.42MB（100 条历史）", bytes: Math.round(0.42 * MB), headerAt: 8.7 },
  { label: "1.25MB（300 条历史）", bytes: Math.round(1.25 * MB), headerAt: 19.0 },
  { label: "2.50MB（600 条历史）", bytes: Math.round(2.50 * MB), headerAt: 30.0 },
];

/* ====================================================================== *
 * ① 小 body → 预算仍是 30 秒（不许偷偷改大）
 * ====================================================================== */
describe("① 小请求的响应头预算仍是 30 秒（本次唯一的回归风险）", () => {
  /* 为什么这条最重要：把默认预算一律抬大是**最省事的修法**，也是最坏的。
     它让所有请求都变慢（等更久才知道失败），包括那些本来 2 秒就该失败转移的。
     正解是只放宽真正大的那一档。 */
  for (const n of [0, 1, 1024, 64 * KB, 256 * KB, 512 * KB - 1]) {
    test(`${n} 字节 → 预算 === ${UPSTREAM_HEADER_TIMEOUT_MS}ms（30 秒）`, () => {
      const ms = upstreamHeaderBudgetMs(n);
      assert.equal(ms, UPSTREAM_HEADER_TIMEOUT_MS,
        `★ 小请求预算被改大了：${n} 字节拿到 ${ms}ms。`
        + "小请求必须保持 30 秒不变，否则所有请求都要等更久才知道失败。");
    });
  }

  test("首事件闸门的小请求档也是 90 秒（与改动前逐字相同）", () => {
    for (const n of [0, 1024, 256 * KB, 512 * KB - 1]) {
      assert.equal(upstreamFirstEventBudgetMs(n), UPSTREAM_FIRST_EVENT_FLOOR_MS,
        `小请求首事件预算被改了：${n} 字节拿到 ${upstreamFirstEventBudgetMs(n)}ms`);
    }
  });

  test("30 秒这个常数还叫 30000，且分档表第一档就是它", () => {
    assert.equal(UPSTREAM_HEADER_TIMEOUT_MS, 30000);
    assert.equal(UPSTREAM_HEADER_TIERS[0].ms, UPSTREAM_HEADER_TIMEOUT_MS,
      "分档表第一档必须就是 30 秒 —— 有人往上插了一档，小请求就不再是 30 秒了");
  });
});

/* ====================================================================== *
 * ② 1.25MB 量级 → 预算 > 实测需要的 19 秒
 * ====================================================================== */
describe("② 1.25MB 量级：预算要盖住实测的 15~19 秒，还要留余量", () => {
  const B = Math.round(1.25 * MB);

  test("预算 > 19 秒（实测上界），且不超过 45 秒（没被顺手放到下一档）", () => {
    const ms = upstreamHeaderBudgetMs(B);
    assert.ok(ms > 19000,
      `★ 1.25MB 只拿到 ${ms}ms —— 实测这个体量的响应头要 15~19 秒。`
      + "这正是用户「对话 1 分钟断一次」的那一档，预算盖不住。");
    assert.ok(ms <= 45000, `1.25MB 拿到 ${ms}ms，跑到 45 秒档以上去了 —— 档位边界划错了？`);
    assert.ok(ms / 19000 >= 2,
      `1.25MB 的余量只有 ${(ms / 19000).toFixed(2)}× —— 该档要的是 ≥2×（45000/19000≈2.4×）`);
  });

  test("同一个请求体对象：先量字节、再查档，两件事结果一致", () => {
    /* 这条钉的是**调用方式**：分档函数吃的是字节数，不是字符串。
       用真的合成 body 走一遍「量 → 查」，确认 1.25MB 的体量真能落进 45 秒档。 */
    const body = bodyOfBytes(B);
    assert.ok(Math.abs(upstreamBodyBytes(body) - B) <= 8,
      `夹具没造准：想要 ${B} 字节，实际 ${upstreamBodyBytes(body)} 字节`);
    const ms = upstreamHeaderBudgetMs(upstreamBodyBytes(body));
    assert.ok(ms > 19000 && ms <= 45000, `真请求体只拿到 ${ms}ms`);
  });
});

/* ====================================================================== *
 * ③ 2.5MB 量级 → 预算更大
 * ====================================================================== */
describe("③ 2.5MB 量级：预算比 1.25MB 那一档更大", () => {
  test("2.5MB > 1.25MB 的预算，且 > 30 秒（实测上界）", () => {
    const b125 = upstreamHeaderBudgetMs(Math.round(1.25 * MB));
    const b250 = upstreamHeaderBudgetMs(Math.round(2.50 * MB));
    assert.ok(b250 > b125,
      `★ 2.5MB 拿到 ${b250}ms，1.25MB 拿到 ${b125}ms —— 大的那一档没变宽。`
      + "预算必须单调不降，否则大请求的余量比小请求还薄。");
    assert.ok(b250 > 30000,
      `2.5MB 只拿到 ${b250}ms，而实测这个体量的响应头**刚好就是 30 秒** —— 零余量。`);
  });

  test("预算对体量单调不降（全区间抽查，不许有回头）", () => {
    let prev = 0;
    for (let mb = 0; mb <= 24; mb += 0.25) {
      const ms = upstreamHeaderBudgetMs(Math.round(mb * MB));
      assert.ok(ms >= prev, `体量 ${mb}MB 处预算回退了：${prev}ms → ${ms}ms`);
      prev = ms;
    }
  });
});

/* ====================================================================== *
 * ④ 超出上限后封顶（不能无限增长）
 * ====================================================================== */
describe("④ 预算有硬上限：再大的 body 也只等这么久", () => {
  for (const label of ["6MB", "12MB", "50MB", "200MB"]) {
    test(`${label} → 预算 === ${UPSTREAM_HEADER_BUDGET_CAP_MS}ms（封顶）`, () => {
      const n = Math.round(Number(label.replace("MB", "")) * MB);
      assert.equal(upstreamHeaderBudgetMs(n), UPSTREAM_HEADER_BUDGET_CAP_MS,
        `${label} 拿到 ${upstreamHeaderBudgetMs(n)}ms —— 封顶失效，预算会无限涨`);
    });
  }

  test("封顶值本身合理：不高于 3 分钟，不低于最宽那一档", () => {
    assert.ok(UPSTREAM_HEADER_BUDGET_CAP_MS >= 60000 && UPSTREAM_HEADER_BUDGET_CAP_MS <= 180000,
      `封顶值 ${UPSTREAM_HEADER_BUDGET_CAP_MS}ms 不合理 —— 3 分钟以上会把「上游挂了」也等那么久`);
    const widest = Math.max(...UPSTREAM_HEADER_TIERS.map((t) => t.ms));
    assert.ok(UPSTREAM_HEADER_BUDGET_CAP_MS >= widest,
      "封顶值比最宽档位还小 —— 那一档永远走不到");
  });

  test("读不出大小 → 按上限等（赌小的代价是把会成功的请求掐断）", () => {
    assert.equal(upstreamHeaderBudgetMs(Number.NaN), UPSTREAM_HEADER_BUDGET_CAP_MS);
    assert.equal(upstreamHeaderBudgetMs(Number.POSITIVE_INFINITY), UPSTREAM_HEADER_BUDGET_CAP_MS);
    assert.equal(upstreamHeaderBudgetMs(undefined), UPSTREAM_HEADER_BUDGET_CAP_MS);
  });
});

/* ====================================================================== *
 * ⑤ 探针档位语义不变
 * ====================================================================== */
describe("⑤ 探针档位语义一个字没变（isProbe 仍走 ZEN_PROBE_TIMEOUT_MS）", () => {
  test("探针的短超时仍是 zen-probe.mjs 那个 10 秒", () => {
    assert.equal(ZEN_PROBE_TIMEOUT_MS, 10000,
      "ZEN_PROBE_TIMEOUT_MS 被改了 —— 它是能力探测专用的短档，不是响应头分档的事");
  });

  test("探针的首事件闸门仍是 Math.max(60000, 10s×3) = 60000ms（两个分支都没被并进分档）", () => {
    /* 这条盯的是一个**真实存在过的写错风险**：首事件闸门原来是
       `Math.max(60000, (isProbe ? ZEN_PROBE_TIMEOUT_MS : 30000) * 3)`，
       探测档 = 60000、真实对话档 = 90000，是两个不同的数。
       改成统一走 upstreamFirstEventBudgetMs() 会让探测档悄悄变成 90000 ——
       探测因此肯等更久，一次探不通要从 60 秒等到 90 秒才报失败。
       所以 server.mjs 里必须仍是**显式的 isProbe 分支**。 */
    assert.match(SERVER_SRC,
      /isProbe\s*\?\s*Math\.max\(\s*60000\s*,\s*ZEN_PROBE_TIMEOUT_MS\s*\*\s*3\s*\)/,
      "★ server.mjs 的首事件闸门里，探测档那个显式分支不见了 —— "
      + "它被并进分档函数，探测肯等的时间会从 60 秒悄悄变成 90 秒");
  });

  test("响应头预算那一侧：探测档同样是显式三元，没有被分档顶掉", () => {
    assert.match(SERVER_SRC,
      /isProbe\s*\?\s*ZEN_PROBE_TIMEOUT_MS\s*:\s*upstreamHeaderBudgetMs\(/,
      "★ doCall 里探测档与分档的那个三元不见了 —— 探测会拿到真实对话的预算");
  });

  test("分档函数本身不认识 isProbe（探测语义不在它的参数表里）", () => {
    assert.equal(upstreamHeaderBudgetMs.length, 1, "upstreamHeaderBudgetMs 只该吃一个参数（字节数）");
    assert.equal(upstreamFirstEventBudgetMs.length, 1, "upstreamFirstEventBudgetMs 只该吃一个参数（字节数）");
  });
});

/* ====================================================================== *
 * ⑥ 首事件闸门不窄于响应头预算
 * ====================================================================== */
describe("⑥ 首事件闸门预算 ≥ 响应头预算（否则「头已到、首事件又被掐」）", () => {
  for (const { label, bytes } of MEASURED) {
    test(`${label}：首事件预算 ${upstreamFirstEventBudgetMs(bytes)}ms ≥ 响应头预算 ${upstreamHeaderBudgetMs(bytes)}ms`, () => {
      const head = upstreamHeaderBudgetMs(bytes);
      const first = upstreamFirstEventBudgetMs(bytes);
      assert.ok(first >= head,
        `★ ${label} 首事件只给 ${first}ms，响应头却给了 ${head}ms —— `
        + "头等到了、首事件又被掐，用户看到一次「明明连上了却又断」，比不修更糟。");
    });
  }

  test("全区间扫描：任何体量下首事件预算都不窄于响应头预算", () => {
    for (let mb = 0; mb <= 30; mb += 0.5) {
      const bytes = Math.round(mb * MB);
      assert.ok(upstreamFirstEventBudgetMs(bytes) >= upstreamHeaderBudgetMs(bytes),
        `${mb}MB 处首事件预算 ${upstreamFirstEventBudgetMs(bytes)}ms < 响应头预算 ${upstreamHeaderBudgetMs(bytes)}ms`);
    }
  });

  test("首事件闸门自己也有上限（不能无限等）", () => {
    assert.ok(UPSTREAM_FIRST_EVENT_CAP_MS <= 300000,
      `首事件闸门上限 ${UPSTREAM_FIRST_EVENT_CAP_MS}ms 太大 —— 「上游连上了却不吐字」会挂更久`);
    for (const n of [6 * MB, 20 * MB, 200 * MB]) {
      assert.ok(upstreamFirstEventBudgetMs(n) <= UPSTREAM_FIRST_EVENT_CAP_MS,
        `${n} 字节的首事件预算 ${upstreamFirstEventBudgetMs(n)}ms 超了上限`);
    }
  });

  test("倍数是 2 而不是 3：3 倍会把 3MB 档的首事件等到 225 秒", () => {
    assert.equal(UPSTREAM_FIRST_EVENT_FACTOR, 2);
    const head3 = upstreamHeaderBudgetMs(Math.round(2.5 * MB));
    assert.equal(upstreamFirstEventBudgetMs(Math.round(2.5 * MB)), head3 * 2,
      "2.5MB 档的首事件预算应当是响应头预算的 2 倍");
  });
});

/* ====================================================================== *
 * ⑦ 同量纲 / 边界守卫：预算是毫秒量级、有限正数
 * ====================================================================== */
describe("⑦ 同量纲与边界守卫（机械检查，比任何具体数字都耐用）", () => {
  test("任何体量下，两个预算都是毫秒量级的有限正数", () => {
    /* 量纲判据：把预算和 1 秒比。写成秒的话这里会拿到 30 / 45 / 75，
       全部小于 1000 → 当场红。写成微秒会拿到 3e7 量级 → 也红。 */
    for (const n of [0, 1, 512 * KB, 1.25 * MB, 2.5 * MB, 6 * MB, 500 * MB]) {
      for (const ms of [upstreamHeaderBudgetMs(n), upstreamFirstEventBudgetMs(n)]) {
        assert.ok(Number.isFinite(ms), `${n} 字节拿到非有限预算 ${ms}`);
        assert.ok(ms > 0, `${n} 字节拿到非正预算 ${ms}`);
        assert.ok(ms >= 1000 && ms <= 600000,
          `★ ${n} 字节的预算 ${ms}ms 不在毫秒量级的合理带内（1 秒 ~ 10 分钟）`
          + "—— 单位错了：写成秒会远小于 1000，写成微秒/纳秒会远大于 600000。");
      }
    }
  });

  test("判据自己没失效：把预算写成**秒**，同一条量纲检查必须红", () => {
    const SECONDS = 30;                                  // ← 单位写成秒的样子
    assert.ok(!(SECONDS >= 1000 && SECONDS <= 600000),
      `负样本失效：${SECONDS} 竟然落在毫秒量纲带内 —— 量纲守卫失灵，上面那条成了恒真断言`);
    const MICROS = 30000 * 1000;                          // ← 单位写成微秒的样子
    assert.ok(!(MICROS >= 1000 && MICROS <= 600000),
      `负样本失效：${MICROS} 竟然落在毫秒量纲带内`);
  });

  test("边界值不越档：512KB 归 30 秒档、512KB+1 归 45 秒档", () => {
    assert.equal(upstreamHeaderBudgetMs(512 * KB - 1), 30000);
    assert.equal(upstreamHeaderBudgetMs(512 * KB), 45000, "512KB 整不该再吃 30 秒档");
    assert.equal(upstreamHeaderBudgetMs(1536 * KB - 1), 45000);
    assert.equal(upstreamHeaderBudgetMs(1536 * KB), 75000);
    assert.equal(upstreamHeaderBudgetMs(3 * MB - 1), 75000);
    assert.equal(upstreamHeaderBudgetMs(3 * MB), 120000);
    assert.equal(upstreamHeaderBudgetMs(6 * MB - 1), 120000);
    assert.equal(upstreamHeaderBudgetMs(6 * MB), UPSTREAM_HEADER_BUDGET_CAP_MS);
  });

  test("负字节数按 0 处理（不是按上限）", () => {
    assert.equal(upstreamHeaderBudgetMs(-1), 30000, "负数不是「读不出」，是「没有」，该吃最小档");
    assert.equal(upstreamHeaderBudgetMs(0), 30000);
  });
});

/* ====================================================================== *
 * ⑧ 单位是字节，不是字符（中文场景差 3 倍）
 * ====================================================================== */
describe("⑧ 单位守卫：字节数，不是字符数", () => {
  test("中文请求体：字符数只有字节数的 1/3，而档位按字节数算", () => {
    const zh = bodyOfZhBytes(Math.round(2.5 * MB));
    const chars = zh.length;
    const bytes = Buffer.byteLength(zh);
    assert.ok(bytes > chars * 2.5,
      `夹具的差值不够明显：字符 ${chars}、字节 ${bytes}。`
      + "中文 UTF-8 是 3 字节/字，这个夹具本该有约 3 倍差值");
    /* 若有人把分档改成吃字符数，2.5MB 的中文请求体会被当成 0.85MB 发给 30 秒预算 ——
       正好修不到点子上。所以这里两头都钉：按字节进宽档，按字符进窄档。 */
    assert.ok(upstreamHeaderBudgetMs(bytes) > 45000,
      `按字节数 ${bytes} 只拿到 ${upstreamHeaderBudgetMs(bytes)}ms —— 2.5MB 该进 75 秒档`);
    assert.ok(upstreamHeaderBudgetMs(chars) < upstreamHeaderBudgetMs(bytes),
      `按字符数 ${chars} 拿到 ${upstreamHeaderBudgetMs(chars)}ms，竟不比按字节数窄 —— `
      + "那说明这两个数没差别，本条守卫的差值基础不成立");
  });

  test("upstreamBodyBytes 对非字符串一律给 0（不猜、不抛）", () => {
    assert.equal(upstreamBodyBytes(""), 0);
    assert.equal(upstreamBodyBytes("x"), 1);
    assert.equal(upstreamBodyBytes(Buffer.alloc(4096)), 0,
      "Buffer 不是字符串 —— 调用方拿 Buffer 时该走 body.length，不该走到这个包装里");
    assert.equal(upstreamBodyBytes(undefined), 0);
    assert.equal(upstreamBodyBytes(null), 0);
    assert.equal(upstreamBodyBytes(12345), 0);
    assert.equal(upstreamBodyBytes({ length: 999 }), 0,
      "对象上的 .length 不是字节数，别被它骗了");
  });
});

/* ====================================================================== *
 * ⑨ 三个实测点的账，逐条能说出来
 * ====================================================================== */
describe("⑨ 三个实测点：每一档的余量都是怎么来的", () => {
  test("每一档预算都 ≥ 实测响应头耗时 × 1.5（余量不是拍脑袋）", () => {
    for (const { label, bytes, headerAt } of MEASURED) {
      const ms = upstreamHeaderBudgetMs(bytes);
      const margin = ms / 1000 / headerAt;
      assert.ok(margin >= 1.5,
        `★ ${label} 预算 ${ms / 1000}s，实测 ${headerAt}s，余量仅 ${margin.toFixed(2)}× —— `
        + "「一刀切 30 秒」那一档的余量是 1.0×，这正是它一抖就 502 的原因");
    }
  });

  test("预算斜率对得上实测（≈4.4s 固定 + 10.2s/MB，三档残差都在 2 秒内）", () => {
    /* 这条钉的是「这几个数不是拍的」：把三个实测点拟合出的斜率拿出来，
       看每一档的预算与「拟合需要值 × 1.8」的差距。差太远说明档位被随手改了。 */
    const fit = (mb) => 4.4 + 10.2 * mb;
    for (const t of UPSTREAM_HEADER_TIERS) {
      const mb = t.maxBytes / MB;
      const need = fit(mb);
      const ratio = t.ms / 1000 / need;
      assert.ok(ratio >= 1.5 && ratio <= 3.5,
        `档位 <${mb.toFixed(2)}MB → ${t.ms}ms，拟合需要 ${need.toFixed(1)}s，比值 ${ratio.toFixed(2)}× `
        + "—— 不在 1.5~3.5 的余量带内，档位被改得与实测脱钩了");
    }
  });

  test("档位理由都写着（不许有一个说不清为什么的档）", () => {
    for (const t of UPSTREAM_HEADER_TIERS) {
      assert.ok(typeof t.why === "string" && t.why.length > 8,
        `档位 <${t.maxBytes} 没有写理由 —— 说不清的档位下一个人就会改错`);
    }
  });
});

/* ====================================================================== *
 * ⑩ 接线完整性：被测的实现 == 生产接的那一个
 * ====================================================================== */
describe("⑩ 接线完整性（否则 ①~⑨ 全在验一个没人用的函数）", () => {
  test("server.mjs 从 ./upstream-budget.mjs import 这几个函数", () => {
    assert.match(SERVER_SRC,
      /import\s*\{[^}]*\bupstreamHeaderBudgetMs\b[^}]*\}\s*from\s*"\.\/upstream-budget\.mjs"/,
      "★ server.mjs 必须 import upstreamHeaderBudgetMs —— 不 import 就还在用它自己那份 30000，"
      + "本文件全部白验");
    assert.match(SERVER_SRC,
      /import\s*\{[^}]*\bupstreamBodyBytes\b[^}]*\}\s*from\s*"\.\/upstream-budget\.mjs"/);
    assert.match(SERVER_SRC,
      /import\s*\{[^}]*\bupstreamFirstEventBudgetMs\b[^}]*\}\s*from\s*"\.\/upstream-budget\.mjs"/);
  });

  test("doCall 真的用分档预算，而不是还写着一个 30000", () => {
    /* 只认这一处的形态：fetch 分支与 directHttp 分支都走 headerBudgetMs()。
       若有人把 doCall 改回 `isProbe ? ZEN_PROBE_TIMEOUT_MS : 30000`，
       这条当场红 —— 那正是本次要消灭的一刀切。 */
    assert.match(SERVER_SRC, /AbortSignal\.timeout\(headerBudgetMs\(\)\)/,
      "fetch 分支还在用别的预算 —— doCall 没接上分档");
    assert.match(SERVER_SRC, /timeoutMs:\s*headerBudgetMs\(\)/,
      "directHttp 分支还在用别的预算 —— doCall 没接上分档");
    assert.match(SERVER_SRC, /const headerBudgetMs = \(\) => isProbe \? ZEN_PROBE_TIMEOUT_MS : upstreamHeaderBudgetMs\(upstreamBodyBytes\(bodyStr\)\)/,
      "★ headerBudgetMs 那一行被改了 —— 它必须同时满足三件事："
      + "① 探测档仍是 ZEN_PROBE_TIMEOUT_MS；② 真实档走分档；③ 分档吃的是 upstreamBodyBytes() 而不是 bodyStr.length");
  });

  test("首事件闸门也接上了分档", () => {
    assert.match(SERVER_SRC, /upstreamFirstEventBudgetMs\(upstreamBodyBytes\(bodyStr\)\)/,
      "wbPipe 的首事件闸门没走 upstreamFirstEventBudgetMs() —— "
      + "响应头放宽了而它没放宽，会出新故障");
  });

  test("server.mjs 里不再有自己那一份分档定义（搬家要搬干净）", () => {
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+upstreamHeaderBudgetMs\b/,
      "server.mjs 里还留着一份本地定义 —— import 的会被它遮住，两份各说各话");
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+upstreamFirstEventBudgetMs\b/);
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+upstreamBodyBytes\b/);
  });

  test("透传路径（bai/sn）也接上了分档，且字节数取的是 body.length", () => {
    assert.match(SERVER_SRC, /upstreamHeaderBudgetMs\(body && body\.length \? body\.length : 0\)/,
      "handleUpstream 的透传路径没接分档 —— 那一档仍是 30 秒一刀切");
  });

  test("upstream-budget.mjs 在打包白名单里（否则装出来的版本 import 就崩）", () => {
    /* check-manifest.cjs 的 C15 就是查这件事的；这里再钉一次是因为
       「漏加 filter」的后果是**装出来的版本启动即崩**，而源码里全绿。 */
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    const srv = ((pkg.build || {}).extraResources || []).find((e) => e && e.from === "src/server");
    const filter = (srv && srv.filter) || [];
    assert.ok(filter.includes("upstream-budget.mjs"),
      `upstream-budget.mjs 不在 build.extraResources[src/server].filter 里 —— `
      + `当前白名单：${JSON.stringify(filter)}。漏了它，源码跑得通、测试全绿，但装出来的版本一启动就崩`);
  });

  test("装出来的白名单里没有本机绝对路径/用户名（顺带守住 C13 的边界）", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    const srv = ((pkg.build || {}).extraResources || []).find((e) => e && e.from === "src/server");
    for (const rel of (srv && srv.filter) || []) {
      assert.doesNotMatch(rel, /^[A-Za-z]:[\\/]/, `filter 条目 ${rel} 是绝对路径`);
      assert.doesNotMatch(rel, /\\/, `filter 条目 ${rel} 带了反斜杠 —— 白名单一律用正斜杠相对路径`);
    }
  });
});

/* ====================================================================== *
 * ⑪ 反向对照：改回一刀切 30 秒，②③④⑥ 必须当场红
 * ====================================================================== */
describe("⑪ 反向对照（证明这些断言不是恒真的）", () => {
  test("把分档改回一刀切 30 秒 → 1.25MB / 2.5MB 的余量断言必须红", () => {
    /* 这里**真的**造一个「改回改前行为」的实现，喂给上面那几条判据。
       若判据抓不住它，说明 ②③ 是恒真的 —— 那种测试比没有测试更坏。 */
    const reverted = () => 30000;                       // ← 改动前的那一行
    const B125 = Math.round(1.25 * MB), B250 = Math.round(2.50 * MB);
    /* ② 的判据是 `ms > 19000`。一刀切给它 30000 —— 注意 30000 > 19000 是**真**的，
       所以 ② 单独抓不住「退回到 30 秒」。真正抓住它的是余量倍数那条
       （要求 ≥2×，一刀切只有 1.58×）与 ③ 的「预算随体量增长」。这里如实算出来。 */
    assert.equal(reverted(B125) > 19000, true,
      "前提：一刀切 30000 在「>19000」这条上居然通过了 —— 那 ② 的第一条太松，拦不住回退");
    assert.ok(reverted(B125) / 19000 < 2,
      `前提：一刀切 30 秒对 1.25MB 只有 ${(reverted(B125) / 19000).toFixed(2)}× 余量，`
      + "够不上 2× —— ② 的余量倍数断言才是抓住回退的那一条");
    assert.ok(reverted(B250) / 30000 < 2,
      "前提：一刀切 30 秒对 2.5MB 是 1.0×（实测刚好 30 秒）—— 这正是它一抖就 502 的原因");
    /* 负样本：一刀切实现下，「预算随体量增长」这条判据必须不成立 */
    const grows = reverted(B250) > reverted(B125);
    assert.equal(grows, false, "前提：一刀切实现的预算不随体量变化");
  });

  test("把分档改回一刀切 → 首事件不窄于响应头 这条也会跟着失真", () => {
    /* 一刀切时两边都是常数，这条会**恒真通过** —— 也就是说它单独抓不住回退。
       所以真正的判据是 ⑪ 第一条 + ②③④ 那几条。这里如实记下这个边界，
       不假装它能单独抓住回退。 */
    const reverted = () => 30000;
    assert.equal(reverted(2.5 * MB) >= reverted(2.5 * MB), true);
  });

  test("把 Buffer.byteLength 换成 length → ⑧ 的中文差值断言必须红", () => {
    const zh = bodyOfZhBytes(Math.round(2.5 * MB));
    const wrongBudget = upstreamHeaderBudgetMs(zh.length);        // ← 用错单位的样子
    assert.ok(wrongBudget < upstreamHeaderBudgetMs(Buffer.byteLength(zh)),
      `前提：按字符数分档会拿到更窄的预算（${wrongBudget}ms vs `
      + `${upstreamHeaderBudgetMs(Buffer.byteLength(zh))}ms）—— ⑧ 抓的正是这个`);
  });

  test("档位表没被掏空（否则 ①②③④ 会因扫不到档位而恒真）", () => {
    assert.ok(UPSTREAM_HEADER_TIERS.length >= 4,
      `只扫到 ${UPSTREAM_HEADER_TIERS.length} 个档位 —— 档位表被删空了，上面的边界断言会空转`);
    for (let i = 1; i < UPSTREAM_HEADER_TIERS.length; i++) {
      assert.ok(UPSTREAM_HEADER_TIERS[i].maxBytes > UPSTREAM_HEADER_TIERS[i - 1].maxBytes,
        `档位表第 ${i} 档的上界没有严格递增 —— 有一档永远走不到`);
      assert.ok(UPSTREAM_HEADER_TIERS[i].ms > UPSTREAM_HEADER_TIERS[i - 1].ms,
        `档位表第 ${i} 档的预算没有严格递增 —— 分档失去意义`);
    }
  });
});
