// src/server/clients/workbuddy-ai.mjs —— WorkBuddy AI（国际版）
//
// ## 配置文件
//
//   ~/.workbuddy-ai/models.json
//   （国际版的数据目录就是 .workbuddy-ai —— 它自己的 cli/product.json 里
//    dataFolderName 写着 ".workbuddy-ai"。**没有**自己的环境变量：
//    $WORKBUDDY_CONFIG_DIR 是国行那份的，两个发行版共用一个变量的话
//    它们会写进同一个文件夹 —— magpie 特意把它们分开（#1494）。）
//
// ## magpie 的对应
//
// internal/agent/workbuddy.go 里的 `workbuddyAI` —— 与 WorkBuddy 是**同一个
// 应用的两个发行版**：形状一模一样（models.json 里的模型条目），
// 只是数据目录不同。所以这一份声明直接复用 workbuddy.mjs 里的 builder。
//
// ## 我们这层做了什么 / 没做什么
//
// 与 WorkBuddy 完全一样，见 workbuddy.mjs 的文件头（把模型写进 models.json；
// **不做** Sync、不写假的上下文窗口与 effort）。

import { workBuddyDecl } from "./workbuddy.mjs";

export const workBuddyAiClient = workBuddyDecl({
  id: "workbuddy-ai",
  name: "WorkBuddy AI",
  note: "WorkBuddy 的国际版（自定义模型）",
  /* 国际版没有自己的环境变量 —— 它固定在 .workbuddy-ai。 */
  env: "",
  dirName: ".workbuddy-ai",
});
