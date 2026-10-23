// src/server/clients/workbuddy.mjs —— WorkBuddy（腾讯 CodeBuddy 的桌面版）
//
// ## 配置文件
//
//   ~/.workbuddy/models.json（$WORKBUDDY_CONFIG_DIR 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/workbuddy.go。WorkBuddy 从 models.json 里取「用户自己的模型」
// —— 那是一批 OpenAI Chat Completions 的模型条目：
//
//   [{"id":"deepseek/pro","name":…,"vendor":"magpie","apiKey":"magpie-workbuddy",
//     "url":"http://127.0.0.1:3425/v1/chat/completions",
//     "maxInputTokens":…,"maxOutputTokens":…,"supportsToolCall":true,
//     "supportsImages":…,"supportsReasoning":true,"reasoning":{…}}]
//
// 或者 CodeBuddy Code 的 CLI 写的那份对象形状：
//
//   {"models":[…],"availableModels":[…]}
//
// WorkBuddy 在自己的选择器里把它们显示成 "custom-local:<id>"，按 url 去问
// 模型（Bearer apiKey），**看着文件改，不用重启**。
//
// ⚠ **形状不能乱改**：magpie 写的时候保留用户文件原来的形状（裸数组还是裸
//   数组，对象还是对象）。这一层用 formats-json-list.mjs（"json-list" 格式）
//   来做同一件事 —— 数组根走 "$list" 那条路径，对象根走 "models" 那条。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：models.json 里我们的那几条（vendor 标成我们的 provider id），
//     以及对象形状时把模型 id 补进 availableModels（那是「要显示哪些」的清单）。
//   · 做了 magpie 的**合并**：用户自己的条目原样留着、位置不变，我们那几条
//     **就地**合并（magpie：用户的条目原地不动，在前面；我们的那几条也留在
//     原来的位置 —— magpie workbuddy.go:281 的 slices.Concat）。
//   · 做了**保留用户手改**：用户在 WorkBuddy 里改过的**模型名**留着（改过的
//     id 换回我们的 —— 模型 id 集合是机器该管的）；关掉的模型（disabled）
//     与用户设的思考档也留着（我们压根没写这两个键 ⇒ 弱保留那一层白拿，
//     magpie 是特意搬回来的：workbuddy.go:229-236）。
//     归属表见 BUDDY_MERGE，配对顺序见 alignOurs。
//   · 没做：magpie 的 Sync（目录变了刷新那份清单）—— 我们每次接线都按当时的
//     清单写一遍，想刷新就断开再接一次。
//   · 没做（两件不同的事，别混）：maxInputTokens / maxOutputTokens —— 它们的真值
//     来自 m.context 与输出上限，**还没到位**（阶段 1 的元数据表）⇒ 现在写就是假
//     数字（写假的会让 WorkBuddy 提前截断）⇒ 等真值；而 reasoning（思考档位）与
//     图片是**能力项** ⇒ 永远没有真值 ⇒ 同样不写，但等不到。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { curValue, pickModel, envDir, rootShapeOf } from "./json-util.mjs";
import { LIST_PATH, MODELS_PATH } from "./formats-json-list.mjs";

/** 配置文件在哪儿。 */
export function buddyDir(ctx, env, dirName) {
  return envDir(env) || path.join(ctx.home, dirName);
}

/**
 * buddyEntry —— 我们自己的那一条模型条目。
 *
 * @param {object} ctx 接线上下文
 * @param {object} m   一个模型（{ id, label }）
 * @param {string} pid 我们的 provider id（vendor 字段用它）
 */
export function buddyEntry(ctx, m, pid) {
  return {
    id: m.id,
    name: m.label || m.id,
    /* vendor 标出「这是谁家的」—— 我们的是自己的 provider id。 */
    vendor: pid,
    apiKey: ctx.apiKey || "",
    /* WorkBuddy 问的是**完整地址**（它不自己拼路径） */
    url: `${ctx.baseUrl}/v1/chat/completions`,
    supportsToolCall: true,
    /* ⚠ 图像与思考**不写**这两个键：「我们不知道」≠「不支持」——
       写 false 是在断言（我们只是不知道），写 true 是撒谎（用户真去发一张
       上游收不下的图，当场报错）。键不写 ⇒ 客户端按自己的默认走（保守），
       将来有了真值再加这两个键。 */
  };
}

/**
 * listPathOf —— 这个 models.json 的列表在哪儿。
 *
 * 数组根 ⇒ "$list"（列表就是整个文件）；对象根 ⇒ "models"（列表在 models 键下）。
 * 文件不在 ⇒ 用调用方给的默认形状（与 magpie 一致：WorkBuddy 新建的是裸数组，
 * CodeBuddy Code 新建的是对象）。
 */
export function listPathOf(file, fallback) {
  const shape = rootShapeOf(file);
  if (shape === "array") return LIST_PATH;
  if (shape === "object") return MODELS_PATH;
  return fallback;
}

