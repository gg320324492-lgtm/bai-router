/* 面板加载的三条路径。
 *
 * 为什么用「先加载、后切换拦截模式」而不是「带着拦截器 loadURL」：
 * 页面脚本在 load 阶段就会发第一个 /api/status，拦截器一挂上 loadURL 就不 resolve，
 * 整个测试卡死（第一版就是这么挂的）。改成先让页面正常起来，再切 MODE，
 * 观察它**下一轮 5 秒轮询**的表现——这正是用户实际会遇到的场景。
 *
 *   A 正常 → 填满，无任何超时字样
 *   B 真慢 → /api/status 延迟 14 秒（超过 12 秒上限）→ 真的触发 AbortSignal.timeout
 *   C 真断 → /api/status 中断 → fetch 抛错（非超时）→ 显示「连不上」
 */
const { app, BrowserWindow, session } = require("electron");
const fs = require("fs");

const PANEL = "http://127.0.0.1:15723";

app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

const PROBE = `
  (() => ({
    sentence: (document.getElementById("statusSentence")||{}).textContent || "",
    svc: (document.getElementById("svc")||{}).textContent || "",
    relay: (document.getElementById("txtRelay")||{}).textContent || "",
    cells: document.querySelectorAll("#matrixGrid .chan-row").length,
    diag: document.querySelectorAll(".ditem").length,
  }))()
`;

let MODE = null, DELAY_MS = 0;
function installInterceptor(sess) {
  /* urls 里**不能带端口**——`Invalid port`，注册直接抛（第一版就是这么静默挂掉的：
     拦截器根本没装上，页面正常加载，测试一路等到超时）。Electron 的匹配模式按
     host+path 分段，这里只写路径。 */
  sess.webRequest.onBeforeRequest({ urls: ["*://127.0.0.1/api/status*"] }, (details, cb) => {
    if (MODE === "abort") return cb({ cancel: true });
    if (MODE === "delay") return setTimeout(() => cb({}), DELAY_MS);
    cb({});
  });
  // 装完立刻自检：注册失败会抛，别让它悄悄变成"没装上"
  if (!sess.webRequest) throw new Error("webRequest 不可用");
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? "✔" : "✗"} ${name}\n      ${detail}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  installInterceptor(session.defaultSession);
  const win = new BrowserWindow({ width: 1440, height: 1050, show: false, webPreferences: { offscreen: true } });
  const snap = () => win.webContents.executeJavaScript(PROBE).catch(() => null);

  // ── A 正常 ──
  console.log("A 正常加载");
  MODE = null;
  await win.loadURL(PANEL + "/#/console");
  await wait(3500);
  const a = await snap();
  check("填满了", a && a.cells >= 8 && a.diag > 0, `cells=${a && a.cells} diag=${a && a.diag}`);
  check("无超时/读取中字样",
    a && !/超时|仍在读取|读取中/.test(a.sentence + a.svc + a.relay),
    `sentence="${a && a.sentence.slice(0, 34)}"`);

  // ── B 真慢：切拦截，等下一轮轮询 ──
  console.log("\nB 真慢（/api/status 延迟 14 秒 > 12 秒上限）");
  MODE = "delay"; DELAY_MS = 14000;
  await wait(9000);                                  // 5s 慢计时器应已说话
  const bMid = await snap();
  check("5 秒后仍在读就明说「已超过 5 秒」并说清页面还是旧数据",
    bMid && /超过 5 秒/.test(bMid.sentence) && /上一次的结果|仍在读取/.test(bMid.sentence),
    `sentence="${bMid && bMid.sentence.slice(0, 46)}"`);
  await wait(9000);                                  // 累计 > 12s，超时应触发
  const b = await snap();
  const bTxt = (b && (b.sentence + " " + b.svc + " " + b.relay)) || "";
  check("超过 12 秒报「读取超时」", /读取超时/.test(bTxt), `svc="${b && b.svc}"`);
  check("超时文案**不含**「已停止」（别诱导白重启）", !/已停止/.test(bTxt), "无「已停止」✔");
  check("提示「先别急着重启」", /先别急着重启/.test(b.sentence), (b && b.sentence.slice(0, 38)) + "…");

  // ── C 真断：中断请求（立刻失败，不等超时）──
  /* 等足一整轮轮询（5s）+ 余量。原来只等 8 秒是从 B 之后算的，而 B 结束时刚好有一轮
   * 延迟请求还悬着，读到的仍是上一步的「读取超时」文案——看着像产品没修好，其实是
   * 我在读上一帧。 */
  console.log("\nC 真断（/api/status 被中断）");
  MODE = "abort";
  await wait(14000);                                 // 让 B 悬着的延迟请求彻底结束，再等一轮轮询
  const c = await snap();
  const cTxt = (c && (c.sentence + " " + c.svc + " " + c.relay)) || "";
  check("说「已停止/连不上」，而**不是**「读取超时」",
    /已停止|连不上/.test(cTxt) && !/读取超时/.test(cTxt),
    `svc="${c && c.svc}" sentence="${c && c.sentence.slice(0, 30)}"`);

  console.log("");
  const fail = results.filter((r) => !r.ok).length;
  console.log(fail ? `  ✗ ${fail} 条失败` : `  ✔ 全部通过（${results.length} 条）`);
  app.exit(fail ? 1 : 0);
});
