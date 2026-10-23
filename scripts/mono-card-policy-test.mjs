/* scripts/mono-card-policy-test.mjs —— 卡片里「挂 .mono 类」的用法的守卫（T17 起）
 *
 * ── 为什么要有第二道闸 ────────────────────────────────────────────
 *   scripts/font-policy-test.mjs 管的是**样式表**里的 `var(--mono)`。
 *   但卡片（src/server/cards/*.js）是**拼 HTML 的** —— 等宽不写进 CSS，
 *   而是给某个元素挂一个 `class="mono"`（或行内 `font-family:var(--mono)`）。
 *   样式表那道闸**看不见这些**：有人给一段说明文字挂上 `.mono`，它一点动静都没有。
 *   本文件补的就是这一半。
 *
 * ── 判据（与 src/server/panel-common.css 里那段界线注释一致）─────────
 *   `.mono` = 这段字是一个**标识符**（模型 id / 路径 / 文件名 / 密钥值 / 哈希 /
 *   会话 id）→ 等宽，因为用户要照着它抄、要比对它。其余一律 UI 字体。
 *
 *   判据看**角色**（这段字是机器读的还是人读的），不看内容像不像代码。
 *
 * ── 办法：文件 + 「渲染式指纹」的白名单 ────────────────────────────
 *   一处「用了等宽」= 一个**标签**（<span class="mono">…</span>）。
 *   给它算一条指纹：
 *
 *     指纹 = 「类名 | 这个标签渲染的东西」
 *
 *   · 类名：class 属性的原样值（class="mono dim" ⇒ "mono dim"）；
 *     行内 style 写 var(--mono) 的 ⇒ 记成 "style:mono"。
 *   · 渲染物：标签里那一段（模板表达式或字面量），空白归一。
 *
 *   白名单记「哪个文件、这条指纹、应该出现几次」。
 *   - 卡片里**新加**一处 `.mono` ⇒ 指纹不在白名单 ⇒ **红**。
 *   - 白名单里那条**被改了/删了** ⇒ 出现次数对不上 ⇒ **红**（失效条目等于没守）。
 *   - 同一处**被复制**了一份 ⇒ 次数对不上 ⇒ **红**。
 *
 *   ⚠ **为什么不用行号**：行号是最脆的做法 —— 别的会话在这个文件里插一行，
 *     后面每一条白名单都跟着漂，改一行就满屏红。白名单该记的是**这段字本身**，
 *     不是它在第几行。指纹取「渲染式」：别的行增删 ⇒ 指纹不动 ⇒ 不误报。
 *
 *   ⚠ **同一段渲染式出现两次怎么办**：记 count 2（plugins.js 里两处都渲染
 *     `e.file`）。这样删掉其中一处也会红 —— 否则「删一处」就悄悄溜过去了。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────
 *   · 思考、注释、报告一律中文（标识符仍英文）。
 *   · 白名单只该有一小批条目；**它变长了就是规矩松了。**
 *     加之前先问一句：这段字是「机器读的东西」吗？不是就别加 ——
 *     把它改成 UI 字体，而不是把它写进白名单。
 *   · 失效的条目要一起改：白名单要跟着代码走。
 *
 * 用法：node --test scripts/mono-card-policy-test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CARDS_DIR = path.join(ROOT, "src", "server", "cards");

/* 白名单：**每一处允许在卡片里用等宽的地方**。
 *
 * 键 = 文件名（相对 src/server/cards/）；fp = 指纹；count = 应该出现几次；
 * why = 一句「为什么它可以是等宽」。
 *
 * ⚠ 每条都要在仓库里真的存在 —— 失效的条目等于没守（下面第二条断言会抓）。 */
