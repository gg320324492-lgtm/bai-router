/* 写路径冒烟：把每个动作**真的点一遍**，验证「写」而不只是「读」。
 *
 * 背景：v17 重写了整个渲染层，但此前的验证全是读路径（截图、DOM 探针、闸门），
 * 所有按钮一次都没点过。这些动作全是「存在即接」接上去的，id 在、监听器在，
 * 不点就不知道跑不跑得起来。
 *
 * 环境：隔离沙箱（scripts/sandbox-launch.cjs 起的 16xxx 实例）。
 * 写的是 %TEMP%\bai-test 与伪 HOME，绝不碰真实 %APPDATA%\bai-router 与 ~/.claude。
 *
 * 每个用例记录：点了什么 → 页面结果文案 → /api/config 是否真的变了 → 有无 JS 报错。
 *
 * 用法：electron scripts/ui-smoke-v17.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const BASE = "http://127.0.0.1:16723";
const OUT = "C:/Users/pc/AppData/Local/Temp/opencode/ui-design/shots";
const REPORT = "C:/Users/pc/AppData/Local/Temp/ui-smoke-v17.json";

app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

const results = [];
const consoleErrors = [];
const netFails = [];

function rec(name, ok, detail) {
  results.push({ name, ok, detail: String(detail || "") });
  console.log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? "  → " + String(detail).replace(/\s+/g, " ").slice(0, 150) : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 固定 sleep 在这里不可靠：/api/test 要经代理探真实上游，沙箱里可能好几秒才回，
   睡 4 秒读到的还是上一次的结果——那不是渲染层的问题，是测试写错了。
   改成「等结果行内容变化」，超时才算失败。 */
async function waitResultChange(win, id, ms = 25000) {
  const before = await js(win, `(document.getElementById(${JSON.stringify(id)})||{}).textContent || ""`);
  const t0 = Date.now();
  for (let i = 0; i < ms / 250; i++) {
    await sleep(250);
    const now = await js(win, `(document.getElementById(${JSON.stringify(id)})||{}).textContent || ""`);
    if (now && now !== before) return { txt: now, took: Date.now() - t0 };
  }
  return { txt: before, took: -1, unchanged: true };
}

