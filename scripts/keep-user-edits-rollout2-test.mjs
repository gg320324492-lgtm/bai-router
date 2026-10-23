/**
 * 「保留用户手改」的通用合并层 · 铺到其余客户端（第二批）
 * （scripts/keep-user-edits-rollout2-test.mjs）
 *
 * ## 测什么
 *
 * 通用合并层（src/server/clients/merge-policy.mjs）在**其余 22 个客户端声明**上：
 *
 *   ★ ① 用户在客户端里**手改过的值**留着（显示名、开关、窗口…）
 *   ★ ② **机器该管的**字段仍然是我们的（地址、令牌、模型 id、方言）
 *   ★ ③ 用户**自己加的**条目 / 键原样留着、位置不变
 *   ★ ④ **断开后文件与「用户改过之后」逐字相同**（硬红线）
 *   ★ ⑤ 再接一次，内容没变 ⇒ **那个文件一个字都不动**
 *
 * ## 每条判据都配了**反向对照**（改坏 ⇒ 必须真的跑红）
 *
 *   ⑥a 把合并层改成「总是我们的赢」   ⇒ ① 的「用户改过的值留着」必须失效
 *   ⑥b 把「备份里存原值」改成「存新值」 ⇒ ④ 的「逐字还原」必须失效
 *   ⑥c 把弱保留改成「抹掉用户的键」   ⇒ ③ 的「用户自己加的留着」必须失效
 *   ⑥d 把**每个客户端自己的归属表**改坏 ⇒ 该客户端的 ① 必须失效
 *
 * ⚠ 改坏副本放在临时目录里 import —— **绝不改仓库里的源码**。
 * ⚠ 锚点与源码脱节时**明确报「锚点与源码脱节」**，不假绿。
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的用户 home**。
 * 🔴 客户端自己的目录变量（QWEN_HOME / GROK_HOME / …）一律清掉，
 *    APPDATA / LOCALAPPDATA / BAI_CLIENT_HOME 指到临时目录。
 * 🔴 全文没有一个真实令牌/API key（夹具里的 key 是明显假的占位串）。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyClient, revertClient, formatOf, backupFileOf } from "../src/server/clients/base.mjs";
import { claudeCodeEdits } from "../src/server/clients/claude-code-edits.mjs";
import "../src/server/clients/formats-json-list.mjs";
import "../src/server/clients/formats-toml.mjs";
import "../src/server/clients/formats-yaml.mjs";
import "../src/server/clients/formats-dotenv.mjs";

import { claudeCodeClient } from "../src/server/clients/claude-code.mjs";
import { claudeDesktopClient, DESKTOP_PROFILE_ID } from "../src/server/clients/claude-desktop.mjs";
import { clineClient } from "../src/server/clients/cline.mjs";
import { codexClient } from "../src/server/clients/codex.mjs";
import { cursorCliClient } from "../src/server/clients/cursor-cli.mjs";
import { droidClient } from "../src/server/clients/droid.mjs";
import { empryoClient } from "../src/server/clients/empryo.mjs";
import { geminiCliClient } from "../src/server/clients/gemini-cli.mjs";
import { gooseClient } from "../src/server/clients/goose.mjs";
import { grokClient } from "../src/server/clients/grok.mjs";
import { hermesClient } from "../src/server/clients/hermes.mjs";
import { jcodeClient } from "../src/server/clients/jcode.mjs";
import { kimiCodeClient } from "../src/server/clients/kimi-code.mjs";
import { minimaxCodeClient } from "../src/server/clients/minimax-code.mjs";
import { morphClient } from "../src/server/clients/morph.mjs";
import { museClient } from "../src/server/clients/muse.mjs";
import { ompClient } from "../src/server/clients/omp.mjs";
import { piClient } from "../src/server/clients/pi.mjs";
import { qoderClient } from "../src/server/clients/qoder.mjs";
import { qoderCnClient } from "../src/server/clients/qoder-cn.mjs";
import { reasonixClient } from "../src/server/clients/reasonix.mjs";
import { stepcodeClient } from "../src/server/clients/stepcode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-keep-rollout2-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ------------------------------------------------------------------ *
 * 隔离：客户端自己的目录变量一律清掉，APPDATA / LOCALAPPDATA 指到临时目录
 * ------------------------------------------------------------------ */