const MONO_CARD_ALLOWLIST = [
  /* ---- account-list.js ---- */
  { file: "account-list.js", fp: "mono|${esc(accId)}", count: 1,
    why: "账号 id（密钥指纹）—— 标识符" },

  /* ---- audit-ledger.js ---- */
  { file: "audit-ledger.js", fp: "mono|${esc(String((k && k.name) || \"\"))}", count: 1,
    why: "归类 token（ok/auth/quota/rate…）—— 机器读的分类名" },
  { file: "audit-ledger.js", fp: "mono|${esc(String((r && r.model) || \"—\"))}", count: 1,
    why: "模型 id" },
  { file: "audit-ledger.js", fp: "mono|${esc(String((r && r.kind) || \"\"))}", count: 1,
    why: "归类 token —— 机器读的分类名" },

  /* ---- clients.js ---- */
  { file: "clients.js", fp: "v mono|—", count: 1,
    why: "统一网关地址（运行时填进去）—— 路径" },
  { file: "clients.js", fp: "mono|provider/档位", count: 1,
    why: "模型 id 的写法（provider/档位）—— 用户要照这个形状写" },
  { file: "clients.js", fp: "mono|${esc(String(dir))}", count: 1,
    why: "客户端插件目录 —— 路径" },
  { file: "clients.js", fp: "mono dim|${esc(String(c.id || \"\"))}", count: 1,
    why: "客户端 id" },
  { file: "clients.js", fp: "hint mono|${esc(String(st.file))}", count: 1,
    why: "客户端配置文件路径 —— 路径" },
  /* 「保留了你手改的」那一格（2026-10-23 接线阶段 2 收尾时加的） */
  { file: "clients.js", fp: "mono|${esc(String(k.path || \"\"))}", count: 1,
    why: "保留了你手改的那一处的键路径（带文件名）—— 标识符" },
  { file: "clients.js", fp: "mono|${esc(n)}", count: 1,
    why: "你自己那些键的键名 —— 标识符" },

  /* ---- config-backup.js ---- */
  { file: "config-backup.js", fp: "v mono|—", count: 1,
    why: "备份目录（运行时填进去）—— 路径" },
  { file: "config-backup.js", fp: "mono|${esc(f.name)}", count: 1,
    why: "备份文件名 —— 文件名" },

  /* ---- mm-member.js ---- */
  { file: "mm-member.js", fp: "style:mono|${esc(t.authPath)}", count: 1,
    why: "登录态文件路径 —— 路径" },
  { file: "mm-member.js", fp: "style:mono|${esc(o.upstream)}", count: 1,
    why: "上游 base URL —— 路径" },

  /* ---- model-catalog.js ---- */
  { file: "model-catalog.js", fp: "mono|${esc(t.tokenFile)}", count: 1,
    why: "令牌文件路径 —— 路径" },

  /* ---- oc-transport.js ---- */
  { file: "oc-transport.js", fp: "style:mono|${esc(probe.path || \"\")}", count: 1,
    why: "本机可执行文件路径 —— 路径" },

  /* ---- or-rotation.js ---- */
  { file: "or-rotation.js", fp: "mono|${esc(rot.activeModel)}", count: 1,
    why: "当前模型 id" },
  { file: "or-rotation.js", fp: "mono|${esc(rot.limitSource)}", count: 1,
    why: "限额来源 token（openrouter_free_tier_daily / upstream_provider_shared_pool）" },

  /* ---- plugins.js ---- */
  { file: "plugins.js", fp: "v mono|—", count: 1,
    why: "插件目录（运行时填进去）—— 路径" },
  { file: "plugins.js", fp: "mono|${esc(String(e.file || \"\"))}", count: 2,
    why: "报错文件名（插件段与 middleware 段各一处）—— 文件名" },
  { file: "plugins.js", fp: "v mono|${esc(id)}", count: 1,
    why: "插件 id" },
  { file: "plugins.js", fp: "v mono|${esc(String(p.upstream || \"\"))}", count: 1,
    why: "上游 base URL —— 路径" },
  { file: "plugins.js", fp: "v mono|${esc((p.models || []).join(\" · \"))}", count: 1,
    why: "模型 id 列表" },
  { file: "plugins.js", fp: "mono|${esc(String(mw.dir || \"\"))}", count: 1,
    why: "middleware 目录 —— 路径" },
  { file: "plugins.js", fp: "mono|${esc(dir)}", count: 2,
    why: "代码插件目录（说明里出现两次）—— 路径" },
  { file: "plugins.js", fp: "mono|plugin.json", count: 2,
    why: "清单文件名 —— 文件名" },
  { file: "plugins.js", fp: "mono|main.mjs", count: 1,
    why: "入口文件名 —— 文件名" },
  { file: "plugins.js", fp: "mono dim|${esc(String(p.id || \"\"))}", count: 1,
    why: "插件 id" },
  { file: "plugins.js", fp: "mono|${esc(String(e.dir || \"\"))}", count: 1,
    why: "报错目录 —— 路径" },

  /* ---- price-table.js ---- */
  { file: "price-table.js", fp: "mono|${esc(sp.model)}", count: 1,
    why: "模型 id" },

  /* ---- quota-panel.js ---- */
  { file: "quota-panel.js", fp: "dim mono|（${e(r.tier)}）", count: 1,
    why: "档位 id（claude-sonnet-5）—— 模型 id，用户要照着它抄" },
  { file: "quota-panel.js", fp: "dim mono|${e(r.model)}", count: 1,
    why: "模型 id" },

  /* ---- traffic-page.js ---- */
  { file: "traffic-page.js", fp: "mono|${esc(short)}", count: 1,
    why: "会话 id（前 10 位）—— 会话 id" },

  /* ---- usage-ledger.js ---- */
  { file: "usage-ledger.js", fp: "mono|${esc(String((m && m.key) || \"\"))}", count: 1,
    why: "模型 key —— 模型 id" },
  { file: "usage-ledger.js", fp: "mono|${esc(model)}", count: 1,
    why: "模型 id" },
];

