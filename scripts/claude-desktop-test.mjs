/* Claude 桌面版接线（src/server/clients/claude-desktop.mjs）的口径测试。
 *
 * ## 这一层在做什么
 *
 * Claude 桌面版在 **3p 模式**下从 `<base_url 主机>/muse-code/models`……不，
 * 是从它自己的**配置档**（configLibrary/<id>.json）读「有哪些模型、网关在哪」。
 * 我们写的是：
 *
 *   ① 我们自己那一档  Claude-3p/configLibrary/<固定 id>.json
 *   ② _meta.json      appliedId 指到我们那一档
 *
 * ⚠ 写**自己**那一档而不是用户当前生效的那一档（理由见声明文件头）。
 * ⚠ 模型 id 必须是 `provider/档位` —— 桌面版原样发出去，网关靠前缀分流。
 *
 * ## 测的是这几条
 *
 *   ① 写出的键与 magpie 的形状一致（internal/agent/claudedesktop.go）。
 *   ② 模型 id 是 provider/档位；标签是友好名；supports1m 与旧行为一致。
 *   ③ **用户收紧过的政策键不被覆盖**（coworkEgressAllowedHosts 是安全相关的）。
 *   ④ 断开后**逐字**还原：用户的 _meta.json 与他当前那一档一个字都不动。
 *   ⑤ 生效的是我们这一档（appliedId）。
 *
 * 反向对照在最后一节：把实现改坏（复制到临时目录改一改再 import 进来），
 * 证明前面那些断言**真的会红** —— 不会红的断言等于没写。
 *
 * 落盘只在 os.tmpdir()：**绝不碰**用户真的 %LOCALAPPDATA%\Claude-3p。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyClient, revertClient, clientStatus } from "../src/server/clients/base.mjs";
import { claudeDesktopClient, DESKTOP_PROFILE_ID } from "../src/server/clients/claude-desktop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "server", "clients", "claude-desktop.mjs");
const CLIENTS_DIR = path.join(HERE, "..", "src", "server", "clients");
const SERVER_DIR = path.join(HERE, "..", "src", "server");

/* 假凭据：明显不是真的。 */
const FAKE_KEY = "bai-local";
const BASE_URL = "http://127.0.0.1:15999";

const MODELS = [
  { id: "sn/claude-opus-5", label: "Claude Opus 5" },
  { id: "sn/claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "sn/claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "sn/claude-fable-5", label: "Claude Fable 5" },
  { id: "bai/claude-opus-5", label: "Claude Opus 5" },
];

/** 用户当前生效的那一档（CC Switch 写的）。 */
const USER_PROFILE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let tmpSeq = 0;

/** 造一个沙箱 home：把用户的配置摆进去。 */
function makeHome(userProfile) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-desktop-test-"));
  const lib = path.join(home, "AppData", "Local", "Claude-3p", "configLibrary");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "_meta.json"), JSON.stringify({
    appliedId: USER_PROFILE_ID,
    entries: [{ id: USER_PROFILE_ID, name: "CC Switch" }],
    userOwnKey: "keep-me",
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(lib, USER_PROFILE_ID + ".json"), JSON.stringify({
    inferenceProvider: "anthropic",
    inferenceGatewayBaseUrl: "https://api.anthropic.com",
    inferenceGatewayApiKey: "user-own-key",
    userOwnKey: "keep-me",
  }, null, 2) + "\n", "utf8");
  return { home, lib, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "claude-desktop-data-")) };
}

function ctxOf(home) {
  return {
    home,
    baseUrl: BASE_URL,
    apiKey: FAKE_KEY,
    models: MODELS,
    providerId: "sn",
    providerName: "B.AI",
  };
}

const libOf = (home) => path.join(home, "AppData", "Local", "Claude-3p", "configLibrary");
const profileOf = (home) => path.join(libOf(home), DESKTOP_PROFILE_ID + ".json");
const metaOf = (home) => path.join(libOf(home), "_meta.json");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

