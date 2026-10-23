// src/server/clients/paths.mjs —— 点分键路径的解析（TOML / YAML 共用）
//
// ## 为什么路径要能带引号
//
// 客户端的模型 id 是 `provider/档位`（例如 `sn/claude-opus-5`）——**带斜杠**。
// Kimi 的模型表叫 `[models."sn/claude-opus-5"]`、Grok 的叫 `[model."sn/claude-opus-5"]`，
// MiniMax Code 的模型表键也是 `sn/claude-opus-5`。于是「点分」这一个分隔符不够用了：
// 键里本身带斜杠（有时还带点）时，得能写出一段**带引号的键**。
//
// 三种写法：
//   providers.bai               → 两段普通键
//   models."bai/sn/x".provider  → 中间一段是带引号的键（斜杠、点都在它里面）
//   a\.b                       → 反斜杠转义一个点（键里真的有个点）
//
// 引号里的内容原样就是键名（`\` 与 `"` 在双引号里可转义，单引号里 `''` 是一个引号）。
//
// ## 与 edit-json.mjs 的关系
//
// edit-json.mjs 有自己的一套（`splitPath` + `unescapeKey`），只认反斜杠转义。
// 本模块多认一种：**引号包住的一整段**——TOML 的段头 `[models."a/b"]` 本来就长这样，
// 键名里有斜杠时不引号根本写不出来。

/**
 * splitPath —— 把点分路径拆成段。
 *
 * @param {string} p 路径，如 `providers.bai` / `models."bai/sn/x".provider`
 * @returns {string[]} 段；空路径返回 []
 * @throws {Error} 引号没闭合时抛（调用方把它变成 `{ ok:false, error }`）
 */
export function splitPath(p) {
  const s = String(p == null ? "" : p);
  const out = [];
  let cur = "";
  let i = 0;
  let quote = "";     // 当前的引号字符（"" 表示不在引号里）
  let started = false; // 本段是不是已经开始（有内容或引号）
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === "\\") {
        cur += s[i + 1] == null ? "" : s[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") { cur += "'"; i += 2; continue; }
        quote = "";
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; i++; continue; }
    if (c === "\\") { cur += s[i + 1] == null ? "" : s[i + 1]; started = true; i += 2; continue; }
    if (c === ".") { out.push({ key: cur, quoted: started }); cur = ""; started = false; i++; continue; }
    cur += c;
    started = true;
    i++;
  }
  if (quote) throw new Error("键路径里有没闭合的引号");
  out.push({ key: cur, quoted: started });
  return out.map((x) => x.key);
}

/**
 * splitPathRaw —— 拆成段，但**保留引号**（每一段是它的原文）。
 *
 * 底座（base.mjs）算「父路径」时用得上：它拿 `parts.slice(0, k).join(".")`
 * 拼出一条路径，再拿那条路径去读/删。⇒ 段里的引号**必须留着** ——
 * `models."bai/sn/x".provider` 的中间段是 `"bai/sn/x"`（带引号）；
 * 去掉引号再拼回去，`bai/sn/x` 里的斜杠没事，但**点**会被当成分隔符，
 * 拼出来的就不是原来那条路径了。
 *
 * ⚠ 与 splitPathParts 的区别：那个**去掉**引号（是「键名」），
 *   这个**留着**引号（是「路径的一段」）。
 */
export function splitPathRaw(p) {
  const s = String(p == null ? "" : p);
  const out = [];
  let cur = "";
  let i = 0;
  let quote = "";
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (quote === '"' && c === "\\") { cur += s[i + 1] == null ? "" : s[i + 1]; i += 2; continue; }
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") { cur += "'"; i += 2; continue; }
        quote = "";
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; i++; continue; }
    if (c === "\\") { cur += c + (s[i + 1] == null ? "" : s[i + 1]); i += 2; continue; }
    if (c === ".") { out.push(cur); cur = ""; i++; continue; }
    cur += c;
    i++;
  }
  if (quote) throw new Error("键路径里有没闭合的引号");
  out.push(cur);
  return out;
}

/**
 * splitPathParts —— 与 splitPath 相同，但同时给出「这一段是不是带引号写的」。
 *
 * 写 TOML 段头时用得上：带引号写过的段，键名里可能有斜杠/点；没带引号的段，
 * 键名一定是裸键（TOML 的裸键只允许字母数字下划线连字符）。
 */
export function splitPathParts(p) {
  const s = String(p == null ? "" : p);
  const out = [];
  let cur = "";
  let i = 0;
  let quote = "";
  let started = false;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === "\\") { cur += s[i + 1] == null ? "" : s[i + 1]; i += 2; continue; }
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") { cur += "'"; i += 2; continue; }
        quote = "";
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; i++; continue; }
    if (c === "\\") { cur += s[i + 1] == null ? "" : s[i + 1]; started = true; i += 2; continue; }
    if (c === ".") { out.push({ key: cur, quoted: started }); cur = ""; started = false; i++; continue; }
    cur += c;
    started = true;
    i++;
  }
  if (quote) throw new Error("键路径里有没闭合的引号");
  out.push({ key: cur, quoted: started });
  return out;
}