/* ── 扫描：把一份源码里所有「用了等宽」的标签找出来 ────────────────────
 *
 * 「用了等宽」有两种写法，都要抓：
 *   ① class 属性里带 mono 这个**词**（class="mono" / class="v mono dim"）；
 *      ⚠ 用**词**而不是子串 —— .monote 是另一个类（字号小一号的小注），不是等宽。
 *   ② 行内 style 写 var(--mono)。
 *
 * 注释先剥掉：注释里出现 <span class="mono"> 只是举例，不是真的用。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    /* 行注释：// 前面不是冒号（免得把 http:// 里的 // 当注释） */
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1) => p1);
}

function attrValue(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs)
    || new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(attrs);
  return m ? m[1] : null;
}

/* 标签里渲染的东西：开标签之后、下一个标签之前的文本。
   空白归一（换行与缩进不算内容）。 */
function innerText(src, from) {
  const region = src.slice(from, from + 400);
  const close = region.indexOf("</");
  const cut = close >= 0 ? close : region.length;
  const lt = region.indexOf("<");
  const end = lt >= 0 && lt < cut ? lt : cut;
  return region.slice(0, end).replace(/\s+/g, " ").trim();
}

/* 一份源码 ⇒ 一串指纹。纯函数（吃文本、不读盘），反向对照才改得动它。 */
function monoUsages(src) {
  const bare = stripComments(src);
  const out = [];
  /* 开标签：属性值里的引号要成对处理（style="a>b" 也不会截断） */
  const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(bare))) {
    const attrs = m[2];
    const cls = attrValue(attrs, "class");
    const style = attrValue(attrs, "style");
    const isMonoClass = cls != null && cls.split(/\s+/).includes("mono");
    const isMonoStyle = style != null && /var\(--mono\)/.test(style);
    if (!isMonoClass && !isMonoStyle) continue;
    const inner = innerText(bare, tagRe.lastIndex);
    out.push((isMonoClass ? cls : "style:mono") + "|" + inner);
  }
  return out;
}

/* { 文件名: 源码 } ⇒ { 文件名: [指纹…] } */
function scanCards(files) {
  const out = {};
  for (const [name, src] of Object.entries(files)) out[name] = monoUsages(src);
  return out;
}

/* 真仓库里的那一份 */
function allCardFiles() {
  const files = {};
  for (const name of fs.readdirSync(CARDS_DIR).filter((n) => n.endsWith(".js")).sort()) {
    files[name] = fs.readFileSync(path.join(CARDS_DIR, name), "utf8");
  }
  return files;
}

/* ── 两条判定 ──────────────────────────────────────────────────────
 *   ① 白名单外的一律红（新加的不正当用法）。
 *   ② 白名单里的次数对不上也红（失效条目 / 被复制出来的一份）。 */
function checkUnlisted(scan) {
  const allowed = new Set(MONO_CARD_ALLOWLIST.map((e) => e.file + "\0" + e.fp));
  const bad = [];
  for (const [file, fps] of Object.entries(scan)) {
    for (const fp of fps) {
      if (!allowed.has(file + "\0" + fp)) bad.push({ file, fp });
    }
  }
  return bad;
}

function checkStale(scan) {
  const bad = [];
  for (const e of MONO_CARD_ALLOWLIST) {
    const actual = (scan[e.file] || []).filter((fp) => fp === e.fp).length;
    if (actual !== e.count) bad.push({ ...e, actual });
  }
  return bad;
}

/* ── 断言 ────────────────────────────────────────────────────────── */

test("卡片里用等宽的地方都在白名单里", () => {
  const scan = scanCards(allCardFiles());
  const total = Object.values(scan).reduce((n, fps) => n + fps.length, 0);
  assert.ok(total > 0, "一处等宽用法都没抓到 —— 解析器坏了，不是卡片坏了");
  const bad = checkUnlisted(scan);
  assert.deepEqual(bad, [],
    `这些地方不在白名单里：\n` +
    bad.map((b) => `  ${b.file}：${b.fp}`).join("\n") + "\n" +
    `判据是「这段字是机器读的东西吗」：不是 ⇒ 把它改回 UI 字体；` +
    `是 ⇒ 写进 MONO_CARD_ALLOWLIST 并附一句理由（见本文件顶上）。`);
});

test("白名单里没有失效条目", () => {
  const scan = scanCards(allCardFiles());
  const bad = checkStale(scan);
  assert.deepEqual(bad, [],
    bad.map((b) => {
      const what = b.actual === 0
        ? "已经不在文件里了（被改了或删了）"
        : b.actual > b.count
          ? `出现了 ${b.actual} 次，比白名单多 —— 有人复制了一份，或新加了一处一样的`
          : `只剩 ${b.actual} 次，比白名单少 —— 少了几处`;
      return `  ${b.file}：${b.fp} —— ${what}`;
    }).join("\n") + "\n" +
    `代码被改/被删了，白名单要跟着改 —— 留着一条失效条目等于没守。`);
});