/* ====================================================================== *
 * ① 写出的形状
 * ====================================================================== */
describe("① 接上 ⇒ 写出的键与 magpie 一致", () => {
  test("①a 我们那一档：七个键都在", async () => {
    const { home, dataDir } = makeHome();
    const r = applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    assert.equal(r.ok, true, `接线失败：${r.detail}`);
    const p = readJson(profileOf(home));
    assert.equal(p.inferenceProvider, "gateway");
    assert.equal(p.inferenceGatewayBaseUrl, BASE_URL, "网关地址要指向统一网关");
    assert.equal(p.inferenceGatewayApiKey, FAKE_KEY, "令牌写占位符（网关用自己配的凭据）");
    assert.equal(p.inferenceGatewayAuthScheme, "bearer");
    assert.ok(Array.isArray(p.inferenceModels), "inferenceModels 是数组");
  });

  test("①b 模型 id 是 provider/档位（桌面版原样发出去，网关靠前缀分流）", async () => {
    const { home, dataDir } = makeHome();
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    const p = readJson(profileOf(home));
    assert.ok(p.inferenceModels.length, "得有模型");
    for (const m of p.inferenceModels) {
      assert.match(String(m.name || ""), /^[a-z0-9]+\/[A-Za-z0-9._-]+$/,
        `模型 id 必须是 provider/档位：「${m.name}」`);
    }
    assert.ok(p.inferenceModels.some((m) => m.name === "sn/claude-opus-5"),
      "当前这一家的档位要在清单里");
    assert.ok(!p.inferenceModels.some((m) => m.name === "bai/claude-opus-5"),
      "别的家不在这一档里（菜单里会出现一堆重名）");
    assert.equal(p.inferenceModels[0].labelOverride, "Claude Opus 5", "标签是友好名");
    /* ⚠ **supports1m 不许写**：我们不知道这一档背后是哪个模型（写 true 是撒谎，
     *   写 false 是在断言「不支持」）——「不知道」的正确表达是**没有这个键**。 */
    assert.equal("supports1m" in p.inferenceModels[0], false,
      "★ 写了 supports1m（我们只是不知道它支不支持 1M）");
  });

  test("①c appliedId 指到我们这一档，entries 里也加了我们那条", async () => {
    const { home, dataDir } = makeHome();
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    const m = readJson(metaOf(home));
    assert.equal(m.appliedId, DESKTOP_PROFILE_ID);
    assert.ok(Array.isArray(m.entries));
    assert.equal(m.entries.length, 2, "用户那条 + 我们那条");
    assert.equal(m.entries[0].id, USER_PROFILE_ID, "用户那条留在前面");
    assert.equal(m.entries[1].id, DESKTOP_PROFILE_ID);
  });

  test("①d 用户当前生效的那一档，一个字节都没动", async () => {
    const { home, dataDir } = makeHome();
    const before = fs.readFileSync(path.join(libOf(home), USER_PROFILE_ID + ".json"), "utf8");
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    const after = fs.readFileSync(path.join(libOf(home), USER_PROFILE_ID + ".json"), "utf8");
    assert.equal(after, before, "我们写的是自己那一档，不碰用户当前那一档");
  });
});

/* ====================================================================== *
 * ② 用户收紧过的政策键不许覆盖
 * ====================================================================== */
describe("② 用户收紧过的设置不许覆盖", () => {
  test("②a 用户自己的 coworkEgressAllowedHosts 留着，我们不覆盖它", async () => {
    const { home, dataDir } = makeHome();
    /* 桌面版里收紧过：只允许一个主机。 */
    const f = path.join(libOf(home), DESKTOP_PROFILE_ID + ".json");
    fs.writeFileSync(f, JSON.stringify({ coworkEgressAllowedHosts: ["corp.example"] }, null, 2) + "\n", "utf8");
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    const p = readJson(f);
    assert.deepEqual(p.coworkEgressAllowedHosts, ["corp.example"],
      "用户收紧过的出网白名单不许被我们覆盖成 [*]");
  });

  test("②b 用户没有的那两个政策键，我们种下默认值", async () => {
    const { home, dataDir } = makeHome();
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    const p = readJson(profileOf(home));
    assert.equal(p.disableDeploymentModeChooser, true);
    assert.deepEqual(p.coworkEgressAllowedHosts, ["*"]);
  });
});

