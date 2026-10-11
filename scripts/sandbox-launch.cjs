// 沙箱预览启动器：设好临时数据目录/伪 USERPROFILE 后 exec 真正的 server.mjs。
// 供 .claude/launch.json 用 node 直接调用，避免 cmd 路径在启动器里的转义问题。
// 绝不触碰真实 %APPDATA%\bai-router 与 ~/.claude。
//
// ── 端口隔离（v1.0.63 修）──────────────────────────────────────────────────
// 此前这里只把顶层的 relayPort/panelPort 和 sn.relayPort 挪到了 16xxx，
// zen/wb/qd/or 四家仍沿用 config.defaults.json 的 15752/15742/15762/15772。
// 正式实例正跑在那几个端口上 → 沙箱起来后这四家 bind 失败，而 server.mjs 的
// 兜底是「已有健康实例在跑，本实例转入待命」，**整个面板永远起不来**，
// 表现为 `fetch failed`，很容易误判成面板代码坏了。
//
// 现在七个监听口全部挪进 16xxx，与正式实例的号段一一对应（+1000），
// 肉眼就能对上，且新增渠道时只需往 PORTS 加一行。
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
/* 沙箱专用的七个监听口。号段与正式实例逐一对应（正式 15722/15732/… → 沙箱 16722/16732/…），
   一眼能对上是谁。bai 是平铺在顶层的（没有 BAI.bai 子对象），单独列。 */
const PORTS = { bai: 16722, panel: 16723, sn: 16732, zen: 16742, wb: 16752, qd: 16762, or: 16772 };
const CHANNELS = ["sn", "zen", "wb", "qd", "or"];

/* 种子配置**从 config.defaults.json 派生**，不再手写。
   手写那份只覆盖了 bai/sn 两家、模型清单还截断成 1~5 项；默认值里本来就有完整的
   四档映射与各家模型清单（providers.js 的 C8 闸门也拿它俩对账），直接继承既不会
   漂移，新增渠道也不用在这里补一遍。 */
/* 沙箱启动时必须把 proxy 预置成 server.mjs 自己会选中的那个通道。
 *
 * 原因：server.mjs 激活后必跑一次 `scheduleProxyCheck(0, "启动探测")`，它按
 * `[cfg.proxy, HTTPS_PROXY, ...PROXY_CANDIDATES, "DIRECT"]` 的顺序挑第一个**探得通**的；
 * 挑中的跟配置里现值不同就 `applyProxy` → 写配置 → **spawn 一个新进程把自己换掉**
 * （"代理变更，服务自重启以应用新通道"）。而 cfg.proxy 排在候选表**第一位**——
 * 预置成它要选的那个值，探测结果就与现值相同，不写配置、不重启。
 *
 * 注意 `BAI_ENV_FIXED=1` **管不到这条**：它只管启动时的 NO_PROXY 环境自检，
 * 代理通道变更是另一条独立的自重启路径（server.mjs 里另一处 spawn）。
 *
 * 探测判据必须与 server.mjs 的 probeVia() 一致：curl 打真实上游 origin，
 * **任何 1xx–5xx 都算通**（未带 key 会返回 401/403，那正好证明链路可达）。
 * 早先这里只做 TCP 连通性判断，结果预置了 7890 —— 那口开着但不真代理，
 * 服务探到的是 7897，照样自重启。判据不够就等于没修。
 */
const PROXY_CANDIDATES = ["http://127.0.0.1:7890", "http://127.0.0.1:7897", "http://127.0.0.1:7891", "http://127.0.0.1:10809", "http://127.0.0.1:2080"];

function probeVia(proxy, origin) {
  const args = ["-s", "--ssl-no-revoke", "-m", "6", "-o", "NUL", "-w", "%{http_code}"];
  if (proxy !== "DIRECT") args.push("-x", proxy);
  args.push(origin);
  return new Promise((res) => {
    execFile("curl", args, { windowsHide: true, timeout: 9000 }, (_e, so) => {
      res(/^[1-5]\d\d$/.test(String(so).trim()));
    }).on("error", () => res(false));   // 没装 curl / 端口不通 → 不可用，继续下一个
  });
}

