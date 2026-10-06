/* cards/model-catalog.js —— Zen / Qoder 两页的「模型目录」区。
 *
 * 两个页面各有一块，结构一样、id 不同，于是按 ctx.PROVIDER 分支：
 *   zen → /api/models?p=zen （zen.html 的 renderZenCatalog / renderZenInfo）
 *   qd  → /api/models?p=qd  （qd.html 的 renderCatalog / renderKeyInfo）
 * 逻辑、配色、文案全部照抄源页，连 qd 那三段「令牌从哪来」的说明也一并搬过来
 * （它原本挂在 cardTok 卡上，extraCards 里没有单独的条目，见交付说明）。
 *
 * 下面用到契约里没列的两个钩子（都做了存在性判断，缺了也不报错）：
 *   ctx.renderRoute()          —— 目录读回来后要重画下拉框（原页直接调 renderRoute()）
 *   window.BAI_MODEL_LABELS    —— qd 的「key → 显示名」映射，供下拉框显示友好名
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["model-catalog"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const slot = ctx.slot || $("slot-extra") || (() => {
      const d = document.createElement("div");
      (document.querySelector(".wrap") || document.body).appendChild(d);
      return d;
    })();
    const PROVIDER = ctx.PROVIDER || "zen";
    const QD = PROVIDER === "qd";

    /* ---------- markup（v1.0.57：新增「一键装补丁」，消掉新电脑装 Python 的负担） ---------- */
    if (QD) {
      slot.insertAdjacentHTML("beforeend", `
        <!-- 令牌（Qoder 无需手动填写，这里只做状态说明 + 一键装补丁） -->
        <div class="card foldable collapsed" id="cardTok">
          <div class="head" id="headTok">
            <span class="eyebrow">令牌</span><span class="title">令牌从哪来</span>
            <span class="aux">新电脑点一次「装补丁」即可</span>
          </div>
          <div class="body">
            <div class="tokstat" id="tokStat">正在读取令牌状态…</div>

            <div class="hint" style="margin-top:12px">
              Qoder 的 <span class="mono">jt-…</span> 令牌<b>每次客户端启动都会轮换</b>，所以它不会被存进 config.json，
              也不会写进 Claude 的 settings.json——中转每次请求现读，Qoder 换令牌后无需重启中转即自动跟随。
            </div>
            <div class="hint" style="margin-top:8px">
              令牌只存在于 Qoder 的 worker 进程内存里（磁盘上没有任何明文副本），所以要在它每次带鉴权的出站请求上
              顺手落盘到 <span class="mono">%TEMP%/qoder-token.json</span>。这一步由下面这个补丁完成——
              <b>已内置在本路由台里，不需要装 Python</b>。
            </div>

            <div class="patchrow" id="qdPatchRow" style="margin-top:12px">
              <div class="tokstat" id="qdPatchStat">正在检查本机 Qoder 安装…</div>
              <div class="saverow" style="margin-top:8px">
                <button class="btn-main" id="btnQdPatch" type="button" style="padding:8px 20px">一键装补丁（自动检测 Qoder 安装位置）</button>
                <button class="btn-sm" id="btnQdRevert" type="button" style="margin-left:8px">还原 Qoder 客户端</button>
              </div>
              <div class="result" id="qdPatchResult"></div>
            </div>

            <div class="hint" style="margin-top:12px">
              <b>前提：Qoder 桌面端必须保持运行</b>。关掉它就不会再刷新令牌文件，中转会读到上一次的旧令牌并返回 401。
              Qoder 升级后会新增版本目录、补丁失效——回到这里再点一次「一键装补丁」即可（会自动发现所有版本）。
            </div>
          </div>
        </div>

        <div class="hint" style="margin-top:10px" id="catHint">下拉里只列<b>能从本中转真正调用</b>的模型。Qoder 客户端内的模型目录与此不同——<span id="catMore">点下方「刷新模型列表」读取</span>。</div>
        <div id="catBox" style="display:none;margin-top:10px">
          <div style="font-size:12px;color:var(--dim);margin-bottom:6px">Qoder 账号的完整模型目录（免费档已标出）：</div>
          <div id="catList" style="display:flex;flex-wrap:wrap;gap:6px"></div>
        </div>`);
    } else {
      slot.insertAdjacentHTML("beforeend", `
        <div class="hint" style="margin-top:10px" id="zenCatHint">下拉里只列<b>能从本中转真正调用</b>的模型。Zen 的公开目录共八十多个，但绝大多数被上游按产品策略锁住——<span id="zenCatMore">点下方「刷新模型列表」读取</span>。</div>
        <div id="zenCatBox" style="display:none;margin-top:10px">
          <div style="font-size:12px;color:var(--dim);margin-bottom:6px">Zen 公开模型目录（<span style="color:var(--ok)">绿框=可外部调用</span>，虚线=上游锁定）：</div>
          <div id="zenCatList" style="display:flex;flex-wrap:wrap;gap:6px"></div>
        </div>`);
    }

    /* 「令牌从哪来」卡的折叠交互（qd 页原样，不记忆选择） */
    if (QD) {
      const card = $("cardTok"), head = $("headTok");
      if (card && head) {
        head.setAttribute("tabindex", "0");
        head.setAttribute("role", "button");
        const sync = () => head.setAttribute("aria-expanded", String(!card.classList.contains("collapsed")));
        sync();
        const toggle = () => { card.classList.toggle("collapsed"); sync(); };
        head.addEventListener("click", toggle);
        head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      }
    }

    /* ---------- 画目录（原样） ---------- */

    // Zen 公开目录：全部列出并标注可用性。下拉只放真能调通的，其余照实展示，
    // 免得用户以为"上游没有这个模型"，其实是产品级封锁（FreeTierError）。
    function renderZenCatalog(j) {
      if (!j || !j.all || !j.all.length) {
        if (j && j.note) $("zenCatHint").textContent = j.note;
        return;
      }
      const box = $("zenCatList");
      box.innerHTML = "";
      for (const m of j.all) {
        const s = document.createElement("span");
        s.style.cssText = "font-family:var(--mono);font-size:11px;padding:3px 8px;border-radius:6px;"
          + (m.external ? "border:1px solid var(--ok);color:var(--ok)"
                        : (m.free ? "border:1px dashed var(--line);color:var(--dim)"
                                  : "border:1px solid var(--line);color:var(--dim)"));
        s.textContent = m.key + (m.external ? " · 可用" : (m.free ? " · 免费档限客户端内" : " · 需付费额度"));
        box.appendChild(s);
      }
      $("zenCatBox").style.display = "";
      $("zenCatHint").textContent = j.note;
      // 同 qd：#zenCatMore 嵌在 #zenCatHint 里，先写 textContent 会抹掉它，故先写提示再重建
      let zmore = document.getElementById("zenCatMore");
      if (!zmore) {
        zmore = document.createElement("span");
        zmore.id = "zenCatMore";
        $("zenCatHint").appendChild(document.createTextNode(" "));
        $("zenCatHint").appendChild(zmore);
      }
      zmore.textContent = "已读取 " + j.all.length + " 个";
      applyModels(j, null);
    }

    // Qoder 的完整模型目录：下拉只放外部真能调通的，其余照实列出并标注「仅客户端内」，
    // 免得选了必然 400。免费档（含 Qwen3.8-Flash）单独标出来。
    function renderCatalog(j) {
      if (!j || !j.all || !j.all.length) {
        if (j && j.note) $("catHint").innerHTML = j.note;
        return;
      }
      const chip = (m) => {
        const s = document.createElement("span");
        s.style.cssText = "font-family:var(--mono);font-size:11px;padding:3px 8px;border-radius:6px;"
          + (m.external ? "border:1px solid var(--line);color:var(--ink)" : "border:1px dashed var(--line);color:var(--dim)")
          + (m.free ? ";border-color:var(--ok);color:var(--ok)" : "");
        s.textContent = (m.external && qdLabels && qdLabels[m.key]) || m.name
          + (m.free ? " · 免费" : "") + (m.external ? "" : " · 仅客户端内");
        s.title = m.key + (m.price != null ? "　price_factor=" + m.price : "");
        return s;
      };
      const box = $("catList");
      box.innerHTML = "";
      for (const m of j.all) box.appendChild(chip(m));
      $("catBox").style.display = "";
      // 顺序有讲究：#catMore 原本嵌在 #catHint 里，先写 innerHTML 会把它连同内部
      // 整段抹掉，后面再 $("catMore") 就是 null → TypeError。所以先写提示，再重建它。
      $("catHint").innerHTML = j.note + " 下拉里只列能从本中转真正调用的那些。";
      let more = document.getElementById("catMore");
      if (!more) {
        more = document.createElement("span");
        more.id = "catMore";
        $("catHint").appendChild(document.createTextNode(" "));
        $("catHint").appendChild(more);
      }
      more.textContent = "已读取 " + j.all.length + " 个";
      // 顺带刷新下拉的可选项与显示名
      applyModels(j, j.labels || null);
    }

    let qdLabels = null;   // key -> 显示名，来自 /api/models?p=qd

    // 把目录里的「外部可调用」那批写进当前 provider 的 availableModels 并重画下拉。
    // ctx.cfg 在页面刚加载、配置还没回来时是 null —— 早期版本在这里直接静默抛错，
    // 结果下拉框永远停在 config.defaults.json 的默认值（Qoder 只剩 lite/auto 两项，
    // 而实际可调用的有 8 个）。所以先把配置等回来，再写。
    async function applyModels(j, labels) {
      if (labels) { qdLabels = labels; window.BAI_MODEL_LABELS = labels; }
      try {
        if (!ctx.cfg && typeof ctx.refreshConfig === "function") await ctx.refreshConfig();
        const c = ctx.cfg && ctx.cfg[PROVIDER];
        if (c) c.availableModels = j.models;
        if (typeof ctx.renderRoute === "function") ctx.renderRoute();
      } catch (e) { /* 目录渲染失败不该拖垮页面 */ }
    }

    /* ---------- 取数据（原样：各自打自己的 ?p= ） ---------- */


    function renderKeyInfo(status) {
      const stat = $("tokStat");
      const qdS = (status && status.qd) || {};
      const t = qdS.token || {};
      const p = qdS.patch || {};
      if (stat) {
        stat.innerHTML = t.configured
          ? '<span style="color:var(--ok)">✔ 已读到令牌</span>　<span class="mono">' + (t.tokenFile || "") + '</span>'
          + '<br><span>令牌每次 Qoder 启动会轮换，中转按此文件现读，无需重启</span>'
          : '<span style="color:var(--err)">✘ 未读到令牌</span>　' + (p.ready
            ? "补丁已装 —— 请启动 Qoder 桌面端并保持运行"
            : '<b>本机还没装补丁</b> —— 点下方「一键装补丁」（第 1 步）');
      }
      // 补丁状态行（新电脑上最关键的诊断：到底是补丁没装，还是 Qoder 没开）
      const ps = $("qdPatchStat");
      if (ps) {
        const bits = [];
        if (!p.found) {
          bits.push('<span style="color:var(--err)">✘ 没找到 Qoder 安装目录</span>　请确认已装 Qoder 桌面端（国际版）');
        } else {
          bits.push(p.ready
            ? '<span style="color:var(--ok)">✔ 补丁已装</span>　' + p.patched + "/" + p.found + " 个 worker 副本"
            : '<span style="color:var(--err)">✘ 补丁未装</span>　发现 ' + p.found + " 个 worker 副本");
          bits.push(p.tokenFresh
            ? '<span>令牌文件新鲜（Qoder 正在刷新）</span>'
            : '<span style="color:var(--dim)">令牌文件未刷新 —— Qoder 没开或没发请求</span>');
        }
        if (p.cn) bits.push('<span style="color:var(--dim)">另有国内版 Qoder CN ' + p.cn + ' 份，有意跳过</span>');
        ps.innerHTML = bits.join("<br>");
      }
    }

    /* ---------- 一键装/还原补丁（v1.0.57） ---------- */
    // 新电脑上用户唯一需要做的事：点一下。服务端 qoder-patch.mjs 会用 Node 自己
    // 扫描所有 Qoder 安装目录、打补丁，不需要用户装 Python、也不需要指定路径。
    const api = ctx.api;
    const runPatch = (btn, url, okMsg) => {
      if (typeof ctx.withBusy === "function") {
        ctx.withBusy(btn, async () => {
          const r = await api(url, { method: "POST" });
          const box = $("qdPatchResult");
          if (r && r.ok) {
            let msg = okMsg;
            if (r.results && r.results.length) {
              msg += "（" + r.results.map((x) => x.ver + " " + x.state).join("、") + "）";
            }
            if (box) { box.className = "result ok"; box.textContent = "✔ " + msg; }
            if (typeof ctx.showInfo === "function") ctx.showInfo("Qoder 补丁", "完成。请确认 Qoder 桌面端正在运行。");
          } else {
            const err = (r && (r.error || (r.results || []).map((x) => x.ver + ":" + (x.note || x.state)).join(" "))) || "未知错误";
            if (box) { box.className = "result err"; box.textContent = "✘ " + err; }
          }
          if (typeof ctx.poll === "function") ctx.poll();
        });
      }
    };
    if (QD) {
      const bp = $("btnQdPatch"), br = $("btnQdRevert");
      if (bp) bp.addEventListener("click", () => runPatch(bp, "/api/qd/patch/apply", "补丁已装到所有 Qoder 版本"));
      if (br) br.addEventListener("click", () => runPatch(br, "/api/qd/patch/revert", "已还原 Qoder 客户端（补丁移除）"));
    }

    // 目录刷新：服务端按 mtime 缓存 30 分钟，代价可忽略，所以每轮轮询都可以刷。
    function fetchCatalog() {
      fetch("/api/models?p=" + PROVIDER).then((r) => r.json()).then(QD ? renderCatalog : renderZenCatalog).catch(() => { });
    }
    fetchCatalog();

    // 首屏就读一次（源页是在 refreshConfig 里做的）
    if (QD) renderKeyInfo(ctx.status);

    return {
      // 轮询刷新：qd 顺带刷新令牌状态与目录（与源页 renderKeyInfo 同一时机）；
      // zen 的目录与 status 无关，源页也只在 refreshConfig 时读，保持如此。
      update(status) {
        if (QD) { renderKeyInfo(status || ctx.status); fetchCatalog(); }
      },
      // 配置刷新 / 「刷新模型列表」之后手动叫一次
      refresh() {
        if (QD) renderKeyInfo(ctx.status);
        fetchCatalog();
      },
    };
  },
};