/**
 * BUDDY_MERGE —— 我们那几条模型条目的字段归属（通用合并层的 spec）。
 *
 * 通用合并层（merge-policy.mjs，底座 base.mjs 调用）在写盘前把「我们要写的值」
 * 与「用户文件里的现值」合并。这个 spec 就是 WorkBuddy 的**归属表**：
 *
 * | 字段 | 归谁 | 为什么 |
 * | --- | --- | --- |
 * | `name` | **用户的** | 用户在 WorkBuddy 的模型设置里改过的名字留着（设计稿 §2.2(a)：模型名是「用户可能手改」的字段） |
 * | `id` | 我们的 | 模型 id 集合是机器该管的（§2.2(a)）—— 用户改过的 id 会被换回来 |
 * | `apiKey` / `url` | 我们的 | 地址与 key 机器该管（§2.2(a)；magpie 同） |
 * | `vendor` | 我们的 | 我们的标记（面板的「接上了没有」就认它） |
 * | `disabled` / `reasoning` / 其它我们没写的键 | **保留用户的** | 我们压根没写 ⇒ 弱保留那一层留着。magpie 特意把「用户在 WorkBuddy 里关掉的模型」（workbuddy.go:229-231 的 `off`）与「用户设的思考档」（:232-236 的 `effort`）搬回来 —— 我们靠这一层白拿 |
 *
 * ## ⚠ 识别键为什么是 `apiKey` 而不是 `vendor`
 *
 * magpie 认「我们那一条」有**两条**规则（workbuddy.go:202-220）：
 * `vendor == magpieID` **或** `apiKey` 是 magpie 那把 key。第二条不是多余的 ——
 * magpie 自己的测试文件写着（kept_effort_test.go:53-60）：
 *
 * > 「WorkBuddy's **Settings > Models saves an edited model whole** into
 * > models.json, with … **the vendor of the provider it matches, "Custom" for
 * > magpie's**（WorkBuddy 5.x 的 inferProviderIdFromLocalCustomModel 与表单的
 * > 保存）；**one set by hand keeps vendor magpie**.」
 *
 * ⇒ 用户在 WorkBuddy 自己的界面里改我们那条模型的**名字**，存回去的那一条
 *   **vendor 变成了 "Custom"**（手改 models.json 才留着 vendor）。
 * ⇒ 只认 `vendor` ⇒ 认不出用户改过的那一条 ⇒ 合并层把它当「用户自己的条目」
 *   留着，**我们的那一条被追加在后面** ⇒ **同一个模型出现两次**
 *   （magpie 明确要求「no second entry of any model」：kept_effort_test.go:60）。
 * ⇒ 认 `apiKey`（**字段名**，不是它的值 —— 值由 ctx 给，不进这个文件）：
 *   那一条用的是我们的 key ⇒ 认得出 ⇒ 就地合并、名字留着、vendor 换回我们的
 *   （magpie 同：workbuddy.go:160-161 与 sync 后的 vendor 断言）。
 *
 * ⚠ 本仓的网关 key 是**固定的** `bai-local`（server.mjs 的 clientCtx）⇒
 *   认 key 不会因为「key 轮换」而失效。
 */
const BUDDY_MERGE = {
  mode: "array",
  key: "apiKey",
  theirs: ["name"],
};

/**
 * alignOurs —— 把我们的条目按「用户文件里我们那几条的顺序」排好。
 *
 * ## 为什么必须排
 *
 * 合并层认出「我们那一条」靠识别键（这里是 `apiKey`）—— 那是一个**组**
 * （我们那把 key 名下的所有模型），**分不出组里哪一条是哪一条** ⇒ 它按
 * **出现顺序**配对：用户的第 i 条 ↔ 我们的第 i 条。
 *
 * ⇒ 我们不排好，用户的改名就会**贴到别的模型上**：用户文件里
 *   `[{id:m2,name:"M2"}, {id:m1,name:"我改的 Opus"}]`，我们的清单是
 *   `[m1, m2]` ⇒ 合并后 m1 顶着「M2」这个名字、m2 顶着「我改的 Opus」——
 *   **用户点一个模型，拿到的是另一个**。
 *
 * 会打乱配对的有两件事：
 *   · 用户在 WorkBuddy 里拖动了模型的顺序；
 *   · **我们自己的档位顺序变了**（ctx.models 的顺序不是固定的）。
 *
 * ⇒ 先按用户文件里的顺序排好我们的条目，配对就对了。
 *
 * @param {object[]} ours  我们的条目（按 ctx.models 的顺序）
 * @param {object[]} mine  用户文件里**我们那几条**（已按文件顺序挑出来）
 * @returns {object[]} 排好后的我们的条目
 */