/* 与 detectWorkingProxy 同序同判据，取第一个探得通的；都探不通就直连。 */
async function reachableProxy(origin) {
  for (const c of PROXY_CANDIDATES) if (await probeVia(c, origin)) return c;
  return "";
}

const SRV = path.resolve(__dirname, "..", "src", "server", "server.mjs");
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(path.dirname(SRV), "config.defaults.json"), "utf8"));

async function seedConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));

  cfg.relayPort = PORTS.bai;
  cfg.panelPort = PORTS.panel;
  /* 探测目标取与 probeVia 相同的真实上游 origin（未带 key，返回 401/403 即算通）。 */
  cfg.proxy = await reachableProxy(originOf(DEFAULTS.upstream) + "/v1/models");
  // 假 key：只为让接线判定与映射下拉有对象可读，不是任何真实凭据
  cfg.apiKey = "sk-test-bai";

  for (const k of CHANNELS) {
    if (!cfg[k]) continue;
    cfg[k].relayPort = PORTS[k];
    cfg[k].useProxy = false;
    /* 沙箱不持有任何真实凭据。清空后面板会如实显示"未配置"——那正是要验的形态。 */
    cfg[k].apiKey = "";
    cfg[k].keys = [];
    for (const f of ["accessToken", "refreshToken", "deviceToken", "userId"]) delete cfg[k][f];
  }
  /* 自测某家真实上游时可给真 key：先 `$env:BAI_TEST_SN_KEY = "sk-..."` 再跑本脚本。
     绝不把真 key 写进仓库（安全红线，C13 闸门同理）。 */
  if (process.env.BAI_TEST_SN_KEY && cfg.sn) cfg.sn.apiKey = process.env.BAI_TEST_SN_KEY;

  return cfg;
}

/* 真正的判据是「会不会和正式实例抢端口」，而不是「等不等于 PORTS 这张表」。
   两者差别很大：前者允许你在沙箱里把某个口手工改成别的 16xxx 号（配置被保留），
   后者会把任何手工调整都冲掉——那是比原版（存在就不覆盖）更差的行为。
   正式实例的号段从 config.defaults.json 现读，改端口时不会漏。 */
function collidesWithProd(cfg) {
  if (!cfg) return true;
  const prod = new Set([DEFAULTS.relayPort, DEFAULTS.panelPort, ...CHANNELS.map((k) => DEFAULTS[k] && DEFAULTS[k].relayPort)]);
  const mine = [cfg.relayPort, cfg.panelPort, ...CHANNELS.map((k) => cfg[k] && cfg[k].relayPort)];
  return mine.some((p) => p != null && prod.has(p));
}

/* ---------------------------------------------------------------------------
 * NO_PROXY：与 server.mjs 的 computeNoProxy() 逐行对应，改那边记得改这里。
 * 只差两个常量来自 server.mjs 内部（WorkBuddy 的国际/国内默认上游），
 * 这里照抄；其余全部从本沙箱的配置现算，所以沙箱改了上游也不会算错。
 *
 * 为什么必须算准：server.mjs 启动时拿它和环境里的 NO_PROXY 逐字比对，
 * 对不上就 spawn 一个修正了环境的新进程把自己换掉（自检重启）。本启动器
 * 是 execFile 监督子进程，**子进程一退出启动器就跟着退**，而服务其实还在跑——
 * 于是 `.claude/launch.json` 那边看到的是"启动器已结束"，排查时极难想到
 * 是自检重启。上面 reachableProxy() 处理的代理通道重启是同一类问题的另一半。
 *
 * 兜底是下面那个 `BAI_ENV_FIXED=1`：它让自检只打一行告警、**绝不重启**
 * （这是 server.mjs 明确设计的，v1.0.37 的重启死循环就是从这里来的）。
 * NO_PROXY 算得准是为了不产生那行告警；万一将来漂移，最坏也只是日志里多一句。
 * ------------------------------------------------------------------------- */
