/* Electron 无头截图（契约 v17 第六节验证 4）
 *
 * 沿用验证 v16 的做法：独立 Electron 主进程 → BrowserWindow → loadURL 指向隔离实例
 * → 等渲染层把真实状态拉完 → capturePage。
 *
 * 截的是**隔离实例**（BAI_DATA_DIR 指向临时目录、凭据全空），所以图上出现
 * 「未配置」是真实且预期的——这一步验的就是"没有数据时面板如实说没有"。
 *
 * 用法：electron shots-v17.cjs
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

/* 用 scripts/sandbox-launch.cjs 起的隔离沙箱（16xxx），不再另起一套实例。 */
const BASE = "http://127.0.0.1:16723";
const OUT = "C:/Users/pc/AppData/Local/Temp/opencode/ui-design/shots";

/* wantDom：等就绪时要看到的视图容器，用来证明「当前是新文档」。
   （hash 段 console/cred/fo/settings ↔ viewConsole/viewCred/viewFo/viewSettings） */
const SHOTS = [
  { file: "v17-console-dark.png",  url: `${BASE}/#/console`,  theme: "dark",  wantDom: "viewConsole", w: 1440, h: 1000 },
  { file: "v17-console-light.png", url: `${BASE}/#/console`,  theme: "light", wantDom: "viewConsole", w: 1440, h: 1000 },
  { file: "v17-cred-dark.png",     url: `${BASE}/#/cred`,     theme: "dark",  wantDom: "viewCred",    w: 1440, h: 1000 },
  { file: "v17-cred-light.png",    url: `${BASE}/#/cred`,     theme: "light", wantDom: "viewCred",    w: 1440, h: 1000 },
  { file: "v17-fo-dark.png",       url: `${BASE}/#/fo`,       theme: "dark",  wantDom: "viewFo",      w: 1440, h: 1000 },
  { file: "v17-fo-light.png",      url: `${BASE}/#/fo`,       theme: "light", wantDom: "viewFo",      w: 1440, h: 1000 },
  { file: "v17-settings-dark.png",   url: `${BASE}/#/settings`, theme: "dark",  wantDom: "viewSettings", w: 1440, h: 1000 },
  { file: "v17-settings-light.png",  url: `${BASE}/#/settings`, theme: "light", wantDom: "viewSettings", w: 1440, h: 1000 },
  { file: "v17-deeplink-wb.png",   url: `${BASE}/workbuddy#/console`, theme: "dark", wantDom: "viewConsole", w: 1440, h: 1000 },
  { file: "v17-narrow-1100.png",   url: `${BASE}/#/console`,  theme: "dark",  wantDom: "viewConsole", w: 1100, h: 900 },
];

app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

/* 每张图前先把主题钉死：渲染层的 wireTheme 会读 localStorage 与系统偏好，
   这里直接改 html[data-theme]，免得同一批次里两套主题串味。 */
async function pinTheme(win, theme) {
  await win.webContents.executeJavaScript(`
    (() => {
      const root = document.documentElement;
      root.classList.add("no-trans");
      root.setAttribute("data-theme", ${JSON.stringify(theme)});
      try { localStorage.setItem("bai.theme", ${JSON.stringify(theme)}); } catch (e) {}
      const i = document.getElementById("themeIcon"), x = document.getElementById("themeText");
      if (i) i.textContent = ${JSON.stringify(theme)} === "light" ? "☀" : "☾";
      if (x) x.textContent = ${JSON.stringify(theme)} === "light" ? "亮色" : "暗色";
      setTimeout(() => root.classList.remove("no-trans"), 0);
      return true;
    })()
  `);
}

/* 等真实状态到位：状态带六格填完 + 矩阵八格生成完，再截。
 *
 * 关键：必须先证明「当前是**新**文档」。loadURL 解析时 executeJavaScript 可能
 * 还在旧文档上执行——上一张图（控制台）已经填满了，waitReady 会立刻返回 true，
 * 于是截到的是新页面刚 boot 完、状态带还是一排「—」的那一瞬。
 * 判据用**期望的视图容器**：旧文档的 .view.on 不会是这一张要的。
 */