export function alignOurs(ours, mine) {
  /* 文件里还没有我们那几条 ⇒ 没有顺序要对 ⇒ 我们的顺序就是我们的顺序。 */
  if (!mine.length) return ours;
  const byId = new Map(ours.map((e) => [e.id, e]));
  const out = [];
  const used = new Set();
  for (const el of mine) {
    const hit = byId.get(el && el.id);
    if (hit && !used.has(hit.id)) { out.push(hit); used.add(hit.id); continue; }
    /* 用户改过这一条的 id（我们认不出它是谁）⇒ 拿一条还没配对的顶上：
       合并层会把它的 id 换回我们的（模型 id 集合是机器该管的）。 */
    const next = ours.find((e) => !used.has(e.id));
    if (next) { out.push(next); used.add(next.id); }
  }
  /* 用户文件里没有的那几条 ⇒ 追加在后面（合并层认不出它们 ⇒ 它们自己排最后）。 */
  for (const e of ours) if (!used.has(e.id)) out.push(e);
  return out;
}

/**
 * buddyWrites —— models.json 要写的那几处。
 *
 * @param {string} file      文件
 * @param {string} listPath  列表那条路径（$list 或 models）
 * @param {object[]} ours    我们的条目
 * @param {string} pid       我们的 provider id（**不用于识别** —— 识别靠 apiKey，
 *                            理由见 BUDDY_MERGE；这个参数留着是因为 codebuddy.mjs
 *                            也调它，签名不能改）
 */
export function buddyWrites(file, listPath, ours, pid) {
  const list = curValue(file, "json-list", listPath);
  const theirs = (list.existed && Array.isArray(list.value)) ? list.value : [];
  /* 「我们那一条」= 用我们那把 key 的那些（认 apiKey 不认 vendor 的理由见
     BUDDY_MERGE 上面那段 —— WorkBuddy 自己的表单会把 vendor 存成 "Custom"）。 */
  const ourKey = ours.length ? ours[0].apiKey : "";
  const writes = [{
    path: listPath,
    /* ⚠ 合并层在写盘前把它与文件里的现值合并：
       用户自己的条目原样留着、位置不变，我们那几条**就地**合并
       （用户改过的 name 留着；地址/key/模型 id 换成我们的）。
       归属见 BUDDY_MERGE，配对顺序见 alignOurs。 */
    value: alignOurs(ours, theirs.filter((e) => e && e.apiKey === ourKey)),
    merge: BUDDY_MERGE,
  }];
  /* availableModels 是「要显示哪些模型」的清单 —— 只在用户本来就有它时补。
     ⚠ 它是**字符串数组**（模型 id 列表）：合并层按「键」认元素，对它用不上
       ⇒ 保持原样：用户的 id 留在前面，我们的 id 追加在后面（magpie 同：
       workbuddy.go:289-296 的 avail）。 */
  if (listPath === MODELS_PATH) {
    const avail = curValue(file, "json-list", "availableModels");
    if (avail.existed && Array.isArray(avail.value)) {
      const ids = ours.map((e) => e.id);
      const keptIds = avail.value.filter((id) => !ids.includes(id));
      writes.push({ path: "availableModels", value: [...keptIds, ...ids] });
    }
  }
  return writes;
}

/**
 * workBuddyDecl —— 造一份 WorkBuddy 的声明。
 *
 * WorkBuddy（国行以外的版本）与 WorkBuddy AI（国际版）是**同一个应用的两个
 * 发行版**：形状一模一样，只是数据目录不同（.workbuddy / .workbuddy-ai）。
 * 所以两个声明共用这一份代码。
 */
export function workBuddyDecl({ id, name, note, env, dirName }) {
  return {
    id,
    name,
    protocol: "chat",
    note,

    files: (ctx) => {
      const file = path.join(buddyDir(ctx, env, dirName), "models.json");
      const pid = ctx.providerId || "bai";
      return [
        {
          path: file,
          format: "json-list",
          writes: () => {
            /* 一个模型都没有就别写 —— 写一份没有模型的清单对用户没意义。 */
            pickModel(ctx);
            const ours = (ctx.models || []).map((m) => buddyEntry(ctx, m, pid));
            return buddyWrites(file, listPathOf(file, LIST_PATH), ours, pid);
          },
          wired: (text, fmt) => {
            for (const p of [LIST_PATH, MODELS_PATH]) {
              const r = fmt.getPath(text, p);
              if (r && r.ok && r.found && Array.isArray(r.value)
                && r.value.some((e) => e && e.vendor === pid)) return true;
            }
            return false;
          },
        },
      ];
    },
  };
}

export const workBuddyClient = workBuddyDecl({
  id: "workbuddy",
  name: "WorkBuddy",
  note: "腾讯 CodeBuddy 的桌面版（自定义模型）",
  env: "WORKBUDDY_CONFIG_DIR",
  dirName: ".workbuddy",
});
