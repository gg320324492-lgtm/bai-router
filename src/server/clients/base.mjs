// src/server/clients/base.mjs —— **客户端接线**的底座
//
// ## 「客户端」是什么
//
// 一个说某种方言、要连 base_url 的 CLI / IDE：Claude Code、Claude Desktop、
// OpenCode、Qoder、ZCode、Kimi Code、Qwen Code、Cline、Droid、MiniMax Code…
// 面板上「接到 Claude Code」那个按钮，接的就是这些东西。
//
// ## 这一层补的是哪个洞
//
// 网关**听得懂**客户端的话（协议桥：Anthropic / Responses / Gemini / Chat）
// 只解决了一半。另一半是：**替用户把客户端的配置文件写好** —— 用户不该自己去
// 找配置文件、照着某个格式手写 provider 块、还猜 base_url 填哪个端口。
//
// magpie 的做法是每个客户端一个 `.go` 文件（`internal/agent/<name>.go`），
// 里面写着**确切的文件路径与字段路径**。本仓照同样的路子，但把共用的部分
// （读文件 / 备份 / 写盘 / 还原 / 判状态）收在这里，每个客户端只留**声明**。
//
// ## 三条纪律
//
// ① **绝不覆盖用户的东西**。写之前先把「我们要改的那几处」的原值记进备份，
//    断开时只把那几处还原回去 —— **其余一个字不动**。
//    ⚠ 为什么不整份还原：用户接线之后又改了别的地方（换了 key、调了参数），
//    整份还原会把那些改动一起抹掉。
// ② **凭据不进声明文件**。客户端的声明里只有「往哪个路径写什么形状」，
//    key 是运行时给的（与「插件渠道」那条纪律同源：声明是分发物，不能带 key）。
// ③ **读不懂就不写**。配置文件存在但解析失败 ⇒ 报错、中止，**绝不**当空配置
//    覆盖掉用户的东西（edit-json.mjs 的 parseJsonc 明确区分「读不出来」与「空」）。
//
// ## 一个客户端的声明长什么样
//
// ```js
// {
//   id: "zcode",                    // 稳定 id（配置文件名、备份名都用它）
//   name: "ZCode",                  // 面板上显示的名字
//   protocol: "chat",               // 它说哪种方言：chat / anthropic / responses / gemini
//   note: "智谱的桌面端",            // 一句话说明（面板上显示）
//   files: (home, ctx) => [         // 它要改哪些文件（可以不止一个）
//     {
//       path: path.join(home, ".zcode", "v2", "config.json"),
//       writes: (ctx) => [          // 要写哪几个键路径（点分路径，顺序应用）
//         { path: "provider.bai", value: { ... } },
//       ],
//       wired: (text) => boolean,   // 「现在接的是不是我们」怎么判
//     },
//   ],
// }
// ```
//
// `ctx`（接线时给）：`{ home, baseUrl, apiKey, models, providerId, providerName }`
// `models`：`[{ id: "claude-opus-5", label: "Claude Opus 5" }]` —— **档位**，不是最终模型名。
//
// ## magpie 的对应
//
// magpie `internal/agent/<name>.go`（每个客户端一个文件）↔ 本仓
// `src/server/clients/<name>.mjs`（每个客户端一个声明）。共用逻辑（读写/备份/
// 还原）在 magpie 是 `internal/edit` 包，本仓是 `edit-json.mjs` + 本文件。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPath, setPath, delPath } from "../edit-json.mjs";

/* ------------------------------------------------------------------ *
 * 格式读写器
 * ------------------------------------------------------------------ */

/**
 * FORMATS —— 按文件格式找「读一个路径 / 写一个路径 / 删一个路径」的实现。
 *
 * JSON / JSONC 用仓库已有的 edit-json.mjs（它保注释、保键序、保缩进与换行风格）。
 * TOML 与 YAML 由 `src/server/clients/formats-toml.mjs` / `formats-yaml.mjs`
 * 用 `registerFormat` 注册进来 —— **不在这里 import**，免得 base 依赖那两个
 * 文件（那是并行开发的两条线，硬依赖会让两条线互相等）。
 *
 * 没注册的格式 ⇒ 接到那个客户端时**如实报「这个格式还没接上」**，不猜、不崩。
 */
const FORMATS = {
  json: { getPath, setPath, delPath },
};

/**
 * registerFormat —— 注册一个格式的读写器。
 *
 * impl：`{ getPath(text, p), setPath(text, p, value), delPath(text, p) }`
 * 每个都返回 `{ ok, … }`（与 edit-json.mjs 同一形状），失败时带一句人话。
 */
