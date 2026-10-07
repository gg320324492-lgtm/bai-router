/* cards/token-capture.js —— WorkBuddy 页的令牌相关卡片与逻辑。
 *
 * 搬自 wb.html：
 *   1) 「手动填写令牌」卡（cardTok）——令牌四件套 + 体检条 + 折叠交互
 *   2) 「一键获取令牌」的等待进度面板 + 点击逻辑（按钮本身在两步引导里，由 panel-common 渲染）
 * 文案、配色、占位符、提示语全部逐字保留。
 *
 * ctx = { cfg, status, $, api, showInfo, showResult, setLed, withBusy, PROVIDER, slot }
 * 下面用到契约里没列的几个钩子（都做了存在性判断，缺了也不报错）：
 *   ctx.refreshConfig() —— 存完令牌后重读配置（原 wb.html 里的同名函数）
 *   ctx.poll()          —— 状态轮询
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["token-capture"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const api = ctx.api;
    const slot = ctx.slot || $("slot-extra") || (() => {
      const d = document.createElement("div");
      (document.querySelector(".wrap") || document.body).appendChild(d);
      return d;
    })();
    const wbSlice = (cfg) => (cfg && cfg.wb) || {};
    const poll = () => { if (typeof ctx.poll === "function") ctx.poll(); };
    const refreshConfig = async () => { if (typeof ctx.refreshConfig === "function") await ctx.refreshConfig(); };

    /* ---------- 卡片 markup（逐字） ---------- */
    slot.insertAdjacentHTML("beforeend", `
      <!-- 令牌（高级：手动填写，平时用不到） -->
      <div class="card foldable collapsed" id="cardTok">
        <div class="head" id="headTok">
          <span class="eyebrow">高级</span><span class="title">手动填写令牌</span>
          <span class="aux">平时用不到 · 一键获取失败时的备用方式</span>
        </div>
        <div class="body">
          <div class="tokstat" id="tokStat">正在读取令牌状态…</div>

          <div class="keyrow">
            <span class="k">访问令牌</span>
            <input type="password" id="accessToken" autocomplete="off" placeholder="eyJ…（JWT，三段）" style="flex:1;min-width:260px">
            <button class="btn-sm" id="tokToggle" type="button">显示</button>
          </div>
          <div class="keyrow">
            <span class="k">刷新令牌</span>
            <input type="password" id="refreshToken" autocomplete="off" placeholder="eyJ…（用于到期自动续期）" style="flex:1;min-width:260px">
          </div>
          <div class="keyrow">
            <span class="k">设备令牌</span>
            <input type="password" id="deviceToken" autocomplete="off" placeholder="v3:AAAA…（X-Device-Token，可留空）" style="flex:1;min-width:260px">
          </div>
          <div class="keyrow">
            <span class="k">用户 ID</span>
            <input type="text" id="userId" autocomplete="off" placeholder="91a1b55c-…（X-User-Id，可留空）" style="flex:1;min-width:260px">
          </div>

          <div class="hint" style="margin-top:12px">
            仅在「一键获取令牌」失败时使用。手动拿令牌：浏览器里登录 <b>workbuddy.ai</b>，按 F12 打开开发者工具 → Network，
            随便发一条对话，点开 <b>/v2/chat/completions</b> 请求，把请求头里的 Authorization（去掉开头的 "Bearer "）、
            X-Refresh-Token、X-Device-Token、X-User-Id 依次粘到上面四个框，点保存。令牌有效期约一年，到期会自动续期。
          </div>

          <div class="saverow">
            <button class="btn-main" id="btnSaveTok" style="padding:8px 20px">保存令牌</button>
          </div>
          <div class="result" id="tokResult"></div>
        </div>
      </div>`);

    /* ---------- 令牌体检条（逐字） ---------- */
    function renderTokens() {
      const wb = wbSlice(ctx.cfg);
      $("accessToken").value = wb.accessToken || "";
      $("refreshToken").value = wb.refreshToken || "";
      $("deviceToken").value = wb.deviceToken || "";
      $("userId").value = wb.userId || "";
      // 令牌体检条（与状态灯互补，这里给精确日期）
      const stat = $("tokStat");
      const exp = (() => {
        try {
          const seg = String(wb.accessToken || "").split(".")[1];
          if (!seg) return null;
          const p = JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/")));
          return typeof p.exp === "number" ? p.exp : null;
        } catch { return null; }
      })();
      // 版别与实际上游（v1.0.59）：面板一眼看出「现在配的是哪版的通道」。
      // 版别来自 /api/status 的 wb.edition（按登录域名判定），上游取自愈后的配置值。
      const stWb = (ctx.status && ctx.status.wb) || {};
      const esc = typeof ctx.esc === "function" ? ctx.esc : (s) => String(s == null ? "" : s);
      const edTxt = stWb.edition === "cn" ? "<b>国内版 WorkBuddy</b>（.cn）"
        : stWb.edition === "intl" ? "<b>国际版 WorkBuddy AI</b>（.ai）"
        : "<b>未检测到</b>（读不到登录文件）";
      const head =
        `<span>登录版别：${edTxt}</span>` +
        `<span>登录域名：<b>${esc(stWb.authDomain || "—")}</b></span>` +
        `<span>实际上游：<b>${esc(wb.upstream || "")}</b></span>`;
      if (!wb.accessToken) stat.innerHTML = head + `<span>访问令牌：<b class="warn">未配置</b></span>`;
      else {
        const days = exp ? Math.max(0, Math.round((exp * 1000 - Date.now()) / 86400000)) : null;
        stat.innerHTML = head +
          `<span>访问令牌：<b>已配置</b></span>` +
          (exp ? `<span>有效期至 <b>${new Date(exp * 1000).toLocaleDateString("zh-CN")}</b>（剩 ${days} 天）</span>` : `<span>有效期：<b>无法解析</b></span>`) +
          `<span>刷新令牌：<b>${wb.refreshToken ? "有（自动续期）" : "无"}</b></span>` +
          `<span>设备令牌：<b>${wb.deviceToken ? "有" : "无"}</b></span>` +
          `<span>用户 ID：<b>${wb.userId ? "有" : "无"}</b></span>`;
      }
    }

    /* ---------- 「一键获取令牌」的等待面板 ---------- */
    // v1.0.58：文案更如实——实测普通业务请求只带 Authorization（够写令牌了），
    // X-Refresh-Token 只在续期时出现；不再让用户误以为「发消息」是唯一/关键动作。
    let capTimer = null, capPoll = null, capTick = 0;
    const CAP_TIPS = [
      "正在等待 WorkBuddy 触发…",
      "如果 10 秒内没反应，请在 WorkBuddy 客户端里打开一个对话，或随便发一条消息",
      "钩子已就位，WorkBuddy 一发起带鉴权的请求就会自动抓到访问令牌",
      "仍在等待中…（最长 2 分 30 秒，可随时关闭页面重试）",
    ];
    function ensureProgress() {
      if (document.getElementById("captureProgress")) return;
      const el = document.createElement("div");
      el.className = "progress";
      el.id = "captureProgress";
      el.style.display = "none";
      el.innerHTML = `
        <div class="spin"></div>
        <div>
          <div class="pTitle" id="pTitle">正在等待 WorkBuddy 触发…</div>
          <div class="pDesc" id="pDesc"></div>
        </div>`;
      // 尽量放回两步引导卡的末尾（源页位置）；找不到就退回插槽
      const guideBody = $("applyResult") && $("applyResult").closest(".body");
      (guideBody || slot).appendChild(el);
    }
    function showCaptureProgress(on) {
      ensureProgress();
      const box = $("captureProgress");
      box.style.display = on ? "flex" : "none";
      clearInterval(capTimer);
      clearInterval(capPoll);
      if (!on) return;
      capTick = 0;
      $("pTitle").textContent = CAP_TIPS[0];
      $("pDesc").textContent = "完成后会自动还原对 WorkBuddy 的临时改动，不影响它正常使用。";
      capTimer = setInterval(() => {
        capTick = Math.min(capTick + 1, CAP_TIPS.length - 1);
        $("pTitle").textContent = CAP_TIPS[capTick];
      }, 12000);
      // 轮询后端进度：如实反馈当前卡在哪一步（钩子注入没、踢侧车结果、抓到令牌没）
      capPoll = setInterval(async () => {
        try {
          const s = await api("/api/wb/capture/status");
          if (s && s.gotAccessToken) {
            $("pTitle").textContent = "已捕获到访问令牌，正在写入配置…";
            $("pDesc").textContent = "刷新令牌只在令牌到期续期时才会出现；没有它也能正常使用，到期后重新获取即可。";
          } else if (s && s.active && s.phaseText) {
            // 后端给的阶段文案（含踢侧车结果）优先于通用提示；附上已等待秒数
            const secs = Math.round((s.elapsedMs || 0) / 1000);
            $("pDesc").textContent = s.phaseText + `（已等待 ${secs} 秒，最长 150 秒）`;
          }
        } catch { /* 轮询失败不影响主流程 */ }
      }, 2000);
    }

    /* ---------- 手动令牌卡折叠（逐字；源页不记忆选择） ---------- */
    (() => {
      const card = $("cardTok"), head = $("headTok");
      if (!card || !head) return;
      head.setAttribute("tabindex", "0");
      head.setAttribute("role", "button");
      const sync = () => head.setAttribute("aria-expanded", String(!card.classList.contains("collapsed")));
      sync();
      const toggle = () => { card.classList.toggle("collapsed"); sync(); };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    })();

    /* ---------- 事件（逐字） ---------- */
    $("tokToggle").addEventListener("click", () => {
      const showAll = ["accessToken", "refreshToken", "deviceToken"].map((id) => $(id));
      const showing = showAll[0].type === "text";
      showAll.forEach((el) => { el.type = showing ? "password" : "text"; });
      $("tokToggle").textContent = showing ? "显示" : "隐藏";
    });

    $("btnSaveTok").addEventListener("click", () => ctx.withBusy($("btnSaveTok"), async () => {
      const r = await api("/api/config", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: ctx.PROVIDER,
          accessToken: $("accessToken").value.trim(),
          refreshToken: $("refreshToken").value.trim(),
          deviceToken: $("deviceToken").value.trim(),
          userId: $("userId").value.trim(),
        }),
      });
      ctx.showResult($("tokResult"), "✔ 令牌已保存\n" + (r.hints || []).map((h) => "· " + h).join("\n"), true);
      await refreshConfig();
      poll();
    }));

    // 「一键获取令牌」按钮在两步引导里（panel-common 渲染），找到才接
    const btnCapture = $("btnCapture");
    let capturing = false;
    if (btnCapture) btnCapture.addEventListener("click", async () => {
      const btn = $("btnCapture");
      if (btn.disabled) return;            // 防连点
      capturing = true; btn.disabled = true; btn.textContent = "获取中…";
      showCaptureProgress(true);
      ctx.showResult($("applyResult"), "正在获取令牌，请按提示操作 WorkBuddy…", true);
      try {
        const r = await api("/api/wb/capture", { method: "POST" });
        if (r.ok) {
          let msg = "✔ 令牌获取成功（" + (r.masked || "") + "），已自动填入并保存。";
          if (r.hasRefresh === false) {
            msg += "\n注意：本次未捕获到刷新令牌（它只在令牌续期时才随请求发出）。";
            msg += "访问令牌有效期约一年，到期后重新点「一键获取令牌」即可。";
          }
          msg += "\n接下来点第 2 步「一键接入 WorkBuddy」即可。";
          ctx.showResult($("applyResult"), msg, true);
          ctx.showInfo("令牌已获取", "第 1 步完成，接下来点「一键接入 WorkBuddy」。");
        } else {
          ctx.showResult($("applyResult"), "✘ 获取失败：" + r.error + "\n可展开下方「手动填写令牌」作为备用方式。", false);
        }
      } catch (e) {
        ctx.showResult($("applyResult"), "✘ 获取失败：" + e.message, false);
      } finally {
        showCaptureProgress(false);
        capturing = false; btn.disabled = false;
        await refreshConfig().catch(() => { });
        poll();
      }
    });

    /* ---------- 引导卡里那半步的状态（源页 renderSteps 的一部分，逐字） ---------- */
    function renderStep1() {
      const tok = !!(ctx.cfg && ctx.cfg.wb && ctx.cfg.wb.accessToken);
      const btn = $("btnCapture");
      if (btn && !capturing) btn.textContent = tok ? "重新获取令牌" : "一键获取令牌";
      const h1 = $("hint1");
      if (h1) h1.textContent = tok ? "" : "本机需已安装并登录 WorkBuddy 客户端";
      return tok;
    }

    renderTokens();
    renderStep1();

    return {
      update() { renderTokens(); renderStep1(); },
      refresh() { renderTokens(); renderStep1(); },
    };
  },
};
