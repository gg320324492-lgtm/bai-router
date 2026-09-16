// 沙箱预览启动器：设好临时数据目录/伪 USERPROFILE 后 exec 真正的 server.mjs。
// 供 .claude/launch.json 用 node 直接调用，避免 cmd 路径在启动器里的转义问题。
// 绝不触碰真实 %APPDATA%\bai-router 与 ~/.claude。
const { execFile } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const TMP = os.tmpdir();
const DATA = path.join(TMP, "bai-test");
const HOME = path.join(TMP, "sb-home");
fs.mkdirSync(path.join(DATA), { recursive: true });
fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
fs.mkdirSync(path.join(HOME, "AppData", "Local", "Claude-3p", "configLibrary"), { recursive: true });
const settings = path.join(HOME, ".claude", "settings.json");
if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721", ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED" } }, null, 2));
const applied = "00000000-0000-4000-8000-000000157210";
const meta = path.join(HOME, "AppData", "Local", "Claude-3p", "configLibrary", "_meta.json");
if (!fs.existsSync(meta)) fs.writeFileSync(meta, JSON.stringify({ appliedId: applied, entries: [{ id: applied, name: "CC Switch" }] }, null, 2));
const desk = path.join(HOME, "AppData", "Local", "Claude-3p", "configLibrary", applied + ".json");
if (!fs.existsSync(desk)) fs.writeFileSync(desk, JSON.stringify({ inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop", inferenceGatewayApiKey: "ccs-x", inferenceModels: [] }, null, 2));
if (!fs.existsSync(path.join(DATA, "config.json"))) {
  // 测试配置：sn 用真实 SenseNova key（境内直连可用），端口全部挪到 16xxx 段
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({
    apiKey: "sk-test-bai", upstream: "https://api.b.ai", proxy: "",
    relayPort: 16722, panelPort: 16723, defaultModel: "qwen3.8-flash",
    availableModels: ["qwen3.8-flash"],
    mapping: {
      "claude-fable-5": { target: "qwen3.8-flash", label: "Qwen" },
      "claude-sonnet-5": { target: "qwen3.8-flash", label: "Qwen" },
      "claude-opus-5": { target: "qwen3.8-flash", label: "Qwen" },
      "claude-haiku-4-5": { target: "qwen3.8-flash", label: "Qwen" },
    },
    sn: {
      apiKey: "sk-1CLPUwwwiVh8XxTEXCFK6WJGt5QJJwph", upstream: "https://token.sensenova.cn",
      relayPort: 16732, defaultModel: "sensenova-6.8-flash-lite",
      availableModels: ["sensenova-6.8-flash-lite", "deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2", "kimi-k3"],
      mapping: {
        "claude-fable-5": { target: "sensenova-6.8-flash-lite", label: "SenseNova" },
        "claude-sonnet-5": { target: "glm-5.2", label: "GLM" },
        "claude-opus-5": { target: "kimi-k3", label: "Kimi" },
        "claude-haiku-4-5": { target: "deepseek-v4-flash", label: "DS-Flash" },
      },
    },
  }, null, 2) + "\n");
}

const SRV = "C:\\Users\\pc\\bai-router-build\\src\\server\\server.mjs";
const child = execFile(process.execPath, [SRV], {
  env: { ...process.env, BAI_DATA_DIR: DATA, USERPROFILE: HOME, NODE_USE_ENV_PROXY: "1", NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "", HTTPS_PROXY: "" },
  windowsHide: true,
}, () => process.exit(0));
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.on("SIGTERM", () => { child.kill(); process.exit(0); });
