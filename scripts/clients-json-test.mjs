/**
 * 客户端接线：这一批 **JSON** 家族（scripts/clients-json-test.mjs）
 *
 * ## 测什么
 *
 * 对每一个客户端（Qwen Code / Qoder / Qoder CN / Cline / Droid / CodeBuddy Code /
 * WorkBuddy / WorkBuddy AI / Pi / Cursor CLI / Muse Code / Empryo）：
 *
 *   ★ ① 接线：说好的键路径真的写进去了，写进去的值是对的
 *   ★ ② **断开：原样还原** —— 我们写的那几处回到原值，用户文件里的**其它内容
 *      一个字没动**
 *   ★ ③ **读不懂就不写** —— 配置文件存在但解析失败 ⇒ 报错、中止，**用户的文件
 *      一个字节都没被改**（多文件的客户端：一份坏了，**另一份也不许动**）
 *   ★ ④ 反向对照：把「写模型清单」那一处**断掉** ⇒ ① 的判据必须变红 ——
 *      证明那个判据不是恒真的
 *   ★ ⑤ 反向对照（源码级）：把客户端声明**复制一份**、在副本上删掉「写模型清单」
 *      那一行 ⇒ ① 的判据必须变红（仓库源码一个字不动）
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的用户 home**。
 *    那些「这个客户端读自己的环境变量」（QWEN_HOME / QODER_CONFIG_DIR…）在测试
 *    里一律清空 —— 否则本机若有设置，写落就落到真目录去了。
 * 🔴 全文没有一个真实令牌/API key（夹具里的凭据形态串是明显假的占位串）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyClient, revertClient, clientStatus, backupFileOf } from "../src/server/clients/base.mjs";
import { getPath } from "../src/server/edit-json.mjs";

import { qwenCodeClient } from "../src/server/clients/qwen-code.mjs";
import { qoderClient } from "../src/server/clients/qoder.mjs";
import { qoderCnClient } from "../src/server/clients/qoder-cn.mjs";
import { clineClient } from "../src/server/clients/cline.mjs";
import { droidClient } from "../src/server/clients/droid.mjs";
import { codeBuddyClient } from "../src/server/clients/codebuddy.mjs";
import { workBuddyClient } from "../src/server/clients/workbuddy.mjs";
import { workBuddyAiClient } from "../src/server/clients/workbuddy-ai.mjs";
import { piClient } from "../src/server/clients/pi.mjs";
import { cursorCliClient } from "../src/server/clients/cursor-cli.mjs";
import { museClient } from "../src/server/clients/muse.mjs";
import { empryoClient } from "../src/server/clients/empryo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-clients-json-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `c${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 动态挑一个空闲端口（测试全程不连网关，但地址得像个真的）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const PORT = await freePort();
const CTX = {
  home: "",
  baseUrl: `http://127.0.0.1:${PORT}`,
  apiKey: "bai-local-placeholder",
  models: [
    { id: "sn/claude-opus-5", label: "Claude Opus 5" },
    { id: "wb/glm-5.2", label: "GLM 5.2" },
  ],
  providerId: "bai",
  providerName: "B.AI",
};

/* 客户端各自读的环境变量 —— 测试里一律清空（见文件头的红线）。 */
const ENV_VARS = [
  "QWEN_HOME", "QODER_CONFIG_DIR", "QODERCN_CONFIG_DIR", "CLINE_DIR", "CLINE_DATA_DIR",
  "FACTORY_HOME_OVERRIDE", "CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR",
  "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR",
];
const savedEnv = {};
for (const k of ENV_VARS) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}
process.on("exit", () => {
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** 一个键路径在文本里的值（没有 ⇒ undefined）。 */
function at(text, p) {
  const r = getPath(text, p);
  return r && r.ok && r.found ? r.value : undefined;
}

/** 写成文件的文本（两格缩进 + 末尾换行 —— 与客户端那些文件自己的排版一致）。 */
function asText(v) {
  return JSON.stringify(v, null, 2) + "\n";
}

/* ====================================================================== *
 * 每一个客户端：文件、用户原有内容、接完以后该有的东西
 * ====================================================================== */

/**
 * `files`  : 这个客户端要碰的文件（相对家目录）
 * `fixture`: 用户**原来**就在那儿的文件内容（键 = 相对家目录的路径）
 * `expect` : 接完以后该有的路径与它的样子（ok 收那个路径上的值，返回布尔）
 * `listPath`: 「写模型清单」那一处的路径 —— 反向对照就断它
 */
const CASES = [
  {
    id: "qwen-code",
    def: qwenCodeClient,
    files: [".qwen/settings.json"],
    fixture: {
      ".qwen/settings.json": {
        theme: "dark",
        modelProviders: {
          openai: [{ id: "my-own", name: "我的模型", baseUrl: "http://x/v1", envKey: "MY_KEY" }],
        },
        model: { name: "old-model" },
        security: { auth: { selectedType: "qwen" } },
        env: { MY_KEY: "my-own-placeholder" },
      },
    },
    expect: [
      ["modelProviders.openai", (v) => Array.isArray(v) && v.length === 3
        && v[0].id === "my-own" && v[1].envKey === "BAI_QWEN_API_KEY"
        && v[1].id === "sn/claude-opus-5" && v[1].baseUrl === CTX.baseUrl
        && v[2].id === "wb/glm-5.2"],
      ["model.name", (v) => v === "sn/claude-opus-5"],
      ["model.baseUrl", (v) => v === CTX.baseUrl],
      ["security.auth.selectedType", (v) => v === "openai"],
      ["env.BAI_QWEN_API_KEY", (v) => v === CTX.apiKey],
      ["env.MY_KEY", (v) => v === "my-own-placeholder"],
    ],
    list: {
      write: "modelProviders.openai",
      check: [".qwen/settings.json", "modelProviders.openai",
        (v) => Array.isArray(v) && v.some((e) => e && e.envKey === "BAI_QWEN_API_KEY")],
    },
  },
  {
    id: "qoder",
    def: qoderClient,
    files: [".qoder/settings.json"],
    fixture: {
      ".qoder/settings.json": {
        theme: "dark",
        providers: { "my-own": { displayName: "我的" } },
        model: { name: "old/x", reasoningEffort: "high" },
      },
    },
    expect: [
      ["providers.bai.baseUrl", (v) => v === CTX.baseUrl],
      ["providers.bai.protocol", (v) => v === "openai"],
      ["providers.bai.apiKey", (v) => v === CTX.apiKey],
      ["providers.bai.model", (v) => v === "sn/claude-opus-5"],
      ["providers.bai.models", (v) => Array.isArray(v) && v.length === 2 && v[0].model === "sn/claude-opus-5"],
      ["model.name", (v) => v === "bai/sn/claude-opus-5"],
      ["model.reasoningEffort", (v) => v === "high"],
      ["providers.my-own.displayName", (v) => v === "我的"],
    ],
    list: {
      /* ⚠ 2026-10-23：写模型清单的那一处从「整块写 providers.bai」改成了
         **单独一条写 providers.bai.models**（通用合并层的数组合并只作用在
         「这条 write 的值根」上 ⇒ 数组必须自己是根；拆开之后用户在这个
         provider 上自己设的那些键才留得住）。断臂的目标要跟着改。 */
      write: "providers.bai.models",
      check: [".qoder/settings.json", "providers.bai.models",
        (v) => Array.isArray(v) && v.length === 2 && v[0].model === "sn/claude-opus-5"],
    },
  },
  {
    id: "qoder-cn",
    def: qoderCnClient,
    files: [".qoder-cn/settings.json"],
    fixture: {
      ".qoder-cn/settings.json": {
        theme: "dark",
        providers: { "my-own": { displayName: "我的" } },
        model: { name: "old/x" },
      },
    },
    expect: [
      ["providers.bai.baseUrl", (v) => v === CTX.baseUrl],
      ["providers.bai.models", (v) => Array.isArray(v) && v.length === 2],
      ["model.name", (v) => v === "bai/sn/claude-opus-5"],
      ["providers.my-own.displayName", (v) => v === "我的"],
    ],
    list: {
      /* 同 qoder：写模型清单的那一处现在是单独一条写（见上面那条注释）。 */
      write: "providers.bai.models",
      check: [".qoder-cn/settings.json", "providers.bai.models",
        (v) => Array.isArray(v) && v.length === 2],
    },
  },
  {
    id: "cline",
    def: clineClient,
    files: [".cline/data/settings/providers.json", ".cline/data/settings/models.json"],
    fixture: {
      ".cline/data/settings/providers.json": {
        version: 1,
        modes: {},
        providers: { "my-own": { settings: { provider: "my-own" } } },
        lastUsedProvider: "my-own",
      },
      ".cline/data/settings/models.json": {
        version: 1,
        providers: { "my-own": { provider: { name: "我的" } } },
      },
    },
    expect: [
      ["providers.openai-compatible.settings.baseUrl", (v) => v === CTX.baseUrl],
      ["providers.openai-compatible.settings.model", (v) => v === "sn/claude-opus-5"],
      ["providers.openai-compatible.settings.apiKey", (v) => v === CTX.apiKey],
      ["providers.openai-compatible.settings.headers.User-Agent", (v) => v === "cline"],
      ["lastUsedProvider", (v) => v === "openai-compatible"],
      ["providers.my-own.settings.provider", (v) => v === "my-own"],
    ],
    list: {
      write: "providers.openai-compatible",
      check: [".cline/data/settings/models.json", "providers.openai-compatible.models",
        (v) => !!v && !!v["sn/claude-opus-5"]],
    },
    /* models.json 那一份的判据（另一个文件，单独查） */
    expectIn: [
      [".cline/data/settings/models.json", "providers.openai-compatible.provider.defaultModelId", (v) => v === "sn/claude-opus-5"],
      [".cline/data/settings/models.json", "providers.openai-compatible.models", (v) => !!v && !!v["sn/claude-opus-5"]],
      [".cline/data/settings/models.json", "providers.my-own.provider.name", (v) => v === "我的"],
    ],
  },
  {
    id: "droid",
    def: droidClient,
    files: [".factory/settings.json"],
    fixture: {
      ".factory/settings.json": {
        theme: "dark",
        customModels: [{ id: "custom:mine", model: "mine" }],
        sessionDefaultSettings: { autoRunMode: "ask" },
      },
    },
    expect: [
      ["customModels", (v) => Array.isArray(v) && v.length === 3
        && v[0].id === "custom:mine" && v[1].id === "custom:bai/sn/claude-opus-5"
        && v[1].provider === "generic-chat-completion-api" && v[1].apiKey === CTX.apiKey],
      ["sessionDefaultSettings.model", (v) => v === "custom:bai/sn/claude-opus-5"],
      ["sessionDefaultSettings.autoRunMode", (v) => v === "ask"],
      ["theme", (v) => v === "dark"],
    ],
    list: {
      write: "customModels",
      check: [".factory/settings.json", "customModels",
        (v) => Array.isArray(v) && v.some((e) => e && String(e.id || "").startsWith("custom:bai/"))],
    },
  },
  {
    id: "codebuddy",
    def: codeBuddyClient,
    files: [".codebuddy/models.json", ".codebuddy/settings.json"],
    fixture: {
      ".codebuddy/models.json": {
        models: [{ id: "mine", vendor: "other" }],
        availableModels: ["mine"],
        other: 1,
      },
      ".codebuddy/settings.json": { theme: "dark" },
    },
    expect: [
      ["models", (v) => Array.isArray(v) && v.length === 3
        && v[0].id === "mine" && v[1].id === "sn/claude-opus-5" && v[1].vendor === "bai"
        && v[1].url === `${CTX.baseUrl}/v1/chat/completions`],
      ["availableModels", (v) => Array.isArray(v) && v.length === 3 && v[0] === "mine"],
      ["other", (v) => v === 1],
    ],
    list: {
      write: "models",
      check: [".codebuddy/models.json", "models",
        (v) => Array.isArray(v) && v.some((e) => e && e.vendor === "bai")],
    },
    expectIn: [
      [".codebuddy/settings.json", "model", (v) => v === "sn/claude-opus-5"],
      [".codebuddy/settings.json", "theme", (v) => v === "dark"],
    ],
  },
  {
    id: "workbuddy",
    def: workBuddyClient,
    files: [".workbuddy/models.json"],
    fixture: {
      /* WorkBuddy 自己写的是**裸数组** —— 形状不能改。 */
      ".workbuddy/models.json": [
        { id: "qwen-local", local: true, url: "http://127.0.0.1:8080/v1/chat/completions" },
      ],
    },
    expect: [
      ["$list", (v) => Array.isArray(v) && v.length === 3
        && v[0].id === "qwen-local" && v[0].local === true
        && v[1].id === "sn/claude-opus-5" && v[1].vendor === "bai"
        && v[2].id === "wb/glm-5.2"],
    ],
    list: {
      write: "$list",
      check: [".workbuddy/models.json", "$list",
        (v) => Array.isArray(v) && v.some((e) => e && e.vendor === "bai")],
    },
    /* 裸数组的根：判据直接看整个文件解析出来的值 */
    rootIsArray: true,
  },
  {
    id: "workbuddy-ai",
    def: workBuddyAiClient,
    files: [".workbuddy-ai/models.json"],
    fixture: {
      /* 另一种形状（CodeBuddy Code 的 CLI 写的那份）：对象根。 */
      ".workbuddy-ai/models.json": {
        models: [{ id: "mine", vendor: "other" }],
        availableModels: ["mine"],
      },
    },
    expect: [
      ["models", (v) => Array.isArray(v) && v.length === 3
        && v[0].id === "mine" && v[2].id === "wb/glm-5.2" && v[2].vendor === "bai"],
      ["availableModels", (v) => Array.isArray(v) && v.length === 3],
    ],
    list: {
      write: "models",
      check: [".workbuddy-ai/models.json", "models",
        (v) => Array.isArray(v) && v.some((e) => e && e.vendor === "bai")],
      /* 全新安装时 magpie 建的是**裸数组**（workbuddy.go 的 buddyWriteAt：
         d.rest 为 nil 时 out 就是那个数组）—— 与用户那份对象形状不同。 */
      freshCheck: [".workbuddy-ai/models.json", "$list",
        (v) => Array.isArray(v) && v.some((e) => e && e.vendor === "bai")],
    },
  },
  {
    id: "pi",
    def: piClient,
    files: [".pi/agent/settings.json", ".pi/agent/models.json"],
    fixture: {
      ".pi/agent/settings.json": {
        defaultProvider: "other",
        defaultModel: "other/x",
        enabledModels: ["other/*"],
      },
      ".pi/agent/models.json": {
        providers: { other: { name: "别的" } },
      },
    },
    expect: [
      ["defaultProvider", (v) => v === "bai"],
      ["defaultModel", (v) => v === "bai/sn/claude-opus-5"],
      ["enabledModels", (v) => Array.isArray(v) && v.length === 3
        && v[0] === "other/*" && v[1] === "bai/sn/claude-opus-5"],
    ],
    list: {
      write: "enabledModels",
      check: [".pi/agent/settings.json", "enabledModels",
        (v) => Array.isArray(v) && v.includes("bai/sn/claude-opus-5")],
      /* enabledModels 只在**用户本来就有**那份清单时才补（magpie：
         "never makes one where there is none"）—— 全新安装时它不该出现，
         这时该看的是 defaultModel。 */
      freshCheck: [".pi/agent/settings.json", "defaultModel", (v) => v === "bai/sn/claude-opus-5"],
    },
    expectIn: [
      [".pi/agent/models.json", "providers.bai.baseUrl", (v) => v === CTX.baseUrl],
      [".pi/agent/models.json", "providers.bai.api", (v) => v === "openai-completions"],
      [".pi/agent/models.json", "providers.bai.models", (v) => Array.isArray(v) && v.length === 2
        && v[0].id === "sn/claude-opus-5"],
      [".pi/agent/models.json", "providers.other.name", (v) => v === "别的"],
    ],
  },
  {
    id: "cursor-cli",
    def: cursorCliClient,
    files: [".cursor/cli-config.json"],
    fixture: {
      ".cursor/cli-config.json": {
        theme: "dark",
        model: { modelId: "old" },
      },
    },
    expect: [
      ["model.modelId", (v) => v === "sn/claude-opus-5"],
      ["model.displayModelId", (v) => v === "sn/claude-opus-5"],
      ["model.displayName", (v) => v === "Claude Opus 5"],
      ["hasChangedDefaultModel", (v) => v === true],
      ["theme", (v) => v === "dark"],
    ],
    list: {
      write: "model.modelId",
      check: [".cursor/cli-config.json", "model.modelId", (v) => v === "sn/claude-opus-5"],
    },
  },
  {
    id: "muse",
    def: museClient,
    files: [".config/muse/settings.json"],
    fixture: {
      ".config/muse/settings.json": {
        theme: "dark",
        endpoint_transport: { base_url: "https://meta.example", auth: "bearer" },
        model: "muse-old",
      },
    },
    expect: [
      ["schema_version", (v) => v === 1],
      ["endpoint_transport.base_url", (v) => v === `${CTX.baseUrl}/v1`],
      ["endpoint_transport.auth", (v) => v === "none"],
      ["model", (v) => v === "sn/claude-opus-5"],
      ["theme", (v) => v === "dark"],
    ],
    list: {
      write: "endpoint_transport",
      check: [".config/muse/settings.json", "endpoint_transport.base_url",
        (v) => v === `${CTX.baseUrl}/v1`],
    },
  },
  {
    id: "empryo",
    def: empryoClient,
    files: [".empryo/config.json"],
    fixture: {
      ".empryo/config.json": {
        theme: "dark",
        providers: [{ id: "mine", name: "我的" }],
        defaultModel: "mine/x",
      },
    },
    expect: [
      ["providers", (v) => Array.isArray(v) && v.length === 2
        && v[0].id === "mine" && v[1].id === "bai" && v[1].baseURL === CTX.baseUrl
        && v[1].modelsAPI === `${CTX.baseUrl}/v1/models`],
      ["defaultModel", (v) => v === "bai/sn/claude-opus-5"],
      ["theme", (v) => v === "dark"],
    ],
    list: {
      write: "providers",
      check: [".empryo/config.json", "providers",
        (v) => Array.isArray(v) && v.some((p) => p && p.id === "bai")],
    },
  },
];

/* ====================================================================== *
 * 工具
 * ====================================================================== */

/** 把夹具写进临时家目录。返回 { home, texts }（texts = 相对路径 → 原文）。 */
function seed(c, cse) {
  const home = tmpDir();
  const texts = {};
  for (const [rel, v] of Object.entries(cse.fixture)) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = asText(v);
    fs.writeFileSync(file, text, "utf8");
    texts[rel] = text;
  }
  return { home, texts };
}

/** 断臂：把声明复制一份，把「写模型清单」那一处从 writes 里去掉。 */
function armSabotage(def, dropPath) {
  return {
    ...def,
    files: (ctx) => def.files(ctx).map((f) => ({
      ...f,
      writes: (c) => (typeof f.writes === "function" ? f.writes(c) : (f.writes || []))
        .filter((w) => w.path !== dropPath),
    })),
  };
}

/** 这个客户端接完以后，那个键路径上的值（没有 ⇒ undefined）。 */
function valueAt(c, home, rel, p) {
  const file = path.join(home, rel);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  if (p === "$list") {
    /* 根**就是**那个数组的文件（WorkBuddy 自己写的那份） */
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : undefined;
  }
  return at(text, p);
}

/* ====================================================================== *
 * ① 接线 + ② 断开
 * ====================================================================== */

describe("① 接线：说好的键路径真的写进去了", () => {
  for (const c of CASES) {
    test(`① ${c.id}：写进去了，值也对`, () => {
      const { home } = seed(c, c);
      const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, true, `接线失败：${r.detail}`);
      for (const [p, ok] of c.expect) {
        const v = valueAt(c, home, c.files[0], p);
        assert.ok(ok(v), `${c.id}：${p} 不对（拿到 ${JSON.stringify(v)}）`);
      }
      for (const [rel, p, ok] of (c.expectIn || [])) {
        const v = valueAt(c, home, rel, p);
        assert.ok(ok(v), `${c.id}：${rel} 的 ${p} 不对（拿到 ${JSON.stringify(v)}）`);
      }
      /* 状态：接完就是「已接到 B.AI」 */
      const st = clientStatus(c.def, { ...CTX, home }, { dataDir: home });
      assert.equal(st.wired, true, `${c.id}：状态不对 ${JSON.stringify(st)}`);
    });

    test(`① ${c.id}：模型 id 是 provider/档位 的完整写法`, () => {
      const { home } = seed(c, c);
      const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, true, r.detail);
      /* 写进文件里的每一个模型 id 都得带 "/" —— 写「档位」而不写
         provider/档位，网关那边会静默落到默认模型（见 memory 里的那一条）。 */
      for (const rel of c.files) {
        const file = path.join(home, rel);
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, "utf8");
        const ids = [...text.matchAll(/"(?:id|model|modelId|displayModelId|defaultModelId)"\s*:\s*"([^"]+)"/g)]
          .map((m) => m[1])
          .filter((s) => s.includes("/") || s.startsWith("custom:") || s === "openai-compatible");
        for (const id of ids) {
          if (id.startsWith("custom:") || id === "openai-compatible") continue;
          assert.match(id, /^[a-z]+\//, `${c.id}：模型 id「${id}」少了 provider 前缀`);
        }
      }
    });
  }
});