async function waitReady(win, wantDom) {
  for (let i = 0; i < 80; i++) {
    const ok = await win.webContents.executeJavaScript(`
      (() => {
        const on = document.querySelector(".view.on");
        const cells = document.querySelectorAll("#matrixGrid .cell");
        const gauge = document.getElementById("txtRelay");
        const sentence = document.getElementById("statusSentence");
        const ready = document.readyState === "complete";
        const done = ready
          && !!on && on.id === ${JSON.stringify(wantDom)}
          && cells.length >= 8
          && !!gauge && gauge.textContent && gauge.textContent !== "—"
          && !!sentence && sentence.textContent && !/正在读取/.test(sentence.textContent);
        return { done, view: on ? on.id : null, cells: cells.length,
                 relay: gauge ? gauge.textContent : "" };
      })()
    `).catch(() => null);
    if (ok && ok.done) return ok;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/* 把控制台上的报错抓出来带进报告——空图和"报错的图"长得一样，得区分。 */
async function collectErrors(win) {
  return win.webContents.executeJavaScript("window.__v17err || []").catch(() => []);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = [];
  /* 单窗口复用：每次用唯一的 ?shot=N 让 URL 不同——同址 loadURL 在 Electron 上
     会以 ERR_FAILED(-2) 拒绝（hash 只变也一样），新开窗口则每张都要重建渲染层。
     用**离屏渲染**：show:false 的普通窗口不产合成帧，capturePage 会拿回旧画面
     （实测拍到过早已不成立的「中转未起 / 当前已关闭」）；设成可见又会在本机弹窗。
     offscreen 模式专门为无头出图设计，每帧都会真的合成。 */
  const win = new BrowserWindow({
    width: 1440, height: 1000, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  let errs = [];
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    /* level>=2 是 warning/error。Electron 自己的 CSP 安全提示与本项目无关，滤掉——
       否则每张图都挂一条同名的噪音，真正的页面报错反而看不见。 */
    if (/Electron Security Warning/.test(message)) return;
    if (level >= 2) errs.push(`${message} @ ${String(sourceId).split("/").pop()}:${line}`);
  });

  for (let i = 0; i < SHOTS.length; i++) {
    const s = SHOTS[i];
    errs = [];
    win.setSize(s.w, s.h);
    /* query 必须在 hash **之前**：拼在后面会变成 "#/cred&shot=1"，
       hash 段匹配不上任何视图 id，页面会静默回落到控制台——
       这正是第一版截图八张全是控制台的原因。 */
    const [base, hash] = s.url.split("#");
    const full = `${base}?shot=${i}${hash ? "#" + hash : ""}`;
    try {
      await win.loadURL(full);
    } catch (e) {
      console.log(`${s.file}  ✘ loadURL 失败: ${e.message}`);
      continue;
    }
    await pinTheme(win, s.theme);
    const state = await waitReady(win, s.wantDom);
    if (!state) console.log(`   (warn) ${s.file} 未等到「${s.wantDom} + 状态就绪」，仍继续截图`);
    // 再等一拍：视图切换后的卡片挂载是异步的
    await new Promise((r) => setTimeout(r, 900));
    await pinTheme(win, s.theme);
    await new Promise((r) => setTimeout(r, 250));

    /* 隐藏窗口的合成器有时不重绘，capturePage 会拿到**上一张**的帧。
       实测：DOM 里状态带已填好（txtRelay="运行中"），存出来的 PNG 却还是一排「—」。
       强制 invalidate 让合成器重画一帧再截。 */
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 500));
    const pre = await win.webContents.executeJavaScript(
      `({ relay: (document.getElementById("txtRelay")||{}).textContent,
          sentence: ((document.getElementById("statusSentence")||{}).textContent||"").slice(0,24) })`
    ).catch(() => ({}));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, s.file), img.toPNG());
    const info = await win.webContents.executeJavaScript(`
      (() => {
        const sel = document.querySelector("#matrixGrid .cell.sel");
        return {
          view: (document.querySelector(".view.on") || {}).id || null,
          theme: document.documentElement.getAttribute("data-theme"),
          cells: document.querySelectorAll("#matrixGrid .cell").length,
          selected: sel ? sel.dataset.k : null,
          selSelected: !!sel && sel.classList.contains("sel"),
          credRows: document.querySelectorAll("#credList .credrow").length,
          credCards: document.querySelectorAll("#credList .crow .cardbody").length,
          foNodes: document.querySelectorAll("#foPanel .node").length,
          chnRows: document.querySelectorAll("#setChannels tbody tr").length,
          diagItems: document.querySelectorAll("#diagList .ditem").length,
          routeRows: document.querySelectorAll("#routeBody tr").length,
          sentence: (document.getElementById("statusSentence") || {}).textContent || "",
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
        };
      })()
    `).catch((e) => ({ error: String(e) }));

    report.push({ ...s, ...info, errs });
    console.log(`${s.file}  view=${info.view} theme=${info.theme} cells=${info.cells} sel=${info.selected}`
      + ` selHi=${info.selSelected} rows=${info.routeRows} cred=${info.credRows}/${info.credCards}cards`
      + ` fo=${info.foNodes} chn=${info.chnRows} diag=${info.diagItems}`
      + ` hOverflow=${info.scrollW > info.clientW ? "是(" + info.scrollW + ">" + info.clientW + ")" : "否"}`
      + ` 截前状态带=${JSON.stringify(pre.relay)}|${JSON.stringify(pre.sentence)}`
      + ` errs=${errs.length}`);
    for (const e of errs) console.log(`    ! ${e}`);
  }
  fs.writeFileSync(path.join(OUT, "v17-report.json"), JSON.stringify(report, null, 2));
  console.log("\n截图目录: " + OUT);
  app.quit();
});