/* scripts/font-policy-test.mjs —— 面板字体的「减法」守卫（T16 起）
 *
 * 规矩（照 magpie 源码定的，别自己发明）：
 *
 *   · **留等宽**：模型 id、文件路径、密钥值、JSON 片段、版本号 —— 这些是
 *     「机器读的东西」。等宽在告诉用户「这段是照抄得动、对得上的」，
 *     **不是给开发者看的装饰**，是对用户有用的。
 *   · **用 UI 字体**：普通界面文字、说明、状态词（免费 / 无 / 停用）——
 *     这些是「给人读的」。
 *
 * 判据看的是**角色**（这段字是机器读的还是人读的），不是内容像不像代码。
 *
 * 但规矩写在注释里是拦不住人的 —— 下一个人加一行 `font-family: var(--mono)`，
 * 整轮减法就白做了。这个测试把「哪些地方允许用等宽」列成**白名单**：
 * 样式表里出现 `var(--mono)` 而不在白名单里，就红；反过来白名单里写了
 * 样式表里已经没有的选择器，也红（**失效条目等于没守**）。
 *
 * 用法：node --test scripts/font-policy-test.mjs
 *
 * ⚠ **它管不到的**：卡片里给某个元素挂 `.mono` **类**（`src/server/cards/*.js`，
 *   现在 35 处）的用法。这个守卫只管**样式表里**的 `var(--mono)`。
 *   卡片里给一段说明文字挂 `.mono` 是另一类错，要拦它得另做一份
 *   「哪些地方的 .mono 是正当的」清单 —— 本轮没做，先记着。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRV = path.join(ROOT, "src", "server");

/* 白名单：**每一处允许用等宽的地方**，附一句「为什么它可以是等宽」。
 *
 * ⚠ **加之前先问一句：这段字是「机器读的东西」吗？** 不是就别加 ——
 *   把它改成 UI 字体，而不是把它写进白名单。白名单只该有一小批条目；
 *   **它变长了就是规矩松了。**
 *
 * ⚠ 键名按**本仓的类名/选择器**写（不是 magpie 的），且每条都必须在仓库里
 *   真的存在 —— 失效的条目等于没守（下面第二条断言会抓）。 */
const MONO_ALLOWLIST = [
  /* ---- src/server/panel-common.css ---- */
  "code",                       // 真代码片段（JSON 片段、请求头）—— 机器读的东西
  ".mono",                      // 「这段是标识符」的标记：模型 id / 路径 / 文件名 / 密钥值 / 指纹 / 会话 id
  ".gauge.patch .keyfp",        // 密钥指纹（密钥值的一种，要照着它比对是哪一把）
  ".chh-relay",                 // 中转口 base URL —— 路径
  "table.route td .tier",       // 档位 id（claude-sonnet-5）—— 模型 id，用户要照着它抄
  ".credbody .cpath",           // 凭据文件路径 —— 路径
  ".keyrow-inline",             // 密钥值那一行（标签 + 值）—— 密钥值
  ".result",                    // 命令输出 / 错误堆栈 —— 日志
  "footer",                     // 页脚那串通道前缀（/qd /bai /sn…）—— 路径
  ".banner .notes",             // 更新说明里的日志与差异 —— diff
  ".updModalCard .notes",       // 更新弹框里的说明 —— diff
  /* ---- src/server/diag.html（诊断页自带一套样式） ---- */
  ".v",                         // 版本号 / 端口 / 错误原文 —— 版本号与日志
  "#logBox",                    // 崩溃日志原文（行内 style）—— 日志
];

/* 样式表里出现 var(--mono) 的规则：抓「选择器 + 声明」两段。
   ⚠ 先把注释剥掉 —— 上一条规则后面的注释会被正则当成下一条的选择器，
     混进白名单比对里就永远对不上。 */
function monoRules(css) {
  const out = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) {
    if (!/var\(--mono\)/.test(m[2])) continue;
    for (const s of m[1].trim().split(/\s*,\s*/)) {
      if (!s || s.startsWith("@")) continue;
      out.push(s.trim());
    }
  }
  return out;
}

/* 行内 style="…var(--mono)…" 的元素（diag.html 的 #logBox 就是这么写的）——
   规则解析器看不见它，得单独扫。键用元素的 id。 */
function monoInline(html) {
  const out = [];
  for (const tag of html.match(/<[^>]*>/g) || []) {
    if (!/style="[^"]*var\(--mono\)/.test(tag)) continue;
    const id = tag.match(/\bid="([^"]+)"/);
    out.push(id ? "#" + id[1] : tag.slice(0, 40));
  }
  return out;
}

/* 全仓面板侧用等宽的地方：主样式表 + 诊断页（它的 <style> 与行内 style）。
   做成纯函数（吃文本、不读盘），下面的反向对照才改得动它。 */
function monoPlaces(css, diagHtml) {
  const diagCss = (diagHtml.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
  return [...monoRules(css), ...monoRules(diagCss), ...monoInline(diagHtml)];
}

/* 真仓库里的那一份 */
function allMonoPlaces() {
  return monoPlaces(
    fs.readFileSync(path.join(SRV, "panel-common.css"), "utf8"),
    fs.readFileSync(path.join(SRV, "diag.html"), "utf8"),
  );
}

test("面板里用等宽的地方都在白名单里", () => {
  const places = allMonoPlaces();
  assert.ok(places.length > 0, "一条 var(--mono) 都没抓到 —— 解析器坏了，不是样式表坏了");
  const extra = places.filter((p) => !MONO_ALLOWLIST.includes(p));
  assert.deepEqual(extra, [],
    `这些地方不在白名单里：\n  ${extra.join("\n  ")}\n` +
    `判据是「这段字是机器读的东西吗」：不是 ⇒ 把它改回 UI 字体；` +
    `是 ⇒ 写进 MONO_ALLOWLIST 并附一句理由（见本文件顶上）。`);
});

test("白名单里没有失效条目", () => {
  const places = new Set(allMonoPlaces());
  const stale = MONO_ALLOWLIST.filter((p) => !places.has(p));
  assert.deepEqual(stale, [],
    `白名单里有样式表里已经不存在的地方：\n  ${stale.join("\n  ")}\n` +
    `规则被删/改名了，白名单要跟着改 —— 留着一条失效条目等于没守。`);
});

/* ── 反向对照：这个守卫自己抓得住吗？抓不住就等于没守 ────────────────── */

test("反向对照 ①：把说明文字改成等宽 ⇒ 必须被抓出来", () => {
  const css = fs.readFileSync(path.join(SRV, "panel-common.css"), "utf8");
  const diag = fs.readFileSync(path.join(SRV, "diag.html"), "utf8");
  /* .hint 是纯说明文字 —— 把它拖成等宽就是犯规 */
  const broken = css + "\n.hint { font-family: var(--mono); }\n";
  const extra = monoPlaces(broken, diag).filter((p) => !MONO_ALLOWLIST.includes(p));
  assert.deepEqual(extra, [".hint"], "守卫没抓到新增的等宽用法 —— 守卫本身坏了");
});

test("反向对照 ②：白名单里放一条不存在的选择器 ⇒ 必须被抓出来", () => {
  const places = new Set(allMonoPlaces());
  const stale = ["table.route td .no-such-class"].filter((p) => !places.has(p));
  assert.deepEqual(stale, ["table.route td .no-such-class"],
    "守卫没抓到失效条目 —— 失效条目等于没守");
});
