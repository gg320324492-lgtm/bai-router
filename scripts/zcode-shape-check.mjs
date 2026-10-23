/**
 * ZCode 配置形状核对（scripts/zcode-shape-check.mjs）
 *
 * ## 做什么
 *
 * 用**临时目录**里的一份接线结果，与**本机真实的** `~/.zcode/v2/provider_config.json`
 * 逐层对**键结构**（键名与类型）—— 确认我们写出来的那份，ZCode 认得。
 *
 * ## 🔴 红线：只取键名与类型，**一个值都不打印**
 *
 * 本机那个文件里可能有 provider 规则与配置。脚本只把「键名 → 类型」递归出来，
 * **值一律不读进输出、不落盘、不打印**。数组是空的时候（用户还没配过 provider）
 * 就没有元素结构可比 —— 那一层只能比「数组 vs 数组」。
 *
 * ## 不是测试
 *
 * 它**要本机装了 ZCode**（有那个真实文件才能比）⇒ 不注册进 `npm test`；
 * 是一次性的核对工具（父会话验收时用）。没装 ⇒ 如实说「跳过」，退出码 0。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { applyClient } from "../src/server/clients/base.mjs";
import { zcodeClient } from "../src/server/clients/zcode.mjs";

const HOME = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");

/** 一个值的「结构」：对象的键 → 子结构；数组 → 元素结构；标量 → 类型名。 */
function shapeOf(v) {
  if (Array.isArray(v)) {
    return v.length ? { "[数组]": shapeOf(v[0]) } : { "[数组]": "(空)" };
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = shapeOf(v[k]);
    return out;
  }
  return typeof v;
}

/** 两份结构对：返回「真实文件有、我们没有」的键（那一类才是问题）。 */
function missingKeys(real, ours, at = "") {
  const out = [];
  if (real && typeof real === "object" && !Array.isArray(real)) {
    if (!ours || typeof ours !== "object" || Array.isArray(ours)) {
      return [`${at || "(根)"}：类型对不上（真实 ${JSON.stringify(real).slice(0, 40)}，我们 ${JSON.stringify(ours).slice(0, 40)}）`];
    }
    for (const [k, rv] of Object.entries(real)) {
      if (!(k in ours)) { out.push(`${at}${k}`); continue; }
      /* 数组的元素结构：两边都非空才比 —— 真实文件里那个数组是空的
         （用户还没配过 provider）⇒ 元素结构无从比，只比「数组 vs 数组」。 */
      if (k === "[数组]") {
        if (rv === "(空)" || ours[k] === "(空)") continue;
      }
      out.push(...missingKeys(rv, ours[k], `${at}${k}.`));
    }
  } else if (real !== ours && !String(real).startsWith("{")) {
    out.push(`${at || "(根)"}：类型对不上（真实 ${real}，我们 ${ours}）`);
  }
  return out;
}

if (!fs.existsSync(HOME)) {
  console.log(`本机没有 ${HOME} —— 没装（或没跑过）ZCode，跳过核对。`);
  process.exit(0);
}

const raw = fs.readFileSync(HOME, "utf8");
const real = JSON.parse(raw);

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bai-zcode-shape-"));
const ctx = {
  home: tmp,
  baseUrl: `http://127.0.0.1:${port}`,
  apiKey: "test-placeholder-key",
  models: [{ id: "sn/claude-opus-5", label: "Claude Opus 5" }],
  providerId: "bai",
  providerName: "B.AI",
};
const r = applyClient(zcodeClient, ctx, { dataDir: tmp });
if (!r.ok) {
  console.error(`接线失败：${r.detail}`);
  process.exit(1);
}
const ours = JSON.parse(fs.readFileSync(path.join(tmp, ".zcode", "v2", "provider_config.json"), "utf8"));

console.log("---- 本机真实文件的键结构（只有键名与类型）----");
console.log(JSON.stringify(shapeOf(real), null, 2));
console.log("---- 我们写出来的键结构 ----");
console.log(JSON.stringify(shapeOf(ours), null, 2));

const bad = missingKeys(shapeOf(real), shapeOf(ours));
console.log("---- 逐层对：真实文件有、我们没有的键 ----");
console.log(bad.length ? bad.join("\n") : "（没有 —— 我们写的键结构是它的子集）");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
