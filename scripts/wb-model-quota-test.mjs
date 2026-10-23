/**
 * scripts/wb-model-quota-test.mjs —— 「额度」屏上**模型级**那一块的判定与反向对照
 *
 * ## 这一块回答什么
 *
 * 「**这一家当前档位那个模型**怎么样」—— 它的积分倍率、此刻能不能用。
 * 它与「额度」屏上面那张**渠道级**的表（各家一共还剩多少）**分开摆**：
 * 含义不同的两个数不能共用一格（改版原则 1：状态是数据，不是装饰）。
 *
 * ## 两种状态，两个口径
 *
 *   · **走过这一家** ⇒ 显示**「当前」**那一行：此刻真实在服务的那一档。
 *   · **没走过这一家** ⇒ 显示**「配置」**的那几行：你映射表里写的每一档，
 *     外加一句**带下一步**的提示（未知态不带下一步就是死胡同）。
 *
 * ⚠ 「配的」与「正在服务的」**不是一回事**，不许混成一个说法：
 *   配的 = `cfg[渠道].mapping`（用户写的意图）；
 *   正在服务的 = `/api/status` 的 `recent.served`（真实发生过的）。
 *
 * ## 为什么它要自己一个测试文件
 *
 * 这一块的口径全是**判定**：倍率怎么归一、免费怎么判、「当前」对应哪个模型、
 * 「配的档位」怎么摆、目录读不到时该显示什么。每一处都会改掉用户看到的数：
 *
 *   · 把「x0.00」判成收费 → 用户以为要花钱，换错档位；
 *   · 把「倍率未知」显示成 0 → 0 会被读成「这款模型不扣积分」（其实免费档恰恰是 x0.00）；
 *   · 倍率取成了目录里**另一个**模型 → 显示一个看着很真的假数；
 *   · 没走过时只说「不知道」不给下一步 → 死胡同，用户不知道该做什么。
 *
 * 没有测试的判定迟早被改坏，而改坏之后面板上仍然「有模有样」——
 * 那比 plainly 坏掉更坏。
 *
 * ## 反向对照
 *
 * 每一处判定都有一个「把它改坏，对应断言必须**真的会红**」的对照。
 * 不会红的断言等于没写 —— 所以对照不是走过场，是把断言的分辨力钉住。
 *
 * ## 红线
 *
 * 夹具里只有**假渠道 key**（alpha/beta）与**假令牌形状**，不碰真实配置；
 * 不落盘（本文件不写任何文件），不碰 %APPDATA% 与 ~/.claude。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARD = path.join(ROOT, "src", "server", "cards", "quota-panel.js");
const CARD_SRC = readFileSync(CARD, "utf8");

/* ⚠ 假渠道 key —— 这一层自己也要守 C11（不许用真渠道名）。 */
const K1 = "alpha";
const K2 = "beta";

const TIER_ZH = { "claude-sonnet-5": "Sonnet", "claude-opus-5": "Opus", "claude-fable-5": "Fable" };

/* ====================================================================== *
 * 工具
 * ====================================================================== */

