/* 真壳环境验「滚动后三键仍在视口内」。
 *
 * 两个坑（都踩过）：
 *  1. 沙箱（浏览器直开）测不到——没有 preload 桥 → body.no-frame → .winCtrls 被 display:none。
 *  2. provider.html 用**绝对路径**引资源（/panel-common.css、/providers.js、/panel-common.js），
 *     所以不能用 loadFile 打开临时目录里的副本——绝对路径会指到文件系统根，三份资源全 404，
 *     量出来的是裸 HTML（表现为「position: static，我的 CSS 没生效」）。
 * 正确做法：起一个本地静态服务提供资源，再把 preload 指向它，这样既有同源资源、又有 preload 桥。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();
["win-minimize", "win-toggle-maximize", "win-close"].forEach((c) => ipcMain.handle(c, () => ({ ok: true })));

const SRC = "E:/BAI/src/server";
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  const f = path.join(SRC, p === "/" ? "provider.html" : p);
  if (!f.startsWith(path.resolve(SRC)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nope"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(17999, "127.0.0.1", r));

  const w = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: { preload: "E:/BAI/src/preload.js", offscreen: true, contextIsolation: true },
  });
  await w.loadURL("http://127.0.0.1:17999/");
  await new Promise((r) => setTimeout(r, 3500));

  const r = await w.webContents.executeJavaScript(`(async () => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), vis: b.bottom > 0 && b.top < innerHeight }; };
    const out = {
      bodyClass: document.body.className, 有桥: !!window.baiDesktop,
      ctrlsDisplay: getComputedStyle(document.getElementById("winCtrls")).display,
      顶栏position: getComputedStyle(document.querySelector(".top")).position,
      cssLoaded: getComputedStyle(document.querySelector(".app")).position,
      pageH: document.documentElement.scrollHeight, viewH: innerHeight,
    };
    out.before = { top: box(".top"), close: box("#winClose") };
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 700));
    out.scrolledY = Math.round(window.scrollY);
    out.after = { top: box(".top"), close: box("#winClose") };
    const c = document.getElementById("winClose");
    if (c) { const b = c.getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      out.hit = el ? ((c.contains(el) || el === c) ? "可点 ✔" : "被 " + (el.id || el.tagName) + " 挡住 ✘") : "点不到 ✘"; }
    return out;
  })()`).catch((e) => ({ __e: String(e) }));

  console.log(JSON.stringify(r, null, 1));
  const a = r.after || {};
  const ok = r.cssLoaded === "relative" && a.top && a.close && a.top.vis && a.close.vis;
  console.log(ok ? "\n✔ 资源已加载；滚到底后顶栏与三键仍在视口内" : "\n✘ 未通过（见上）");
  server.close();
  app.quit();
});