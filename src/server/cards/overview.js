/* cards/overview.js —— 总览页（/）的「六家免费渠道」卡。
 *
 * 定位（用户原话）：「剩下的是这些提供方的免费模型界面」——本卡把六家的免费模型界面
 * 收成一张横向状态表：左边点得进对应页签，中间是凭据就绪情况，右边是默认映射目标与
 * 最近一次上游探测。它是主页第一屏，所以**只读不写**：mount 只造 DOM 与事件，
 * 数据一律来自 ctx.status / ctx.cfg 与 update()，绝不做任何网络请求。
 *
 * 数据来源（served 由 server.mjs 的 /api/status 与 /api/config 给出，字段名逐个照抄
 * panel-common.js 里对应的读法，不另造）：
 *   · 凭据就绪：qd/wb/or 的 st().token.configured、zen 的 st().keyConfigured、
 *     bai/sn 用 cli/desktop 的 keyMatch*（server.mjs 只在配了 key 时才写这个字段，
 *     所以「字段不存在」= 未配置，与 panel-common.js paintBadges 的判读一致）；
 *     qd 另有 st().patch 补丁状态（found/patched/ready），没读到令牌时一并显示。
 *   · 默认映射目标：cfg 对应切片的 mapping["claude-sonnet-5"].target（档位名取
 *     ctx.TIERS，不写死）。
 *   · 最近探测：st().upstream（{ ok, model, ms, error, at }），即上游灯 LAMP_PAINTERS
 *     所读的那几个字段。
 *
 * 视觉全部复用既有类（card foldable / head / eyebrow / title / aux / hint /
 * grid2 / fld / msync-row / msync-delta），不新增任何 CSS；配色跟随
 * html[data-provider="home"]。名单从 window.BAI_PROVIDERS 遍历生成，不写死六家。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["overview"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));
    const slot = ctx.slot || $("slot-extra") || document.body;

    /* 提供方名单一律从清单取（顺序 = providers.js 里的书写顺序），总览页自己排除掉——
       表里每一行都是一个「可点进去的提供方页签」，主界面自己不是其中一行。 */
    const MANIFEST = window.BAI_PROVIDERS || {};
    const ROWS = Object.keys(MANIFEST).filter((k) => k !== ctx.PROVIDER && k !== "home");
    const nameOf = (k) => (MANIFEST[k] || {}).tab || k;
    /* 本卡自己的折叠记忆键：跟着清单 foldKey 走，不在本文件里另抄一份 key 字面量 */
    const STORE = ((ctx.P && ctx.P.foldKey) || "bai.ov") + ".ov";

    /* 切片：flat（bai）在顶层，nested 在 cfg[key] / status[key] 里。
       算法照抄 panel-common.js 的 sliceOf/stOf 与 cards/model-sync.js 的 mergeFor。 */
    const flat = (k) => ((MANIFEST[k] || {}).shape === "flat");
    const cfgSlice = (cfg, k) => (flat(k) ? (cfg || {}) : ((cfg || {})[k] || {}));
    const stSlice = (st, k) => (flat(k) ? (st || {}) : ((st || {})[k] || {}));

    slot.insertAdjacentHTML("beforeend", `
      <div class="card foldable" id="cardOv">
        <div class="head" id="headOv">
          <span class="eyebrow">渠道</span><span class="title">六家免费渠道</span>
          <span class="aux" id="ovAux">正在读取接线状态…</span>
        </div>
        <div class="body">
          <div id="ovGrid"></div>
          <div class="hint" id="ovHint">模型映射与免费模型选择去各家页面；公共设置（故障转移 / 转移顺序）在上方「自动故障转移」卡。</div>
        </div>
      </div>`);

    /* ---------------- 每行的三格 ---------------- */

    /* 中格：凭据就绪。判据逐家对应 panel-common.js 的既有读法，读不到就说「—」。 */
    function credCell(k, status) {
      const s = stSlice(status, k);
      const t = s.token || {};
      if (typeof t.configured === "boolean") {
        if (!t.configured) return { ok: false, txt: patchNote(s) || "未配置" };
        const n = typeof t.keyCount === "number" ? t.keyCount : null;
        return { ok: true, txt: n ? `已配置 ${n} 把` : "已就绪" };
      }
      if (typeof s.keyConfigured === "boolean") {
        return { ok: s.keyConfigured, txt: s.keyConfigured ? "已就绪" : "未配置" };
      }
      /* bai / sn 的 keyMatch*：server.mjs 只在配置里真有 key 时才写这个字段，
         所以「两端都读不到该字段」= 没配 key（与 panel-common.js paintBadges 同判据）。 */
      const f = (window.baiKeyMatchField && window.baiKeyMatchField(k)) || "keyMatch";
      const ends = [status && status.cli, status && status.desktop].filter(Boolean);
      const seen = ends.map((e) => e[f]).find((v) => v !== undefined);
      if (seen === undefined) return { ok: false, txt: "未配置" };
      return { ok: true, txt: "已就绪" };
    }

    /* Qoder 的补丁状态：status.qd.patch（字段照抄 cards/model-catalog.js 的读法：
       found / patched / ready）。没读到令牌时它最有信息量——新电脑上用户唯一要做
       的事就是装补丁，光显示「未配置」等于什么都没说。没有该字段的家返回 null。 */
    function patchNote(s) {
      const p = s.patch;
      if (!p || typeof p.ready !== "boolean") return null;
      if (p.ready) return "未读到令牌 · 补丁已装（启动 Qoder）";
      return p.found ? "未读到令牌 · 补丁未装" : "未读到令牌 · 未找到 Qoder";
    }

    /* 右格第一段：默认映射目标（Sonnet 档指到哪）。 */
    function mapCell(k, cfg) {
      const tier = (ctx.TIERS || []).filter((t) => t.key === "claude-sonnet-5")[0]
        || (ctx.TIERS || [])[1];
      const key = tier && tier.key;
      const m = key ? ((cfgSlice(cfg, k).mapping || {})[key] || {}) : {};
      return m.target || "—";
    }

    /* 右格第二段：最近一次上游探测。字段照抄上游灯的读法（up.ok / at / model / ms）。 */
    function probeCell(k, status) {
      const up = (stSlice(status, k).upstream) || {};
      if (!up.at) return "未探测";
      const mark = up.ok === true ? "✔" : up.ok === false ? "✘" : "—";
      const when = new Date(up.at).toLocaleTimeString("zh-CN", { hour12: false });
      const ms = up.ok === true && up.ms != null ? ` ${up.ms}ms` : "";
      return `${mark} ${when}${ms}`;
    }

    /* 头部副行：CLI / 桌面版各接在哪家。 */
    function auxHtml(status) {
      const txt = (m) => {
        if (!m) return "未知";
        const mode = m.mode || "";
        if (mode === ctx.PROVIDER) return nameOf(ctx.PROVIDER);
        if (MANIFEST[mode]) return nameOf(mode);
        return (ctx.MODE_TXT && ctx.MODE_TXT[mode]) || mode || "未知";
      };
      return `CLI → ${esc(txt(status && status.cli))} · 桌面版 → ${esc(txt(status && status.desktop))}`;
    }

    /* ---------------- 绘制（每轮 poll 调一次，数据缺失一律「—」，不许抛错） ---------------- */
    function draw(status, cfg) {
      const aux = $("ovAux");
      if (aux) aux.innerHTML = auxHtml(status);
      const grid = $("ovGrid");
      if (!grid) return;
      grid.innerHTML = "";
      for (const k of ROWS) {
        const P = MANIFEST[k] || {};
        const cred = credCell(k, status);
        const row = document.createElement("a");
        row.className = "msync-row openable";
        row.href = P.path || "/";
        row.style.textDecoration = "none";
        row.style.color = "var(--ink)";
        row.innerHTML =
          `<span style="min-width:96px;font-weight:600">${esc(nameOf(k))}</span>` +
          `<span style="color:${cred.ok ? "var(--ok)" : "var(--err)"}">${esc(cred.txt)}</span>` +
          `<span class="msync-delta" style="text-align:right">` +
          `${esc(mapCell(k, cfg))}<br><span style="opacity:.75">${esc(probeCell(k, status))}</span></span>`;
        grid.appendChild(row);
      }
    }

    /* 本卡是总览页第一屏的主体，默认展开（折叠状态仍由 fold() 记忆，用户点过才收）。
       ctx.fold 第四参 startCollapsed 传 false = 不做 localStorage 默认收起。 */
    if (typeof ctx.fold === "function") ctx.fold("cardOv", "headOv", STORE, false);

    return {
      update(status) {
        try { draw(status, ctx.cfg); }
        catch (e) { console.warn("[card] overview", e); }
      },
    };
  },
};