/** 在 vm 里求值这张卡（不碰真实 DOM、不发网络）。 */
function loadCard(src, extra) {
  const ctx = Object.assign({ window: {} }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(src === undefined ? CARD_SRC : src, ctx, { filename: "quota-panel.js" });
  const mod = ctx.window.BAI_CARDS && ctx.window.BAI_CARDS["quota-panel"];
  assert.ok(mod, "卡片必须导出 window.BAI_CARDS[\"quota-panel\"]");
  return mod;
}

/**
 * 改坏一份源码。
 *
 * ⚠ **锚点必须真的在源码里**（改不到就当场炸）—— 否则「改坏」这一步悄悄没生效，
 *   后面的「断言会红」就成了自欺欺人。
 */
function mutantSrc(replacements) {
  let src = CARD_SRC;
  for (const [from, to] of replacements) {
    assert.ok(src.includes(from), `锚点不在源码里，改坏这一步没生效：${from.slice(0, 70)}`);
    src = src.replace(from, to);
  }
  return src;
}

/** 改坏一份源码再求值。 */
function mutant(replacements) {
  return loadCard(mutantSrc(replacements));
}

/** 断言「这个改坏的实现**不**满足预期」—— 即正常实现下那条断言真的会红。 */
async function assertRed(card, check, why) {
  let threw = false;
  try { await check(card); } catch { threw = true; }
  assert.equal(threw, true, why);
}

/** 剥掉注释（判「源码里有没有渠道名字面量」时用：注释里的举例不算）。 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/** 取第一行 <tr> 的第 n 个 <td> 的内容（n 从 0 起）。 */
function tdOf(html, n) {
  const tb = html.indexOf("<tbody>");
  const tr = html.indexOf("<tr>", tb);
  const end = html.indexOf("</tr>", tr);
  if (tr < 0 || end < 0) return "";
  const row = html.slice(tr, end);
  const tds = row.split("<td>").slice(1).map((s) => s.split("</td>")[0]);
  return tds[n] == null ? "" : tds[n];
}

/** 所有 <tr> 的 <td> 内容（一行一组）。 */
function rowsOf(html) {
  const out = [];
  const tb = html.indexOf("<tbody>");
  let at = tb;
  for (;;) {
    const tr = html.indexOf("<tr>", at);
    if (tr < 0) break;
    const end = html.indexOf("</tr>", tr);
    if (end < 0) break;
    const row = html.slice(tr, end);
    out.push(row.split("<td").slice(1).map((s) => s.split("</td>")[0]));
    at = end + 5;
  }
  return out;
}

/** 一段 HTML 里的表头文字（渲染出来的表格用这个判）。 */
function thOf(html) {
  const out = [];
  for (const m of String(html).matchAll(/<th[^>]*>([^<]+)<\/th>/g)) out.push(m[1].trim());
  return out;
}

/* ====================================================================== *
 * 夹具
 * ====================================================================== */

/** 一份「当前档位 = sonnet 档、正在服务 hy4-preview-f」的账号池状态。 */
function poolSlice(over) {
  const base = {
    recent: {
      tier: "claude-sonnet-5", label: "Hy4-Preview-F",
      target: "hy4-preview-f", served: "hy4-preview-f",
      observedAt: "2026-10-23T00:00:00.000Z", mismatch: false,
    },
    pool: {
      total: 2,
      accounts: [
        { id: "a1", label: "号一", available: true, coolingModels: [] },
        { id: "a2", label: "号二", available: true, coolingModels: [] },
      ],
    },
  };
  return Object.assign(base, over || {});
}

/** 走过这一家、但**只走了一档**（其余档位是配好的、没在用）。 */
function noTrafficSlice() {
  const s = poolSlice();
  s.recent = { tier: null };
  return s;
}

/* ⚠ 目录里**第一条不是**要查的那个模型 —— 这样「取错模型」这件事才有分辨力。 */
const CATALOG = {
  ok: true, source: "live", catalogAt: "2026-10-23T00:00:00.000Z",
  /* ⚠ 目录是**某一个账号**的权限事实：多账号时各号可见的倍率可能不同。 */
  sourceAccount: { fp: "0123456789abcdef", label: "号一", synthetic: false },
  all: [
    { key: "hy3", name: "HY3", credits: "x0.00", free: true },
    { key: "hy4-preview-f", name: "Hy4-Preview-F", credits: "x0.29", free: false },
  ],
};

/** 一份映射表（用户配的「每档指向哪个模型」）。 */
const CFG_FIX = {
  mapping: {
    "claude-fable-5": { target: "hy3", label: "HY3" },
    "claude-sonnet-5": { target: "hy4-preview-f", label: "Hy4-Preview-F" },
    "claude-opus-5": { target: "hy3", label: "HY3" },
  },
};

const ESC = (s) => String(s == null ? "" : s);

/* ====================================================================== *
 * ① 倍率口径
 * ====================================================================== */

function checkCredits(card) {
  const a = card.modelCredits({ credits: "x0.00 credits", free: true });
  assert.equal(a.credits, "x0.00", "'x0.00 credits' 要剥掉 ' credits' 后缀");
  assert.equal(a.free, true, "★ 免费档就是 x0.00（判错＝把「不扣积分」说成「要花钱」）");
  assert.equal(a.known, true);

  const b = card.modelCredits({ credits: "x0.34 credits", free: false });
  assert.equal(b.credits, "x0.34", "'x0.34 credits' 要剥掉后缀");
  assert.equal(b.free, false, "x0.34 不是免费");
  assert.equal(b.known, true);

  const c = card.modelCredits({ credits: "x0.00" });
  assert.equal(c.free, true, "★ 没给 free 标志时也要自己判出 x0.00 是免费");

  const d = card.modelCredits({ credits: "x0.29" });
  assert.equal(d.free, false, "x0.29 不是免费");
  assert.equal(d.credits, "x0.29");

  const e = card.modelCredits({ credits: "" });
  assert.equal(e.known, false, "★ 空倍率 = 不知道");
  assert.equal(e.credits, null, "★ 空倍率不是 0（0 会被读成「不扣积分」）");

  const f = card.modelCredits(null);
  assert.equal(f.known, false, "没有这条记录 = 不知道");
  assert.equal(f.credits, null);
}

/* ====================================================================== *
 * ② 走过这一家 —— 显示「当前」那一行
 * ====================================================================== */

function checkCurrent(card) {
  const g = card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH,
    slice: poolSlice(), cfg: CFG_FIX,
    catalog: { loading: false, err: "", data: CATALOG },
  });
  assert.equal(g.hasCurrent, true, "走过这一家 ⇒ 有「当前」那一档");
  assert.equal(g.rows.length, 1, "★ 走过这一家只显示当前那一行（不是把配的档位也铺开）");
  const r = g.rows[0];
  assert.equal(r.kind, "current", "★ 这一行的口径是「当前」（正在服务的）");
  assert.equal(r.tier, "claude-sonnet-5", "当前档位取服务端 recent.tier");
  assert.equal(r.tierLabel, "Sonnet", "档位显示名走 TIER_ZH");
  assert.equal(r.model, "hy4-preview-f", "档位模型 = 正在服务的那个模型");
  assert.equal(r.credits, "x0.29", "★ 倍率取**这个模型**的，不是目录里第一条");
  assert.equal(r.creditsKnown, true);
  assert.equal(r.free, false);
  assert.equal(r.usable, true, "池里有一个可用账号就算可用");
  assert.equal(r.modelName, "Hy4-Preview-F", "★ 模型显示名要写清");
  assert.equal(g.summary, "", "有当前档位时不需要那句提示");

  /* 服务过的与打算路由的不一致 ⇒ 两个都要报出来。 */
  const mism = poolSlice();
  mism.recent = Object.assign({}, mism.recent, { served: "hy3", target: "hy4-preview-f", mismatch: true });
  const mm = card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH, slice: mism, cfg: CFG_FIX,
    catalog: { loading: false, err: "", data: CATALOG },
  });
  assert.equal(mm.rows[0].model, "hy3", "★ 真实服务的那个模型才是正在消耗额度的那个");
  assert.equal(mm.rows[0].credits, "x0.00", "倍率跟着**真正在用**的那个模型走");
  assert.equal(mm.rows[0].mismatch, true, "不一致要报出来（以为在用 A 其实在用 B）");
}