/* ── 反向对照：这个守卫自己抓得住吗？抓不住就等于没守 ──────────────────
 *
 * ⚠ 反向对照看的是**差集**：以「改动前」为基线，只认「这一改**新带出来**的犯规」。
 *   这么写有两个好处：
 *   · 仓库里若另有别的犯规，不该让这些反向对照的判定跟着变（它们只管证明
 *     **检测逻辑**还灵，不管仓库干不干净）；
 *   · 检测逻辑要是整个坏了（比如解析器只字不吐），差集就是空的 ⇒ 反向对照红。
 */

/* 基线 → 改动后：新冒出来的「不在白名单里的用法」 */
function newUnlisted(baseFiles, files) {
  const key = (b) => b.file + "|" + b.fp;
  const before = new Set(checkUnlisted(scanCards(baseFiles)).map(key));
  return checkUnlisted(scanCards(files)).filter((b) => !before.has(key(b)));
}

/* 基线 → 改动后：新冒出来的「失效条目」 */
function newStale(baseFiles, files) {
  const key = (e) => e.file + "|" + e.fp;
  const before = new Set(checkStale(scanCards(baseFiles)).map(key));
  return checkStale(scanCards(files)).filter((e) => !before.has(key(e)));
}

test("反向对照 ①：给一段说明文字挂上 .mono ⇒ 必须被抓出来", () => {
  const base = allCardFiles();
  const files = { ...base };
  /* 「说明文字」正是这个守卫存在的理由 —— 上一轮没做这道闸时，它抓不住。 */
  files["clients.js"] = base["clients.js"].replace(
    "<span class=\"v mono\" data-role=\"c-base\">—</span>",
    "<span class=\"v mono\" data-role=\"c-base\">—</span>"
    + "\n          <div class=\"hint mono\">这一段是给人读的说明文字，不该是等宽。</div>",
  );
  assert.notEqual(files["clients.js"], base["clients.js"], "替换没生效 —— 反向对照本身坏了");
  const bad = newUnlisted(base, files);
  assert.ok(bad.some((b) => b.fp.includes("这一段是给人读的说明文字")),
    "守卫没抓到新增的不正当用法 —— 守卫本身坏了");
});

test("反向对照 ②：删掉一处正当的用法 ⇒ 必须被抓出来（失效条目）", () => {
  const base = allCardFiles();
  const files = { ...base };
  files["plugins.js"] = base["plugins.js"].replace(
    "<span class=\"mono\">main.mjs</span>", "<span>main.mjs</span>");
  assert.notEqual(files["plugins.js"], base["plugins.js"], "替换没生效 —— 反向对照本身坏了");
  const bad = newStale(base, files);
  assert.ok(bad.some((e) => e.file === "plugins.js" && e.fp.includes("main.mjs") && e.actual === 0),
    "守卫没抓到失效条目 —— 守卫本身坏了");
});

test("反向对照 ③：把一处正当的改成不正当（换掉渲染物）⇒ 必须被抓出来", () => {
  const base = allCardFiles();
  const files = { ...base };
  files["price-table.js"] = base["price-table.js"].replace(
    "<span class=\"mono\">${esc(sp.model)}</span>",
    "<span class=\"mono\">${esc(sp.vendor)}</span>",
  );
  assert.notEqual(files["price-table.js"], base["price-table.js"], "替换没生效 —— 反向对照本身坏了");
  assert.ok(newUnlisted(base, files).some((b) => b.fp.includes("sp.vendor")),
    "守卫没抓到改坏了的用法 —— 守卫本身坏了");
  assert.ok(newStale(base, files).some((e) => e.actual === 0),
    "改坏了却没报失效条目 —— 守卫本身坏了");
});

test("反向对照 ④：把一处正当的复制一份 ⇒ 必须被抓出来（次数对不上）", () => {
  const base = allCardFiles();
  const files = { ...base };
  files["plugins.js"] = base["plugins.js"].replace(
    "<span class=\"mono\">main.mjs</span>",
    "<span class=\"mono\">main.mjs</span><span class=\"mono\">main.mjs</span>",
  );
  assert.notEqual(files["plugins.js"], base["plugins.js"], "替换没生效 —— 反向对照本身坏了");
  const bad = newStale(base, files);
  assert.ok(bad.some((e) => e.file === "plugins.js" && e.fp.includes("main.mjs") && e.actual === 2),
    "守卫没抓到多出来的一份 —— 守卫本身坏了");
});
