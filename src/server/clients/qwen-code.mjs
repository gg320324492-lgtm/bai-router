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
//   · 做了 magpie 的**合并**：用户自己在 modelProviders.openai 里的条目留在前面
//     （magpie 也是这么做的：「用户的条目原地不动，在前面」，这样他们自己的
//     id 不挪位）。
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
          /* 用户自己的条目留在前面 —— 他们的 id 不挪位。
             （认「是不是我们的」靠 envKey：我们写的那几条 envKey 都是 ENV_KEY。） */
          const list = curValue(file, "json", "modelProviders.openai");
          const kept = (list.existed && Array.isArray(list.value))
            ? list.value.filter((e) => !(e && e.envKey === ENV_KEY))
            : [];
          return [
            { path: "modelProviders.openai", value: [...kept, ...ours] },
            /* model 与 security 都写**叶子**：用户的 model / security 里还有别的
               字段（思考级别、目录权限…），我们只改我们该改的那一格。 */
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

