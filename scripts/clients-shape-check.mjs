/**
 * 客户端配置形状核对 · 第二版（scripts/clients-shape-check.mjs）
 *
 * ## 这一版比第一版强在哪
 *
 * 第一版问「我们写的键，真实文件取得到吗」—— 可我们**要新建的那一块**（用户还没配过
 * 我们这家）当然取不到 ⇒ 满屏假警报。
 *
 * 这一版问对的问题：**照着用户自己配过的那家学**。
 *   ① 我们要写的那一块（父路径下的某个新子键）⇒ 真实文件里**同父路径下用户自己
 *      配过的那些块**长什么样？
 *   ② 拿其中一个当样本，比**键名集合**：
 *      · 我们**缺**的键 ⇒ 客户端可能需要（照它那份就该有）
 *      · 我们**多**的键 ⇒ 客户端可能不认（照它那份就没有）
 *   ③ 真实文件里**一个同类块都没有**（用户压根没配过上游）⇒ **无从比对**，如实说。
 *
 * ## 判据只对「JSON 家族」成立
 *
 * 要列出一个父路径下的所有子键 ⇒ 得能遍历。JSON 能（`parseJsonc`）。
 * TOML / YAML 的读写器内部用的是自己的树、没有「转成普通对象」的导出 ⇒ 这两个
 * 家族用**文本层面**找同级块名（见 `siblingNamesOf`）。
 *
 * ## ⚠ 这个判据**分不出来**的事（2026-10-23 实测的局限）
 *
 * 「我们没有、样本有」这一条**分不出两种情况**：
 *   ① 我们**漏写**了客户端需要的键（真问题）；
 *   ② **用户压根没配过第二家上游** ⇒ 样本那一项来自别的原因（或根本不存在）。
 * 而 ② 是**常态**：本机 28 个客户端里，只有 cline 配过别家上游（`openai-codex`），
 * 其余的用户自己的配置里**没有同类块可当样本** ⇒ 自动核出来的「可疑」多半是 ②。
 *
 * ⇒ 所以本脚本的输出是**线索**，不是结论：它把「值得人看一眼」的地方挑出来，
 *   判「到底要不要改」仍然要人对着**这个客户端的文档/源码**看。
 *   ⚠ 别把它的输出当成「有 bug」—— 2026-10-23 这一轮跑下来，**没有一条是真问题**。
 *
 * ## 🔴 红线：只读结构，**一个值都不打印**
 *
 * 真实配置文件里常有 provider 规则与凭据。本脚本只比**键名集合**与**类型**，
 * **不打印真实值**、不落盘、不写回任何真实文件。接线写到**临时目录**（隔离），
 * 真实文件**只读**。
 *
 * ## 不是测试
 *
 * 要本机真装了那些客户端才能比 ⇒ **不注册进 `npm test`**；一次性核对工具。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { allClients } from "../src/server/clients/registry.mjs";
import { formatOf } from "../src/server/clients/base.mjs";
import { parseJsonc } from "../src/server/edit-json.mjs";
import "../src/server/clients/formats-toml.mjs";
import "../src/server/clients/formats-yaml.mjs";
import "../src/server/clients/formats-dotenv.mjs";

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** 一个值的类型标签 */
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  if (typeof v === "object") return "对象";
  if (typeof v === "string") return "字符串";
  if (typeof v === "number") return "数字";
  if (typeof v === "boolean") return "布尔";
  return typeof v;
}

/* ------------------------------------------------------------------ *
 * 取「某个父路径下的子键名」
 * ------------------------------------------------------------------ */

/** JSON：直接读。 */
function jsonChildren(root, parentPath) {
  let cur = root;
  for (const seg of parentPath) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = cur[seg];
  }
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
  return Object.keys(cur);
}

/** TOML：文本层面找 `[父.子]` 形式的表名。 */
function tomlChildren(text, parentPath) {
  const prefix = parentPath.length ? parentPath.join(".") + "." : "";
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[([^\]]+)\]\s*$/.exec(line);
    if (!m) continue;
    const name = m[1].trim().replace(/^["']|["']$/g, "");
    if (prefix && !name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!rest || rest.includes(".")) continue;
    out.add(rest);
  }
  return out.size ? [...out] : null;
}

/** YAML：文本层面找父键下同缩进的子键（`  子键:` 或 `  - name: x`）。 */
function yamlChildren(text, parentPath) {
  const lines = text.split(/\r?\n/);
  const want = parentPath[parentPath.length - 1];
  let indent = -1, out = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const ind = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent < 0) {
      if (new RegExp(`^${want}\\s*:`).test(t)) indent = ind;
      continue;
    }
    if (ind <= indent) break;
    const m = /^([A-Za-z0-9_.-]+)\s*:/.exec(t);
    if (m) { if (!out) out = new Set(); out.add(m[1]); continue; }
    const li = /^-\s*([A-Za-z0-9_.-]+)\s*:/.exec(t);
    if (li) { if (!out) out = new Set(); out.add(li[1]); }
  }
  return out && out.size ? [...out] : null;
}