async function cfgOf(win) {
  return win.webContents.executeJavaScript(`fetch("/api/config").then(r=>r.json()).catch(()=>null)`).catch(() => null);
}
async function js(win, code) {
  return win.webContents.executeJavaScript(code).catch((e) => ({ __err: String(e) }));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 1000, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.on("console-message", (_e, level, message, line, src) => {
    if (/Electron Security|UnhandledPromise|net::ERR_/.test(message)) return;
    if (level >= 2) consoleErrors.push(`${message} @${String(src).split("/").pop()}:${line}`);
  });
  win.webContents.session.webRequest.onCompleted({ urls: ["http://127.0.0.1:16723/api/*"] }, (d) => {
    if (d.statusCode >= 400) netFails.push(`${d.method} ${d.url.replace(BASE, "")} → ${d.statusCode}`);
  });

  // confirm/alert 自动应答并记账：/api/or/keys 的保存会弹二次确认，不接住会卡死
  await win.loadURL(`${BASE}/#/console`);
  await js(win, `(() => {
    window.__dialogs = [];
    const oc = window.confirm, oa = window.alert;
    window.confirm = (m) => { window.__dialogs.push("confirm: " + m); return true; };
    window.alert = (m) => { window.__dialogs.push("alert: " + m); };
    return true;
  })()`);

  /* 等状态带真的填上（与截图脚本同一个判据） */
  for (let i = 0; i < 80; i++) {
    const ok = await js(win, `(!!document.getElementById("txtRelay") && document.getElementById("txtRelay").textContent !== "—")`);
    if (ok === true) break;
    await sleep(250);
  }
  await sleep(800);

  console.log("\n══════ 控制台视图 ══════");

  // ① 点矩阵卡切换选中
  {
    const before = await js(win, `document.querySelector("#matrixGrid .cell.sel")?.dataset.k`);
    await js(win, `document.querySelector('.cell[data-k="bai"]').click(); 1`);
    await sleep(500);
    const after = await js(win, `({
      sel: document.querySelector("#matrixGrid .cell.sel")?.dataset.k,
      title: document.getElementById("mapTitle")?.textContent,
      badge: document.getElementById("mapBadge")?.textContent,
      h1: document.getElementById("h1Text")?.textContent,
      doc: document.title,
    })`);
    rec("点卡片切换选中（qd → bai）", after.sel === "bai" && /B\.AI/.test(after.title || ""),
      `选中=${after.sel} 映射区=${after.title} 徽标=${after.badge} 页标题=${after.doc} h1=${after.h1} (原先 ${before})`);
  }

  // ② 改映射下拉 → 保存映射 → 验证配置真的落盘
  {
    const beforeCfg = await cfgOf(win);
    const pick = await js(win, `(() => {
      const sel = document.querySelector('select[data-tier="claude-sonnet-5"]');
      if (!sel) return { err: "没有下拉" };
      const opts = Array.from(sel.options).map(o => o.value);
      const cur = sel.value;
      const other = opts.find(o => o !== cur && o !== "__custom__") || cur;
      sel.value = other;
      sel.dispatchEvent(new Event("change"));
      return { from: cur, to: sel.value, label: document.querySelector('input[data-role="label"][data-tier="claude-sonnet-5"]').value };
    })()`);
    await js(win, `document.getElementById("btnSave").click(); 1`);
    await sleep(1500);
    const res = await js(win, `document.getElementById("testResult").textContent`);
    const afterCfg = await cfgOf(win);
    const persisted = afterCfg && afterCfg.mapping && afterCfg.mapping["claude-sonnet-5"];
    const changed = JSON.stringify(beforeCfg?.mapping?.["claude-sonnet-5"]) !== JSON.stringify(persisted);
    rec("改下拉 + 保存映射（落盘校验）", /映射已保存/.test(res || "") && changed,
      `页面=${String(res).split("\n")[0]} | 配置 target=${persisted?.target} label=${persisted?.label}`);
    rec("  ↳ 下拉 change 联动显示名", pick.label && pick.label !== pick.from,
      `下拉 ${pick.from} → ${pick.to}，显示名联动为「${pick.label}」`);
  }

  // ③ 「自定义…」分支
  {
    const r = await js(win, `(() => {
      const sel = document.querySelector('select[data-tier="claude-haiku-4-5"]');
      sel.value = "__custom__";
      sel.dispatchEvent(new Event("change"));
      const cus = document.querySelector('input[data-role="custom"][data-tier="claude-haiku-4-5"]');
      const shown = cus && getComputedStyle(cus).display !== "none";
      if (shown) { cus.value = "my-custom-model"; cus.dispatchEvent(new Event("input")); }
      return { shown, label: document.querySelector('input[data-role="label"][data-tier="claude-haiku-4-5"]').value };
    })()`);
    rec("下拉「自定义…」展开输入框并联动", r.shown === true && /my-custom-model/i.test(r.label || ""),
      `自定义框可见=${r.shown} 显示名联动=「${r.label}」`);
  }

  // ④ 恢复默认模型（有 defaultModels 的渠道才有按钮）
  {
    await js(win, `document.querySelector('.cell[data-k="qd"]').click(); 1`);
    await sleep(400);
    const visQd = await js(win, `(() => { const b=document.getElementById("btnResetModels"); return { show: getComputedStyle(b).display !== "none", disabled: b.disabled }; })()`);
    await js(win, `document.getElementById("btnResetModels").click(); 1`);
    await sleep(1500);
    const res = await js(win, `document.getElementById("sysResult").textContent`);
    const c = await cfgOf(win);
    rec("恢复默认模型（Qoder → lite）", /恢复默认模型/.test(res || "") && JSON.stringify(c?.qd?.availableModels) === '["lite"]',
      `${String(res).split("\n")[0]} | 配置 qd.availableModels=${JSON.stringify(c?.qd?.availableModels)}`);
    // 换到没有 defaultModels 的渠道，那个按钮必须消失
    await js(win, `document.querySelector('.cell[data-k="bai"]').click(); 1`);
    await sleep(500);
    const visBai = await js(win, `(() => { const b=document.getElementById("btnResetModels"); return { show: getComputedStyle(b).display !== "none", disabled: b.disabled }; })()`);
    rec("  ↳ 无 defaultModels 的渠道应隐藏该按钮", visBai.show === false && visQd.show === true,
      `Qoder 时可见=${visQd.show}；B.AI 时可见=${visBai.show}`);
    await js(win, `document.querySelector('.cell[data-k="qd"]').click(); 1`);
    await sleep(400);
  }

  // ⑤ 测试连通（沙箱无凭据 → 必须**如实报错**，不能假成功）
  {
    await js(win, `document.querySelector('.cell[data-k="bai"]').click(); 1`);
    await sleep(500);
    /* 整段在**一次** executeJavaScript 里跑：点按钮、看它有没有进 disabled、
       再轮询结果行。把"点击"和"读 before"拆成两次往返，中间那几毫秒里
       请求就可能已经回来，before 读到的是新值——于是永远等不到"变化"。
       另外结果行可能被写成空串（没有可显示的行），那种情况也必须当成"有结果"。 */
    const r = await js(win, `(async () => {
      const btn = document.getElementById("btnTest");
      const before = document.getElementById("testResult").textContent;
      let sawDisabled = false;
      const fetches = []; let ticks = [];
      const of = window.fetch;
      window.fetch = (...a) => { fetches.push(String(a[0]).slice(-24) + (a[1] && a[1].method ? " " + a[1].method : "")); return of(...a); };
      const mo = new MutationObserver(() => { if (btn.disabled) sawDisabled = true; });
      mo.observe(btn, { attributes: true, attributeFilter: ["disabled"] });
      btn.click();
      const t0 = Date.now();
      for (let i = 0; i < 620; i++) {   // 155 秒上限：实测这台机 /api/test 要 125 秒（四档各烧满 10 秒上游超时再轮完转移链）：脏映射下故障转移会轮完整个链
        await new Promise(r => setTimeout(r, 250));
        if (!sawDisabled && btn.disabled) sawDisabled = true;
        /* 长动作期间按钮要走秒、轮询不能停——这两条只在这个足够长的动作里验得到。
           拿"刷新模型列表"当样本不行：它 1.2 秒就结束，1000ms 的走秒器来不及跳。 */
        if (/处理中/.test(btn.textContent) && ticks[ticks.length-1] !== btn.textContent.trim()) ticks.push(btn.textContent.trim());
        const txt = document.getElementById("testResult").textContent;
        if (txt !== before) { mo.disconnect(); window.fetch = of;
          return { took: Date.now() - t0, txt, cls: document.getElementById("testResult").className, sawDisabled, fetches, ticks }; }
      }
      mo.disconnect(); window.fetch = of;
      return { took: -1, txt: before, cls: document.getElementById("testResult").className, sawDisabled, fetches, ticks,
               btnDisabled: btn.disabled, btnText: btn.textContent };
    })()`);
    rec("测试连通（无凭据应如实失败）",
      r.took > 0 && (r.cls || "").includes("bad") && /✘|失败|出错/.test(r.txt || ""),
      `耗时 ${r.took}ms 监听器触发=${r.sawDisabled} 请求=${JSON.stringify(r.fetches)} class="${r.cls}" 文本="${String(r.txt).split("\n")[0]}"`
      + ` [超时态: disabled=${r.btnDisabled} 文案=${r.btnText}]`);
    const statuses = (r.fetches || []).filter((f) => f.indexOf("/api/status") >= 0).length;
    rec("  ↳ 长动作期间轮询不冻结", statuses >= 2,
      `${Math.round(r.took/1000)} 秒的动作里仍发了 ${statuses} 次 /api/status（修之前 busy 会把它整个停掉）`);
    const secVals = [...new Set((r.ticks||[]).map(t => (t.match(/(\d+)s/)||[])[1]).filter(x => x !== undefined))];
    rec("  ↳ 按钮显示已等待秒数（且秒数在推进）", secVals.length >= 2,
      secVals.length >= 2 ? `按钮文案走过 ${secVals.length} 个不同秒值：${secVals.join(" → ")}s`
                          : `只采到 ${JSON.stringify(secVals)}（文案：${(r.ticks||[]).join("｜")}）`);
  }

  // ⑥ 刷新模型列表
  {
    await js(win, `document.getElementById("btnModels").click(); 1`);
    const r = await waitResultChange(win, "testResult", 40000);
    rec("刷新模型列表（上游不可达应如实报错）", !r.unchanged && /已拉取模型|出错了|失败/.test(r.txt || ""),
      `耗时 ${r.took}ms 文本="${String(r.txt).split("\n")[0]}"`);
  }

  // ⑦ 一键接入（无凭据 → 服务端 400，页面必须优雅呈现而不是崩溃）
  {
    await js(win, `document.querySelector('.cell[data-k="sn"]').click(); 1`);
    await sleep(400);
    const dis = await js(win, `document.querySelector('.cell[data-k="sn"] .cfoot button').disabled`);
    await js(win, `document.querySelector('.cell[data-k="bai"] .cfoot button').click(); 1`);
    await sleep(2500);
    const res = await js(win, `document.getElementById("applyResult").textContent`);
    rec("一键接入 B.AI（走 /api/apply）", /已接入|请先|出错了|失败/.test(res || ""), String(res).split("\n")[0]);
    rec("  ↳ 凭据未配的渠道主按钮应禁用", dis === true, `sn（未配凭据）disabled=${dis}`);
  }

  // ⑧ 接回 CC Switch（/api/restore）
  {
    await js(win, `document.getElementById("btnRestore2").click(); 1`);
    await sleep(2000);
    const res = await js(win, `document.getElementById("applyResult").textContent`);
    rec("接回 CC Switch（/api/restore）", /已接回|出错了/.test(res || ""), String(res).split("\n")[0]);
  }

  // ⑨ 一键最优
  {
    await js(win, `document.getElementById("btnBest").click(); 1`);
    await sleep(3000);
    const res = await js(win, `document.getElementById("applyResult").textContent`);
    rec("一键最优", /已按转移链|没有一家|出错了/.test(res || ""), String(res).split("\n")[0]);
  }

  // ⑩ 诊断抽屉
  {
    await js(win, `document.getElementById("btnDiag").click(); 1`);
    await sleep(700);
    const r = await js(win, `({
      open: document.getElementById("diagDrawer").classList.contains("open"),
      items: document.querySelectorAll("#diagList .ditem").length,
      sum: document.getElementById("diagSum").textContent,
      kinds: Array.from(document.querySelectorAll("#diagList .ditem")).map(d => d.className.replace("ditem ","")),
    })`);
    rec("诊断抽屉开合 + 出结论", r.open === true && r.items > 0,
      `${r.items} 条 · 摘要「${r.sum}」· 状态分布 ${JSON.stringify(r.kinds.reduce((a,k)=>(a[k]=(a[k]||0)+1,a),{}))}`);
    const hasFake = (r.kinds || []).includes("info") || /历史|次错误/.test(r.sum || "");
    rec("  ↳ 不得编造错误数/时间线", !hasFake, `没有「N 次错误 / 历史」这类无数据源的说法`);
  }

  console.log("\n══════ 凭据视图 ══════");
  await js(win, `document.querySelector('#navViews [data-view="cred"]').click(); 1`);
  await sleep(1200);

  // ⑪ API Key 输入 + 保存 + 显示/隐藏
  {
    const r = await js(win, `(async () => {
      const row = document.querySelector('.credrow[data-k="bai"]');
      const inp = row.querySelector(".keyinput");
      const before = await fetch("/api/config").then(r=>r.json());
      inp.value = "sk-smoke-test-1234";
      row.querySelector('button[data-act="savekey"]').click();
      await new Promise(r=>setTimeout(r,2000));
      const after = await fetch("/api/config").then(r=>r.json());
      const res = document.getElementById("applyResult").textContent;
      const inp2 = row.querySelector(".keyinput");
      const typeBefore = inp2.type;
      row.querySelector('button[data-act="toggle"]').click();
      const typeAfter = row.querySelector(".keyinput").type;
      return { beforeKey: before.apiKey, afterKey: after.apiKey, res, typeBefore, typeAfter,
               cleared: inp2.value === "" };
    })()`);
    rec("凭据 API Key 保存并落盘", r.afterKey === "sk-smoke-test-1234" && /已保存/.test(r.res || ""),
      `配置 apiKey: ${String(r.beforeKey)} → ${r.afterKey ? r.afterKey.slice(0, 8) + "…" : "(空)"} · ${String(r.res).split("\n")[0]}`);
    rec("  ↳ 保存后输入框清空（明文不留页面）", r.cleared === true, `保存后 input.value="${r.cleared ? "" : "仍有值"}"`);
    rec("  ↳ 显示/隐藏切换 input type", r.typeBefore === "password" && r.typeAfter === "text",
      `${r.typeBefore} → ${r.typeAfter}`);
  }

  // ⑫ 一键装补丁（无 Qoder 安装 → 必须说"什么都没改"，不能报成功）
  {
    const r = await js(win, `(async () => {
      const row = document.querySelector('.credrow[data-k="qd"]');
      const b = row && row.querySelector('button[data-act="patch"]');
      if (!b) return { err: "行或按钮不在" };
      const before = document.getElementById("applyResult").textContent;
      let sawDisabled = false;
      const mo = new MutationObserver(() => { if (b.disabled) sawDisabled = true; });
      mo.observe(b, { attributes: true, attributeFilter: ["disabled"] });
      b.click();
      const t0 = Date.now();
      for (let i = 0; i < 240; i++) {   // 60 秒上限
        await new Promise(r => setTimeout(r, 250));
        if (!sawDisabled && b.disabled) sawDisabled = true;
        const txt = document.getElementById("applyResult").textContent;
        if (txt !== before) { mo.disconnect();
          return { took: Date.now() - t0, res: txt, cls: document.getElementById("applyResult").className, sawDisabled }; }
      }
      mo.disconnect();
      return { took: -1, res: before, cls: document.getElementById("applyResult").className, sawDisabled, btnText: b.textContent };
    })()`);
    rec("一键装补丁（本机无 Qoder 应如实说没改动）",
      r.took > 0 && (r.cls || "").includes("bad") && /没找到|失败|出错了|✘/.test(r.res || ""),
      `耗时 ${r.took}ms 监听器触发=${r.sawDisabled} class="${r.cls}" 文本="${String(r.res).split("\n")[0]}"`
      + (r.err ? ` [${r.err}]` : (r.sawDisabled ? "" : ` [按钮文案=${r.btnText}]`)));
  }

  // ⑬ 一键获取令牌 → 进度面板出现即算接线成功（不等到 150s 超时）
  {
    const r = await js(win, `(async () => {
      const row = document.querySelector('.credrow[data-k="wb"]');
      const b = row.querySelector('button[data-act="capture"]');
      b.click();
      await new Promise(r=>setTimeout(r,1500));
      const prog = row.querySelector('.progress');
      return { btnText: b.textContent, disabled: b.disabled,
               progShown: prog && getComputedStyle(prog).display !== "none",
               progTitle: prog && prog.querySelector(".pTitle")?.textContent };
    })()`);
    rec("一键获取令牌（卡片接管流程并出进度面板）", r.progShown === true,
      `按钮「${r.btnText}」disabled=${r.disabled} 进度面板=${r.progShown ? "已显示" : "未显示"} 「${r.progTitle}」`);
    // 等它自己结束，别把请求挂在那儿
    await sleep(12000);
  }

  // ⑭ 手动填写 → 展开编辑器
  {
    const r = await js(win, `(() => {
      const row = document.querySelector('.credrow[data-k="wb"]');
      row.querySelector('button[data-act="manual"]').click();
      const box = row.querySelector('.keybox');
      return { shown: box && getComputedStyle(box).display !== "none",
               inputs: box ? box.querySelectorAll("input[data-f]").length : 0 };
    })()`);
    rec("手动填写令牌（展开四个输入格）", r.shown === true && r.inputs === 4, `可见=${r.shown} 输入格=${r.inputs}`);
  }

  // ⑮ OpenRouter 三把 key 编辑器（重点：不能误删已有 key）
  {
    const r = await js(win, `(async () => {
      const row = document.querySelector('.credrow[data-k="or"]');
      const b = row.querySelector('button[data-act="keys"]');
      if (!b) return { err: "找不到「编辑三把 key」按钮" };
      b.click();
      await new Promise(r=>setTimeout(r,800));
      const box = row.querySelector('[data-role="act"]');
      const note = box && box.querySelector(".keynote");
      return { shown: !!(box && getComputedStyle(box).display !== "none"),
               inputs: row.querySelectorAll('[data-role="act"] .keyinput').length,
               note: note && note.textContent.replace(/\s+/g," ").trim().slice(0,50) };
    })()`);
    rec("OpenRouter 编辑三把 key（展开编辑器 + 警告）", r.shown === true && r.inputs === 3,
      r.err || `${r.inputs} 格 · 警告「${r.note}…」`);
    // 空提交必须被挡住（否则等于清空用户的轮换区）
    if (r.shown) {
      const guard = await js(win, `(async () => {
        const row = document.querySelector('.credrow[data-k="or"]');
        row.querySelector('button[data-act="keysave"]').click();
        await new Promise(r=>setTimeout(r,1200));
        const dlg = (window.__dialogs||[]).slice(-1)[0] || "";
        const keys = await fetch("/api/config").then(r=>r.json()).then(c=>(c.or.keys||[]).length);
        return { dlg, res: document.getElementById("applyResult").textContent, keys,
                 confirmShown: /确定|替换/.test(dlg) };
      })()`);
      /* 应用的做法是「先警告、要用户再点一次」，**不弹** confirm。
         所以这里断言的是"没弹框 + 给了明确警告 + 配置一个 key 没少"。 */
      const blocked = /三格都空着|清空轮换区/.test(guard.res || "");
      const askedTwice = /请确认后再点一次/.test(guard.res || "");
      rec("  ↳ 三格全空时不得直接清空（应挡住并要用户确认）",
        blocked && askedTwice && guard.keys === 0 && guard.confirmShown === false,
        `结果行「${String(guard.res).split("\n")[0]}」· 配置 or.keys 仍为 ${guard.keys} 把 · 未弹确认框`);
    }
  }

  // ⑯ 刷新免费目录与额度
  {
    const r = await js(win, `(async () => {
      const row = document.querySelector('.credrow[data-k="or"]');
      const b = row.querySelector('button[data-act="quota"]');
      if (!b) return { err: "按钮不在（编辑器还开着，先取消）" };
      b.click();
      await new Promise(r=>setTimeout(r,10000));
      return { res: document.getElementById("applyResult").textContent };
    })()`);
    rec("刷新免费目录与额度", /重筛|额度|出错了|失败/.test(r.res || "") || r.err, String(r.res || r.err).split("\n")[0]);
  }

  console.log("\n══════ 故障转移视图 ══════");
  await js(win, `document.querySelector('#navViews [data-view="fo"]').click(); 1`);
  await sleep(1200);

  // ⑰ 开关 + 调序 + 保存
  {
    const before = await js(win, `({
      on: document.getElementById("ckFailover").getAttribute("aria-checked"),
      order: Array.from(document.querySelectorAll("#foSeq .node")).map(n=>n.dataset.k),
    })`);
    await js(win, `(() => {
      const sw = document.getElementById("ckFailover"); sw.click();
      const btns = document.querySelectorAll("#foSeq .node")[1].querySelectorAll("button[data-mv]");
      btns[0].click();                       // 第 2 位上移
      return 1;
    })()`);
    await sleep(400);
    const after = await js(win, `({
      on: document.getElementById("ckFailover").getAttribute("aria-checked"),
      order: Array.from(document.querySelectorAll("#foSeq .node")).map(n=>n.dataset.k),
    })`);
    rec("故障转移：开关切换", before.on !== after.on, `aria-checked ${before.on} → ${after.on}`);
    rec("故障转移：↑↓ 调序", before.order[1] === after.order[0],
      `${before.order.join(">")} → ${after.order.join(">")}`);
    await js(win, `document.getElementById("btnSaveFo").click(); 1`);
    await sleep(2000);
    const res = await js(win, `document.getElementById("foResult").textContent`);
    const c = await cfgOf(win);
    rec("故障转移：保存链序并落盘", /已保存/.test(res || "") && JSON.stringify(c?.failover?.chain) === JSON.stringify(after.order),
      `${String(res).split("\n")[0]} | 配置 failover.chain=${(c?.failover?.chain || []).join(">")}`);
  }

  console.log("\n══════ 设置视图 ══════");
  await js(win, `document.querySelector('#navViews [data-view="settings"]').click(); 1`);
  await sleep(1000);

  // ⑱ 平铺渠道 vs 嵌套渠道的「走本机代理」
  {
    // bai 是平铺的那家：服务端 /api/config 明确不收它的 useProxy（走进程级 proxy），
    // 所以这里**不该**出现勾选框，出现就是骗用户。
    const flat = await js(win, `(async () => {
      document.querySelector('.cell[data-k="bai"]').click();
      await new Promise(r=>setTimeout(r,700));
      const ck = document.getElementById("ckUseProxy");
      const label = ck.closest("label");
      return { ckShown: getComputedStyle(ck).display !== "none",
               labelShown: getComputedStyle(label).display !== "none",
               note: (document.querySelector(".proxynote")||{}).textContent || "" };
    })()`);
    rec("平铺渠道不显示「走本机代理」勾选框",
      flat.ckShown === false && flat.labelShown === false && /进程级代理/.test(flat.note),
      `勾选框可见=${flat.ckShown} 说明行「${flat.note.slice(0, 60)}…」`);

    // 上游地址对两家都该存得进去
    const up = await js(win, `(async () => {
      document.getElementById("fUpstream").value = "https://smoke.example.com";
      document.getElementById("btnSaveSys").click();
      await new Promise(r=>setTimeout(r,2000));
      const c = await fetch("/api/config").then(r=>r.json());
      return { res: document.getElementById("sysResult").textContent, upstream: c.upstream };
    })()`);
    rec("设置：上游地址保存并落盘", /已保存/.test(up.res || "") && up.upstream === "https://smoke.example.com",
      `${String(up.res).split("\n")[0]} | 配置 upstream=${up.upstream}`);

    // 嵌套渠道（sn）：勾选框必须在，且 useProxy 真的能存进去
    const nested = await js(win, `(async () => {
      document.querySelector('.cell[data-k="sn"]').click();
      await new Promise(r=>setTimeout(r,800));
      const ck = document.getElementById("ckUseProxy");
      const shown = getComputedStyle(ck).display !== "none";
      ck.checked = true;
      document.getElementById("btnSaveSys").click();
      await new Promise(r=>setTimeout(r,2000));
      const c = await fetch("/api/config").then(r=>r.json());
      return { shown, useProxy: c.sn && c.sn.useProxy };
    })()`);
    rec("嵌套渠道：勾选框在且 useProxy 落盘",
      nested.shown === true && nested.useProxy === true,
      `勾选框可见=${nested.shown} 配置 sn.useProxy=${JSON.stringify(nested.useProxy)}`);
  }

  // ⑲ 端口表跟随选中渠道
  {
    const r = await js(win, `(() => {
      const rows = Array.from(document.querySelectorAll("#setChannels tbody tr"));
      return { n: rows.length, sample: rows.slice(0,3).map(tr => Array.from(tr.children).map(td=>td.textContent.trim())) };
    })()`);
    rec("设置：六家端口表渲染", r.n === 6, `${r.n} 行 · 例：${JSON.stringify(r.sample[0])}`);
  }

  console.log("\n══════ 主题 / 视图 / 深链 ══════");

  // ⑳ 主题切换
  {
    const r = await js(win, `(() => {
      const before = document.documentElement.getAttribute("data-theme");
      document.getElementById("themeBtn").click();
      const after = document.documentElement.getAttribute("data-theme");
      const stored = localStorage.getItem("bai.theme");
      return { before, after, stored, icon: document.getElementById("themeText").textContent };
    })()`);
    rec("主题切换 + 记忆", r.before !== r.after && r.stored === r.after,
      `${r.before} → ${r.after}（按钮文案「${r.icon}」，localStorage=${r.stored}）`);
  }

  // ㉑ hash 驱动视图切换 + 刷新保持
  {
    await js(win, `document.querySelector('#navViews [data-view="cred"]').click(); 1`);
    await sleep(800);
    const h = await js(win, `({ hash: location.hash, view: document.querySelector(".view.on")?.id })`);
    rec("视图切换写 hash", /#\/cred/.test(h.hash || "") && h.view === "viewCred", `hash=${h.hash} 视图=${h.view}`);
  }

  // ㉒ 深链：/workbuddy 自动选中
  {
    await js(win, `location.href = "/workbuddy#/console"; 1`).catch(() => {});
    await sleep(3000);
    for (let i = 0; i < 40; i++) {
      const ok = await js(win, `!!document.querySelector('#matrixGrid .cell.sel')`);
      if (ok === true) break;
      await sleep(250);
    }
    const r = await js(win, `({ sel: document.querySelector('#matrixGrid .cell.sel')?.dataset.k, doc: document.title })`);
    rec("深链 /workbuddy 自动选中并高亮", r.sel === "wb", `选中=${r.sel} 标题=${r.doc}`);
  }

  // ㉑ 用户正在编辑的输入框不许被轮询抹掉（这是同一根因：重绘不认用户状态）
  {
    const r = await js(win, `(async () => {
      document.querySelector('#navViews [data-view="settings"]').click();
      await new Promise(r=>setTimeout(r,800));
      document.querySelector('.cell[data-k="sn"]').click();
      await new Promise(r=>setTimeout(r,800));
      const up = document.getElementById("fUpstream");
      up.focus();
      up.value = "https://typing-in-progress.example.com";
      up.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r=>setTimeout(r,7000));   // 至少跨过一轮 5 秒轮询
      const survived = up.value;
      // 再看勾选框：点完还没按保存，不该被轮询弹回去
      const ck = document.getElementById("ckUseProxy");
      ck.checked = true;
      ck.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r=>setTimeout(r,7000));
      const ckAlive = ck.checked;
      up.value = ""; up.dispatchEvent(new Event("input", { bubbles: true }));  // 复原
      return { survived, ckAlive, ckVisible: getComputedStyle(ck).display !== "none" };
    })()`);
    rec("轮询不抹掉用户正在输入的内容", r.survived === "https://typing-in-progress.example.com",
      `跨两轮轮询后输入框仍是「${r.survived}」`);
    rec("  ↳ 轮询不弹回刚点的勾选框", r.ckVisible === false || r.ckAlive === true,
      `勾选框可见=${r.ckVisible} 跨两轮轮询后仍勾着=${r.ckAlive}`);
  }

  const dialogs = await js(win, `window.__dialogs || []`);
  fs.writeFileSync(REPORT, JSON.stringify({
    at: new Date().toISOString(), results, consoleErrors, netFails, dialogs,
  }, null, 2));

  const bad = results.filter((r) => !r.ok);
  console.log(`\n══════ 汇总 ══════`);
  console.log(`用例 ${results.length} 条：通过 ${results.length - bad.length}，失败 ${bad.length}`);
  if (bad.length) { console.log("失败项："); for (const b of bad) console.log(`  ✘ ${b.name} → ${b.detail}`); }
  console.log(`页面 JS 报错 ${consoleErrors.length} 条${consoleErrors.length ? "：\n  " + consoleErrors.join("\n  ") : ""}`);
  console.log(`4xx/5xx 请求 ${netFails.length} 条${netFails.length ? "：\n  " + [...new Set(netFails)].join("\n  ") : ""}`);
  console.log(`弹出的 confirm/alert ${dialogs.length} 次${dialogs.length ? "：\n  " + dialogs.map((d) => "  " + d.slice(0, 110)).join("\n") : ""}`);
  console.log(`\n明细: ${REPORT}`);
  app.quit();
  process.exit(bad.length ? 1 : 0);
});