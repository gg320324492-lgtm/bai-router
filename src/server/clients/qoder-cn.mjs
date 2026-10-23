// src/server/clients/qoder-cn.mjs —— Qoder CN 的 CLI（国行）
//
// ## 配置文件
//
//   ~/.qoder-cn/settings.json（$QODERCN_CONFIG_DIR 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/qoder.go 里的 `qoderCN` —— 与国际版**同一个 CLI 的另一个站点**
// （@qodercn-ai/qoderclicn）：配置形状一模一样，只是目录、账号与计划不同
// （国行要 Qoder CN 计划的 BYOK）。
//
// 所以这一份声明直接复用 qoder.mjs 里那个 builder —— 两份抄着改，抄岔了就
// 出「国际版能接、国行接不上」这种查起来很费劲的问题。
//
// ## 我们这层做了什么 / 没做什么
//
// 与 Qoder（国际版）完全一样，见 qoder.mjs 的文件头（provider 那一条 +
// model.name；**不做** effort —— 我们的接线上下文里没有 effort 这一项，不猜）。

import { qoderDecl } from "./qoder.mjs";

export const qoderCnClient = qoderDecl({
  id: "qoder-cn",
  name: "Qoder CN",
  note: "Qoder 的 CLI（国行）",
  env: "QODERCN_CONFIG_DIR",
  dirName: ".qoder-cn",
});