/* ====================================================================== *
 * ③ 状态
 * ====================================================================== */
describe("③ 面板上的状态", () => {
  test("③a 接上之后说「已接到 B.AI」", async () => {
    const { home, dataDir } = makeHome();
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    const st = clientStatus(claudeDesktopClient, ctxOf(home), { dataDir });
    assert.equal(st.wired, true, `状态说没接：${JSON.stringify(st)}`);
  });

  test("③b 还没接的时候说「还没接」", async () => {
    const { home, dataDir } = makeHome();
    const st = clientStatus(claudeDesktopClient, ctxOf(home), { dataDir });
    assert.equal(st.wired, false);
  });
});

/* ====================================================================== *
 * ④ 断开：逐字还原
 * ====================================================================== */
describe("④ 断开 ⇒ 逐字还原", () => {
  test("④a 用户的 _meta.json 与他当前那一档都逐字还原", async () => {
    const { home, dataDir } = makeHome();
    const metaBefore = fs.readFileSync(metaOf(home), "utf8");
    const profBefore = fs.readFileSync(path.join(libOf(home), USER_PROFILE_ID + ".json"), "utf8");
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    const rv = revertClient(claudeDesktopClient, { dataDir });
    assert.equal(rv.ok, true, `断开失败：${rv.detail}`);
    assert.equal(fs.readFileSync(metaOf(home), "utf8"), metaBefore,
      "_meta.json 断开后必须与接上之前一模一样");
    assert.equal(fs.readFileSync(path.join(libOf(home), USER_PROFILE_ID + ".json"), "utf8"), profBefore,
      "用户当前那一档必须原样");
  });

  test("④b 我们那一档里不留我们的键（底座只还原键路径，不删文件）", async () => {
    const { home, dataDir } = makeHome();
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    revertClient(claudeDesktopClient, { dataDir });
    const p = readJson(profileOf(home));
    assert.equal(p.inferenceGatewayBaseUrl, undefined, "断开后不该还指着我们");
    assert.equal(p.inferenceModels, undefined, "断开后不该还留着模型清单");
    assert.equal(p.inferenceProvider, undefined, "断开后不该还声明自己是 gateway");
    assert.equal(p.inferenceGatewayApiKey, undefined, "断开后不该还留着令牌");
  });

  test("④c 断开后状态说「还没接」", async () => {
    const { home, dataDir } = makeHome();
    applyClient(claudeDesktopClient, ctxOf(home), { dataDir });
    revertClient(claudeDesktopClient, { dataDir });
    const st = clientStatus(claudeDesktopClient, ctxOf(home), { dataDir });
    assert.equal(st.wired, false);
  });
});

/* ====================================================================== *
 * ⑤ 反向对照：把实现改坏，证明前面的断言真的会红
 * ====================================================================== */

/**
 * 把声明与它的依赖复制到临时目录、改坏声明，再 import 进来。
 *
 * ⚠ 依赖也要复制：声明 import 的是 ./json-util.mjs 与 ./base.mjs，
 *   它们再 import ../edit-json.mjs —— 只复制声明的话，import 会断。
 *   目录形状照原样（clients/ 与 edit-json.mjs 平级）。
 */
