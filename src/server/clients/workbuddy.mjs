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
//   · 做了 magpie 的**合并**：用户自己的条目留在前面（magpie：用户的条目原地
//     不动，在前面）。
//   · 没做：magpie 的 Sync（目录变了刷新那份清单）与「用户手动关掉的模型
//     保持关着」那套（disabled 标记是 WorkBuddy 自己写的，我们保留用户那份
//     原样，但我们新写的条目不带 disabled —— 新写的默认是开的）。
//   · 没做：maxInputTokens / maxOutputTokens / reasoning（我们的接线上下文里
//     没有「这个档位的上下文窗口、能写多少 token、支持哪些 effort」这一项 ——
//     写一个假的数字会让 WorkBuddy 提前截断）。
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
 * buddyWrites —— models.json 要写的那几处。
 *
 * @param {string} file      文件
 * @param {string} listPath  列表那条路径（$list 或 models）
 * @param {object[]} ours    我们的条目
 * @param {string} pid       我们的 provider id
 */
export function buddyWrites(file, listPath, ours, pid) {
  const list = curValue(file, "json-list", listPath);
  const kept = (list.existed && Array.isArray(list.value))
    ? list.value.filter((e) => !(e && e.vendor === pid))
    : [];
  const writes = [{ path: listPath, value: [...kept, ...ours] }];
  /* availableModels 是「要显示哪些模型」的清单 —— 只在用户本来就有它时补。 */
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