describe("② 断开：只还原我们写过的那几处", () => {
  for (const c of CASES) {
    test(`② ${c.id}：原样还原，用户文件里的其它内容一个字没动`, () => {
      const { home, texts } = seed(c, c);
      const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, true, `接线失败：${r.detail}`);
      /* 接上以后，用户的东西应当还在（不是被我们覆盖了） */
      const rv = revertClient(c.def, { dataDir: home });
      assert.equal(rv.ok, true, `断开失败：${rv.detail}`);
      for (const [rel, before] of Object.entries(texts)) {
        const file = path.join(home, rel);
        assert.ok(fs.existsSync(file), `${c.id}：${rel} 断开后不见了`);
        const after = fs.readFileSync(file, "utf8");
        assert.equal(after, before, `★ ${c.id}：${rel} 断开后与原文件不一样（用户的东西被动过了）`);
      }
      /* 断开后再断一次 ⇒ 如实说「不是我们接的」，不碰文件 */
      const again = revertClient(c.def, { dataDir: home });
      assert.equal(again.ok, false, "第二次断开必须说不成");
      for (const [rel, before] of Object.entries(texts)) {
        assert.equal(fs.readFileSync(path.join(home, rel), "utf8"), before,
          `★ ${c.id}：失败的断开动了用户的文件`);
      }
    });
  }
});

