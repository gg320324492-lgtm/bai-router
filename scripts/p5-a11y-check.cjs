/* Electron 无头检查：窄屏不溢出 + 键盘可达（P5 收尾的验收）
 *
 * 为什么用 Electron 而不是浏览器面板：用户用的就是这个窗口，
 * 而 Electron 的排版与真实应用一致（同样的字体、同样的滚动条占位）。
 *
 * 查五件事：
 *   ① **窄屏不横向溢出**：每个宽度 × 每个视图，scrollWidth 不得超过视口。
 *      横向溢出的后果是「右边有一截看不见的内容」，而用户不会往右拉 ——
 *      他只会以为那儿没有东西。
 *   ② **跳过导航**：第一个 Tab 必须能到那条「跳到主内容」。
 *   ③ **切屏后焦点跟着内容走**：键盘切屏，焦点要落进新视图（tabindex="-1" 的容器）。
 *   ④ **Esc 关浮层**：通知横幅、升级弹窗，Esc 都要能关。
 *   ⑤ **焦点环看得见**：键盘聚焦的元素要有 outline（浅色主题下也要够对比）。
 *
 * 用法：先起沙箱实例（node scripts/sandbox-launch.cjs），再
 *       electron scripts/p5-a11y-check.cjs
 * 报告写到 docs/evidence/p5-a11y-report.json（机器可读，可当回归基线）。
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const BASE = "http://127.0.0.1:16723";
const OUT = path.join(__dirname, "..", "docs", "evidence");

/* 宽度从宽到窄。480 是「手机上打开面板」那种极端情况。 */
const WIDTHS = [1440, 1100, 900, 700, 480];
const VIEWS = ["console", "channels", "fo", "settings", "quota", "traffic"];

app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

const report = { at: new Date().toISOString(), base: BASE, widths: [], keyboard: {}, problems: [] };