/** 按格式选一个「列子键」的实现。 */
function childrenOf(fmtName, realText, root, parentPath) {
  if (fmtName === "toml") return tomlChildren(realText, parentPath);
  if (fmtName === "yaml") return yamlChildren(realText, parentPath);
  if (fmtName === "json" || fmtName === "json-list" || !fmtName) {
    const c = jsonChildren(root, parentPath);
    return c && c.length ? c : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const ctx = {
  home: os.homedir(),
  baseUrl: `http://127.0.0.1:${port}`,
  apiKey: "test-placeholder-key",
  models: [{ id: "sn/claude-opus-5", label: "Claude Opus 5" }],
  providerId: "bai",
  providerName: "B.AI",
  /* claude-code 的声明要 ctx.cli.editsFor()（真接线时 server.mjs 给）。
     这里给一份**最小的**事实集，让它算出要写哪几处 —— 只为核形状，不为写盘。 */
  cli: {
    editsFor: () => [
      { path: "env.ANTHROPIC_BASE_URL", value: `http://127.0.0.1:${port}` },
      { path: "env.ANTHROPIC_AUTH_TOKEN", value: "test-placeholder-token" },
    ],
  },
};

const clients = await allClients();
const report = [];
let compared = 0, noSample = 0, noFile = 0;
const findings = [];

for (const c of clients) {
  let files = [];
  try { files = c.files(ctx) || []; } catch (e) {
    findings.push(`${c.id}：files() 抛错 —— ${String((e && e.message) || e).slice(0, 80)}`);
    continue;
  }
  for (const f of files) {
    if (!fs.existsSync(f.path)) { noFile++; continue; }
    const fmtName = f.format || "json";
    const fmt = formatOf(fmtName);
    if (!fmt) { findings.push(`${c.id}：格式 ${fmtName} 没注册`); continue; }
    let realText;
    try { realText = fs.readFileSync(f.path, "utf8"); } catch { continue; }
    let root = null;
    if (fmtName === "json" || fmtName === "json-list" || !fmtName) {
      const p = parseJsonc(realText);
      root = p.ok ? p.value : null;
    }
    let writes = [];
    try { writes = (typeof f.writes === "function" ? f.writes(ctx) : f.writes) || []; }
    catch (e) {
      findings.push(`${c.id}：算要写什么时出错 —— ${String((e && e.message) || e).slice(0, 80)}`);
      continue;
    }

    const lines = [];
    /* 按「父路径」把写入项归堆：我们写的是同一父路径下的一块。 */
    const byParent = new Map();
    for (const w of writes) {
      const p = String(w.path || "");
      if (!p || w.delete) continue;
      const segs = p.split(".");
      const parent = segs.slice(0, -1).join(".");
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push({ last: segs[segs.length - 1], value: w.value, path: p });
    }

    for (const [parent, items] of byParent) {
      const parentSegs = parent ? parent.split(".") : [];
      const sibs = childrenOf(fmtName, realText, root, parentSegs);
      if (!sibs || !sibs.length) {
        lines.push(`   · ${parent || "(根)"}：真实文件里这个层级下**没有别的块** ⇒ 无从比对`);
        noSample++;
        continue;
      }
      /* 我们要新建的那一块（最后一段）⇒ 拿别的当样本 */
      const ours = items.map((i) => i.last);
      const samples = sibs.filter((s) => !ours.includes(s));
      if (!samples.length) {
        lines.push(`   · ${parent || "(根)"}：同级只有我们自己要写的那一块 ⇒ 无从比对`);
        noSample++;
        continue;
      }
      compared++;
      /* 取第一个样本，比它的键名集合 */
      const sample = samples[0];
      const sampleVal = (() => {
        if (fmtName === "json" || fmtName === "json-list" || !fmtName) {
          let cur = root;
          for (const seg of parentSegs) { if (!cur || typeof cur !== "object") return null; cur = cur[seg]; }
          return cur ? cur[sample] : null;
        }
        return undefined;   // TOML/YAML：文本层面拿不到「值」，只能拿键名
      })();
      /* 样本块的键名集合 —— 数组比**元素**的键 */
      const keysOf = (v) => {
        if (Array.isArray(v)) {
          const e = v.find((x) => x && typeof x === "object" && !Array.isArray(x));
          return e ? { keys: Object.keys(e), of: "数组元素" } : null;
        }
        if (v && typeof v === "object") return { keys: Object.keys(v), of: "对象" };
        return null;
      };
      const sampleShape = sampleVal !== undefined ? keysOf(sampleVal) : null;
      if (!sampleShape) {
        /* 样本是**标量**（像 Claude Code 的 env：每个键一个字符串值）⇒ 能比的是
           「**同级键名**」：这个客户端认哪些 env 键，答案就在用户自己写的那些键里。 */
        const sibKeys = sibs;   // 父路径下的每一个子键都是「这个客户端认的那个键」
        const ourNames = [...new Set(items.map((i) => i.last))];
        lines.push(`   · ${parent || "(根)"}：我们写的键 = ${ourNames.join("、")}`);
        lines.push(`       同级真实存在的键 = ${sibKeys.join("、")}`);
        const notIn = ourNames.filter((n) => !sibKeys.includes(n));
        if (notIn.length) {
          lines.push(`       ? 我们写了同级没有的键：${notIn.join("、")}（可疑：可能这个客户端压根不认它）`);
          findings.push(`${c.id}（${f.path}）：我们写了同级不存在的键（${notIn.join("、")}）—— 需人工判别（也可能是「用户压根没配过第二家」造成的）`);
        } else lines.push(`       ✓ 我们写的键同级都有`);
        compared++;
        continue;
      }
      /* 我们的块：同一父路径下、**最后一段相同**的那些写入项合并成一个块。
         ⚠ 我们的「键」是**块内部**的键（值对象的键），不是块名本身。 */
      const byBlock = new Map();
      for (const i of items) {
        if (!byBlock.has(i.last)) byBlock.set(i.last, []);
        byBlock.get(i.last).push(i);
      }
      for (const [blockName, blockItems] of byBlock) {
        const merged = {};
        for (const i of blockItems) {
          if (i.value && typeof i.value === "object" && !Array.isArray(i.value)) Object.assign(merged, i.value);
        }
        const ourShape = keysOf(blockItems.length === 1 ? blockItems[0].value : merged);
        if (!ourShape) {
          /* ⚠ 我们写的是**标量**（像 Claude Code 的 env：每个键一个字符串值）。
             这时能比的不是「块内部的键」而是「**同级键名**」——
             这个客户端认哪些 env 键，答案就在用户自己写的那些键里。 */
          /* ⚠ 这里**不能**排除 blockName：标量项的最后一段就是**键名**（像
             `ANTHROPIC_BASE_URL`），不是块名 ⇒ 同级的每一个键都是「这个客户端
             认的那个键」，我们写的那个也在其中。 */
          const sibKeys = sibs;
          if (sibKeys.length) {
            const ourNames = blockItems.map((i) => i.last);
            const notIn = ourNames.filter((n) => !sibKeys.includes(n));
            lines.push(`   · ${parent || "(根)"}/\`${blockName}\`：我们写的键 = ${ourNames.join("、")}`);
            lines.push(`       同级真实存在的键 = ${sibKeys.join("、")}`);
            if (notIn.length) {
              lines.push(`       ? 我们写了同级没有的键：${notIn.join("、")}（可疑：可能这个客户端压根不认它）`);
              findings.push(`${c.id}（${f.path}）：我们写了同级不存在的键（${notIn.join("、")}）—— 需人工判别（也可能是「用户压根没配过第二家」造成的）`);
            } else lines.push(`       ✓ 我们写的键同级都有`);
          } else {
            lines.push(`   · ${parent || "(根)"}/\`${blockName}\`：我们写的不是对象/数组，且同级无别的键 ⇒ 无从比对`);
            noSample++;
          }
          continue;
        }
        const missing = sampleShape.keys.filter((k) => !ourShape.keys.includes(k));
        const extra = ourShape.keys.filter((k) => !sampleShape.keys.includes(k));
        lines.push(`   · ${parent || "(根)"}/\`${blockName}\`：样本 \`${sample}\`（${sampleShape.of}）的键 = ${sampleShape.keys.join("、")}`);
        lines.push(`       我们（${ourShape.of}）的键 = ${ourShape.keys.join("、")}`);
        if (missing.length) {
          lines.push(`       ⚠ 样本有、我们没有：${missing.join("、")}`);
          findings.push(`${c.id}（${f.path}）：\`${parent}\`/\`${blockName}\` —— 样本 \`${sample}\` 有 ${missing.length} 个键我们没写（${missing.join("、")}）—— 逐个看是不是真需要`);
        }
        if (extra.length) {
          lines.push(`       ⚠ 我们有、样本没有：${extra.join("、")}`);
          findings.push(`${c.id}（${f.path}）：\`${parent}\`/\`${blockName}\` —— 我们写了 ${extra.length} 个样本里没有的键（${extra.join("、")}）—— 需人工判别`);
        }
        if (!missing.length && !extra.length) lines.push(`       ✓ 键名集合与样本一致`);
      }
    }
    report.push({ id: c.id, file: f.path, fmt: fmtName, lines });
  }
}

console.log("════ 客户端配置形状核对 · 照着用户自己配过的那家学（只读；不打印任何值）════");
console.log(`客户端 ${clients.length} 个；比过 ${compared} 处；本机没装/没生成过配置而跳过 ${noFile} 个文件；无从比对 ${noSample} 处`);
for (const r of report) {
  console.log(`\n■ ${r.id}（${r.fmt}）  ${r.file}`);
  r.lines.forEach((l) => console.log(l));
}
console.log("\n════ 需要看的 ════");
if (findings.length) findings.forEach((p) => console.log("· " + p));
else console.log("（没有 —— 键名集合都与样本一致）");
