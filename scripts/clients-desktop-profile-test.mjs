/**
 * 桌面版那档的模型清单（scripts/clients-desktop-profile-test.mjs）
 *
 * ## 这测的是 2026-10-25 那个 400 的**现场形状**
 *
 *   用户的桌面版那档里 `inferenceModels` 曾经有 **8 条**：
 *     4 条**裸档位**（`claude-fable-5` …，092 的整份覆盖写留下的）
 *     4 条**带前缀**（`mm/claude-fable-5` …，104 的合并写留下的）
 *   ⇒ 桌面版里能选到**裸档位**那条 ⇒ 它原样发给统一网关
 *   ⇒ **400「模型名没有 provider 前缀」**（用户实拍报错）。
 *
 * ## 测什么
 *
 * ★ ① **端到端**（真的走底座：备份 → 写盘 → 读回）：接线后清单里
 *   **不得再有裸档位**，也不得两套并存。
 * ★ ② 用户的显示名（`labelOverride`）留着、`supports1m` 这种我们没写的键也留着。
 * ★ ③ 用户的**自定义条目**（不是我们那几档）原样留着、位置不变。
 * ★ ④ 网关地址写的是**统一网关**（15799），不是某家的中转端口。
 *
 * ## 红线
 *
 * 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真的桌面版配置**。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyClient } from "../src/server/clients/base.mjs";
import { claudeDesktopClient } from "../src/server/clients/claude-desktop.mjs";

/** 我们写进去的那 4 条（带 provider 前缀）。 */
const OURS = [
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-fable-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-sonnet-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-opus-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-haiku-4-5" },
];

/** 用户清单里那 8 条的真实形状（从机器上的备份抄的）。 */
const HAVE_8 = [
  { labelOverride: "MiniMax-M3.1-Flash", name: "claude-fable-5", supports1m: true },
  { labelOverride: "MiniMax-M3.1-Flash", name: "claude-sonnet-5", supports1m: true },
  { labelOverride: "MiniMax-M3.1-Flash", name: "claude-opus-5", supports1m: true },
  { labelOverride: "MiniMax-M3.1-Flash", name: "claude-haiku-4-5", supports1m: true },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-fable-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-sonnet-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-opus-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-haiku-4-5" },
];

function makeHome(have) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bai-deskprofile-"));
  const lib = path.join(home, "AppData", "Local", "Claude-3p", "configLibrary");
  fs.mkdirSync(lib, { recursive: true });
  const file = path.join(lib, "00000000-0000-4000-8000-6261692d726f.json");
  fs.writeFileSync(file, JSON.stringify({
    coworkEgressAllowedHosts: ["*"],
    disableDeploymentModeChooser: true,
    inferenceGatewayApiKey: "mm-local",
    inferenceGatewayAuthScheme: "bearer",
    inferenceGatewayBaseUrl: "http://127.0.0.1:15792",
    inferenceModels: have,
    inferenceProvider: "gateway",
  }, null, 2), "utf8");
  return { home, file };
}

const CTX = (home) => ({
  home,
  baseUrl: "http://127.0.0.1:15799",
  apiKey: "bai-local",
  /* ⚠ ctx.models 的形状是 `{id, label}`（**id 带 provider 前缀**）——
     *   那是 clientCtx 给的（gatewayModelEntries 的结果）。 */
  models: OURS.map((m) => ({ id: m.name, label: m.labelOverride })),
  providerId: "mm",
  providerName: "B.AI",
  channel: { mapping: {}, defaultModel: "MiniMax-M3.1-Flash" },
});

describe("桌面版那档：模型清单不能两套并存", () => {
  test("① 旧写法（裸档位）与新写法并存 ⇒ 收敛成 4 条带前缀的", () => {
    const { home, file } = makeHome(HAVE_8);
    try {
      const r = applyClient(claudeDesktopClient, CTX(home), { dataDir: path.join(home, "data") });
      assert.equal(r.ok, true, r.detail);
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      const bare = after.inferenceModels.filter((m) => !String(m.name).includes("/"));
      assert.equal(bare.length, 0, `★ 裸档位还在：${bare.map((m) => m.name).join(", ")}`);
      assert.deepEqual(after.inferenceModels.map((m) => m.name).sort(), OURS.map((m) => m.name).sort(),
        "★ 清单应当只剩我们那 4 条（带前缀）");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("② 旧版本整份覆盖留下的裸档位 ⇒ 也被换成带前缀的", () => {
    /* 092 的 `applyToDesktop` 是**整份覆盖写** ⇒ 把 104 写对的带前缀条目冲掉了，
       只剩 4 条裸的 ⇒ 桌面版**必然**发裸档位 ⇒ 400。 */
    const { home, file } = makeHome(HAVE_8.slice(0, 4));
    try {
      const r = applyClient(claudeDesktopClient, CTX(home), { dataDir: path.join(home, "data") });
      assert.equal(r.ok, true, r.detail);
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      const bare = after.inferenceModels.filter((m) => !String(m.name).includes("/"));
      assert.equal(bare.length, 0, `★ 裸档位还在：${bare.map((m) => m.name).join(", ")}`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("③ 用户的显示名与我们没写的键都留着；自定义条目原样留着", () => {
    const have = [
      { labelOverride: "我改过的显示名", name: "claude-fable-5", supports1m: true },
      { labelOverride: "我自己加的", name: "my-own-model" },
    ];
    const { home, file } = makeHome(have);
    try {
      const r = applyClient(claudeDesktopClient, CTX(home), { dataDir: path.join(home, "data") });
      assert.equal(r.ok, true, r.detail);
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      const fable = after.inferenceModels.find((m) => m.name === "mm/claude-fable-5");
      assert.ok(fable, "应当有 mm/claude-fable-5 那一条");
      assert.equal(fable.labelOverride, "我改过的显示名", "★ 用户改过的显示名被抹了");
      assert.equal(fable.supports1m, true, "★ 我们没写的键被抹了（弱保留被破坏）");
      const mine = after.inferenceModels.find((m) => m.name === "my-own-model");
      assert.ok(mine, "★ 用户自己加的条目被吃了");
      assert.equal(mine.labelOverride, "我自己加的");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("④ 网关地址写的是统一网关（15799），不是某家的中转端口", () => {
    const { home, file } = makeHome(HAVE_8);
    try {
      const r = applyClient(claudeDesktopClient, CTX(home), { dataDir: path.join(home, "data") });
      assert.equal(r.ok, true, r.detail);
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(after.inferenceGatewayBaseUrl, "http://127.0.0.1:15799",
        "★ 桌面版的网关地址应当是统一网关");
      assert.equal(after.inferenceProvider, "gateway");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