/* 载入一页并等到渲染层把真实状态拉完（状态带六格 + 视图容器已就位）。 */
async function openAt(win, view, w, h) {
  win.setSize(w, h);
  await win.loadURL(`${BASE}/#/${view}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const ok = await win.webContents.executeJavaScript(`
      (() => {
        const on = document.querySelector(".view.on");
        const cells = document.querySelectorAll("#matrixGrid .chan-row").length;
        return !!on && (cells > 0 || document.querySelector(".panelbox"));
      })()
    `).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 700));   // 等卡片把自己的第一屏画完
}

/* ① 窄屏：横向溢出 */
async function checkOverflow(win) {
  const rows = [];
  for (const w of WIDTHS) {
    for (const v of VIEWS) {
      await openAt(win, v, w, 900);
      const r = await win.webContents.executeJavaScript(`
        (() => ({
          view: (document.querySelector(".view.on") || {}).id || "",
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          bodyScrollW: document.body.scrollWidth,
        }))()
      `);
      const over = Math.max(r.scrollW, r.bodyScrollW) - r.clientW;
      rows.push({ w, view: r.view, scrollW: r.scrollW, clientW: r.clientW, over });
      if (over > 1) {
        report.problems.push(`横向溢出：${w}px 宽的「${r.view}」超出 ${over}px`);
      }
    }
  }
  report.widths = rows;
}

/* ② 跳过导航：第一个 Tab 是不是那条 skip link */
async function checkSkipLink(win) {
  await openAt(win, "console", 1440, 900);
  const r = await win.webContents.executeJavaScript(`
    (async () => {
      const el = document.querySelector(".skiplink");
      if (!el) return { ok: false, why: "没有 .skiplink" };
      /* ⚠⚠ **量之前先把过渡关掉**：.skiplink 的 top 有 .12s 过渡，而
         **隐藏的窗口不推进过渡**（Chromium 对不可见的窗口停掉动画）——
         于是量到的永远是过渡起点（-60），那是**环境**的毛病，不是页面的。
         关掉过渡量到的才是「聚焦之后它该在的位置」，也就是用户真能看见的那个。 */
      const old = el.style.transition;
      el.style.transition = "none";
      el.focus();
      const focused = document.activeElement === el;
      await new Promise((r) => setTimeout(r, 120));
      const rect = el.getBoundingClientRect();
      el.style.transition = old;
      return { ok: focused, inViewport: rect.top >= 0 && rect.left >= 0 && rect.width > 0, top: Math.round(rect.top) };
    })()
  `);
  report.keyboard.skipLink = r;
  if (!r.ok) report.problems.push("跳过导航：focus() 之后焦点没落在它身上");
  if (r.inViewport === false) report.problems.push("跳过导航：聚焦时它还藏在屏幕外（top=" + r.top + "）");
}

/* ③ 切屏后焦点跟着内容走（只对键盘操作生效） */
async function checkFocusFollows(win) {
  await openAt(win, "console", 1440, 900);
  const r = await win.webContents.executeJavaScript(`
    (async () => {
      /* 模拟「键盘用户按了导航」：先按 Tab（渲染层据此认定是键盘操作），
         再用键盘激活那颗按钮。 */
      const fire = (type, key) => document.dispatchEvent(
        new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      fire("keydown", "Tab");
      const btn = document.querySelector('#navViews [data-view="channels"]');
      if (!btn) return { ok: false, why: "没有渠道那个 nav 按钮" };
      btn.focus();
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const a = document.activeElement;
      return {
        ok: !!(a && a.id && a.id.indexOf("view") === 0),
        activeId: a ? (a.id || a.className || a.tagName) : "(没有焦点)",
        viewOn: (document.querySelector(".view.on") || {}).id || "",
      };
    })()
  `);
  report.keyboard.focusFollows = r;
  if (!r.ok) report.problems.push("切屏后焦点没落进新视图（落在：" + r.activeId + "）");
}

/* ④ Esc 关浮层 */
async function checkEscape(win) {
  await openAt(win, "console", 1440, 900);
  const r = await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      /* 通知横幅：先让它显示（走渲染层自己的 showInfo —— 它挂在 window 上吗？
         不挂，所以直接点那个「×」按钮之外的办法：手动加上 show 类。 */
      const b = document.getElementById("bnrInfo");
      if (b) {
        b.classList.add("show");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
        out.bannerClosed = !b.classList.contains("show");
      }
      /* 升级弹窗 */
      const m = document.getElementById("updModal");
      if (m) {
        m.classList.add("show");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
        out.modalClosed = !m.classList.contains("show");
      }
      return out;
    })()
  `);
  report.keyboard.escape = r;
  if (r.bannerClosed === false) report.problems.push("Esc 关不掉通知横幅");
  if (r.modalClosed === false) report.problems.push("Esc 关不掉升级弹窗");
}

/* ⑤ 焦点环看得见 */
async function checkFocusRing(win) {
  await openAt(win, "console", 1440, 900);
  /* ⚠⚠ **必须先发一次真实的 Tab 输入**：`:focus-visible` 只在「最近一次输入来自
     键盘」时才匹配 —— 脚本的 el.focus() 属于**程序性聚焦**，浏览器不认它是
     键盘操作，于是 :focus-visible 根本不匹配，量到的就是「没有焦点环」。
     那是**检查脚本的毛病**，不是页面的毛病（真按键时是有环的）。
     所以这里用 sendInputEvent 发真键，把浏览器切进「键盘模式」。 */
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await new Promise((r) => setTimeout(r, 150));
  const r = await win.webContents.executeJavaScript(`
    (() => {
      const out = { total: 0, noRing: [] };
      const sel = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const els = [...document.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      out.total = els.length;
      for (const e of els) {
        e.focus();
        const cs = getComputedStyle(e);
        const has = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
        if (!has) {
          out.noRing.push((e.id ? "#" + e.id : e.className || e.tagName).toString().slice(0, 40));
        }
      }
      return out;
    })()
  `);
  report.keyboard.focusRing = r;
  if (r.noRing && r.noRing.length) {
    report.problems.push("这些元素聚焦时没有焦点环：" + r.noRing.join("、"));
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  /* ⚠⚠ **必须清缓存再加载**：Electron 默认缓存静态资源，而本脚本要验的
   *   恰恰是「刚改的 CSS/HTML」—— 拿缓存里的旧文件量，量到的是上一版的
   *   行为（我在这上面误判过一次：以为 :focus 规则没生效，其实是旧 CSS）。
   * ⚠ **窗口要可见并真的获得焦点**：隐藏的窗口**不应用 :focus 伪类**
     *   （`:focus-visible` 同理）—— 那样量到的「没有焦点环」全是假的。
     *   脚本跑完立刻退出，窗口只闪一下。 */
  try { await win.webContents.session.clearCache(); } catch { }
  const errs = [];
  win.webContents.on("console-message", (_e, _lvl, msg) => { if (/error/i.test(String(msg))) errs.push(String(msg)); });
  try {
    await checkOverflow(win);
    await checkSkipLink(win);
    await checkFocusFollows(win);
    await checkEscape(win);
    await checkFocusRing(win);
  } catch (e) {
    report.problems.push("检查脚本自己出错：" + String((e && e.message) || e));
  }
  report.errors = errs;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "p5-a11y-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ problems: report.problems, keyboard: report.keyboard }, null, 2));
  app.exit(report.problems.length ? 1 : 0);
});