/* ====================================================================== *
 * ②b 没走过这一家 —— 显示「配的档位」+ 带下一步的提示
 * ====================================================================== */

function checkConfigured(card) {
  const g = card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH,
    slice: noTrafficSlice(), cfg: CFG_FIX,
    catalog: { loading: false, err: "", data: CATALOG },
  });
  assert.equal(g.hasCurrent, false, "没走过 ⇒ 没有「当前」那一档");
  assert.equal(g.noTraffic, true);
  /* ★ **提示必须带下一步**：只说「不知道」是死胡同。 */
  assert.ok(g.summary.indexOf("没有正在服务的模型") >= 0,
    "★ 提示要说清「此刻没有正在服务的模型」");
  assert.ok(g.summary.indexOf("走过这一家") >= 0,
    "★ 提示必须给下一步（走过这一家 / 点「测试连通」）");
  assert.ok(g.summary.indexOf("测试连通") >= 0, "下一步要具体到能执行的动作");

  assert.equal(g.rows.length, 3, "★ 配了几档就摆几行");
  for (const r of g.rows) {
    assert.equal(r.kind, "configured", "★ 配的档位这一行的口径是「配置」");
  }
  const fable = g.rows[0];
  assert.equal(fable.tier, "claude-fable-5", "配的档位逐个摆出来");
  assert.equal(fable.tierLabel, "Fable");
  assert.equal(fable.model, "hy3", "配的档位指向哪个模型");
  assert.equal(fable.credits, "x0.00", "★ 配的档位也要带那个模型的倍率");
  assert.equal(fable.free, true, "免费档要认出来");
  const opus = g.rows[2];
  assert.equal(opus.tier, "claude-opus-5");
  assert.equal(opus.model, "hy3");
  assert.equal(opus.credits, "x0.00");

  /* 连映射表都没配 ⇒ 提示换一句（还是要有下一步）。 */
  const bare = card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH,
    slice: noTrafficSlice(), cfg: {},
    catalog: { loading: false, err: "", data: CATALOG },
  });
  assert.equal(bare.rows.length, 0, "没配映射表 ⇒ 没有配置档位那几行");
  assert.ok(bare.summary.indexOf("映射表") >= 0, "要说清缺的是映射表");
  assert.ok(bare.summary.indexOf("渠道") >= 0, "下一步要指到能配的地方");

  /* 目录退化成兜底（名字就是 id）⇒ 用用户在映射表里起的那个名字。 */
  const flat = { ok: true, source: "builtin", all: [{ key: "hy3", name: "hy3", credits: null, free: false }] };
  const g2 = card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH, slice: noTrafficSlice(), cfg: CFG_FIX,
    catalog: { loading: false, err: "", data: flat },
  });
  assert.equal(g2.rows[0].modelName, "HY3",
    "★ 兜底目录（名字就是 id）时用映射表里起的名字，别把 id 显示两遍");
  assert.equal(g2.rows[0].creditsKnown, false, "兜底目录没有倍率 ⇒ 说「不知道」，不是 0");
}