/* ====================================================================== *
 * ③ 读不懂就不写
 * ====================================================================== */

describe("③ 读不懂的配置 ⇒ 中止，用户文件一个字节都没被改", () => {
  const BROKEN = "{ this is not json ";

  for (const c of CASES) {
    test(`③ ${c.id}：坏文件 ⇒ 报错、不写`, () => {
      const home = tmpDir();
      const files = c.files.map((rel) => {
        const file = path.join(home, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, BROKEN, "utf8");
        return file;
      });
      const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, false, `${c.id}：坏文件不该被接线`);
      assert.match(r.detail, /读不懂|读不了|写不了/, `${c.id}：报错信息没说清：${r.detail}`);
      for (const f of files) {
        assert.equal(fs.readFileSync(f, "utf8"), BROKEN, `★ ${c.id}：用户的坏文件被改写了`);
      }
      /* 失败时不留下备份（否则还原时会拿错误的原值覆盖用户文件） */
      assert.equal(fs.existsSync(backupFileOf(c.id, home)), false,
        `★ ${c.id}：失败的接线留下了备份`);
    });
  }

  test("③ 多文件：一份坏了，另一份也不许动", () => {
    const c = CASES.find((x) => x.id === "cline");
    const home = tmpDir();
    const good = path.join(home, ".cline/data/settings/providers.json");
    const bad = path.join(home, ".cline/data/settings/models.json");
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    const goodText = asText({ version: 1, providers: {} });
    fs.writeFileSync(good, goodText, "utf8");
    fs.writeFileSync(bad, BROKEN, "utf8");
    const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, false, "有一份坏了就不该接");
    assert.equal(fs.readFileSync(good, "utf8"), goodText,
      "★ 一份文件坏了，另一份却已经被写了");
    assert.equal(fs.readFileSync(bad, "utf8"), BROKEN, "★ 用户的坏文件被改写了");
  });
});

