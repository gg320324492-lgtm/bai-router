/* cards/oc-transport.js —— 「传输方式」开关卡（v1.0.75）。
 *
 * 这一档的请求可以走两条完全不同的路：
 *   · 直连 —— 本程序直接调上游接口（**出厂值**，改动前的路径，一行都没变）
 *   · 经一个本机的 OpenCode 客户端 —— 用它自己的身份发请求
 * 两者可配置性、失败方式、前置条件全都不一样，所以必须是**面板上看得见的一档开关**，
 * 而不是让人手改 config.json。
 *
 * ── 这张卡只画「清单声明了 transportSwitch 的渠道」的那一格 ──
 * 选项、各自的前置条件来自 window.BAI_PROVIDERS 的 transportOptions；
 * 当前是哪一档、前置条件在本机满足没有，来自 /api/status 的 transport /
 * transportProbe（探测在服务端 oc-transport-info.mjs，**复用** oc-runtime 的
 * findOpenCodeBinary，本卡不自己去找可执行文件）。
 * 渲染层因此不需要认识任何渠道名，也不需要复制任何判定逻辑。
 *
 * ── 三种探测状态必须画成三种东西 ──
 *   found   → 绿 + 路径，可以直接打开这一档
 *   missing → 红 + 「一键安装 OpenCode CLI」按钮（官方源、固定版本、sha512 校验，
 *             仅在点击时下载）+ 一条**可以自己执行**的安装命令
 *   error   → 「检测失败」+ 原因，并明说这**不等于没装**
 * 最后一条最容易省掉，省掉就是在误导人：把 error 画成 missing，处置会从
 * 「再试一次」变成「去装一个可能早就装好的东西」。
 *
 * 导出 renderTransportPanel / transportPayload / applyTransport 三个纯函数给
 * scripts/oc-ui-test.mjs 直接调（vm 里只挂一个空 window 就能跑，测试不碰真实 DOM）。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["oc-transport"] = {
  /* ================================================================== *
   * 纯函数区（无 DOM、无网络，测试直接调这三个）
   * ================================================================== */

  /**
   * 画这一格。**纯函数**：只认传进来的数据，不读全局、不碰 DOM。
   *
   * @param {object} o
   * @param {Array<{value,label,desc,need,requiresProbe}>} o.options 清单里声明的选项
   * @param {string} o.current   当前生效的档位（服务端给的，中转真正会走的那一档）
   * @param {object|null} o.probe {state,path,source,hint,error,checkedAt}
   * @param {string} o.hint      「何时生效」说明（服务端给的）
   * @param {Function} [o.esc]
   * @param {object} [o.kit] 共享组件库（window.BAI_KIT）。**传进来才有三态**：
   *   这个纯函数在单测里被直接求值（vm 里只有一个空 window），那时没有组件库。
   * @returns {string} HTML
   */
  renderTransportPanel(o) {
    const kit = o.kit || null;
    const esc = o.esc || ((s) => String(s == null ? "" : s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
    const opts = Array.isArray(o.options) && o.options.length ? o.options : [];
    const current = String(o.current || "");
    const probe = o.probe || null;
    const state = String((probe && probe.state) || "unknown");

    const rows = opts.map((op) => {
      const on = op.value === current;
      return `<label class="ocopt${on ? " on" : ""}">
        <span class="checks"><input type="radio" name="ocTransport" data-role="oc-transport-opt" value="${esc(op.value)}"${on ? " checked" : ""}></span>
        <span class="body">
          <span class="t">${esc(op.label || op.value)}</span>
          <span class="d">${esc(op.desc || "")}</span>
          <span class="n">${esc(op.need || "")}</span>
        </span>
        <span class="lvl ${on ? "ok" : ""}">${on ? "当前" : ""}</span>
      </label>`;
    }).join("");

    /* 探测那一段。三种状态各有各的说法，互相之间**不共用任何一句关键判词**。 */
    let probeLine;
    if (state === "found") {
      probeLine = `<div class="fpline"><span class="k">本机检测</span><span class="v ok">已安装</span></div>`
        + `<div class="fpline"><span class="k">路径</span><span class="v" style="font-family:var(--mono);white-space:normal;word-break:break-all">${esc(probe.path || "")}</span></div>`
        + (probe.source ? `<div class="fpline"><span class="k">来源</span><span class="v zh">${esc(probe.source)}</span></div>` : "");
    } else if (state === "missing") {
      probeLine = `<div class="fpline"><span class="k">本机检测</span><span class="v err">未安装</span></div>`
        + `<div class="btnrow" style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">`
        + `<button class="btn sm" type="button" data-role="oc-install">一键安装 OpenCode CLI</button>`
        + `<span class="hint" style="margin:0">官方源 · 固定版本 · sha512 校验 · 约 60MB · 仅点击时下载</span>`
        + `</div>`
        + `<div class="hint" data-role="oc-probe-hint" style="margin-top:6px;white-space:pre-wrap">${esc(probe.hint || "")}</div>`;
    } else if (state === "error") {
      /* ★ 与「未安装」严格分开：这里说的是「面板此刻说不出装没装」。 */
      probeLine = `<div class="fpline"><span class="k">本机检测</span><span class="v warn">检测失败</span></div>`
        + `<div class="hint" data-role="oc-probe-hint" style="margin-top:6px;white-space:pre-wrap">${esc(probe.hint || "")}</div>`
        + (probe.error ? `<div class="hint" data-role="oc-probe-error" style="margin-top:4px;color:var(--err)">${esc(probe.error)}</div>` : "");
    } else {
      /* 「还没读到探测结果」= **还在读**，不是「没装」。这两种混起来，
         处置会从「等一下」变成「去装一个可能早就装好的东西」。 */
      probeLine = (kit && kit.loadingState)
        ? kit.loadingState("尚未读到本机的安装情况…", { hint: "面板正在等本机的探测结果。" })
        : `<div class="fpline"><span class="k">本机检测</span><span class="v">尚未读到</span></div>`;
    }

    return `<div class="fieldset">
      <div class="ocopts">${rows}</div>
      <div data-role="oc-probe">${probeLine}</div>
      <div class="hint" data-role="oc-effect" style="margin-top:9px">${esc(o.hint || "")}</div>
      <div class="result" data-role="oc-transport-result"></div>
    </div>`;
  },

  /** 清单里声明了才画。**只有布尔 true 算数**——渲染层不许自己决定要不要画这一格。 */
  shouldShow(P) {
    return !!(P && P.transportSwitch === true);
  },

  /** 切换请求的载荷。**只有这两个字段**——服务端是白名单收字段，多余的会被静默丢掉还回 ok:true。 */
  transportPayload(provider, value) {
    return { provider: provider, transport: String(value == null ? "" : value) };
  },

  /**
   * 发切换请求并把结果（成或不成都）如实报出去。
   * 服务端拒收时（400）异常里带的就是它给的理由，这里**原样转述**并按失败渲染——
   * 静默地把单选钮拨回去而不说理由，用户只会以为面板坏了。
   *
   * @param {{post:Function, onResult:Function, onSettled?:Function}} deps
   * @param {{provider:string, value:string, label?:string, hint?:string}} args
   */
  async applyTransport(deps, args) {
    const body = this.transportPayload(args.provider, args.value);
    try {
      await deps.post("/api/config", body);
      const said = `已保存为「${args.label || args.value}」。${args.hint || ""}`;
      if (deps.onResult) deps.onResult(true, said);
      return { ok: true, body };
    } catch (e) {
      /* 服务端拒了 = 没保存。必须说「没保存」+ 它的理由，不能让界面停在拨过去的那一档。 */
      const msg = `没保存成功：${String((e && e.message) || e)}`;
      if (deps.onResult) deps.onResult(false, msg);
      return { ok: false, error: msg, body };
    } finally {
      if (deps.onSettled) deps.onSettled();
    }
  },

  /* ================================================================== *
   * 挂载
   * ================================================================== */
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const MANIFEST = window.BAI_PROVIDERS || {};
    const NAME = "oc-transport";
    const self = this;

    /* 落点：映射编辑卡（#mapPanel）之下、诊断抽屉之上。清单里声明了
     * transportSwitch 的渠道才显示它；换到别的渠道就收起来（refresh 由
     * 共享层在 selectChannel 之后调）。 */
    let panel = $(NAME);
    if (!panel) {
      const anchor = $("mapPanel");
      panel = document.createElement("div");
      panel.className = "panelbox";
      panel.id = NAME;
      panel.style.display = "none";
      panel.innerHTML = `<div class="pb-head"><h3>传输方式</h3><span class="sub">这一档的请求走哪条路</span></div>`;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
      else document.body.appendChild(panel);
    }

    const body = document.createElement("div");
    panel.appendChild(body);

    const key = () => ctx.channel || "";
    const declared = () => {
      const P = MANIFEST[key()] || {};
      return self.shouldShow(P) ? P : null;
    };
    const resultSlot = () => body.querySelector('[data-role="oc-transport-result"]');
    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const kit = window.BAI_KIT || null;

    function paint() {
      const P = declared();
      if (!P) { panel.style.display = "none"; return; }
      panel.style.display = "";
      /* 重画会整块换掉 innerHTML，所以先把「上一条结果」捞出来重贴回去：
       * 切换成功后紧跟着的那次重画（等轮询回来）会把它抹掉，而那句话正是
       * 「下一次请求生效」的提示——抹掉就成了静默切换。 */
      const prev = resultSlot();
      const prevText = prev ? String(prev.textContent || "") : "";
      const prevGood = prev ? /(^|\s)good(\s|$)/.test(String(prev.className || "")) : false;
      const S = ctx.stOf(key()) || {};
      const probe = S.transportProbe || null;
      /* 探测出错 ⇒ 在最顶上补一块错误态（**带下一步**）。
         下面那一行「检测失败」是服务端给的事实，**不等于没装**；
         这一块负责说清「那该怎么办」—— 两件事分工不同，缺一块用户就只能干瞪眼。 */
      const probeErr = (kit && probe && probe.state === "error")
        ? kit.errorState("面板此刻说不出本机装没装", {
          hint: "这不等于没装 —— 先自己确认一下（终端里敲 which opencode），还不行就看诊断抽屉（右上角）。",
          detail: probe.error || probe.hint || "",
        })
        : "";
      /* 没装客户端 = **这一档没有任何本地客户端可用**（缺前置条件，不是出错）。
         它和「检测失败」是两回事：处置一个是要装，一个是要重试。 */
      const probeMissing = (kit && probe && probe.state === "missing")
        ? kit.emptyState("本机没有可用的客户端中转", {
          hint: "这一档要经本机的客户端发请求 —— 点上面的「一键安装 OpenCode CLI」（官方源 · 固定版本 · sha512 校验 · 仅点击时下载），或先装好它再回来。",
        })
        : "";
      body.innerHTML = probeErr + probeMissing + self.renderTransportPanel({
        options: P.transportOptions || [],
        current: S.transport || "",
        probe: probe,
        hint: S.transportHint || "",
        esc: ctx.esc,
        kit: kit,
      });
      if (prevText && ctx.showResult) ctx.showResult(resultSlot(), prevText, prevGood);
      for (const el of body.querySelectorAll('[data-role="oc-transport-opt"]')) {
        el.addEventListener("change", () => onPick(el.value, P));
      }
      /* 一键安装按钮（只有 missing 态画得出来）：接上监听；下载进行中要抗住重画。 */
      for (const el of body.querySelectorAll('[data-role="oc-install"]')) {
        el.addEventListener("click", () => onInstall(P));
      }
      if (installing) markInstalling();
    }

    /* ============ 一键安装（2026-10-17）============
     * 只在用户**点击**时才走这条路：POST /api/oc/install（服务端从官方源下载 +
     * sha512 校验 + 装到 ~/.opencode/bin）。装完顺手把开关拨到「OpenCode 客户端中转」，
     * 因为点这个按钮的目的本来就是用它。拨动失败不算安装失败，如实分开说。
     * `installing` 对这张卡是全局的——共享层 5 秒轮询会重画 innerHTML，
     * 靠它把「下载中」的禁用状态从重画里救回来，避免用户以为没点上又点一次。 */
    let installing = false;
    const INSTALL_BUSY_TEXT = "下载中…（约 60MB · 官方源 · sha512 校验，请勿关闭本窗口）";
    function markInstalling() {
      const b = body.querySelector('[data-role="oc-install"]');
      if (b) { b.disabled = true; b.textContent = INSTALL_BUSY_TEXT; }
    }
    async function onInstall(P) {
      if (installing) return;
      installing = true;
      markInstalling();
      const slot = resultSlot();
      if (ctx.showResult && slot) ctx.showResult(slot, "开始下载 OpenCode CLI（npm 官方源，落地前做 sha512 校验）……", true);
      let text = "", good = false;
      try {
        const r = await ctx.postJSON("/api/oc/install", {});
        if (r && r.already) {
          text = `本机已有可用的 OpenCode：${(r && r.path) || ""}。`;
        } else {
          const mb = Math.round((((r && r.bytes) || 0) / 1048576));
          text = `已安装 OpenCode CLI v${(r && r.version) || ""} → ${(r && r.path) || ""}（${mb} MB）。`;
        }
        good = true;
        const cur = String(((ctx.stOf(key()) || {}).transport) || "");
        if (cur !== "opencode") {
          const op = (P.transportOptions || []).find((x) => x.value === "opencode");
          const res = await self.applyTransport({ post: ctx.postJSON, onResult: () => {} }, {
            provider: key(), value: "opencode",
            label: (op && op.label) || "OpenCode 客户端中转", hint: "",
          });
          text += (res && res.ok)
            ? " 已切换到「OpenCode 客户端中转」。"
            : ` 安装已完成，但自动切换没成功：${(res && res.error) || ""}（可在上面手动选择）。`;
        }
      } catch (e) {
        text = `安装失败：${String((e && e.message) || e)}`;
        good = false;
      } finally {
        installing = false;
        if (ctx.showResult && slot) ctx.showResult(slot, text, good);
        if (typeof ctx.poll === "function") { Promise.resolve(ctx.poll()).then(paint, () => paint()); } else paint();
      }
    }

    async function onPick(value, P) {
      const op = (P.transportOptions || []).find((x) => x.value === value);
      const S = ctx.stOf(key()) || {};
      await self.applyTransport({
        post: ctx.postJSON,
        onResult: (good, text) => ctx.showResult(resultSlot(), text, good),
        onSettled: () => {
          /* 成败都按**服务端说的**那一档重画：拨回去 / 拨过去由状态决定，
           * 不由刚才那个单选钮决定（失败时必须自己弹回去，否则界面停在一个没保存的值上）。
           * 当前档位的权威是 /api/status，所以等一次轮询回来再重画。 */
          if (typeof ctx.poll !== "function") { paint(); return; }
          Promise.resolve(ctx.poll()).then(paint, () => paint());
        },
      }, {
        provider: key(), value,
        label: (op && op.label) || value,
        hint: S.transportHint || "",
      });
    }

    paint();
    return {
      update() { paint(); },
      refresh() { paint(); },
    };
  },
};