export function registerFormat(name, impl) {
  if (!name || !impl || typeof impl.getPath !== "function"
    || typeof impl.setPath !== "function" || typeof impl.delPath !== "function") {
    throw new Error("registerFormat：读写器要有 getPath / setPath / delPath 三个函数");
  }
  FORMATS[String(name)] = impl;
}

/** formatOf —— 取一个格式的读写器；没有就 null。 */
export function formatOf(name) {
  return FORMATS[String(name || "json")] || null;
}

/* ------------------------------------------------------------------ *
 * 备份目录
 * ------------------------------------------------------------------ */

/**
 * backupDirOf —— 接线备份放在哪儿。
 *
 * 与 server.mjs 的 DATA_DIR 同一口径（`BAI_DATA_DIR` 优先），备份单独一个子目录
 * —— 它不是「配置备份」（那是 server.mjs 的 backups/），是「客户端接线前那几个
 * 键的原值」。
 */
export function backupDirOf(dataDir) {
  const base = dataDir || process.env.BAI_DATA_DIR
    || path.dirname(fileURLToPath(import.meta.url));
  return path.join(base, "client-backups");
}

/** backupFileOf —— 某个客户端的备份文件。 */
export function backupFileOf(id, dataDir) {
  return path.join(backupDirOf(dataDir), `${String(id || "unknown").replace(/[^a-z0-9_-]/gi, "_")}.json`);
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

/**
 * readFileText —— 读一个配置文件。
 *
 * 返回 `{ ok, text, exists, error }`：
 *   · 文件不在 → `{ ok: true, exists: false, text: "" }`（合法的「从零开始建」）
 *   · 文件在但读不出来（权限/编码） → `{ ok: false, error }`（**绝不**当空）
 */
export function readFileText(file) {
  try {
    if (!fs.existsSync(file)) return { ok: true, exists: false, text: "" };
    return { ok: true, exists: true, text: fs.readFileSync(file, "utf8") };
  } catch (e) {
    return { ok: false, exists: true, error: String((e && e.message) || e) };
  }
}

/**
 * pathValue —— 某个点分路径在文本里的当前值。
 *
 * 文件不存在 → `{ existed: false }`（还原时该删掉）。
 * 文件在但解析失败 → `{ error }`（**中止**，不猜）。
 */
export function pathValue(text, p, fmt) {
  if (String(text || "").trim() === "") return { existed: false };
  const r = fmt.getPath(text, p);
  if (!r.ok) return { error: r.error, line: r.line, column: r.column };
  if (!r.found) return { existed: false };
  return { existed: true, value: r.value };
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/**
 * writeText —— 原子写一个文件（先写临时文件再改名，避免半截文件）。
 *
 * ⚠ 写之前**不**做备份（备份是 applyClient 的事，它要知道原值）。
 */
export function writeText(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".bai-tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ *
 * 接线 / 还原 / 状态
 * ------------------------------------------------------------------ */

/**
 * applyClient —— 把 B.AI 接到某个客户端上。
 *
 * ctx：`{ home, baseUrl, apiKey, models, providerId, providerName }`
 * 返回 `{ ok, detail, changed, files }`。
 *
 * 流程（每个文件）：
 *   ① 读原文（读不出来 ⇒ 整个失败，不写）
 *   ② 算出要写的键路径与新值
 *   ③ **先**把每个键路径的**原值**记进备份（一次改多处 ⇒ 一次写全）
 *   ④ 再写盘
 *
 * ⚠ 顺序要紧：**先备份再写**。反过来（先写再备份）的话，中途崩了备份里存的是
 *   新值 —— 还原时等于什么都没还原。
 */
export function applyClient(def, ctx, opts = {}) {
  const list = fileListOf(def, ctx);
  if (!list.length) return { ok: false, detail: "这个客户端没有声明要改哪些文件" };

  /* ① 先把每个文件要改的键的原值全读出来（读不出来 ⇒ 中止，一个字都不写） */
  const plan = [];
  for (const f of list) {
    const r = readFileText(f.path);
    if (!r.ok) {
      return { ok: false, detail: `读不了 ${f.path}：${r.error}` };
    }
    let writes;
    try {
      writes = (typeof f.writes === "function" ? f.writes(ctx) : f.writes) || [];
    } catch (e) {
      return { ok: false, detail: `算 ${def.name} 要写什么时出错：${String((e && e.message) || e)}` };
    }
    const edits = [];
    const parents = [];
    const fmt = formatOf(f.format || "json");
    if (!fmt) {
      return { ok: false, detail: `还不知道怎么读写 ${f.format || "json"} 格式的文件（${f.path}）` };
    }
    for (const w of writes) {
      const p = String(w.path || "");
      if (!p) continue;
      const before = pathValue(r.text, p, fmt);
      if (before.error) {
        return { ok: false, detail: `读不懂 ${f.path}（${before.error}）—— 宁可不接，也不能把用户写坏` };
      }
      edits.push({ path: p, before, value: w.value });
      /* ⚠ **父路径的原值也要记**：我们删掉 `providers.bai` 之后，`providers`
       *   会剩下一个**空壳**（edit-json.mjs 的 delPath 只删那个键，不删空父级）。
       *   那个空壳是我们留下的痕迹 —— 断开时必须连它一起收掉，否则用户的文件
       *   里多出一个 `{}`（他原来可能压根没有 `providers` 这一节）。
       *   记下父路径的原值 ⇒ 还原时能**精确**复原：原来有就留着，原来没有就删掉。 */
      const parts = p.split(".");
      for (let k = parts.length - 1; k >= 1; k--) {
        const pp = parts.slice(0, k).join(".");
        if (parents.some((x) => x.path === pp)) continue;
        const pb = pathValue(r.text, pp, fmt);
        if (pb.error) {
          return { ok: false, detail: `读不懂 ${f.path}（${pb.error}）—— 宁可不接，也不能把用户写坏` };
        }
        parents.push({ path: pp, existed: pb.existed === true, value: pb.existed === true ? pb.value : null });
      }
    }
    plan.push({ file: f, text: r.text, edits, parents, exists: r.exists, fmt });
  }

  /* ② 写备份（一次改多处 ⇒ 一次写全，备份里能看出「我们碰了哪些路径」） */
  const backup = { id: def.id, at: new Date().toISOString(), files: {} };
  for (const p of plan) {
    backup.files[p.file.path] = {
      format: p.file.format || "json",
      edits: p.edits.map((e) => ({
        path: e.path,
        existed: e.before.existed === true,
        value: e.before.existed === true ? e.before.value : null,
      })),
      parents: p.parents.map((x) => ({
        path: x.path,
        existed: x.existed === true,
        value: x.existed === true ? x.value : null,
      })),
    };
  }
  try {
    const bf = backupFileOf(def.id, opts.dataDir);
    fs.mkdirSync(path.dirname(bf), { recursive: true });
    fs.writeFileSync(bf, JSON.stringify(backup, null, 2), "utf8");
  } catch (e) {
    return { ok: false, detail: `备份写不进去（${backupFileOf(def.id, opts.dataDir)}）：${String((e && e.message) || e)}` };
  }

  /* ③ 写盘 */
  const written = [];
  for (const p of plan) {
    let text = p.text;
    for (const e of p.edits) {
      const r = p.fmt.setPath(text, e.path, e.value);
      if (!r.ok) {
        return { ok: false, detail: `写 ${p.file.path} 的 ${e.path} 失败：${r.error}` };
      }
      text = r.text;
    }
    try {
      writeText(p.file.path, text);
    } catch (e) {
      return { ok: false, detail: `写 ${p.file.path} 失败：${String((e && e.message) || e)}` };
    }
    written.push(p.file.path);
  }

  return {
    ok: true,
    changed: true,
    files: written,
    detail: `已接好：${written.join("、")}（原值已备份，断开时原样还原）`,
  };
}

/**
 * revertClient —— 把我们写的那几处原样还回去（其余一个字不动）。
 *
 * 备份里记的是**每个键路径的原值**：
 *   · 原来有 → 写回原值
 *   · 原来没有 → **删掉**（这是「新增的那块」该有的下场）
 *
 * 没有备份 ⇒ 这个客户端**不是我们接的**（或者已经被用户手动改过）⇒ 如实说，
 * 不猜、不动用户文件。
 */
export function revertClient(def, opts = {}) {
  const bf = backupFileOf(def.id, opts.dataDir);
  if (!fs.existsSync(bf)) {
    return { ok: false, detail: "没有这份客户端的接线备份 —— 它不是我们接的（或者已经被手动改过），不动你的文件" };
  }
  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(bf, "utf8"));
  } catch (e) {
    return { ok: false, detail: `备份读不出来（${bf}）：${String((e && e.message) || e)}` };
  }
  const touched = [];
  for (const [file, entry] of Object.entries(backup.files || {})) {
    const edits = Array.isArray(entry) ? entry : (entry.edits || []);
    const parents = (entry && entry.parents) || [];
    const fmt = formatOf((entry && entry.format) || "json");
    if (!fmt) return { ok: false, detail: `还不知道怎么读写这个客户端的配置文件格式（${file}）` };
    const r = readFileText(file);
    if (!r.ok) return { ok: false, detail: `读不了 ${file}：${r.error}` };
    let text = r.text;
    for (const e of edits) {
      const res = e.existed ? fmt.setPath(text, e.path, e.value) : fmt.delPath(text, e.path);
      if (!res.ok) {
        return { ok: false, detail: `还原 ${file} 的 ${e.path} 失败：${res.error}` };
      }
      text = res.text;
    }
    /* 收掉空壳：我们新增的那块删掉后，父级会剩下一个空对象。
     *   父级**原来就有** ⇒ 留着（那是用户自己的）；**原来没有** ⇒ 删掉。 */
    const byDepth = parents.slice().sort((a, b) => b.path.split(".").length - a.path.split(".").length);
    for (const p of byDepth) {
      if (p.existed) continue;
      const cur = fmt.getPath(text, p.path);
      if (!cur.ok || !cur.found) continue;
      if (!isEmptyObject(cur.value)) continue;
      const res = fmt.delPath(text, p.path);
      if (!res.ok) {
        return { ok: false, detail: `还原 ${file} 的空壳 ${p.path} 失败：${res.error}` };
      }
      text = res.text;
    }
    try {
      writeText(file, text);
    } catch (e) {
      return { ok: false, detail: `写 ${file} 失败：${String((e && e.message) || e)}` };
    }
    touched.push(file);
  }
  try { fs.unlinkSync(bf); } catch { /* 备份删不掉不算失败（还原本身已经做完了） */ }
  return { ok: true, detail: `已断开：${touched.join("、")}（只还原了我们写过的那几处）` };
}

/**
 * clientStatus —— 这个客户端现在接的是不是我们。
 *
 * 返回 `{ wired, detail, file, provider }`：
 *   · `wired` —— 备份文件在 **且** 配置里我们的那块在 ⇒ 是我们接的
 *   · 只有配置在、没有备份 ⇒ 用户（或别的工具）自己写的，如实说明
 */
export function clientStatus(def, ctx, opts = {}) {
  const list = fileListOf(def, ctx);
  if (!list.length) return { wired: false, detail: "这个客户端没有声明配置文件", file: "" };
  const f = list[0];
  const r = readFileText(f.path);
  if (!r.ok) return { wired: false, detail: `读不了 ${f.path}：${r.error}`, file: f.path };
  if (!r.exists) {
    return { wired: false, detail: `没找到 ${f.path}（这个客户端可能没装）`, file: f.path, missing: true };
  }
  let on = false;
  try {
    const fmt = formatOf(f.format || "json");
    on = typeof f.wired === "function" ? !!f.wired(r.text, fmt) : false;
  } catch { on = false; }
  const hasBackup = fs.existsSync(backupFileOf(def.id, opts.dataDir));
  return {
    wired: on && hasBackup,
    configured: on,
    detail: on
      ? (hasBackup ? "已接到 B.AI" : "配置里有 B.AI，但不是本机接的（没有备份记录）")
      : "还没接",
    file: f.path,
  };
}

/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */

/** fileListOf —— 把声明里的 files 变成一个规整的数组。 */
function fileListOf(def, ctx) {
  if (!def || typeof def.files !== "function") return [];
  const raw = def.files(ctx);
  return (Array.isArray(raw) ? raw : [raw]).filter((f) => f && f.path);
}

/**
 * isEmptyObject —— 一个值是不是空对象（`{}`）。
 *
 * 只用它来判断「我们删掉一块之后，父级是不是只剩了个空壳」。空数组、
 * 空字符串都**不算** —— 那些不是「壳」，是用户自己的内容。
 */
function isEmptyObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

/**
 * jsonSafe —— 一个值能不能原样写进 JSON。
 *
 * 写不进去的东西（函数、undefined、循环引用）在这里就**炸掉**，而不是到了
 * 写盘那一步才变成一句「[object Object]」。
 */
export function jsonSafe(v, where) {
  if (v === null) return v;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "undefined" || t === "function") {
    throw new Error(`${where || "值"} 写不进去（${t}）`);
  }
  if (Array.isArray(v)) {
    return v.map((x, i) => jsonSafe(x, `${where || "值"}[${i}]`));
  }
  if (t === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonSafe(x, `${where || "值"}.${k}`);
    return out;
  }
  throw new Error(`${where || "值"} 写不进去（${t}）`);
}
