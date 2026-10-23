// src/server/clients/qwen-code.mjs —— Qwen Code（阿里的 CLI，Gemini CLI 的分支）
//
// ## 配置文件
//
//   ~/.qwen/settings.json（$QWEN_HOME 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/qwen.go。magpie 往四个地方写：
//
//   ① modelProviders.openai —— **数组**，一个条目一个模型：
//        {baseUrl, envKey, id, name}
//      id 是网关认的模型 id（magpie 那边是 "<provider>/<model>"），
//      name 是 /model 选择器上显示的名字，envKey 指向同一份文件里 env 对象
//      中的一个变量名 —— key 从那儿取（magpie 的变量名是 MAGPIE_QWEN_API_KEY）。
//   ② env.<那个变量名> —— key 本身放在 settings 的 env 对象里。
//   ③ model = {name, baseUrl} —— 新会话从哪个模型起（baseUrl 是同名条目的区分位：
//      两个条目可以同名，靠 baseUrl 分开）。
//   ④ security.auth.selectedType = "openai" —— 跳过启动时的 /auth 提问。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：上面四处，一个不落。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：用户原来的 model、auth 类型、
//     env 里的同名变量，由底座 base.mjs 备份（备份的是那几处键路径的原值），
//     断开时只还原那几处 —— 其余一个字不动。
//   · 做了 magpie 的**合并**：用户自己在 modelProviders.openai 里的条目原样留着、
//     位置不变，我们那几条**就地**合并（magpie 也是这么做的：「用户的条目原地
//     不动，在前面」，这样他们自己的 id 不挪位）。
//   · 做了**保留用户手改**：用户在 Qwen Code 里改过的**模型名**（/model 选择器
//     上显示的那一格）留着；改过的 id 换回我们的（模型 id 集合是机器该管的）；
//     用户自己加的条目原样留着。归属表见 QWEN_MERGE。
//   · 没做：magpie 的 Sync（模型目录变了就刷新那份清单）。我们每次接线都按
//     当时的清单写一遍 —— 想刷新，断开再接一次。
//   · 没做：magpie 对「shell 里 / ~/.qwen/.env 里的同名环境变量优先级更高」
//     的处理。我们用的变量名是 BAI_QWEN_API_KEY（**带客户端名**）—— 与 magpie
//     用 MAGPIE_QWEN_API_KEY 是同一个道理：名字具体一点，被盖掉的概率小。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { curValue, pickModel, envDir } from "./json-util.mjs";

/** key 放在 settings 的 env 对象里的哪个变量名下。 */
const ENV_KEY = "BAI_QWEN_API_KEY";

/**
 * QWEN_MERGE —— modelProviders.openai 里**我们那几条**的字段归属（合并层的 spec）。
 *
 * 通用合并层（merge-policy.mjs，底座 base.mjs 调用）在写盘前把「我们要写的值」
 * 与「用户文件里的现值」合并。这个 spec 就是 Qwen Code 的**归属表**：
 *
 * | 字段 | 归谁 | 为什么 |
 * | --- | --- | --- |
 * | `name` | **用户的** | /model 选择器上显示的名字，用户改过就留着（设计稿 §2.2(a)：模型名是「用户可能手改」的字段） |
 * | `id` | 我们的 | 模型 id 集合是机器该管的（§2.2(a)）—— 用户改过的 id 会被换回来 |
 * | `baseUrl` | 我们的 | 地址机器该管（§2.2(a)） |
 * | `envKey` | 我们的 | 认出「我们那一条」的钥匙（magpie 同：qwen.go:43-48「every one on the same env key of its own, which is how an entry of magpie's is told from the user's own」） |
 * | `generationConfig` 等我们没写的键 | **保留用户的** | 我们压根没写 ⇒ 弱保留那一层留着 |
 *
 * ⚠ `key` 是**字段名**（`envKey`），**不是**它的值（`ENV_KEY` 那个常量）——
 *   合并层拿这个字段的**值**跟我们的比（值相同 ⇒ 是我们那一条）。
 */
