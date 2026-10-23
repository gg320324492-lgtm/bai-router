// src/server/clients/claude-desktop.mjs —— Claude 桌面版（3p 模式：走第三方网关）
//
// ## 配置文件
//
//   %LOCALAPPDATA%\Claude-3p\configLibrary\<配置档 id>.json   ← 我们写的那一档
//   %LOCALAPPDATA%\Claude-3p\configLibrary\_meta.json           ← 指明现在生效的是哪一档
//
// ⚠ **三个同名的地方最容易搞混**（本仓的旧实现也在这里栽过跟头）：
//   · `%APPDATA%\Claude`                —— 桌面版**自己的**数据目录（不是我们写的）
//   · `%LOCALAPPDATA%\Claude-3p`         —— 3p 模式的 userData（**我们在这一带**）
//   · `~/.claude\settings.json`          —— **Claude Code** 的（claude-code.mjs 那一行）
//
// ## magpie 的对应
//
// internal/agent/claudedesktop.go（**不是** desktopapp.go —— 那个只管「桌面应用
// 的版本号」，与配置无关）。magpie 写四样东西：
//
//   ① Claude-3p/configLibrary/<magpie 的 id>.json —— 配置档本体
//   ② Claude-3p/configLibrary/_meta.json          —— appliedId 指到它
//   ③/④ Claude-3p/claude_desktop_config.json 与 Claude/claude_desktop_config.json
//      —— deploymentMode: "3p"（**最后**才写：「到这儿为止桌面版还照原样启动」）
//
// ## 我们写哪两样、为什么不写另两样
//
//   · 我们**写自己的一档**（id 固定）并把 appliedId 指过去 —— 与 magpie 同款。
//     ⚠ **不写用户当前那一档**：那是用户自己的配置（可能是 CC Switch 给别的
//     网关写的），我们改了等于替它做主；而且那一档的 id 在 _meta.json 里，
//     **不是固定路径** —— 底座按「文件路径」备份与还原，路径得是确定的。
//   · 我们**不写 deploymentMode**（3p 模式）：那是桌面版自己的启动模式，
//     切过去会让桌面版不再走 Anthropic 登录 —— 该由用户/CC Switch 决定。
//     ⚠ 桌面版**只在启动时**读一次这些文件 ⇒ 接线完要**重启桌面版**才见效。
//
// ## 模型 id 必须是 `provider/档位`
//
// 桌面版把 `inferenceModels[].name` **原样**当模型发出去，网关靠这个前缀分流
// （前缀不在已知渠道里就 404 —— 网关不猜）。⚠ 写最终模型名就分流不了，
// 而且多档同模型时最终模型名反推不出档位（这一条曾经写反过，代价是
// 「用户点 opus、跑的是 fable 的模型」—— 面板上看不出来）。
//
// ## 令牌写占位符
//
// 网关模式下请求先到**统一网关**，网关再用自己的凭据去调上游 ⇒ 客户端送来的
// 那个 token 对网关没有意义。真写上去反而在用户主目录留了一份明文副本
// （与 claude-code.mjs 同一口径）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { curValue } from "./json-util.mjs";

/**
 * 我们自己那一档的 id。
 *
 * ⚠ 形状照 magpie（`00000000-0000-4000-8000-` + 名字的十六进制：
 * magpie 的后 12 位是 "magpie"，我们的是 "bai-ro"）—— 桌面版把它当普通 UUID 看，
 * 但**固定**这件事对我们更要紧：底座按文件路径备份与还原，路径必须是确定的。
 */
export const DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-6261692d726f";

/** Claude-3p 的数据目录（%LOCALAPPDATA%\Claude-3p）。 */
function desktop3pDir(ctx) {
  return path.join(ctx.home || "", "AppData", "Local", "Claude-3p");
}

/** configLibrary 目录（配置档与 _meta.json 都在这儿）。 */
function desktopLibraryDir(ctx) {
  return path.join(desktop3pDir(ctx), "configLibrary");
}

/**
 * 我们要摆给桌面版的模型清单。
 *
 * ⚠ **只列当前这一家**的档位：网关按 id 的 provider 前缀分流，可列八家，
 *   但八家 × 四档 = 三十多条、标签还全一样（"Claude Opus 5" 出现八次）——
 *   菜单里一片重名。列当前这一家的四档，与本仓旧实现（applyToDesktop 写
 *   S.mapping 的四档）一致。
 */
