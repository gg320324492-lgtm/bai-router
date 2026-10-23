// src/server/clients/util.mjs —— 客户端声明共用的两个小工具
//
// ## 这个文件里为什么只有两样东西
//
// 「读用户当前配置」那一类工具（curValue / curObj / mergeObj / rootShapeOf）
// 在 json-util.mjs 里 —— 那是**这一批 JSON 客户端**专用的（TOML / YAML 那一批
// 用不上它们：那两个格式的读写器自己管解析）。
//
// 这里只留**每个客户端都要用**的两样：
//
//   · pickModel —— 接线时选哪个模型（面板上「接到某客户端」是接到一整个网关，
//     不是接到一个模型；用户在客户端自己的选择器里换模型即可）。
//   · envDir —— 读某个客户端自己的环境变量（QWEN_HOME / QODER_CONFIG_DIR…）。
//
// 本文件**不导出任何客户端声明**（没有 id + files 的对象）—— 名录 registry.mjs
// 扫目录时会把这里的函数跳过。

/**
 * pickModel —— 接线时选哪个模型。
 *
 * 清单里的第一个。一个模型都没有 ⇒ 抛错：底座会把它报成
 * 「算 <客户端> 要写什么时出错」，**不写半个配置**（写一个没有模型的
 * provider 块对用户毫无意义）。
 */
export function pickModel(ctx) {
  const ms = (ctx && ctx.models) || [];
  if (!ms.length) throw new Error("没有可选的模型 —— 先在面板上选好模型再接线");
  return ms[0];
}

/**
 * envDir —— 环境变量指的那个目录；没设（或只有空白）⇒ 空串。
 *
 * magpie 对每个客户端都读一个自己的环境变量（QWEN_HOME / QODER_CONFIG_DIR…）。
 * 这里的规矩与 magpie 一致：**设了就用它，没设就用家目录下的默认位置**。
 */
export function envDir(name) {
  return String(process.env[name] || "").trim();
}