/* ====================================================================== *
 * ⑥ 全新安装：文件原本不在
 * ====================================================================== */

describe("⑥ 全新安装：文件原本不在 ⇒ 从零建起", () => {
  for (const c of CASES) {
    test(`⑥ ${c.id}：文件建出来了，我们那块也在`, () => {
      const home = tmpDir();
      const r = applyClient(c.def, { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, true, `接线失败：${r.detail}`);
      for (const rel of c.files) {
        const file = path.join(home, rel);
        assert.ok(fs.existsSync(file), `${c.id}：${rel} 没写出来`);
        /* 建出来的必须是**能解析的 JSON** —— 客户端读不懂就是废文件。 */
        JSON.parse(fs.readFileSync(file, "utf8"));
      }
      const [rel, p, ok] = c.list.freshCheck || c.list.check;
      const v = valueAt(c, home, rel, p);
      assert.ok(ok(v), `${c.id}：接上了但 ${p} 不对（${JSON.stringify(v)}）`);
      /* 断开 ⇒ 我们写的那几处没了（文件本身可以留着 —— 底座不删用户没让删的文件） */
      const rv = revertClient(c.def, { dataDir: home });
      assert.equal(rv.ok, true, rv.detail);
      const v2 = valueAt(c, home, rel, p);
      assert.equal(ok(v2), false, `${c.id}：断开后 ${p} 还在`);
    });
  }
});

/* ====================================================================== *
 * ④ 反向对照（声明级）：断掉「写模型清单」那一处 ⇒ 判据必须变红
 * ====================================================================== */

describe("④ 反向对照：断掉「写模型清单」⇒ ① 的判据必须红", () => {
  for (const c of CASES) {
    test(`④ ${c.id}：断臂之后那个判据不再成立`, () => {
      const { home } = seed(c, c);
      const broken = armSabotage(c.def, c.list.write);
      const r = applyClient(broken, { ...CTX, home }, { dataDir: home });
      assert.equal(r.ok, true, `断臂之后接线本身应当还是成功（只是少写一处）：${r.detail}`);
      /* 判「模型清单」的那条判据必须**不再成立** —— 否则它是恒真的。 */
      const [rel, p, ok] = c.list.check;
      const v = valueAt(c, home, rel, p);
      assert.equal(ok(v), false,
        `★ ${c.id}：断掉「${c.list.write}」之后判据仍然成立 —— 那它测了个寂寞`);
    });
  }
});

/* ====================================================================== *
 * ⑤ 反向对照（源码级）：复制一份声明，在副本上删掉「写模型清单」那一行
 * ====================================================================== */

describe("⑤ 反向对照（源码级）：副本改坏 ⇒ 判据必须红", () => {
  test("⑤ qwen-code：副本里删掉写模型清单那一行 ⇒ 判据不再成立", async () => {
    /* 把 clients 目录与 edit-json.mjs 复制到临时目录（副本要能 import 到
       base.mjs 与 edit-json.mjs —— 相对路径得在） —— **仓库源码一个字不动**。 */
    const dir = path.join(TMPROOT, "broken-clients", "src", "server");
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(REPO, "src", "server", "clients"), path.join(dir, "clients"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "src", "server", "edit-json.mjs"), path.join(dir, "edit-json.mjs"));

    const target = path.join(dir, "clients", "qwen-code.mjs");
    const text = fs.readFileSync(target, "utf8");
    const broken = text.replace(/^[ \t]*\{ path: "modelProviders\.openai".*\n/m, "");
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(target, broken, "utf8");

    const mod = await import(pathToFileURL(target).href + `?v=${Date.now()}`);
    const c = CASES.find((x) => x.id === "qwen-code");
    const home = tmpDir();
    const file = path.join(home, ".qwen", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, asText(c.fixture[".qwen/settings.json"]), "utf8");
    const r = applyClient(mod.qwenCodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const listEntry = c.expect.find(([p]) => p === "modelProviders.openai");
    const v = valueAt(c, home, ".qwen/settings.json", "modelProviders.openai");
    assert.equal(listEntry[1](v), false,
      "★ 副本里删掉了写模型清单那一行，判据却仍然成立 —— 那它测了个寂寞");
  });
});