function desktopModels(ctx) {
  const pid = String(ctx.providerId || "bai");
  const all = Array.isArray(ctx.models) ? ctx.models : [];
  const mine = all.filter((m) => String(m && m.id || "").startsWith(pid + "/"));
  const use = mine.length ? mine : all;
  return use.map((m) => ({
    labelOverride: m.label || m.id,
    name: m.id,
    /* ⚠ **supports1m 我们不写**（与 muse-models.mjs 同一规矩，2026-10-23）：
     *   它说的是「支持 1M 上下文」，而我们**不知道**这一档背后是哪个模型 ——
     *   各家 mapping 不同，同一档在不同渠道背后可能是不同的模型（连 Anthropic
     *   自己那四档的 1M 支持也不一样）。
     *   写 true 是撒谎（用户真发一段超长请求，上游收不下，当场报错）；
     *   写 false 是在断言「不支持」—— 那也只是猜。
     *   键不写 ⇒ 客户端按自己的默认走（保守），将来有了真值再加这个键
     *   （真值从哪来：docs/client-wiring-deep-plan.md 的「模型元数据下发」）。 */
  }));
}

/** 这一档（我们的配置档）要写的键。 */
function profileWrites(ctx) {
  const baseUrl = String(ctx.baseUrl || "").replace(/\/+$/, "");
  const file = path.join(desktopLibraryDir(ctx), DESKTOP_PROFILE_ID + ".json");
  const writes = [
    { path: "inferenceProvider", value: "gateway" },
    { path: "inferenceGatewayBaseUrl", value: baseUrl },
    { path: "inferenceGatewayApiKey", value: ctx.apiKey || "" },
    { path: "inferenceGatewayAuthScheme", value: "bearer" },
  ];
  /* ⚠ **政策只在用户还没有时种下**（magpie 同款，claudedesktop.go:474-480）：
   *   coworkEgressAllowedHosts 是「桌面版允许出网到哪些主机」—— 用户可以在
   *   桌面版里收紧它；我们每次接线都覆盖一遍等于替用户做主（安全相关的设置）。
   *   disableDeploymentModeChooser 同理（用户可能自己关掉那个选择器）。 */
  const has = (p) => {
    const v = curValue(file, "json", p);
    return !v.error && v.existed;
  };
  if (!has("disableDeploymentModeChooser")) {
    writes.push({ path: "disableDeploymentModeChooser", value: true });
  }
  if (!has("coworkEgressAllowedHosts")) {
    writes.push({ path: "coworkEgressAllowedHosts", value: ["*"] });
  }
  writes.push({ path: "inferenceModels", value: desktopModels(ctx) });
  return writes;
}

/** _meta.json：appliedId 指到我们这一档，外加一条我们自己那条 entries。 */
function metaWrites(ctx) {
  const file = path.join(desktopLibraryDir(ctx), "_meta.json");
  const cur = curValue(file, "json", "entries");
  const kept = cur.existed && Array.isArray(cur.value)
    ? cur.value.filter((e) => !(e && String(e.id || "") === DESKTOP_PROFILE_ID))
    : [];
  return [
    { path: "appliedId", value: DESKTOP_PROFILE_ID },
    { path: "entries", value: [...kept, { id: DESKTOP_PROFILE_ID, name: ctx.providerName || "B.AI" }] },
  ];
}

export const claudeDesktopClient = {
  id: "claude-desktop",
  name: "Claude 桌面版",
  protocol: "anthropic",
  note: "Anthropic 的桌面版（写 Claude-3p/configLibrary 里我们那一档）",

  files: (ctx) => {
    const lib = desktopLibraryDir(ctx);
    return [
      {
        /* 我们自己那一档 —— 不是用户当前生效的那一档（理由见文件头）。 */
        path: path.join(lib, DESKTOP_PROFILE_ID + ".json"),
        format: "json",
        writes: (c) => profileWrites(c),
        /* 「接上了」怎么判：这一档的网关地址指向我们（127.0.0.1）。
         * ⚠ 不用「文件里有没有网关地址」这种宽判据 —— 用户自己配过网关时，
         *   那条会误判成接上了（与 claude-code.mjs 同一口径）。 */
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "inferenceGatewayBaseUrl");
          return !!(r && r.ok && r.found && String(r.value || "").includes("127.0.0.1"));
        },
      },
      {
        /* _meta.json：桌面版靠它的 appliedId 知道现在生效的是哪一档。 */
        path: path.join(lib, "_meta.json"),
        format: "json",
        writes: (c) => metaWrites(c),
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "appliedId");
          return !!(r && r.ok && r.found && String(r.value || "") === DESKTOP_PROFILE_ID);
        },
      },
    ];
  },
};