async function mutant(replacements) {
  const src = readFileSync(SRC, "utf8");
  let out = src;
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `改坏用的锚点不在源码里：${JSON.stringify(from)}`);
    out = out.replace(from, to);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-desktop-mutant-"));
  const clients = path.join(root, "clients");
  fs.mkdirSync(clients, { recursive: true });
  fs.copyFileSync(path.join(SERVER_DIR, "edit-json.mjs"), path.join(root, "edit-json.mjs"));
  for (const f of ["base.mjs", "json-util.mjs", "util.mjs"]) {
    fs.copyFileSync(path.join(CLIENTS_DIR, f), path.join(clients, f));
  }
  const file = path.join(clients, "claude-desktop.mjs");
  fs.writeFileSync(file, out, "utf8");
  const mod = await import(pathToFileURL(file).href);
  return { mod, root };
}

/** 断言「改坏之后这条检查会红」。 */
async function mustGoRed(mod, check, why) {
  let threw = false;
  try {
    await check(mod);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, `改坏之后这条断言竟然还过：${why}`);
}

describe("⑤ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑤a 把模型 id 写成最终模型名 ⇒ ①b 会红", async () => {
    const { mod } = await mutant([
      ["name: m.id,", "name: String(m.id).split(\"/\").pop(),"],
    ]);
    await mustGoRed(mod, async (m) => {
      const { home, dataDir } = makeHome();
      m.mod.applyClient(m.mod.claudeDesktopClient, ctxOf(home), { dataDir });
      const p = readJson(profileOf(home));
      for (const one of p.inferenceModels) {
        assert.match(String(one.name || ""), /^[a-z0-9]+\/[A-Za-z0-9._-]+$/,
          `模型 id 必须是 provider/档位：「${one.name}」`);
      }
    }, "模型 id 写成最终模型名之后，①b 竟然还过");
  });

  test("⑤b 把「用户有就不覆盖」去掉 ⇒ ②a 会红", async () => {
    const { mod } = await mutant([
      ['if (!has("coworkEgressAllowedHosts")) {', "if (true) {"],
    ]);
    await mustGoRed(mod, async (m) => {
      const { home, dataDir } = makeHome();
      const f = path.join(libOf(home), m.mod.DESKTOP_PROFILE_ID + ".json");
      fs.writeFileSync(f, JSON.stringify({ coworkEgressAllowedHosts: ["corp.example"] }, null, 2) + "\n", "utf8");
      m.mod.applyClient(m.mod.claudeDesktopClient, ctxOf(home), { dataDir });
      const p = readJson(f);
      assert.deepEqual(p.coworkEgressAllowedHosts, ["corp.example"],
        "用户收紧过的出网白名单不许被我们覆盖成 [*]");
    }, "覆盖策略被改坏之后，②a 竟然还过");
  });

  test("⑤c 不把 appliedId 指到我们 ⇒ ①c 会红", async () => {
    const { mod } = await mutant([
      ['{ path: "appliedId", value: DESKTOP_PROFILE_ID },', '{ path: "appliedId", value: "somebody-else" },'],
    ]);
    await mustGoRed(mod, async (m) => {
      const { home, dataDir } = makeHome();
      m.mod.applyClient(m.mod.claudeDesktopClient, ctxOf(home), { dataDir });
      const meta = readJson(metaOf(home));
      assert.equal(meta.appliedId, m.mod.DESKTOP_PROFILE_ID, "appliedId 必须指到我们这一档");
    }, "appliedId 改坏之后，①c 竟然还过");
  });

  test("⑤d 改成写用户当前那一档 ⇒ ①d 会红", async () => {
    const { mod } = await mutant([
      ['export const DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-6261692d726f";',
        'export const DESKTOP_PROFILE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";'],
    ]);
    await mustGoRed(mod, async (m) => {
      const { home, dataDir } = makeHome();
      const before = fs.readFileSync(path.join(libOf(home), USER_PROFILE_ID + ".json"), "utf8");
      m.mod.applyClient(m.mod.claudeDesktopClient, ctxOf(home), { dataDir });
      const after = fs.readFileSync(path.join(libOf(home), USER_PROFILE_ID + ".json"), "utf8");
      assert.equal(after, before, "我们写的是自己那一档，不碰用户当前那一档");
    }, "改成写用户那一档之后，①d 竟然还过");
  });
});