/* ====================================================================== *
 * ③ 模型级冷却
 * ====================================================================== */

function checkCooling(card) {
  const slice = poolSlice();
  slice.pool.accounts[1].coolingModels = ["hy4-preview-f"];
  const g = card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH, slice, cfg: CFG_FIX,
    catalog: { loading: false, err: "", data: CATALOG },
  });
  assert.equal(g.rows[0].cooling, true, "★ 这个模型在某个账号上冷却 ⇒ 模型级冷却");
  assert.equal(g.rows[0].coolingAccounts.length, 1, "要说清是哪个号");
  assert.equal(g.rows[0].usable, true, "★ 整号仍可用 —— 模型级冷却不等于这家不可用");

  const other = card.modelCooling({ accounts: [{ id: "a1", coolingModels: ["别的模型"] }] }, "hy4-preview-f");
  assert.equal(other.cooling, false, "别的模型在冷却不算这个模型在冷却");
  const none = card.modelCooling(null, "hy4-preview-f");
  assert.equal(none.cooling, false, "没有池子 = 没有冷却");
}

/* ====================================================================== *
 * ④ 渲染 —— 两种状态各长什么样
 * ====================================================================== */

function checkRender(card) {
  /* ── 走过这一家 ── */
  const cur = card.renderModelQuota([card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH, slice: poolSlice(), cfg: CFG_FIX,
    catalog: { loading: false, err: "", data: CATALOG },
  })], ESC, null);
  assert.ok(cur.indexOf("模型级额度") >= 0, "这一块有自己的标题（不是混在渠道级那张表里）");
  assert.ok(thOf(cur).includes("档位"), "第二列说清是档位");
  assert.ok(thOf(cur).includes("指向的模型"), "★ 模型名那一列写清");
  assert.ok(thOf(cur).includes("积分倍率"), "列名说清是倍率（不是余额）");
  assert.ok(cur.indexOf("Sonnet") >= 0, "档位显示名要显示出来");
  assert.ok(cur.indexOf("Hy4-Preview-F") >= 0, "★ 模型显示名要显示出来");
  assert.ok(cur.indexOf("x0.29") >= 0, "倍率要显示出来");
  assert.ok(cur.indexOf("当前") >= 0, "★ 这一行的口径标成「当前」");
  assert.ok(cur.indexOf(">配置<") < 0, "走过这一家时不该出现「配置」那几行");
  /* ⚠ 判据落在**表头**上，不是整段 HTML：说明文字里提到「上游余额」是为了
   *   说清两张表的区别，那是对的；混进**列**里才是错配。 */
  assert.ok(!thOf(cur).includes("上游余额"), "★ 这一块的表头里不许有「上游余额」——那是渠道级的列");
  assert.ok(cur.indexOf("渠道级") >= 0, "要说清与上面那张表的区别");
  /* ⚠ 说明文字是**纯文本**：里面写 markdown 的 ** 只会原样印出来（不会变粗体）。 */
  assert.ok(cur.indexOf("**") < 0, "★ 说明文字里不许漏出 markdown 的 **（纯文本不会渲染它）");
  /* 倍率的出处要能说清是哪个账号的目录。 */
  assert.ok(cur.indexOf("号一") >= 0, "★ 倍率的出处要能说清是哪个账号的目录");
  assert.ok(cur.indexOf("实时抓的") >= 0, "出处还要说清是不是实时抓的");

  /* ── 没走过这一家 ── */
  const cfgd = card.renderModelQuota([card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH, slice: noTrafficSlice(), cfg: CFG_FIX,
    catalog: { loading: false, err: "", data: CATALOG },
  })], ESC, null);
  assert.ok(cfgd.indexOf("没有正在服务的模型") >= 0, "★ 提示行说清此刻没有正在服务的模型");
  assert.ok(cfgd.indexOf("走过这一家") >= 0, "★ 提示行给了下一步");
  assert.ok(cfgd.indexOf("配置") >= 0, "配的档位那几行的口径标成「配置」");
  assert.ok(cfgd.indexOf("HY3") >= 0, "★ 配的档位指向的模型要摆出来");
  assert.ok(cfgd.indexOf("x0.00") >= 0, "★ 配的档位那个模型的倍率也要摆出来");
  assert.ok(cfgd.indexOf("免费") >= 0, "免费档要写出来");
  assert.ok(cfgd.indexOf(">当前<") < 0, "没走过这一家时不该出现「当前」那一行");
  assert.ok(cfgd.indexOf("这一档还没在用") >= 0, "配的档位那几行说清「还没在用」");
  assert.ok(cfgd.indexOf("可用") < 0, "★ 配的档位那几行不许说「可用」（它压根没在用）");

  /* 没有组 ⇒ 整块不画（画一条空条会被读成「它在跑」）。 */
  assert.equal(card.renderModelQuota([], ESC, null), "", "没有带账号池的渠道 ⇒ 整块不画");
  assert.equal(card.renderModelQuota(null, ESC, null), "", "同上");

  /* 目录读不到 ⇒ 「倍率未知」，绝不能显示成 0。 */
  const unknown = card.renderModelQuota([card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH, slice: poolSlice(), cfg: CFG_FIX,
    catalog: { loading: false, err: "读不到目录", data: null },
  })], ESC, null);
  const ucell = tdOf(unknown, 3);
  assert.ok(ucell.indexOf("倍率未知") >= 0, "★ 读不到目录要说「倍率未知」");
  assert.ok(ucell.indexOf("x0") < 0, "★ 读不到倍率时那一格绝不能出现 x0（会被读成免费/0）");
  assert.ok(ucell.indexOf("读目录中") < 0, "读完了就不该还说「读目录中」");

  /* 目录还在读 ⇒ 说「读目录中…」。 */
  const loading = card.renderModelQuota([card.modelQuotaRows({
    key: K1, name: "假渠道一", tierZh: TIER_ZH, slice: poolSlice(), cfg: CFG_FIX,
    catalog: { loading: true, err: "", data: null },
  })], ESC, null);
  assert.ok(tdOf(loading, 3).indexOf("读目录中") >= 0, "目录还在读要说「读目录中…」");
}