for (const k of ["WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "QWEN_HOME",
  "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "QODER_CONFIG_DIR", "QODERCN_CONFIG_DIR",
  "GROK_HOME", "KIMI_SHARE_DIR", "JCODE_HOME", "STEPCODE_CONFIG_DIR", "MINIMAX_DATA_DIR",
  "FACTORY_HOME_OVERRIDE", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE",
  "PI_PROFILE", "MISTER_MORPH_CONFIG", "HERMES_HOME", "REASONIX_HOME", "CLINE_DIR",
  "CLINE_DATA_DIR"]) {
  delete process.env[k];
}
process.env.APPDATA = path.join(TMPROOT, "appdata");
process.env.LOCALAPPDATA = path.join(TMPROOT, "localappdata");
process.env.BAI_CLIENT_HOME = path.join(TMPROOT, "client-home");

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `r${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 接线上下文（第二个模型的 id **带点** —— 键里带点的那条路要一起测）。 */
const CTX = {
  home: "",
  baseUrl: "http://127.0.0.1:15799",
  apiKey: "bai-local",
  models: [
    { id: "sn/claude-opus-5", label: "Claude Opus 5" },
    { id: "sn/glm-5.2", label: "GLM 5.2" },
  ],
  providerId: "bai",
  providerName: "B.AI",
  /* Claude Code 那条线复用既有的接线逻辑（纯函数 claudeCodeEdits）——
     传**真的**那个函数、给假的事实 ⇒ 测的是真的逻辑。 */
  cli: {
    editsFor: () => claudeCodeEdits({
      tiers: [
        { key: "claude-fable-5", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL" },
        { key: "claude-sonnet-5", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
        { key: "claude-opus-5", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
        { key: "claude-haiku-4-5", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
      ],
      gw: true,
      gatewayBaseUrl: CTX.baseUrl,
      cliBaseUrl: CTX.baseUrl,
      viaLocalRelay: false,
      proxyManagedToken: "test-placeholder-token",
      providerId: "bai",
      channelId: "bai",
      key: CTX.apiKey,
      mapping: { "claude-opus-5": { target: "test-target-opus", label: "档·Opus" } },
      defaultModel: "test-target-default",
      proxy: "http://127.0.0.1:7897",
    }),
  },
};

const OLD_URL = "http://127.0.0.1:15798";

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
/** 夹具一律用紧凑 JSON —— 断开后要逐字相同（排版也得一样）。 */
function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj));
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
/** 从 TOML / YAML / dotenv 里取一个键路径上的值（用**格式自己的**读取器）。 */
function at(fmtName, file, p) {
  const fmt = formatOf(fmtName);
  const r = fmt.getPath(fs.readFileSync(file, "utf8"), p);
  if (!r.ok) throw new Error(`读 ${file} 的 ${p} 失败：${r.error}`);
  return r.found ? r.value : undefined;
}

/* ------------------------------------------------------------------ *
 * 22 个客户端的夹具与判据
 *
 * 每一条：
 *   · `files`  —— 这个客户端要改哪些文件（相对 ctx.home；APPDATA 下的用绝对路径）
 *   · `seed`   —— 造一份「用户已经改过」的用户配置
 *   · `kept`   —— 那个**必须留着**的用户改过的值（反向对照 ⑥d 就盯它）
 *   · `check`  —— 其余判据（机器该管的、用户自己的条目、位置不变…）
 * ------------------------------------------------------------------ */

/** 每个客户端「用户改过的那个值」该是什么。 */
const EXPECT_KEEP = {
  "claude-code": "我改过的名字",
  "claude-desktop": "我改过的名字",
  "cline": "我改过的模型名",
  "codex": "我改过的名字",
  "cursor-cli": "我改过的名字",
  "droid": "我改过的名字",
  "empryo": "我改过的名字",
  "goose": "我改过的名字",
  "grok": "我改过的名字",
  "hermes": "我改过的名字",
  "jcode": 200000,
  "kimi-code": "我改过的名字",
  "minimax-code": "我改过的名字",
  "morph": 200000,
  "omp": "我改过的名字",
  "pi": "我改过的模型名",
  "qoder": "我改过的模型名",
  "qoder-cn": "我改过的模型名",
  "stepcode": "我改过的名字",
};

const CASES = [
  {
    id: "claude-code",
    def: claudeCodeClient,
    files: (h) => [path.join(h, ".claude", "settings.json")],
    seed: (h) => writeJson(path.join(h, ".claude", "settings.json"), {
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "我改过的名字",
        ANTHROPIC_BASE_URL: OLD_URL,
        MY_OWN: "1",
      },
    }),
    kept: (h) => readJson(path.join(h, ".claude", "settings.json")).env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME,
    check: (h) => {
      const j = readJson(path.join(h, ".claude", "settings.json"));
      assert.equal(j.env.ANTHROPIC_BASE_URL, CTX.baseUrl, "★ 地址是机器该管的 ⇒ 必须换成我们的");
      assert.equal(j.env.MY_OWN, "1", "★ 用户自己在 env 里的键被动了");
      assert.equal(j.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "bai/claude-opus-5", "模型 id 是机器该管的");
    },
  },
  {
    id: "claude-desktop",
    def: claudeDesktopClient,
    files: (h) => [
      path.join(h, "AppData", "Local", "Claude-3p", "configLibrary", DESKTOP_PROFILE_ID + ".json"),
      path.join(h, "AppData", "Local", "Claude-3p", "configLibrary", "_meta.json"),
    ],
    seed: (h) => {
      const lib = path.join(h, "AppData", "Local", "Claude-3p", "configLibrary");
      writeJson(path.join(lib, DESKTOP_PROFILE_ID + ".json"), {
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: OLD_URL,
        inferenceGatewayApiKey: "旧key",
        inferenceGatewayAuthScheme: "bearer",
        disableDeploymentModeChooser: false,
        inferenceModels: [
          { labelOverride: "我改过的名字", name: "sn/claude-opus-5" },
          { labelOverride: "我自己的模型", name: "我自己的/模型" },
        ],
      });
      writeJson(path.join(lib, "_meta.json"), {
        appliedId: "别人的-档",
        entries: [
          { id: "别人的-档", name: "别人的" },
          { id: DESKTOP_PROFILE_ID, name: "我改过的档名" },
        ],
      });
    },
    kept: (h) => readJson(path.join(h, "AppData", "Local", "Claude-3p", "configLibrary", DESKTOP_PROFILE_ID + ".json")).inferenceModels[0].labelOverride,
    check: (h) => {
      const lib = path.join(h, "AppData", "Local", "Claude-3p", "configLibrary");
      const p = readJson(path.join(lib, DESKTOP_PROFILE_ID + ".json"));
      assert.equal(p.inferenceModels[0].name, "sn/claude-opus-5", "★ 模型 id 是机器该管的");
      assert.equal(p.inferenceModels[0].labelOverride, "我改过的名字", "★ 用户改过的显示名被改回去了");
      assert.deepEqual(p.inferenceModels[1], { labelOverride: "我自己的模型", name: "我自己的/模型" },
        "★ 用户自己加的模型被抹了");
      assert.equal(p.inferenceGatewayBaseUrl, CTX.baseUrl, "地址是机器该管的");
      assert.equal(p.disableDeploymentModeChooser, false, "★ 用户关掉的开关被我们打开了");
      const m = readJson(path.join(lib, "_meta.json"));
      assert.equal(m.entries[1].name, "我改过的档名", "★ 用户改过的档名被改回去了");
      assert.equal(m.entries[1].id, DESKTOP_PROFILE_ID, "档 id 是机器该管的");
      assert.deepEqual(m.entries[0], { id: "别人的-档", name: "别人的" }, "★ 别人的那一档被动");
      assert.equal(m.appliedId, DESKTOP_PROFILE_ID, "appliedId 是机器该管的");
    },
  },
  {
    id: "cline",
    def: clineClient,
    files: (h) => [
      path.join(h, ".cline", "data", "settings", "providers.json"),
      path.join(h, ".cline", "data", "settings", "models.json"),
    ],
    seed: (h) => {
      const dir = path.join(h, ".cline", "data", "settings");
      writeJson(path.join(dir, "providers.json"), {
        version: 1,
        providers: {
          "openai-compatible": {
            settings: {
              provider: "openai-compatible",
              apiKey: "旧key",
              model: "old/x",
              baseUrl: OLD_URL,
              headers: { "User-Agent": "cline", "X-Mine": "1" },
              /* ⚠ Cline 自己的形状：思考档在 **settings 里**（magpie cline.go
                 写的也是 settings.reasoning）—— 用户自己调的那一档要留着。 */
              reasoning: { effort: "high" },
            },
            updatedAt: "2020-01-01T00:00:00.000Z",
            tokenSource: "manual",
          },
          mine: { settings: { provider: "mine" } },
        },
        lastUsedProvider: "openai-compatible",
      });
      writeJson(path.join(dir, "models.json"), {
        version: 1,
        providers: {
          "openai-compatible": {
            provider: { name: "我改过的 provider 名", baseUrl: OLD_URL, defaultModelId: "old/x" },
            models: {
              "sn/claude-opus-5": { id: "sn/claude-opus-5", name: "我改过的模型名", capabilities: ["streaming"] },
              "我自己的/模型": { id: "我自己的/模型", name: "我自己的模型", capabilities: ["streaming"] },
            },
          },
        },
      });
    },
    kept: (h) => readJson(path.join(h, ".cline", "data", "settings", "models.json"))
      .providers["openai-compatible"].models["sn/claude-opus-5"].name,
    check: (h) => {
      const dir = path.join(h, ".cline", "data", "settings");
      const p = readJson(path.join(dir, "providers.json"));
      assert.equal(p.providers["openai-compatible"].settings.baseUrl, CTX.baseUrl, "地址是机器该管的");
      assert.equal(p.providers["openai-compatible"].settings.model, "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.equal(p.providers["openai-compatible"].settings.reasoning.effort, "high",
        "★ 用户自己设的思考档被盖掉了");
      assert.equal(p.providers["openai-compatible"].settings.headers["X-Mine"], "1",
        "★ 用户自己加的头被盖掉了");
      assert.deepEqual(p.providers.mine, { settings: { provider: "mine" } }, "★ 别的 provider 被动");
      const m = readJson(path.join(dir, "models.json"));
      const bai = m.providers["openai-compatible"];
      assert.equal(bai.provider.name, "我改过的 provider 名", "★ 用户改过的 provider 名被改回去了");
      assert.equal(bai.provider.baseUrl, CTX.baseUrl, "地址是机器该管的");
      assert.equal(bai.models["sn/claude-opus-5"].name, "我改过的模型名", "★ 用户改过的模型名被改回去了");
      assert.ok(bai.models["sn/glm-5.2"], "★ 我们另一条模型没写进去");
      assert.deepEqual(bai.models["我自己的/模型"], { id: "我自己的/模型", name: "我自己的模型", capabilities: ["streaming"] },
        "★ 用户自己加的模型被抹了");
    },
  },
  {
    id: "codex",
    def: codexClient,
    files: (h) => [path.join(h, ".codex", "config.toml")],
    seed: (h) => writeText(path.join(h, ".codex", "config.toml"), [
      'model_provider = "other"',
      'model = "old/x"',
      "",
      "[model_providers.other]",
      'name = "别人的"',
      'base_url = "https://elsewhere/v1"',
      "",
      "[model_providers.bai]",
      'name = "我改过的名字"',
      'base_url = "https://old/v1"',
      'wire_api = "responses"',
      'experimental_bearer_token = "旧key"',
      "",
    ].join("\n")),
    kept: (h) => at("toml", path.join(h, ".codex", "config.toml"), "model_providers.bai.name"),
    check: (h) => {
      const f = path.join(h, ".codex", "config.toml");
      assert.equal(at("toml", f, "model_providers.bai.base_url"), CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(at("toml", f, "model_providers.bai.experimental_bearer_token"), CTX.apiKey, "令牌是机器该管的");
      assert.equal(at("toml", f, "model_providers.bai.wire_api"), "responses", "方言是机器该管的");
      assert.equal(at("toml", f, "model_providers.other.name"), "别人的", "★ 别人的 provider 被动");
      assert.equal(at("toml", f, "model"), "sn/claude-opus-5", "模型 id 是机器该管的");
    },
  },
  {
    id: "cursor-cli",
    def: cursorCliClient,
    files: (h) => [path.join(h, ".cursor", "cli-config.json")],
    seed: (h) => writeJson(path.join(h, ".cursor", "cli-config.json"), {
      model: { modelId: "old/x", displayModelId: "old/x", displayName: "我改过的名字", extra: 1 },
      hasChangedDefaultModel: false,
      theme: "dark",
    }),
    kept: (h) => readJson(path.join(h, ".cursor", "cli-config.json")).model.displayName,
    check: (h) => {
      const j = readJson(path.join(h, ".cursor", "cli-config.json"));
      assert.equal(j.model.modelId, "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.equal(j.model.displayModelId, "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.equal(j.model.extra, 1, "★ 用户自己在 model 里加的键被盖掉了");
      assert.equal(j.hasChangedDefaultModel, true, "hasChangedDefaultModel 是机器该管的");
      assert.equal(j.theme, "dark", "★ 用户的其它配置被动");
    },
  },
  {
    id: "droid",
    def: droidClient,
    files: (h) => [path.join(h, ".factory", "settings.json")],
    seed: (h) => writeJson(path.join(h, ".factory", "settings.json"), {
      customModels: [
        {
          model: "sn/claude-opus-5", id: "custom:bai/sn/claude-opus-5", displayName: "我改过的名字",
          baseUrl: OLD_URL, apiKey: "旧key", provider: "generic-chat-completion-api",
        },
        {
          model: "other", id: "custom:other/x", displayName: "我自己的", baseUrl: "https://elsewhere",
          apiKey: "别人的key", provider: "anthropic",
        },
      ],
      sessionDefaultSettings: { model: "custom:other/x", temperature: 0.2 },
    }),
    kept: (h) => readJson(path.join(h, ".factory", "settings.json")).customModels[0].displayName,
    check: (h) => {
      const j = readJson(path.join(h, ".factory", "settings.json"));
      const list = j.customModels;
      assert.equal(list[0].id, "custom:bai/sn/claude-opus-5", "★ 我们的条目被挪位了");
      assert.equal(list[0].baseUrl, CTX.baseUrl, "地址是机器该管的");
      assert.equal(list[0].apiKey, CTX.apiKey, "令牌是机器该管的");
      assert.equal(list[1].id, "custom:other/x", "★ 用户自己的条目被挪位/抹了");
      assert.equal(list[1].baseUrl, "https://elsewhere", "★ 用户自己条目的地址被我们改了");
      assert.equal(list[1].displayName, "我自己的", "★ 用户自己条目的名字被我们改了");
      assert.ok(list.some((e) => e.id === "custom:bai/sn/glm-5.2"), "★ 我们另一条模型没写进去");
      assert.equal(j.sessionDefaultSettings.temperature, 0.2, "★ 用户自己的设置被动");
    },
  },
  {
    id: "empryo",
    def: empryoClient,
    files: (h) => [path.join(h, ".empryo", "config.json")],
    seed: (h) => writeJson(path.join(h, ".empryo", "config.json"), {
      providers: [
        { id: "other", name: "我自己的", baseURL: "https://elsewhere", envVar: "MY_KEY" },
        { id: "bai", name: "我改过的名字", baseURL: OLD_URL, modelsAPI: `${OLD_URL}/v1/models`, envVar: "MY_KEY" },
      ],
      defaultModel: "other/x",
    }),
    kept: (h) => readJson(path.join(h, ".empryo", "config.json")).providers[1].name,
    check: (h) => {
      const j = readJson(path.join(h, ".empryo", "config.json"));
      assert.equal(j.providers[0].id, "other", "★ 用户自己的 provider 被挪位/抹了");
      assert.equal(j.providers[0].baseURL, "https://elsewhere", "★ 用户自己 provider 的地址被我们改了");
      assert.equal(j.providers[1].baseURL, CTX.baseUrl, "地址是机器该管的");
      assert.equal(j.providers[1].modelsAPI, `${CTX.baseUrl}/v1/models`, "列模型的地址是机器该管的");
      assert.equal(j.providers[1].envVar, "MY_KEY", "★ 用户自己填的 envVar 被盖掉了");
      assert.equal(j.defaultModel, "bai/sn/claude-opus-5", "默认模型是机器该管的");
    },
  },
  {
    id: "gemini-cli",
    def: geminiCliClient,
    files: (h) => [
      path.join(h, ".gemini", "settings.json"),
      path.join(h, ".gemini", ".env"),
    ],
    seed: (h) => {
      writeJson(path.join(h, ".gemini", "settings.json"), {
        security: { auth: { selectedType: "oauth-personal" } },
        model: { name: "old/x" },
        theme: "dark",
      });
      writeText(path.join(h, ".gemini", ".env"), "GOOGLE_GEMINI_BASE_URL=" + OLD_URL + "\nMY_OWN=1\n");
    },
    /* ⚠ 这个客户端**没有**「用户可能手改」的字段（每一个都是机器该管的）⇒
       它不该有任何「保留」声明 —— 这一条就是**如实记录那个事实**。 */
    kept: null,
    check: (h) => {
      const s = readJson(path.join(h, ".gemini", "settings.json"));
      assert.equal(s.security.auth.selectedType, "gemini-api-key", "auth 类型是机器该管的");
      assert.equal(s.model.name, "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.equal(s.theme, "dark", "★ 用户的其它配置被动");
      const env = at("dotenv", path.join(h, ".gemini", ".env"), "MY_OWN");
      assert.equal(env, "1", "★ 用户自己在 .env 里的键被盖掉了");
    },
  },
  {
    id: "goose",
    def: gooseClient,
    files: (h) => [
      path.join(process.env.APPDATA, "Block", "goose", "config", "config.yaml"),
      path.join(process.env.APPDATA, "Block", "goose", "config", "custom_providers", "bai.json"),
    ],
    seed: (h) => {
      const dir = path.join(process.env.APPDATA, "Block", "goose", "config");
      writeText(path.join(dir, "config.yaml"), [
        "active_provider: other",
        "providers:",
        "  bai:",
        "    enabled: false",
        "    model: old/x",
        "    configured: true",
        "  other:",
        "    enabled: true",
        "",
      ].join("\n"));
      writeJson(path.join(dir, "custom_providers", "bai.json"), {
        name: "bai",
        engine: "openai",
        display_name: "我改过的名字",
        description: "我的描述",
        api_key_env: "",
        base_url: `${OLD_URL}/v1`,
        headers: { Authorization: "Bearer 旧key", "X-Mine": "1" },
        requires_auth: false,
        skip_canonical_filtering: true,
        dynamic_models: false,
        models: [
          { name: "sn/claude-opus-5", context_limit: 200000 },
          { name: "我自己的/模型", context_limit: 9999 },
        ],
      });
    },
    kept: (h) => readJson(path.join(process.env.APPDATA, "Block", "goose", "config", "custom_providers", "bai.json")).display_name,
    check: (h) => {
      const dir = path.join(process.env.APPDATA, "Block", "goose", "config");
      const y = path.join(dir, "config.yaml");
      assert.equal(at("yaml", y, "providers.bai.enabled"), false, "★ 用户关掉的 provider 被我们打开了");
      assert.equal(at("yaml", y, "providers.bai.model"), "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.equal(at("yaml", y, "providers.other.enabled"), true, "★ 别人的 provider 被动");
      assert.equal(at("yaml", y, "active_provider"), "bai", "active_provider 是机器该管的");
      const j = readJson(path.join(dir, "custom_providers", "bai.json"));
      assert.equal(j.base_url, CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(j.headers.Authorization, `Bearer ${CTX.apiKey}`, "令牌是机器该管的");
      assert.equal(j.headers["X-Mine"], "1", "★ 用户自己加的头被盖掉了");
      assert.equal(j.models[0].context_limit, 200000, "★ 用户自己调的窗口被盖掉了");
      assert.deepEqual(j.models[1], { name: "我自己的/模型", context_limit: 9999 }, "★ 用户自己加的模型被抹了");
    },
  },
  {
    id: "grok",
    def: grokClient,
    files: (h) => [path.join(h, ".grok", "config.toml")],
    seed: (h) => writeText(path.join(h, ".grok", "config.toml"), [
      "[models]",
      'default = "old/x"',
      "",
      "[features]",
      "campaigns = true",
      "",
      '[model."bai/sn/claude-opus-5"]',
      'model = "sn/claude-opus-5"',
      'name = "我改过的名字"',
      'base_url = "https://old/v1"',
      'api_key = "旧key"',
      'api_backend = "chat_completions"',
      "context_window = 200000",
      "",
    ].join("\n")),
    kept: (h) => at("toml", path.join(h, ".grok", "config.toml"), 'model."bai/sn/claude-opus-5".name'),
    check: (h) => {
      const f = path.join(h, ".grok", "config.toml");
      const t = 'model."bai/sn/claude-opus-5"';
      assert.equal(at("toml", f, `${t}.base_url`), CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(at("toml", f, `${t}.api_key`), CTX.apiKey, "令牌是机器该管的");
      assert.equal(at("toml", f, `${t}.context_window`), 200000, "★ 用户自己调的窗口被盖掉了");
      assert.equal(at("toml", f, "models.default"), "bai/sn/claude-opus-5", "默认模型是机器该管的");
      assert.equal(at("toml", f, "features.campaigns"), false, "战役开关是机器该管的");
    },
  },
  {
    id: "hermes",
    def: hermesClient,
    files: (h) => [path.join(h, ".hermes", "config.yaml")],
    seed: (h) => {
      fs.mkdirSync(path.join(h, ".hermes"), { recursive: true });
      writeText(path.join(h, ".hermes", "config.yaml"), [
        "model:",
        "  provider: other",
        "  default: other/x",
        "providers:",
        "  bai:",
        "    name: 我改过的名字",
        "    base_url: https://old/v1",
        "    api_key: 旧key",
        "    api_mode: chat_completions",
        "    model: old/x",
        "    models:",
        "      - old/x",
        "    extra_key: 1",
        "",
      ].join("\n"));
    },
    kept: (h) => at("yaml", path.join(h, ".hermes", "config.yaml"), "providers.bai.name"),
    check: (h) => {
      const f = path.join(h, ".hermes", "config.yaml");
      assert.equal(at("yaml", f, "providers.bai.base_url"), CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(at("yaml", f, "providers.bai.api_key"), CTX.apiKey, "令牌是机器该管的");
      assert.equal(at("yaml", f, "providers.bai.extra_key"), 1, "★ 用户自己加的键被盖掉了");
      assert.equal(at("yaml", f, "model.provider"), "bai", "model.provider 是机器该管的");
    },
  },
  {
    id: "jcode",
    def: jcodeClient,
    files: (h) => [path.join(h, ".jcode", "config.toml")],
    seed: (h) => writeText(path.join(h, ".jcode", "config.toml"), [
      "[provider]",
      'default_provider = "other"',
      'default_model = "old/x"',
      "",
      "[providers.bai]",
      'type = "openai-compatible"',
      'base_url = "https://old/v1"',
      'api_key = "旧key"',
      "requires_api_key = true",
      'extra_key = "keep"',
      /* ⚠ 数组写成**多行**（TOML 写入器写数组的规范形状）—— 写入器会把它
       *   规范化成这个形状 ⇒ 夹具也得是它，否则「断开后逐字相同」比的是
       *   「排版被规范化了」而不是「内容没变」。 */
      "models = [",
      '  { id = "sn/claude-opus-5", context_window = 200000, input = ["text"] },',
      '  { id = "我自己的/模型", context_window = 9999, input = ["text"] },',
      "]",
      "",
    ].join("\n")),
    kept: (h) => at("toml", path.join(h, ".jcode", "config.toml"), "providers.bai.models")[0].context_window,
    check: (h) => {
      const f = path.join(h, ".jcode", "config.toml");
      assert.equal(at("toml", f, "providers.bai.base_url"), CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(at("toml", f, "providers.bai.api_key"), CTX.apiKey, "令牌是机器该管的");
      assert.equal(at("toml", f, "providers.bai.extra_key"), "keep", "★ 用户自己加的键被盖掉了");
      const models = at("toml", f, "providers.bai.models");
      assert.equal(models.length, 3, "不该多出/少掉条目");
      assert.equal(models[1].id, "我自己的/模型", "★ 用户自己加的模型被抹了");
      assert.equal(at("toml", f, "provider.default_model"), "sn/claude-opus-5", "默认模型是机器该管的");
    },
  },
  {
    id: "kimi-code",
    def: kimiCodeClient,
    files: (h) => [path.join(h, ".kimi", "config.toml")],
    seed: (h) => writeText(path.join(h, ".kimi", "config.toml"), [
      'default_model = "old/x"',
      "",
      "[providers.bai]",
      'type = "kimi"',
      'base_url = "https://old/v1"',
      'api_key = "旧key"',
      "",
      '[models."bai/sn/claude-opus-5"]',
      'provider = "bai"',
      'model = "sn/claude-opus-5"',
      'display_name = "我改过的名字"',
      "max_context_size = 200000",
      "",
    ].join("\n")),
    kept: (h) => at("toml", path.join(h, ".kimi", "config.toml"), 'models."bai/sn/claude-opus-5".display_name'),
    check: (h) => {
      const f = path.join(h, ".kimi", "config.toml");
      const t = 'models."bai/sn/claude-opus-5"';
      assert.equal(at("toml", f, `${t}.max_context_size`), 200000, "★ 用户自己调的窗口被盖掉了");
      assert.equal(at("toml", f, "providers.bai.base_url"), CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(at("toml", f, "providers.bai.api_key"), CTX.apiKey, "令牌是机器该管的");
      assert.equal(at("toml", f, "default_model"), "bai/sn/claude-opus-5", "默认模型是机器该管的");
    },
  },
  {
    id: "minimax-code",
    def: minimaxCodeClient,
    files: (h) => [path.join(h, ".minimax", "config.yaml")],
    seed: (h) => writeText(path.join(h, ".minimax", "config.yaml"), [
      "custom_provider:",
      "  bai:",
      "    name: bai",
      "    kind: custom",
      "    enabled: false",
      "    api: openai-completions",
      "    options:",
      "      apiKey: 旧key",
      "      baseURL: https://old",
      "      authMode: api-key",
      "      extra_opt: 1",
      "    models:",
      /* ⚠ 键**不加引号** —— YAML 读取器解析文件里的键时**保留引号**
       * （`"sn/…"` 会变成键名的一部分）⇒ 客户端（它写的是不带引号的键）
       * 认不出带引号的那一条 ⇒ 会多写一个重复的键。
       * 这条是 YAML 读取器的既有毛病（不是本轮引入的），见报告。 */
      "      sn/claude-opus-5:",
      "        name: 我改过的名字",
      "        limit:",
      "          context: 200000",
      /* ⚠ 不加引号 —— YAML 写入器写标量时**不加引号**（除非必须加）⇒
       *   夹具得是它的规范形状，否则「断开后逐字相同」比的是「引号被规范化了」。 */
      "defaultModel: custom_provider:bai/old/x",
      "",
    ].join("\n")),
    kept: (h) => at("yaml", path.join(h, ".minimax", "config.yaml"), "custom_provider.bai.models.sn/claude-opus-5.name"),
    check: (h) => {
      const f = path.join(h, ".minimax", "config.yaml");
      assert.equal(at("yaml", f, "custom_provider.bai.enabled"), false, "★ 用户关掉的 provider 被我们打开了");
      assert.equal(at("yaml", f, "custom_provider.bai.options.baseURL"), CTX.baseUrl, "地址是机器该管的");
      assert.equal(at("yaml", f, "custom_provider.bai.options.apiKey"), CTX.apiKey, "令牌是机器该管的");
      assert.equal(at("yaml", f, "custom_provider.bai.options.extra_opt"), 1, "★ 用户自己加的键被盖掉了");
      assert.equal(at("yaml", f, "custom_provider.bai.models.sn/claude-opus-5.limit.context"), 200000,
        "★ 用户自己调的窗口被盖掉了");
    },
  },
  {
    id: "morph",
    def: morphClient,
    files: (h) => [path.join(h, ".morph", "config.yaml")],
    seed: (h) => writeText(path.join(h, ".morph", "config.yaml"), [
      "llm:",
      "  inference_provider: openai_response_compatible",
      "  endpoint: https://old/v1",
      "  api_key: 旧key",
      "  model: old/x",
      "  context_window_tokens: 200000",
      "  my_own: 1",
      "",
    ].join("\n")),
    kept: (h) => at("yaml", path.join(h, ".morph", "config.yaml"), "llm.context_window_tokens"),
    check: (h) => {
      const f = path.join(h, ".morph", "config.yaml");
      assert.equal(at("yaml", f, "llm.endpoint"), CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(at("yaml", f, "llm.api_key"), CTX.apiKey, "令牌是机器该管的");
      assert.equal(at("yaml", f, "llm.model"), "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.equal(at("yaml", f, "llm.my_own"), 1, "★ 用户自己加的键被盖掉了");
    },
  },
  {
    id: "muse",
    def: museClient,
    files: (h) => [path.join(h, ".config", "muse", "settings.json")],
    seed: (h) => writeJson(path.join(h, ".config", "muse", "settings.json"), {
      schema_version: 1,
      endpoint_transport: { base_url: OLD_URL + "/v1", auth: "bearer", timeout: 30 },
      model: "old/x",
      theme: "dark",
    }),
    /* ⚠ Muse 的配置里**没有**「用户可能手改」的字段（只有地址、鉴权与默认模型）⇒
       它不该有「保留」声明 —— 这一条如实记录那个事实。 */
    kept: null,
    check: (h) => {
      const j = readJson(path.join(h, ".config", "muse", "settings.json"));
      assert.equal(j.endpoint_transport.base_url, CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(j.endpoint_transport.auth, "none", "鉴权是机器该管的");
      assert.equal(j.model, "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.equal(j.theme, "dark", "★ 用户的其它配置被动");
    },
  },
  {
    id: "omp",
    def: ompClient,
    files: (h) => [
      path.join(h, ".omp", "agent", "config.yml"),
      path.join(h, ".omp", "agent", "models.yml"),
    ],
    seed: (h) => {
      writeText(path.join(h, ".omp", "agent", "config.yml"), [
        "modelRoles:",
        "  default: old/x",
        "my_own: 1",
        "",
      ].join("\n"));
      writeText(path.join(h, ".omp", "agent", "models.yml"), [
        "providers:",
        "  bai:",
        "    baseUrl: https://old/v1",
        "    api: openai-completions",
        "    auth: none",
        "    my_own: 1",
        "    models:",
        "      - id: sn/claude-opus-5",
        "        name: 我改过的名字",
        "        contextWindow: 200000",
        "        input:",
        "          - text",
        "",
      ].join("\n"));
    },
    kept: (h) => at("yaml", path.join(h, ".omp", "agent", "models.yml"), "providers.bai.models")[0].name,
    check: (h) => {
      const m = path.join(h, ".omp", "agent", "models.yml");
      assert.equal(at("yaml", m, "providers.bai.baseUrl"), CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(at("yaml", m, "providers.bai.my_own"), 1, "★ 用户自己加的键被盖掉了");
      const models = at("yaml", m, "providers.bai.models");
      assert.equal(models[0].contextWindow, 200000, "★ 用户自己调的窗口被盖掉了");
      assert.equal(at("yaml", path.join(h, ".omp", "agent", "config.yml"), "modelRoles.default"), "bai/sn/claude-opus-5",
        "默认模型是机器该管的");
    },
  },
  {
    id: "pi",
    def: piClient,
    files: (h) => [
      path.join(h, ".pi", "agent", "settings.json"),
      path.join(h, ".pi", "agent", "models.json"),
    ],
    seed: (h) => {
      writeJson(path.join(h, ".pi", "agent", "settings.json"), {
        defaultProvider: "other",
        defaultModel: "other/x",
        enabledModels: ["other/*"],
      });
      writeJson(path.join(h, ".pi", "agent", "models.json"), {
        providers: {
          other: { name: "别的" },
          bai: {
            name: "我改过的 provider 名",
            baseUrl: OLD_URL,
            api: "openai-completions",
            apiKey: "旧key",
            models: [{ id: "sn/claude-opus-5", name: "我改过的模型名" }],
            compat: { sendSessionAffinityHeaders: true },
          },
        },
      });
    },
    kept: (h) => readJson(path.join(h, ".pi", "agent", "models.json")).providers.bai.models[0].name,
    check: (h) => {
      const j = readJson(path.join(h, ".pi", "agent", "models.json"));
      assert.equal(j.providers.bai.name, "我改过的 provider 名", "★ 用户改过的 provider 名被改回去了");
      assert.equal(j.providers.bai.baseUrl, CTX.baseUrl, "地址是机器该管的");
      assert.equal(j.providers.bai.apiKey, CTX.apiKey, "令牌是机器该管的");
      assert.equal(j.providers.bai.compat.sendSessionAffinityHeaders, true,
        "★ 用户自己在 provider 里加的键被盖掉了");
      assert.equal(j.providers.bai.models.length, 2, "不该多出/少掉条目");
      assert.equal(j.providers.bai.models[0].id, "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.deepEqual(j.providers.other, { name: "别的" }, "★ 别人的 provider 被动");
      const s = readJson(path.join(h, ".pi", "agent", "settings.json"));
      assert.equal(s.defaultModel, "bai/sn/claude-opus-5", "默认模型是机器该管的");
      assert.equal(s.enabledModels[0], "other/*", "★ 用户自己那份清单被动");
    },
  },
  {
    id: "qoder",
    def: qoderClient,
    files: (h) => [path.join(h, ".qoder", "settings.json")],
    seed: (h) => writeJson(path.join(h, ".qoder", "settings.json"), {
      theme: "dark",
      providers: {
        "my-own": { displayName: "我的" },
        bai: {
          displayName: "我改过的 provider 名",
          protocol: "openai",
          baseUrl: OLD_URL,
          apiKey: "旧key",
          model: "old/x",
          firstPayloadTimeoutMs: 30000,
          models: [{ model: "sn/claude-opus-5", displayName: "我改过的模型名", capabilities: { tools: true } }],
        },
      },
      model: { name: "old/x", reasoningEffort: "high" },
    }),
    kept: (h) => readJson(path.join(h, ".qoder", "settings.json")).providers.bai.models[0].displayName,
    check: (h) => {
      const j = readJson(path.join(h, ".qoder", "settings.json"));
      assert.equal(j.providers.bai.displayName, "我改过的 provider 名", "★ 用户改过的 provider 名被改回去了");
      assert.equal(j.providers.bai.baseUrl, CTX.baseUrl, "地址是机器该管的");
      assert.equal(j.providers.bai.apiKey, CTX.apiKey, "令牌是机器该管的");
      assert.equal(j.providers.bai.firstPayloadTimeoutMs, 30000, "★ 用户自己设的路由被盖掉了");
      assert.equal(j.providers.bai.models.length, 2, "不该多出/少掉条目");
      assert.equal(j.providers.bai.models[0].model, "sn/claude-opus-5", "模型 id 是机器该管的");
      assert.deepEqual(j.providers["my-own"], { displayName: "我的" }, "★ 别人的 provider 被动");
      assert.equal(j.model.reasoningEffort, "high", "★ 用户自己的思考档被动");
    },
  },
  {
    id: "qoder-cn",
    def: qoderCnClient,
    files: (h) => [path.join(h, ".qoder-cn", "settings.json")],
    seed: (h) => writeJson(path.join(h, ".qoder-cn", "settings.json"), {
      providers: { bai: { displayName: "我改过的 provider 名", models: [{ model: "sn/claude-opus-5", displayName: "我改过的模型名" }] } },
    }),
    kept: (h) => readJson(path.join(h, ".qoder-cn", "settings.json")).providers.bai.models[0].displayName,
    check: (h) => {
      const j = readJson(path.join(h, ".qoder-cn", "settings.json"));
      assert.equal(j.providers.bai.displayName, "我改过的 provider 名", "★ 用户改过的 provider 名被改回去了");
      assert.equal(j.providers.bai.models.length, 2, "不该多出/少掉条目");
    },
  },
  {
    id: "reasonix",
    def: reasonixClient,
    files: () => [
      path.join(process.env.APPDATA, "reasonix", "config.toml"),
      path.join(process.env.APPDATA, "reasonix", ".env"),
    ],
    seed: () => {
      const dir = path.join(process.env.APPDATA, "reasonix");
      writeText(path.join(dir, "config.toml"), [
        'default_model = "old/x"',
        "",
        "[[providers]]",
        'name = "bai"',
        'kind = "openai"',
        'base_url = "https://old/v1"',
        'api_key_env = "BAI_REASONIX_API_KEY"',
        'models = ["old/x"]',
        'model = "old/x"',
        'default = "old/x"',
        'my_own = "keep"',
        "",
      ].join("\n"));
      writeText(path.join(dir, ".env"), "BAI_REASONIX_API_KEY=旧key\nMY_OWN=1\n");
    },
    /* ⚠ Reasonix 的 provider 段里**没有**「用户可能手改」的字段（name 是判别键，
       其余全是机器该管的）⇒ 它不该有「保留」声明。 */
    kept: null,
    check: () => {
      const dir = path.join(process.env.APPDATA, "reasonix");
      const f = path.join(dir, "config.toml");
      assert.equal(at("toml", f, "providers[name=bai].base_url"), CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(at("toml", f, "providers[name=bai].my_own"), "keep", "★ 用户自己加的键被盖掉了");
      assert.equal(at("dotenv", path.join(dir, ".env"), "MY_OWN"), "1", "★ 用户自己在 .env 里的键被盖掉了");
    },
  },
  {
    id: "stepcode",
    def: stepcodeClient,
    files: (h) => [
      path.join(h, ".stepcode", "config.toml"),
      path.join(h, ".stepcode", "models.json"),
    ],
    seed: (h) => {
      writeText(path.join(h, ".stepcode", "config.toml"), [
        'defaultProvider = "other"',
        'defaultModel = "old/x"',
        "",
      ].join("\n"));
      writeJson(path.join(h, ".stepcode", "models.json"), {
        providers: {
          bai: {
            name: "bai",
            baseUrl: OLD_URL + "/v1",
            api: "openai-completions",
            apiKey: "旧key",
            my_own: 1,
            models: [{ id: "sn/claude-opus-5", name: "我改过的名字" }],
          },
        },
      });
    },
    kept: (h) => readJson(path.join(h, ".stepcode", "models.json")).providers.bai.models[0].name,
    check: (h) => {
      const j = readJson(path.join(h, ".stepcode", "models.json"));
      assert.equal(j.providers.bai.baseUrl, CTX.baseUrl + "/v1", "地址是机器该管的");
      assert.equal(j.providers.bai.apiKey, CTX.apiKey, "令牌是机器该管的");
      assert.equal(j.providers.bai.my_own, 1, "★ 用户自己加的键被盖掉了");
      assert.equal(j.providers.bai.models.length, 2, "不该多出/少掉条目");
      assert.equal(j.providers.bai.models[0].id, "sn/claude-opus-5", "模型 id 是机器该管的");
      const t = path.join(h, ".stepcode", "config.toml");
      assert.equal(at("toml", t, "defaultModel"), "sn/claude-opus-5", "默认模型是机器该管的");
    },
  },
];

/* ====================================================================== *
 * ① 保留用户手改 ② 逐字还原 ③ 幂等
 * ====================================================================== */

describe("① 保留用户手改 · ② 断开逐字还原 · ③ 幂等", () => {
  for (const c of CASES) {
    test(`${c.id}`, () => {
      const home = tmpDir();
      const ctx = { ...CTX, home };

      /* 造一份「用户已经改过」的配置 */
      c.seed(home);
      const before = {};
      for (const f of c.files(home)) before[f] = fs.readFileSync(f, "utf8");

      /* 接线 */
      const r = applyClient(c.def, ctx, { dataDir: home });
      assert.equal(r.ok, true, `${c.id}：接线失败：${r.detail}`);
      c.check(home);
      if (c.kept) {
        assert.equal(c.kept(home), EXPECT_KEEP[c.id], `★ ${c.id}：用户改过的值没留住`);
      }

      /* 断开 ⇒ 与「用户改过之后」逐字相同（硬红线） */
      const back = revertClient(c.def, { dataDir: home });
      assert.equal(back.ok, true, `${c.id}：断开失败：${back.detail}`);
      for (const f of c.files(home)) {
        assert.equal(fs.readFileSync(f, "utf8"), before[f],
          `★ ${c.id}：断开后与用户改过之后不逐字相同（${f}）`);
      }
    });
  }
});

/* ====================================================================== *
 * ⑤ 幂等：再接一次，内容没变 ⇒ 那个文件一个字都不动
 *
 * ⚠ **Cline 例外**：它的 provider 条目里有一个 `updatedAt`（写入的时间戳）
 *   ⇒ 每接一次那个值都不同 ⇒ 文件本来就会被重写（**既有行为**，不是本轮
 *   引入的）⇒ 这条断言对它不成立，单独列出来说明。
 * ====================================================================== */

describe("⑤ 幂等：再接一次 ⇒ 那个文件一个字都不动", () => {
  for (const c of CASES) {
    if (c.id === "cline") continue;
    test(`⑤ ${c.id}`, () => {
      const home = tmpDir();
      const ctx = { ...CTX, home };
      c.seed(home);
      const first = applyClient(c.def, ctx, { dataDir: home });
      assert.equal(first.ok, true, `${c.id}：接线失败：${first.detail}`);
      const snap = {};
      for (const f of c.files(home)) snap[f] = fs.readFileSync(f, "utf8");
      const again = applyClient(c.def, ctx, { dataDir: home });
      assert.equal(again.ok, true, `${c.id}：再接一次失败：${again.detail}`);
      for (const f of c.files(home)) {
        assert.equal(fs.readFileSync(f, "utf8"), snap[f],
          `★ ${c.id}：内容没变却把文件重写了一遍（用户手写的排版被换掉了）`);
      }
    });
  }
});

/** 每个客户端「用户改过的那个值」该是什么（见上面的 EXPECT_KEEP）。 */

/* ====================================================================== *
 * ⑨ YAML 带引号的键（模型 id 里带斜杠，用户手写时往往会加引号）
 *
 * ⚠ **既有毛病，2026-10-23 由负责人修**（`formats-yaml.mjs` 的 `splitKey`：
 *   原来双引号分支把**键**也交给 `plainValue` —— 那是处理**值**的，对
 *   `"sn/claude-opus-5"` 这种字符串它**原样返回**（连引号一起）⇒ 树里的键
 *   带引号 ⇒ 用路径 `models."sn/…".name` 找**永远找不到** ⇒ 写回去还会
 *   **多写一个不带引号的同名键** ⇒ 用户在带引号那个里改的值被盖掉）。
 *
 * 这一条把那个修复**钉住** —— 免得以后有人「简化」splitKey 时又把它改回去。
 * ====================================================================== */

describe("⑨ YAML 带引号的键也能认出来 ⇒ 不多写一个重复的键", () => {
  test("⑨ minimax-code：用户手写的带引号的模型键，改过的名字要留住", () => {
    const home = tmpDir();
    const file = path.join(home, ".minimax", "config.yaml");
    writeText(file, [
      "custom_provider:",
      "  bai:",
      "    name: bai",
      "    kind: custom",
      "    enabled: true",
      "    api: openai-completions",
      "    options:",
      "      apiKey: 旧key",
      "      baseURL: https://old",
      "      authMode: api-key",
      "    models:",
      '      "sn/claude-opus-5":',
      "        name: 我改过的名字",
      "        limit:",
      "          context: 200000",
      "",
    ].join("\n"));
    const r = applyClient(minimaxCodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const models = at("yaml", file, "custom_provider.bai.models");
    assert.equal(Object.keys(models).length, 2,
      `★ 多写了一个重复的模型键：${Object.keys(models).join("、")}`);
    assert.equal(models["sn/claude-opus-5"].name, "我改过的名字",
      "★ 用户改过的名字被盖掉了（读取器没认出带引号的那个键）");
    assert.equal(models["sn/claude-opus-5"].limit.context, 200000,
      "★ 用户自己调的窗口被盖掉了");
    assert.ok(models["sn/glm-5.2"], "★ 我们另一条模型没写进去");
    const text = fs.readFileSync(file, "utf8");
    /* ⚠ 只数**键那一行** —— `defaultModel: custom_provider:bai/sn/claude-opus-5`
     *   里也有这个 id（那是另一件事）。 */
    const keyLines = text.split("\n").filter((l) => /^\s*"?sn\/claude-opus-5"?\s*:/.test(l));
    assert.equal(keyLines.length, 1,
      `★ 文件里出现了重复的模型键（带引号的 + 不带引号的）：${keyLines.join(" | ")}`);
  });
});

/* ====================================================================== *
 * ⑩ `kept` 的**两类**：theirs（我们本来就会写、但用户改过 ⇒ 让给他）
 *     与 unmanaged（**我们压根没写**、用户自己有的 ⇒ 弱保留层留下的）
 *
 * ⚠ 面板（`cards/clients.js` 的 `showKept`）按 `kind` 把它们**分开说**：
 *   theirs ⇒ 「保留了你手改的 N 处」（路径 + 你的值 + 我们记的值）；
 *   unmanaged ⇒ 「还留着你自己的 N 个键」（**只列键名**，不列值）。
 * ⚠ 「保留了你手改的 N 处」那个 N **只数 theirs**（把用户压根没改过的东西算
 *   进去，那个数就不准了）—— base.mjs 的 detail 那一行就是这么算的。
 * ====================================================================== */

describe("⑩ kept 的两类：theirs 与 unmanaged 分开说", () => {
  test("⑩a Cline：用户自己设的思考档进了 kept 的 unmanaged 组（只有键名、没有值）", () => {
    const home = tmpDir();
    const c = CASES.find((x) => x.id === "cline");
    c.seed(home);
    const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const kept = r.kept || [];
    const unmanaged = kept.filter((k) => k.kind === "unmanaged");
    const theirs = kept.filter((k) => k.kind !== "unmanaged");
    assert.ok(unmanaged.length > 0, "★ 弱保留的键一个都没报出来（面板会一个字不说）");
    const reasoning = unmanaged.find((k) => String(k.path || "").includes("settings.reasoning"));
    assert.ok(reasoning, `★ 用户自己设的思考档没进 unmanaged 组：${unmanaged.map((k) => k.path).join("、")}`);
    assert.equal(reasoning.theirs, undefined, "★ unmanaged 只报键名，不报值");
    assert.equal(reasoning.ours, undefined, "★ unmanaged 只报键名，不报值");
    /* theirs 那组照旧带「你的值」与「我们记的值」 */
    assert.ok(theirs.length > 0, "★ theirs 那组空了");
    assert.ok(theirs.every((k) => "theirs" in k && "ours" in k),
      "★ theirs 那组必须带两个值（面板要显示它们）");
    /* ⚠ 路径带文件名（base.mjs 里拼的）⇒ 多文件的客户端分得清是哪一份 */
    assert.ok(unmanaged.every((k) => String(k.path || "").includes(":")),
      "★ kept 的路径没带文件名");
  });

  test("⑩b detail 里的「N 处」只数 theirs，不把 unmanaged 算进去", () => {
    const home = tmpDir();
    const c = CASES.find((x) => x.id === "cline");
    c.seed(home);
    const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const kept = r.kept || [];
    const theirs = kept.filter((k) => k.kind !== "unmanaged").length;
    const unmanaged = kept.filter((k) => k.kind === "unmanaged").length;
    assert.ok(unmanaged > 0, "★ 这一条要有 unmanaged 才有意义");
    const m = String(r.detail || "").match(/保留了你手改的 (\d+) 处/);
    assert.ok(m, `★ detail 里没有那句「保留了你手改的 N 处」：${r.detail}`);
    assert.equal(Number(m[1]), theirs,
      `★ detail 的 N 应当只数 theirs（${theirs}），不该把 ${unmanaged} 个 unmanaged 算进去`);
    assert.notEqual(Number(m[1]), kept.length, "★ detail 的 N 把两类混在一起算了");
  });

  test("⑩c 数组里用户自己加的条目也进 unmanaged 组（Droid 的 custom:other/x）", () => {
    const home = tmpDir();
    const c = CASES.find((x) => x.id === "droid");
    c.seed(home);
    const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const unmanaged = (r.kept || []).filter((k) => k.kind === "unmanaged");
    const own = unmanaged.find((k) => String(k.path || "").includes("custom:other/x"));
    assert.ok(own, `★ 用户自己加的条目没进 unmanaged 组：${unmanaged.map((k) => k.path).join("、")}`);
    assert.equal(own.theirs, undefined, "★ unmanaged 只报键名，不报值");
  });
});

/* ====================================================================== *
 * ⑥ 反向对照：改坏 ⇒ 判据必须红
 * ====================================================================== */

/**
 * copyTree —— 把 clients 目录 + edit-json.mjs 复制一份到临时目录。
 *
 * 改坏的副本在副本里 import —— **仓库里的源码一个字不动**。
 */
function copyTree(tag) {
  const dir = path.join(TMPROOT, tag);
  const dst = path.join(dir, "src", "server", "clients");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, "src", "server", "clients"))) {
    if (!f.endsWith(".mjs")) continue;
    fs.copyFileSync(path.join(REPO, "src", "server", "clients", f), path.join(dst, f));
  }
  fs.mkdirSync(path.join(dir, "src", "server"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "src", "server", "edit-json.mjs"), path.join(dir, "src", "server", "edit-json.mjs"));
  return dir;
}

/** patch —— 在副本里改坏一处；**锚点对不上就当场报「锚点与源码脱节」**。 */
function patch(dir, rel, from, to) {
  const file = path.join(dir, "src", "server", "clients", rel);
  const text = fs.readFileSync(file, "utf8");
  const broken = text.replace(from, to);
  assert.notEqual(broken, text,
    `改坏的副本没改成（${rel} 的锚点与源码脱节了）—— 这条反向对照失效了`);
  fs.writeFileSync(file, broken, "utf8");
}

/**
 * importPatched —— import 副本里的一个模块。
 *
 * ⚠ **不带查询串**：副本里的客户端声明 import 的是「同目录的 base.mjs」——
 *   带查询串会多出一个模块实例 ⇒ 底座的「格式注册表」与客户端看到的不是同一份
 *   ⇒ 格式读写器找不到。副本目录每次都是新的 ⇒ 不会吃到上一次的缓存。
 */
async function importPatched(dir, rel) {
  const file = path.join(dir, "src", "server", "clients", rel);
  return import(pathToFileURL(file).href);
}

/**
 * armSpec —— **声明级**的改坏：把某个客户端自己那份归属表改坏。
 *
 * ⚠ 这是「声明级」的反向对照（与 clients-json-test 的 armSabotage 同一路子）：
 *   它盯的是「**每个客户端自己的归属表**」这一层 —— 合并层本身没坏，
 *   但客户端说错了「哪些键归用户」⇒ 用户的值照样被盖掉。
 */
function armSpec(def, fn) {
  return {
    ...def,
    files: (ctx) => def.files(ctx).map((f) => ({
      ...f,
      writes: (c) => (typeof f.writes === "function" ? f.writes(c) : (f.writes || []))
        .map((w) => (w.merge ? { ...w, merge: fn(w.merge) } : w)),
    })),
  };
}

describe("⑥ 反向对照：改坏 ⇒ 判据必须红", () => {
  test("⑥a 合并层改成「总是我们的赢」⇒ 各客户端的「用户改过的值留着」都失效", async () => {
    const dir = copyTree("broken-merge-ours");
    /* 子路径的 theirs（数组元素里的 name 那种） */
    patch(dir, "merge-policy.mjs",
      "    if (sameValue(have, ours)) return ours;\n"
        + "    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "    return have;",
      "    if (sameValue(have, ours)) return ours;\n"
        + "    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "    return ours;   // SABOTAGE：用户的赢被改成我们的赢");
    /* 根模式的 theirs（标量那种） */
    patch(dir, "merge-policy.mjs",
      "      if (sameValue(have, ours)) return ours;\n"
        + "      kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "      return have;",
      "      if (sameValue(have, ours)) return ours;\n"
        + "      kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "      return ours;   // SABOTAGE：根模式里用户的赢被改成我们的赢");

    /* 挑三个形状各异的客户端当探针（改一个就够证明这条对照是活的） */
    const probes = [
      ["cursor-cli.mjs", "cursorCliClient", "cursor-cli"],
      ["droid.mjs", "droidClient", "droid"],
      ["grok.mjs", "grokClient", "grok"],
    ];
    const base = await importPatched(dir, "base.mjs");
    for (const [rel, exportName, id] of probes) {
      const mod = await importPatched(dir, rel);
      const c = CASES.find((x) => x.id === id);
      const home = tmpDir();
      c.seed(home);
      const r = base.applyClient(mod[exportName], { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, true, r.detail);
      assert.notEqual(c.kept(home), EXPECT_KEEP[id],
        `★ 改坏之后仍然保留用户的值 —— 那 ${id} 的判据是恒真的，测了个寂寞`);
    }
  });

  test("⑥b 「备份里存原值」改成「存新值」⇒ 断开逐字还原失效", async () => {
    const dir = copyTree("broken-base");
    patch(dir, "base.mjs",
      "        value: e.before.existed === true ? e.before.value : null,\n      })),",
      "        value: e.value,   // SABOTAGE：备份里存的是写后的新值\n      })),");
    const base = await importPatched(dir, "base.mjs");
    for (const [rel, exportName, id] of [
      ["cursor-cli.mjs", "cursorCliClient", "cursor-cli"],
      ["droid.mjs", "droidClient", "droid"],
      ["pi.mjs", "piClient", "pi"],
    ]) {
      const mod = await importPatched(dir, rel);
      const c = CASES.find((x) => x.id === id);
      const home = tmpDir();
      c.seed(home);
      const before = fs.readFileSync(c.files(home)[0], "utf8");
      base.applyClient(mod[exportName], { ...CTX, home }, { dataDir: home });
      base.revertClient(mod[exportName], { dataDir: home });
      assert.notEqual(fs.readFileSync(c.files(home)[0], "utf8"), before,
        `★ 改坏之后仍然逐字还原 —— 那 ${id} 的判据是恒真的，测了个寂寞`);
    }
  });

  test("⑥c 弱保留改成「抹掉用户没写的键」⇒ 「用户自己加的键留着」失效", async () => {
    const dir = copyTree("broken-weakkeep");
    patch(dir, "merge-policy.mjs",
      "      out[k] = hv;                    /* 我们没写 ⇒ 用户的留下 */",
      "      out[k] = undefined;             // SABOTAGE：用户没写的键被抹掉");
    const base = await importPatched(dir, "base.mjs");
    /* ⚠ 只有**整块写 + 合并**的客户端才走这一层弱保留（别的客户端是**逐键写**
     *   ⇒ 用户的键本来就不动，不靠合并层）。Cline 的 provider 条目就是整块写的。 */
    const mod = await importPatched(dir, "cline.mjs");
    const c = CASES.find((x) => x.id === "cline");
    const home = tmpDir();
    c.seed(home);
    const r = base.applyClient(mod.clineClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const reasoning = readJson(path.join(home, ".cline", "data", "settings", "providers.json"))
      .providers["openai-compatible"].settings.reasoning;
    const stillThere = !!(reasoning && reasoning.effort === "high");
    assert.equal(stillThere, false,
      "★ 改坏之后用户自己设的思考档还在 —— 那 cline 的判据是恒真的，测了个寂寞");
  });

  test("⑥c-2 数组合并的「认不出的条目原样留着」改坏 ⇒ 「用户自己加的条目留着」失效", async () => {
    const dir = copyTree("broken-arraykeep");
    patch(dir, "merge-policy.mjs",
      "    if (idx < 0) {\n      out.push(el);                                /* 用户的条目原样留着 */",
      "    if (idx < 0) {\n      /* SABOTAGE：用户认不出的条目被抹掉 */");
    const base = await importPatched(dir, "base.mjs");
    for (const [rel, exportName, id] of [
      ["droid.mjs", "droidClient", "droid"],
      ["goose.mjs", "gooseClient", "goose"],
    ]) {
      const mod = await importPatched(dir, rel);
      const c = CASES.find((x) => x.id === id);
      const home = tmpDir();
      c.seed(home);
      const r = base.applyClient(mod[exportName], { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, true, r.detail);
      let stillThere = false;
      if (id === "droid") {
        stillThere = readJson(path.join(home, ".factory", "settings.json"))
          .customModels.some((e) => e.id === "custom:other/x");
      } else {
        stillThere = readJson(path.join(process.env.APPDATA, "Block", "goose", "config", "custom_providers", "bai.json"))
          .models.some((m) => m.name === "我自己的/模型");
      }
      assert.equal(stillThere, false,
        `★ 改坏之后用户自己加的条目还在 —— 那 ${id} 的判据是恒真的，测了个寂寞`);
    }
  });

  test("⑥d 每个客户端**自己的归属表**改坏 ⇒ 该客户端的「用户改过的值留着」失效", () => {
    /* 把每个客户端 merge 里的 `theirs` 清空 = 「不承认任何键归用户」
       ⇒ 用户的改过必然被盖回去 ⇒ 该客户端的判据必须失效。 */
    for (const c of CASES) {
      if (!c.kept) continue;      /* 没有「用户可能手改」的字段的客户端（gemini-cli /
                                    muse / reasonix）本来就不该有保留声明 */
      const home = tmpDir();
      c.seed(home);
      const broken = armSpec(c.def, (m) => ({ ...m, theirs: [] }));
      const r = applyClient(broken, { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, true, `${c.id}：断臂之后接线本身应当还是成功：${r.detail}`);
      assert.notEqual(c.kept(home), EXPECT_KEEP[c.id],
        `★ 改坏归属表之后仍然保留用户的值 —— 那 ${c.id} 的判据是恒真的，测了个寂寞`);
    }
  });
});
