// src/server/clients/codebuddy.mjs —— CodeBuddy Code（腾讯的 CLI）
//
// ## 配置文件
//
//   ~/.codebuddy/models.json（$CODEBUDDY_CONFIG_DIR 设了就用那儿）
//   ~/.codebuddy/settings.json
//
// ## magpie 的对应
//
// internal/agent/codebuddy.go。CodeBuddy Code 的模型从 models.json 里取，
// **用的是 WorkBuddy 那份形状**（workbuddy.go 的 buddyWriteAt 写它）：
//
//   {"models":[{"id":"deepseek/pro","name":…,"vendor":"magpie",
//     "apiKey":"magpie-codebuddy",
//     "url":"http://127.0.0.1:3425/v1/chat/completions",
//     "maxInputTokens":…,"maxOutputTokens":…,"supportsToolCall":true,…}],
//    "availableModels":[…]}
//
// 国际版（codebuddy.ai）与国行（codebuddy.cn）是**同一个 npm 包**。
// 一个会话从哪个模型起，是 settings.json 的 "model"（那个清单里的一个 id），
// 开会话时读的 —— 改了要新开会话才生效。
//
// ⚠ 新建的 models.json 是**对象**形状（{"models":[…]}）—— 这是 CodeBuddy Code
//   文档给它的形状（WorkBuddy 桌面版自己写的是裸数组）。所以这里两个形状都要
//   会：文件在 ⇒ 按它现在的形状写；文件不在 ⇒ 按 CodeBuddy Code 的形状建。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：models.json 里我们的那几条 + settings.json 的 model（当前用哪个）。
//   · 没做（两件不同的事，别混）：maxInputTokens / maxOutputTokens —— 它们的真值
//     来自 m.context 与输出上限，**还没到位**（阶段 1 的元数据表）⇒ 现在写就是假
//     数字 ⇒ 等真值；而 reasoning（思考档位）是**能力项** ⇒ 永远没有真值 ⇒ 同样
//     不写，但等不到。
//   · 没做：magpie 的 Sync（目录变了刷新清单）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel } from "./json-util.mjs";
import { LIST_PATH, MODELS_PATH } from "./formats-json-list.mjs";
import { buddyDir, buddyEntry, buddyWrites, listPathOf } from "./workbuddy.mjs";

export const codeBuddyClient = {
  id: "codebuddy",
  name: "CodeBuddy Code",
  protocol: "chat",
  note: "腾讯的 CLI（自定义模型）",

  files: (ctx) => {
    const dir = buddyDir(ctx, "CODEBUDDY_CONFIG_DIR", ".codebuddy");
    const models = path.join(dir, "models.json");
    const settings = path.join(dir, "settings.json");
    const pid = ctx.providerId || "bai";
    return [
      {
        path: models,
        format: "json-list",
        writes: () => {
          /* 一个模型都没有就别写 —— 写一份没有模型的清单对用户没意义。 */
          pickModel(ctx);
          const ours = (ctx.models || []).map((m) => buddyEntry(ctx, m, pid));
          /* 文件不在 ⇒ 按 CodeBuddy Code 文档给的形状建（{"models":[…]}）。 */
          return buddyWrites(models, listPathOf(models, MODELS_PATH), ours, pid);
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
      {
        path: settings,
        writes: () => {
          const pick = pickModel(ctx);
          /* settings.json 的 "model" 是清单里的**裸 id**（不带 provider 前缀） */
          return [{ path: "model", value: pick.id }];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "model");
          return !!(r && r.ok && r.found && r.value);
        },
      },
    ];
  },
};