/* ====================================================================== *
 * ⑤ 挂载 —— 真的画出来，且目录**只取一次**
 * ====================================================================== */

/**
 * 最小 DOM 垫片：这一张卡只用到「造一个容器 + 按 data-role 找到那块 + 读 innerHTML」。
 * 不用真 DOM，也不用整套解析器 —— 把**写进去的 HTML 记下来**就够了。
 */
function miniNode(sel, bag) {
  const n = {
    _sel: sel, innerHTML: "", textContent: "", className: "", id: "",
    children: [], parentNode: null, style: {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    closest() { return null; },
    /* 同一个选择器必须回到**同一个**节点 —— 否则卡片写进去的 HTML 会散在
       好几个临时节点上，断言就落空了。 */
    querySelector(s) {
      const hit = bag.find((x) => x._sel === s);
      return hit || miniNode(s, bag);
    },
  };
  bag.push(n);
  return n;
}

/** 装一张卡，喂一份假状态，返回 {view, calls, find}。 */
async function mountCard(apiMock, status, src) {
  const bag = [];
  const calls = [];
  const doc = { createElement: (t) => miniNode("new:" + t, bag) };
  const slot = miniNode("slot", bag);
  const ctx = {
    $: () => null,
    slot,
    esc: ESC,
    api: async (p, o) => { calls.push({ path: p, opts: o || {} }); return apiMock(p, o); },
    channels: [K1, K2],
    nameOf: (k) => "假渠道" + k,
    stOf: (k) => (status && status[k]) || {},
    cfgOf: (k) => (k === K1 ? CFG_FIX : {}),
    TIER_ZH,
    channelState: () => ({ s: "ok", txt: "可用" }),
    CATALOG_TIMEOUT_MS: 60000,
  };
  /* ⚠ 卡片必须在**带 document 的上下文**里求值：mount() 会 document.createElement。
   *   所以这里收的是**源码**（改坏的那一份也走这条路），不是已求值的卡对象。 */
  const mod = loadCard(src, { document: doc });
  const view = mod.mount(ctx);
  await new Promise((r) => setTimeout(r, 5));
  const find = (sel) => bag.find((n) => n._sel === sel) || null;
  return { view, calls, find, bag };
}

const STATUS_FIX = {
  [K1]: poolSlice(),
  /* K2 **有**账号池，但每个号都没填令牌 ⇒ 那一行全是空话，不该画。 */
  [K2]: {
    recent: { tier: null },
    pool: {
      total: 1,
      accounts: [{ id: "b1", label: "没令牌的号", available: false, reason: "no_token", coolingModels: [] }],
    },
  },
};

function apiFixture(p) {
  /* ⚠ 渠道级那一份要给**一行** —— providers 为空时走的是空态，
   *   渠道级那张表的表头根本不会出现，「两张表不许混列」那条断言就成了空话。 */
  if (p === "/api/quota/overview") {
    return {
      ok: true,
      providers: [{
        key: K1, name: "假渠道一",
        budget: null, cost: null,
        probe: { known: false, used: null, limit: null, error: "探不到" },
        resting: false, restUntil: 0, cooling: false,
      }],
    };
  }
  if (p === "/api/models?p=" + K1) return CATALOG;
  return { ok: true };
}

async function checkMounted(src) {
  const { view, calls, find } = await mountCard(apiFixture, STATUS_FIX, src);
  const model = find('[data-role="qov-model"]');
  const body = find('[data-role="qov-body"]');
  assert.ok(model, "要有模型级那一块的落点");

  /* 面板挂载后第一轮轮询：目录是在这时候才去取的（不跟挂载抢）。 */
  await view.update();
  await new Promise((r) => setTimeout(r, 5));

  assert.ok(model.innerHTML.indexOf("模型级额度") >= 0, "★ 挂载后那一块真的画出来了");
  assert.ok(model.innerHTML.indexOf("Hy4-Preview-F") >= 0, "★ 模型名写在那块里");
  assert.ok(model.innerHTML.indexOf("x0.29") >= 0, "★ 倍率写在那块里");

  /* ★ 分开摆：渠道级那张表里不许出现模型级的列，反之亦然。 */
  assert.ok(body.innerHTML.indexOf("积分倍率") < 0, "★ 渠道级那张表里不许混进模型级的列");
  assert.ok(body.innerHTML.indexOf("指向的模型") < 0, "★ 渠道级那张表里不许混进模型级的列");
  assert.ok(!thOf(model.innerHTML).includes("上游余额"), "★ 模型级那一块里不许混进渠道级的列");

  /* 目录只取一次：轮询几轮也不该多打上游。 */
  const catCalls = () => calls.filter((c) => c.path.indexOf("/api/models") === 0).length;
  assert.equal(catCalls(), 1, "★ 目录要取一次");
  for (let i = 0; i < 3; i++) await view.update();
  assert.equal(catCalls(), 1, "★ 每 5 秒轮询不该多打上游（目录只取一次）");
  assert.equal(calls.filter((c) => c.path === "/api/quota/overview").length, 5,
    "渠道级那一份照旧每轮读一次（挂载那一次 + 四轮轮询）");

  /* 没账号池、或者池子里全是没填令牌的号 ⇒ 不画行。 */
  assert.ok(model.innerHTML.indexOf("假渠道alpha") >= 0, "★ 在用的渠道要画行");
  assert.ok(model.innerHTML.indexOf("假渠道beta") < 0, "★ 没填令牌的渠道不画行");
}

/* ====================================================================== *
 * ⑥ 纪律
 * ====================================================================== */

function checkSeparation(src) {
  const s = src === undefined ? CARD_SRC : src;
  const chan = tableHeaders(s, "预算上限");
  const model = tableHeaders(s, "积分倍率");
  assert.ok(chan.length >= 6, "渠道级那张表要有六列");
  assert.ok(model.length >= 5, "模型级那一块要有五列");
  for (const h of model) {
    if (h === "渠道") continue;               /* 「渠道」这一列两边都该有 */
    assert.ok(!chan.includes(h), `★ 「${h}」不能同时出现在两张表里 —— 含义不同的两个数不能共用一格`);
  }
}

/**
 * 某张表的表头。**按表头文字认表**，不按位置 ——
 * 按位置认的话，改一处列宽就会认错表，这道判据就成了空话。
 */
function tableHeaders(src, mustContain) {
  for (const m of String(src).matchAll(/<thead>([\s\S]*?)<\/thead>/g)) {
    if (m[1].indexOf(mustContain) < 0) continue;
    const out = [];
    for (const h of m[1].matchAll(/<th[^>]*>([^<]+)<\/th>/g)) out.push(h[1].trim());
    return out;
  }
  return [];
}

/* ====================================================================== *
 * 测试
 * ====================================================================== */

describe("① 倍率口径 —— 归一与免费判定", () => {
  test("① 倍率归一 + x0.00 判成免费 + 空倍率判成「不知道」", () => {
    checkCredits(loadCard());
  });
});

describe("② 走过这一家 —— 「当前」那一行", () => {
  test("② 当前档位取服务端 recent、模型取正在服务的那一个、倍率跟着它走", () => {
    checkCurrent(loadCard());
  });
});

describe("②b 没走过这一家 —— 「配的档位」+ 带下一步的提示", () => {
  test("②b 配的档位逐个摆出来，各带那个模型的倍率；提示必须给下一步", () => {
    checkConfigured(loadCard());
  });
});

describe("③ 模型级冷却", () => {
  test("③ 这个模型在冷却就说这个模型在冷却（整号仍可用）", () => {
    checkCooling(loadCard());
  });
});

describe("④ 渲染 —— 两种状态各长什么样", () => {
  test("④ 走过：当前那一行；没走过：提示行 + 配置那几行", () => {
    checkRender(loadCard());
  });
});

describe("⑤ 挂载 —— 真的画出来，且目录只取一次", () => {
  test("⑤ 挂载后模型级那一块有内容；轮询几轮不多打上游", async () => {
    await checkMounted(undefined);
  });
});

describe("⑥ 纪律", () => {
  test("⑥a 卡片里不许出现渠道名字面量（C11）", () => {
    const code = stripComments(CARD_SRC);
    for (const key of ["bai", "sn", "wb", "wbai", "zen", "qd", "or", "mm"]) {
      const rx = new RegExp(`["']${key}["']`);
      assert.ok(!rx.test(code), `卡片里出现了渠道名字面量 "${key}" —— 显示名必须走 ctx.nameOf(key)`);
    }
  });
  test("⑥b 卡片只用语义类名，不许写死色值", () => {
    const code = stripComments(CARD_SRC);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), "卡片里写了十六进制色值");
    assert.ok(!/\brgba?\s*\(/.test(code), "卡片里写了 rgb() 色值");
    assert.ok(!/\bhsla?\s*\(/.test(code), "卡片里写了 hsl() 色值");
  });
  test("⑥c 行尾必须是 LF（按文本锚点抠源码的测试会被 CRLF 弄崩）", () => {
    assert.ok(!CARD_SRC.includes("\r"), "卡片里有 CRLF");
  });
  test("⑥d 卡片注册名与文件名一致", () => {
    assert.ok(/window\.BAI_CARDS\s*=\s*window\.BAI_CARDS\s*\|\|\s*\{\}/.test(CARD_SRC));
    assert.ok(/window\.BAI_CARDS\["quota-panel"\]/.test(CARD_SRC));
  });
  test("⑥e 目录那一读要走目录专属的读预算（不能靠 api() 的默认 12 秒）", () => {
    assert.ok(/ctx\.api\("\/api\/models\?p=" \+ encodeURIComponent\(key\), \{ timeoutMs: ctx\.CATALOG_TIMEOUT_MS \}\)/.test(CARD_SRC),
      "★ /api/models 最坏 45 秒 —— 必须给目录专属的读预算");
  });
});

/* ====================================================================== *
 * ⑦ 反向对照：把实现改坏，对应断言必须**真的会红**
 * ====================================================================== */

describe("⑦ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑦a 把免费判定改坏（x0.00 不再判成免费）⇒ ① 会红", async () => {
    const card = mutant([
      [
        "const free = e.free === true ? true : (e.free === false ? false : /^x?0\\.0+$/.test(s));",
        "const free = e.free === true ? true : (e.free === false ? false : false);",
      ],
    ]);
    await assertRed(card, checkCredits, "免费判定改坏后 ① 必须红");
  });

  test("⑦b 把「剥掉 credits 后缀」改坏 ⇒ ① 会红", async () => {
    const card = mutant([
      [
        'const s = raw.trim().replace(/\\s*credits\\s*$/i, "").trim();',
        'const s = raw.trim();',
      ],
    ]);
    await assertRed(card, checkCredits, "后缀没剥掉时 ① 必须红");
  });

  test("⑦c 把「正在服务的那个模型」改成「打算路由的那个」⇒ ② 会红", async () => {
    const card = mutant([["const live = served || target;", "const live = target || served;"]]);
    await assertRed(card, checkCurrent, "取错模型后 ② 必须红");
  });

  test("⑦d 把「取这个模型的倍率」改成「取目录第一条」⇒ ② 会红", async () => {
    const card = mutant([
      [
        'const entry = id ? (all.find((m) => m && String(m.key) === id) || null) : null;',
        "const entry = id ? (all[0] || null) : null;",
      ],
    ]);
    await assertRed(card, checkCurrent, "取错倍率后 ② 必须红");
  });

  test("⑦e 把「没走过这一家」判成「走过」⇒ ②b 会红", async () => {
    const card = mutant([["noTraffic: !tier,", "noTraffic: false,"]]);
    await assertRed(card, checkConfigured, "「没走过」判坏后 ②b 必须红");
  });

  test("⑦f 把模型级冷却判坏（谁在冷却都不算）⇒ ③ 会红", async () => {
    const card = mutant([
      ['if (list.some((m) => String(m) === id)) hit.push', 'if (list.some((m) => String(m) === "__never__")) hit.push'],
    ]);
    await assertRed(card, checkCooling, "冷却判定改坏后 ③ 必须红");
  });

  test("⑦g 把「倍率未知」显示成 0 ⇒ ④ 会红", async () => {
    const card = mutant([[">倍率未知</span>", ">0</span>"]]);
    await assertRed(card, checkRender, "把「不知道」显示成 0 后 ④ 必须红");
  });

  test("⑦h 把模型级那一块的表头改成渠道级的列名 ⇒ ④b 会红", async () => {
    const src = mutantSrc([
      ['<th style="width:24%">档位</th>', '<th style="width:24%">上游余额</th>'],
    ]);
    await assertRed(src, checkSeparation, "两张表共用一列后 ④b 必须红");
  });

  test("⑦i 不画模型级那一块 ⇒ ⑤ 会红", async () => {
    const src = mutantSrc([
      ["host.innerHTML = self.renderModelQuota(modelGroups(), esc, kit);", 'host.innerHTML = "";'],
    ]);
    await assertRed(src, checkMounted, "不画那一块后 ⑤ 必须红");
  });

  test("⑦j 让目录每轮都重取 ⇒ ⑤ 会红", async () => {
    const src = mutantSrc([
      ["if (!keepOld && catState.has(k)) continue;", "if (!keepOld && catState.has(k)) { catState.delete(k); }"],
    ]);
    await assertRed(src, checkMounted, "每轮重取目录后 ⑤ 必须红");
  });

  test("⑦k 把倍率那一列混进渠道级那张表 ⇒ ⑤ 会红", async () => {
    const src = mutantSrc([
      ["<th style=\"width:22%\">预算上限</th>", "<th style=\"width:22%\">积分倍率</th>"],
    ]);
    await assertRed(src, checkMounted, "列名混了之后 ⑤ 必须红");
  });

  test("⑦l 把「没填令牌的渠道也画行」改坏 ⇒ ⑤ 会红", async () => {
    const src = mutantSrc([
      ['const used = accts.some((a) => a && a.reason !== "no_token");', "const used = accts.length > 0;"],
    ]);
    await assertRed(src, checkMounted, "空行画出来后 ⑤ 必须红");
  });

  test("⑦m 把说明文字里的粗体写成 markdown ⇒ ④ 会红", async () => {
    const card = mutant([["那<b>不是</b>这家没额度", "那**不是**这家没额度"]]);
    await assertRed(card, checkRender, "markdown 漏进纯文本后 ④ 必须红");
  });

  test("⑦n 把倍率的出处（哪个账号的目录）去掉 ⇒ ④ 会红", async () => {
    const card = mutant([
      ['r.catalogAccount ? "账号「" + r.catalogAccount + "」的目录" : "",', '"" ,'],
    ]);
    await assertRed(card, checkRender, "出处去掉后 ④ 必须红");
  });

  test("⑦o 没走过时**不摆**配的档位 ⇒ ②b 会红", async () => {
    const card = mutant([
      [
        'for (const t of Object.keys(mapping)) {',
        'for (const t of []) {',
      ],
    ]);
    await assertRed(card, checkConfigured, "不摆配的档位后 ②b 必须红");
  });

  test("⑦p 提示行**不给**下一步 ⇒ ②b 会红", async () => {
    const card = mutant([
      [
        "· 走过这一家（或点「测试连通」）之后，这里会显示当前档位那个模型的倍率。",
        "。",
      ],
    ]);
    await assertRed(card, checkConfigured, "提示不给下一步后 ②b 必须红");
  });

  test("⑦q 把配的档位那一行说成「可用」⇒ ④ 会红", async () => {
    const card = mutant([
      [
        "'<span class=\"led idle\"></span> 这一档还没在用'",
        "'<span class=\"led ok\"></span> 可用'",
      ],
    ]);
    await assertRed(card, checkRender, "说成「可用」后 ④ 必须红");
  });

  test("⑦r 把「当前」与「配置」两个口径混成一个 ⇒ ④ 会红", async () => {
    const card = mutant([
      [
        '\'<span class="pill idle" style="font-size:10px">配置</span>\'',
        '\'<span class="pill ok" style="font-size:10px">当前</span>\'',
      ],
    ]);
    await assertRed(card, checkRender, "两个口径混成一个后 ④ 必须红");
  });

  test("⑦s 兜底目录时不用映射表里的名字 ⇒ ②b 会红", async () => {
    const card = mutant([
      [
        "const name = (catName && catName !== id) ? catName : (fallbackName || catName || id);",
        "const name = catName || (fallbackName || id);",
      ],
    ]);
    await assertRed(card, checkConfigured, "兜底目录的名字改坏后 ②b 必须红");
  });
});