const QWEN_MERGE = {
  mode: "array",
  key: "envKey",
  theirs: ["name"],
};

/**
 * alignOurs —— 把我们的条目按「用户文件里我们那几条的顺序」排好。
 *
 * 合并层认出「我们那一条」靠识别键（`envKey`）—— 那是一个**组**（我们那几条
 * 条目），**分不出组里哪一条是哪一条** ⇒ 它按**出现顺序**配对：用户的第 i 条
 * ↔ 我们的第 i 条。
 *
 * ⇒ 我们不排好，用户的改名就会**贴到别的模型上**（id 与名字对不上 ——
 *   用户点一个模型，拿到的是另一个）。会打乱配对的有两件事：用户在客户端里
 *   调了顺序、**我们自己的档位顺序变了**（ctx.models 的顺序不是固定的）。
 *
 * ⚠ 与 workbuddy.mjs 的 alignOurs 是同一套 routine。两边各留一份，是因为每个
 *   客户端声明都是**自足**的（本轮不新增共用模块）—— 改一处逻辑要记得改另一处。
 */
function alignOurs(ours, mine) {
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
  for (const e of ours) if (!used.has(e.id)) out.push(e);
  return out;
}

/** 配置文件在哪儿。 */
function qwenDir(ctx) {
  return envDir("QWEN_HOME") || path.join(ctx.home, ".qwen");
}

/** 我们自己的那一条 provider 条目（modelProviders.openai 的一个成员）。 */
function entry(ctx, m) {
  return {
    baseUrl: ctx.baseUrl,
    envKey: ENV_KEY,
    id: m.id,
    name: m.label || m.id,
  };
}

export const qwenCodeClient = {
  id: "qwen-code",
  name: "Qwen Code",
  protocol: "chat",
  note: "阿里的 CLI（Gemini CLI 的分支）",

  files: (ctx) => {
    const file = path.join(qwenDir(ctx), "settings.json");
    return [
      {
        path: file,
        writes: () => {
          const pick = pickModel(ctx);
          const ours = (ctx.models || []).map((m) => entry(ctx, m));
          /* 认「是不是我们的」靠 envKey：我们写的那几条 envKey 都是 ENV_KEY。
             用户自己的条目**位置不变**（合并层按出现顺序配对，见下面）。 */
          const list = curValue(file, "json", "modelProviders.openai");
          const theirs = (list.existed && Array.isArray(list.value)) ? list.value : [];
          const mine = theirs.filter((e) => e && e.envKey === ENV_KEY);
          return [
            /* ⚠ 合并层在写盘前把它与文件里的现值合并：用户自己的条目原样留着、
               位置不变，我们那几条**就地**合并（用户改过的 name 留着；地址/key/
               模型 id 换成我们的）。归属见 QWEN_MERGE，配对顺序见 alignOurs。 */
            { path: "modelProviders.openai", value: alignOurs(ours, mine), merge: QWEN_MERGE },
            /* model 与 security 都写**叶子**：用户的 model / security 里还有别的
               字段（思考级别、目录权限…），我们只改我们该改的那一格。
               ⚠ `model.name` 与 `model.baseUrl` 是**一对**（magpie qwen.go:287-301
                 的 put()：baseUrl 是同名条目的区分位）⇒ 都是我们的：地址是我们的
                 时候，默认模型也得是我们的（否则客户端拿我们的网关去问一个
                 我们没有的 id）。「用户在客户端里选了别的默认模型」这一格**故意
                 不归用户** —— 交接稿 §4.3 把它列成根模式候选，本轮不接（理由见
                 报告）。 */
            { path: "model.name", value: pick.id },
            { path: "model.baseUrl", value: ctx.baseUrl },
            { path: "security.auth.selectedType", value: "openai" },
            { path: `env.${ENV_KEY}`, value: ctx.apiKey || "" },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "modelProviders.openai");
          if (!r || !r.ok || !r.found || !Array.isArray(r.value)) return false;
          return r.value.some((e) => e && e.envKey === ENV_KEY);
        },
      },
    ];
  },
};

