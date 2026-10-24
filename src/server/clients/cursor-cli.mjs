// src/server/clients/cursor-cli.mjs —— Cursor CLI（cursor-agent）
//
// ## 配置文件
//
//   ~/.cursor/cli-config.json
//
// ## magpie 的对应
//
// internal/agent/agents.go 的 `cursor`（**不是** Cursor 编辑器，也不是
// cursorlocal.go 那个 "Cursor Private Inference"）。magpie 在这一行只管
// **模型**：
//
//   {"model":{"modelId":"…","displayModelId":"…","displayName":"…"},
//    "hasChangedDefaultModel":true}
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：上面那四处（modelId / displayModelId / displayName +
//     hasChangedDefaultModel）。displayName 我们填模型的友好名，magpie 填的是
//     那个 id —— 显示给人看的那个格子，填个能看懂的更好。
//   · 做了**保留用户手改**：`model.displayName` 归用户（用户在 Cursor CLI 里
//     改过的显示名留着）。模型 id（modelId / displayModelId）与
//     hasChangedDefaultModel 是机器该管的 —— 照写、不比对。
//   · ⚠ **没做（也做不了）：把 Cursor CLI 指到 B.AI 的网关**。magpie 在这一行
//     **也没有**改 base URL（它 magpie 那一行的 Cursor CLI 走的是 Cursor 自己
//     的后端 —— magpie 的网关对 cursor-agent 是「它只跟 Cursor 的后端说话」）。
//     我们手里没有 Cursor CLI 自定义端点那几格的**确切字段名**（magpie 那边
//     没有，别的实现我们不凭空猜）—— **读不懂就不写**。
//     所以这一行接通后，Cursor CLI 会拿一个它后端不认识的模型 id 去问。
//     想要 Cursor CLI 真的走到 B.AI，得等 Cursor CLI 自己认自定义端点，
//     那时再有确切字段名再补这一层。断开随时可还原。
//
// ## ⚠⚠ 面板上**不能**说「已接上」
//
// 这一点特别要紧，因为面板那一格本来会说「已接上」（cards/clients.js 的
// statusText）—— 对 Cursor CLI 来说**那是误导**：它的请求**仍然走 Cursor 自己的
// 后端**，一个都没到 B.AI；我们只是替它把「用哪个模型」那个 id 改了。
//
// magpie 那边也一样（`docs/reference.md:107`：Cursor CLI **只接管 `model` 一个
// 字段**）⇒ **这是 Cursor CLI 自己的上限，不是我们的缺口** —— 照抄就是正解。
//
// ⇒ 声明上带两个字段给面板用（cards/clients.js 读它们）：
//   · `partial: true`      —— 「接了，但不是接通了」
//   · `partialNote: "…"`   —— 一句话，说清「接到哪、没接到哪、用户该做什么」
//
// 面板上建议这么说（**不要**说「已接上」）：
//
//   只设了模型（不走 B.AI）：Cursor CLI 只跟它自己的后端说话，
//   我们改不了它的地址 ⇒ 它的请求不会经过 B.AI。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel } from "./json-util.mjs";

export const cursorCliClient = {
  id: "cursor-cli",
  name: "Cursor CLI",
  protocol: "chat",
  note: "Cursor 的 CLI（cursor-agent）—— 只改它选哪个模型（请求仍走 Cursor 自己的后端）",
  /* ⚠ **半个接线**：面板上别显示「已接上」（那会误导）——
   *   详见文件头「面板上不能说『已接上』」那节。 */
  partial: true,
  partialNote: "只设了模型（不走 B.AI）：Cursor CLI 只跟它自己的后端说话，我们改不了它的地址 ⇒ 它的请求不会经过 B.AI。",

  files: (ctx) => {
    const file = path.join(ctx.home, ".cursor", "cli-config.json");
    return [
      {
        path: file,
        writes: () => {
          const pick = pickModel(ctx);
          return [
            { path: "model.modelId", value: pick.id },
            { path: "model.displayModelId", value: pick.id },
            /* ⚠ **显示名归用户**（设计稿 §2.2(a)：模型名是「用户可能手改」的字段）。
             *   根模式（`theirs: [""]`）—— 这是「一个 write 只写一个字段」的标量
             *   声明，没法用子路径表达归属：整个值逐值比对，一样就不动，
             *   不一样**用户的赢**（magpie 的 openCodeKept 是同一层意思）。 */
            { path: "model.displayName", value: pick.label || pick.id, merge: { theirs: [""] } },
            /* Cursor 靠这个标记知道「模型被改过」，否则它会按自己的默认走。 */
            { path: "hasChangedDefaultModel", value: true },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "model.modelId");
          return !!(r && r.ok && r.found && r.value);
        },
      },
    ];
  },
};