const WB_UPSTREAM_INTL = "https://www.workbuddy.ai"; // 与 server.mjs 同名常量，两处同步
const WB_UPSTREAM_CN = "https://www.workbuddy.cn";
function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }
function originOf(u) { try { return new URL(u).origin; } catch { return "https://api.b.ai"; } }
function computeNoProxy(cfg) {
  const list = ["127.0.0.1", "localhost"];
  const add = (host, useProxy) => { if (!useProxy && host && !list.includes(host)) list.push(host); };
  const wbUseProxy = cfg.wb && cfg.wb.useProxy === true;
  add(hostOf(WB_UPSTREAM_INTL), wbUseProxy);
  add(hostOf(WB_UPSTREAM_CN), wbUseProxy);
  add(hostOf(cfg.wb && cfg.wb.upstream), wbUseProxy);
  for (const k of ["sn", "zen", "qd", "or"]) {
    add(hostOf(cfg[k] && cfg[k].upstream), !!(cfg[k] && cfg[k].useProxy));
  }
  return list.join(",");
}

async function main() {
  const CFG_FILE = path.join(DATA, "config.json");
  let sandboxCfg;
  {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch { /* 没有就读默认 */ }
    /* 探测目标与 server.mjs 的 probeVia 同源：真实上游的 origin + /v1/models */
    const probeTarget = originOf((prev && prev.upstream) || DEFAULTS.upstream) + "/v1/models";

    if (!collidesWithProd(prev)) {
      sandboxCfg = prev;
      console.log(`[sandbox] 沿用现有配置（端口已挪开，不撞正式实例）: ${CFG_FILE}`);
      /* 只补 proxy 这一个字段，不动别的。旧版启动器留下的配置 proxy 是空的，
         启动探测会挑出本机可用的代理 → 写配置 → 自重启（见上面 reachableProxy 的说明）。
         这里就地改掉，让探测结果与现值一致。其余字段原样保留，手工改动不会丢。 */
      const want = await reachableProxy(probeTarget);
      if (want && sandboxCfg.proxy !== want) {
        sandboxCfg.proxy = want;
        fs.writeFileSync(CFG_FILE, JSON.stringify(sandboxCfg, null, 2) + "\n");
        console.log(`[sandbox] 已把 proxy 预置为 ${want}（避免启动探测触发自重启）`);
      }
    } else {
      if (prev) console.log(`[sandbox] 现有配置还指着正式实例的端口，已重新生成（多半是旧版启动器留下的）`);
      sandboxCfg = await seedConfig();
      fs.writeFileSync(CFG_FILE, JSON.stringify(sandboxCfg, null, 2) + "\n");
      console.log(`[sandbox] 已生成配置: ${CFG_FILE}`);
      console.log(`[sandbox] 监听口: ` + [
        `中转 :${PORTS.bai}`, `面板 :${PORTS.panel}`,
        ...CHANNELS.map((k) => `${k} :${PORTS[k]}`),
      ].join("  "));
    }
  }

  const NO_PROXY = computeNoProxy(sandboxCfg || {});

  console.log(`[sandbox] BAI_ENV_FIXED=1 · NO_PROXY=${NO_PROXY}`);
  const child = execFile(process.execPath, [SRV], {
    env: {
      ...process.env,
      BAI_DATA_DIR: DATA,
      USERPROFILE: HOME,
      NODE_USE_ENV_PROXY: "1",
      // 声明环境已就位 → NO_PROXY 对不上也只告警、绝不自动重启（见上面说明）
      BAI_ENV_FIXED: "1",
      NO_PROXY,
      no_proxy: NO_PROXY,          // Node 认小写这个；两边都给，免得版本差异踩空
      HTTPS_PROXY: "",            // 置空，免得它进了 detectWorkingProxy 的候选表
      HTTP_PROXY: "",
    },
    windowsHide: true,
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  /* 退出码从 ChildProcess 的 'exit' 事件拿，**不要**用 execFile 的回调参数：
     那个回调是 `(err, stdout, stderr)`（stdio 默认被捕获成字符串），
     第二个参数是 **stdout 字符串**。把它当退出码传给 process.exit 会炸成
     `ERR_INVALID_ARG_TYPE: The "code" argument must be of type number`——
     表现是启动器在服务刚起来时自己崩掉，留下一个查不到主人的孤儿服务。 */
  child.on("error", (e) => {
    console.error(`[sandbox] 启动服务进程失败：${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) { console.error(`[sandbox] 服务被信号 ${signal} 终止`); process.exit(1); }
    process.exit(code == null ? 0 : code);
  });
  process.on("SIGTERM", () => { child.kill(); process.exit(0); });
}

main();
