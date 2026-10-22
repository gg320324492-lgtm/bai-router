/* cards/token-capture.js —— 凭据视图里「访问令牌（jwt）」那一行的内联面板。
 *
 * v17 之前这是 WorkBuddy 页面的一张独立折叠卡 + 两步引导里的「一键获取令牌」按钮。
 * 单页改版后令牌逻辑按清单的 credential.kind = "jwt" 自认领凭据视图里所有同类行
 * ——不写死渠道名，新增一家令牌型渠道时这张卡自动跟过去。
 *
 * 保留的是两条真正有用的路：
 *   1) 「一键获取令牌」：装钩子 → 提示用户在客户端里触发 → 抓 Authorization → 写回配置
 *      （令牌**只存内存**，不落 config.json；这一步是 jwt 类型渠道的核心动作）
 *   2) 「手动填写令牌」：一键获取失败时的备用方式（浏览器 F12 抓四个头）
 *
 * 折叠壳由渲染层提供（凭据行本身就是可展开的），本卡不再自带 .card.foldable。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["token-capture"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));
    const hosts = (typeof ctx.rowsOfKind === "function" ? ctx.rowsOfKind("jwt") : []) || [];
    if (!hosts.length) return { update() { }, refresh() { } };

    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const kit = window.BAI_KIT || null;
    const S3 = (kind, text, opts) => (kit
      ? kit[kind](text, opts)
      : '<div class="hint">' + esc(text) + "</div>");

    /* 每家一个独立的作用域：同一张卡挂在多行上时，id 必须带渠道 key 才不打架 */
    let seq = 0;
    const scoped = hosts.map((host) => {
      const key = (host.closest(".credrow") || {}).dataset ? host.closest(".credrow").dataset.k : null;
      const n = key || ("c" + (++seq));
      host.innerHTML = `
        <div class="cardbody" data-cid="tc-${esc(n)}">
          <div class="tcap">
            <span class="k">怎么拿</span>
            <span class="v">开始获取后，客户端发起带鉴权的请求时会自动保存令牌。完成或超时后会还原临时改动。</span>
          </div>
          <label class="tcap"><input type="checkbox" data-role="auto-restart">允许自动重启客户端（可选）</label>
          <div class="tcap"><span class="v">勾选后，点击获取会关闭并重新打开对应客户端窗口；未保存内容可能丢失，客户端内的终端会话也可能结束。未勾选时请手动重启，或使用「手动填写」。</span></div>
          <div class="progress" data-role="prog" style="display:none">
            <div class="spin"></div>
            <div>
              <div class="pTitle" data-role="ptitle"></div>
              <div class="pDesc" data-role="pdesc"></div>
            </div>
          </div>
          <div class="tokstat" data-role="stat">${S3("loadingState", "正在读令牌状态…", { hint: "读完这一行就知道有没有捕获到访问令牌、还能用多久。" })}</div>
          <div class="keybox" data-role="keys" style="display:none"></div>
          <div class="result" data-role="res"></div>
        </div>`;
      const scope = host.querySelector('[data-cid]');
      return {
        host, scope, key,
        /* 委托到整行：本卡**不画**「一键获取令牌 / 手动填写」按钮——那两个由渲染层按
           credential.kind 统一分派，画两份会出现两个同名按钮。用事件委托接过去，
           谁画的按钮都走同一条流程。 */
        row: host.closest(".credrow") || scope,
        $: (sel) => scope.querySelector(sel),
        $all: (sel) => Array.from(scope.querySelectorAll(sel)),
        tokstat() { return scope.querySelector('[data-role="stat"]'); },
      };
    });

    /* ---------------- 等待面板 ---------------- */
    const CAP_TIPS = [
      "正在准备获取令牌…",
      "正在等待客户端发起带鉴权的请求…",
      "若尚未捕获，请按下方提示重启客户端或发一条消息",
      "仍在等待中…（最长 10 分钟，超时后自动还原客户端脚本）",
    ];
    const timers = new Map();
    /* 停掉某个作用域的等待面板。**两个定时器都要清**：只清轮询那个的话，
       12 秒一次的文案推进会变成野定时器，页面关掉后仍在跑。 */
    function stopTimers(sc) {
      const cur = timers.get(sc);
      if (!cur) return false;
      clearInterval(cur.tick);
      clearInterval(cur.poll);
      timers.delete(sc);
      return true;
    }

    /* POST /api/wb/capture 要阻塞到捕获结束（后端最长等 10 分钟），而 ctx.api() 的默认
       读超时只有 12 秒 —— 用默认值发过去，一次**成功**的捕获也会被掐成「读取超时」，
       服务端却还在后台正常等着钩子，于是用户以为没抓到（实测复现的就是这个）。
       所以发之前先问后端这次要等多久，再按它给足。问不到就用兜底窗口，宁可等久也不误报。 */
    const CAP_WINDOW_FALLBACK_MS = 10 * 60 * 1000;
    const CAP_POST_MARGIN_MS = 60 * 1000;
    const capTimeoutMs = typeof ctx.capTimeoutMs === "function"
      ? ctx.capTimeoutMs
      : (backendMs) => (Number(backendMs) || CAP_WINDOW_FALLBACK_MS) + CAP_POST_MARGIN_MS;

    /* 报结果前先占位：两条路径（POST 的返回 / 轮询看到 done）都会走到这里，
       谁先到谁报。run.reported 兼作「已收摊」信号 —— 不置位的话另一条还会再报一次，
       而轮询比 POST 早到是常态。 */
    function claimReport(run) {
      if (!run || run.reported) return false;
      run.reported = true;
      return true;
    }
    async function settle(sc, run) {
      if (!run || run.settled) return;
      run.settled = true;
      /* 收摊就**必须把等待面板收掉**。settle 是两条路径唯一的公共收尾点：
         POST 抢先 claimReport 成功时走的就是这里，而它原来只 stopTimers 不隐藏 ——
         于是定时器停了、文案冻在最后一帧（还剩 9:46），绿条说成功、面板却一直挂着，
         用户以为没抓到。finishFromPoll 自己藏过一次，这里再藏一遍是幂等的。
         ⚠ keepPolling 时**不**调 settle（见下），面板要留给轮询直到捕获真正结束。 */
      const box = sc.$('[data-role="prog"]');
      if (box) box.style.display = "none";
      stopTimers(sc);
      if (run.btn) { run.btn.disabled = false; run.btn.textContent = run.old; }
      if (run.restartBox) run.restartBox.disabled = false;
      await ctx.refreshConfig().catch(() => { });
      ctx.poll();
    }
    function okMsg(masked, hasRefresh) {
      let msg = "✔ 令牌获取成功（" + (masked || "") + "），已自动填入并保存。";
      if (hasRefresh === false) {
        msg += "\n注意：本次未捕获到刷新令牌（它只在令牌续期时才随请求发出）。";
        msg += "访问令牌到期后重新点一次即可。";
      }
      return msg;
    }
    const failMsg = (err) =>
      "✘ 获取失败：" + (err || "未知原因") + "\n可改用「手动填写」作为备用方式。";

    /* 轮询看到「本次捕获结束了」：停轮询、如实报成功或失败。 */
    function finishFromPoll(sc, run, s) {
      if (!claimReport(run)) return;
      stopTimers(sc);
      const box = sc.$('[data-role="prog"]');
      if (box) box.style.display = "none";
      if (s.ok) {
        ctx.showResult(sc.$('[data-role="res"]'), okMsg(s.masked, s.hasRefresh), true);
      } else {
        /* 超时也是**有结论的失败**——如实说出来，不让界面一直转圈。 */
        ctx.showResult(sc.$('[data-role="res"]'), failMsg(s.error), false);
      }
      settle(sc, run);
    }

    function showProgress(sc, on, run) {
      const box = sc.$('[data-role="prog"]');
      if (!box) return;
      box.style.display = on ? "flex" : "none";
      stopTimers(sc);
      if (!on) return;
      let n = 0;
      /* 轮询分支若接管了标题（自动重启中 / 重启没做成 / 等用户手动重启），
         这个 12 秒推进器就**必须让位**——否则它会在下一拍把
         「正在自动重启，窗口会被关掉」覆盖成一句「请发一条消息」，
       那正是我们要消灭的那种误导。 */
      let tickBlocked = false;
      sc.$('[data-role="ptitle"]').textContent = CAP_TIPS[0];
      sc.$('[data-role="pdesc"]').textContent = "完成后会自动还原对客户端的临时改动，不影响它正常使用。";
      const tick = setInterval(() => {
        if (tickBlocked) return;
        n = Math.min(n + 1, CAP_TIPS.length - 1);
        sc.$('[data-role="ptitle"]').textContent = CAP_TIPS[n];
      }, 12000);
      const poll = setInterval(async () => {
        try {
          const s = await ctx.api("/api/wb/capture/status");
          /* 「结束了」这条要**第一个**判：它一旦成立，本次的结论就是定论，
             后面的进度文案都不该再改写了。
             ⚠ startedAt 必须和发起这次捕获前记下的对上号 —— 上一轮留下的 done
             不属于这次，据此报出去就是拿旧结局骗用户。 */
          if (s && s.done && s.startedAt != null && s.startedAt !== run.prevStartedAt) {
            finishFromPoll(sc, run, s);
            return;
          }
          if (s && s.gotAccessToken) {
            tickBlocked = false;
            sc.$('[data-role="ptitle"]').textContent = "已捕获到访问令牌，正在写入配置…";
            sc.$('[data-role="pdesc"]').textContent = "刷新令牌只在令牌到期续期时才会出现；没有它也能正常使用，到期后重新获取即可。";
          } else if (s && s.restarting) {
            /* v1.0.82：正在由**程序**自动重启客户端。这一句必须显眼：
               我们要关掉的是用户正在用的窗口，不能默默杀用户的应用 ——
               「窗口会被关掉并重新打开」+「未保存内容可能丢失」都要说出口。 */
            tickBlocked = true;
            sc.$('[data-role="ptitle"]').textContent = "正在自动重启客户端，请勿手动操作";
            sc.$('[data-role="pdesc"]').textContent = s.phaseText
              || "正在自动重启 WorkBuddy 客户端：**你的客户端窗口会被关掉并重新打开**，未保存的对话内容可能丢失。稍等几秒，窗口会自动重新出现。";
          } else if (s && s.restart && !s.restarted && s.restart.action !== "restarted" && s.restart.action !== "not_running") {
            /* 展示真实重启结局；启动失败时旧窗口已经退出，不能声称没有动任何进程。 */
            tickBlocked = true;
            sc.$('[data-role="ptitle"]').textContent = s.restart.action === "disabled"
              ? "自动重启已关闭，请手动重启客户端"
              : s.restart.action === "spawn_failed" ? "客户端已退出，但未能重新打开" : "没能完成自动重启客户端";
            sc.$('[data-role="pdesc"]').textContent = (s.restart.detail || "")
              + "本轮仍在等待，可手动重开客户端后发消息；本轮结束后需重新获取，或使用「手动填写令牌」。";
          } else if (s && s.needRestart && !s.restarted) {
            /* v1.0.65：客户端在钩子注入前就已启动，内存里是旧入口脚本——
               改磁盘对它无效，光发消息是抓不到的。必须明说，否则用户会一直试。
               这里**不**拼「已等待 N 秒」——等再久也没用，要等的是用户重启客户端。 */
            tickBlocked = true;
            sc.$('[data-role="ptitle"]').textContent = "需要先完全退出并重启客户端";
            sc.$('[data-role="pdesc"]').textContent = s.phaseText
              + "（关窗口不算，托盘图标也要退出；重开后发一条消息即可）";
          } else if (s && s.restarted) {
            /* v1.0.70：探测到客户端已在注入之后重启 —— 钩子此刻确实生效了。
               不用再让用户自己判断"我这一步做对没有"，界面直接翻成「可以发消息了」。
               剩下的时间也一并显示，免得再出现"我是不是又错过了时限"的悬念。
               v1.0.82：自动重启成功时也会走这里 —— 后端重启探测到新进程，且它**可能**
               空载就抓到（预热请求带鉴权时用户全程零操作）；抓不到时再说「发一条消息」。 */
            tickBlocked = true;
            const left = Math.max(0, Math.round((s.remainMs || 0) / 1000));
            const mm = Math.floor(left / 60);
            const ss = String(left % 60).padStart(2, "0");
            sc.$('[data-role="ptitle"]').textContent = "客户端已重启，正在等待令牌…";
            sc.$('[data-role="pdesc"]').textContent =
              (s.phaseText || `${s.provider === "wbai" ? "WorkBuddy AI" : "WorkBuddy"} 客户端已重启，正在等待带鉴权的请求`)
              + `（还剩 ${mm}:${ss}，超时后自动还原客户端脚本）。若这段时间内没抓到，请在客户端里发一条消息即可。`;
          } else if (s && s.active && s.phaseText) {
            /* 时长由后端给（v1.0.70 之前这里写死「最长 150 秒」，与后端一改就对不上了）。 */
            const secs = Math.round((s.elapsedMs || 0) / 1000);
            const mins = Math.round((s.timeoutMs || 0) / 60000);
            sc.$('[data-role="pdesc"]').textContent = s.phaseText + `（已等待 ${secs} 秒，最长 ${mins} 分钟）`;
          }
        } catch { /* 轮询失败不影响主流程 */ }
      }, 2000);
      timers.set(sc, { tick, poll });
    }

    /* ---------------- 手动填写（备用路径，事件委托到行内的按钮） ---------------- */
    const FIELDS = [
      ["accessToken", "访问令牌", "eyJ…（JWT，三段）"],
      ["refreshToken", "刷新令牌", "eyJ…（用于到期自动续期）"],
      ["deviceToken", "设备令牌", "可留空"],
      ["userId", "用户 ID", "可留空"],
    ];
    function openManual(sc) {
      const box = sc.$('[data-role="keys"]');
      if (!box) return;
      if (box.style.display !== "none") { box.style.display = "none"; return; }
      const C = ctx.cfgOf(sc.key) || {};
      box.style.display = "";
      box.innerHTML = FIELDS.map(([f, k, ph]) =>
        `<div class="keyrow-inline"><span class="n">${esc(k)}</span>`
        + `<input type="password" autocomplete="off" placeholder="${esc(ph)}" data-f="${esc(f)}" value="${esc(C[f] ? "已保存（不回显）" : "")}" ${C[f] ? "readonly" : ""}>`
        + (C[f] ? `<span class="live">已保存</span>` : "")
        + "</div>").join("")
        + `<div class="saverow"><button class="btn sm" type="button" data-act="savetok" data-n="${esc(sc.key)}">保存令牌</button>
             <span class="fpline" style="border:0;padding:0"><span class="v zh">已保存过的格子不回显明文，要改就清空重填</span></span></div>`;
      const b = box.querySelector('[data-act="savetok"]');
      if (b) b.addEventListener("click", () => saveTok(sc, box, b));
    }
    async function saveTok(sc, box, btn) {
      const body = { provider: sc.key };
      for (const inp of Array.from(box.querySelectorAll("input[data-f]"))) {
        if (inp.readOnly) continue;
        body[inp.dataset.f] = inp.value.trim();
      }
      await ctx.withBusy(btn, async () => {
        const r = await ctx.postJSON("/api/config", body);
        ctx.showResult(sc.$('[data-role="res"]'), "✔ 令牌已保存\n" + (r.hints || []).map((h) => "· " + h).join("\n"), true);
        box.style.display = "none";
        await ctx.refreshConfig();
        ctx.poll();
      }, sc.$('[data-role="res"]'));
    }

    /* ---------------- 令牌体检条 ---------------- */
    function paint(sc, status) {
      const stat = sc.tokstat();
      if (!stat) return;
      const S = ctx.stOf(sc.key) || {};
      const t = S.token || {};
      const parts = [];
      /* ⚠ 服务端状态还没到 ⇒ 说「在读」。**不能**当成「没捕获到令牌」：
         那个结论要的是「真的找过了、确实没有」，不是「还没找」。 */
      if (!status && !ctx.status) {
        stat.innerHTML = S3("loadingState", "正在读令牌状态…", { hint: "读完这一行就知道有没有捕获到访问令牌、还能用多久。" });
        return;
      }
      if (!S.token) {
        /* 状态到了、但里面没有令牌这一段 ⇒ 读不到（**不是「还没捕获」**）。 */
        stat.innerHTML = S3("errorState", "读不到令牌状态", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
        });
        return;
      }
      if (S.edition) parts.push(`<span>版别：<b>${esc(S.edition)}</b></span>`);
      if (S.authDomain) parts.push(`<span>登录域名：<b>${esc(S.authDomain)}</b></span>`);
      if (!t.configured) {
        /* 空态要说清「怎么才会出现」：用户得知道先点哪个按钮。
           ⚠ 空态**不是出错** —— 没捕获到令牌只是一件事还没发生。 */
        parts.unshift(S3("emptyState", "还没有捕获到访问令牌", {
          hint: "点上面的「一键获取令牌」，或者在客户端里发一条消息 —— 路由台会在它带鉴权的请求上顺手把令牌接住。",
        }));
        parts.push('<span>访问令牌：<b class="warn">未捕获</b></span>');
        parts.push('<span>本机需已安装并登录对应客户端</span>');
      } else {
        parts.push('<span>访问令牌：<b>已捕获</b></span>');
        if (t.expAt) parts.push(`<span>有效期至：<b>${esc(new Date(t.expAt).toLocaleDateString("zh-CN"))}</b>（剩 ${t.expiresInDays} 天）</span>`);
        parts.push(`<span>刷新令牌：<b>${t.hasRefresh ? "有（自动续期）" : "无"}</b></span>`);
      }
      stat.innerHTML = parts.join("");
      /* 按钮是渲染层画的，本卡只改它的文案（存在即改，不重建元素）。 */
      const btn = sc.row.querySelector('[data-act="capture"]');
      if (btn) btn.textContent = t.configured ? "重新获取令牌" : "一键获取令牌";
    }

    /* ---------------- 流程所有权 ----------------
     按钮由渲染层按 credential.kind 画出；**本卡注册接管**，共享层就不会自己跑一遍
     （否则一次点击会发两次 /api/wb/capture）。注册不了的那一行由共享层兜底。 */
    for (const sc of scoped) {
      if (typeof ctx.registerCapture !== "function") break;
      ctx.registerCapture(sc.key, async (btn) => {
        if (btn.disabled) return;                 // 防连点
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = "获取中…";
        /* 一次捕获的运行态。prevStartedAt 是发起**之前**后端已有的那一轮的开始时刻：
           轮询回来时靠它把「本次的结果」和「上一次留下的结果」分开。 */
        const restartBox = sc.$('[data-role="auto-restart"]');
        const run = { prevStartedAt: null, reported: false, settled: false, btn, old,
          restartBox, autoRestart: !!(restartBox && restartBox.checked) };
        if (restartBox) restartBox.disabled = true;
        showProgress(sc, true, run);
        try {
          /* 先问后端这次要等多久：POST 会一直阻塞到捕获结束，拿面板 api() 的
             12 秒默认值去发，一次**成功**的捕获也会被掐成「读取超时」，而服务端
             还挂着钩子正常在等 —— 用户看到的就是「明明抓到了却报失败」。 */
          try {
            const s0 = await ctx.api("/api/wb/capture/status");
            run.prevStartedAt = (s0 && s0.startedAt != null) ? s0.startedAt : null;
            run.windowMs = Number(s0 && s0.timeoutMs) || 0;
          } catch { /* 问不到就按兜底窗口给；宁可等久，绝不误报失败 */ }
          /* provider 必带（契约 v18 里程碑 1b）：wb 与 wbai 是两条渠道、令牌不通用，
             后端据此决定写进 cfg.wb 还是 cfg.wbai。不带会默认落到 wb —— 那是**写错渠道**，
             症状是接上去以后一律 401，且极难自查。
             ctx.api 是 fetch 的薄封装（不自动序列化），故 body 要自己 JSON.stringify。 */
          const r = await ctx.api("/api/wb/capture", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: sc.key, autoRestart: run.autoRestart }),
            timeoutMs: capTimeoutMs(run.windowMs),
          });
          if (claimReport(run)) {
            if (r && r.ok) ctx.showResult(sc.$('[data-role="res"]'), okMsg(r.masked, r.hasRefresh), true);
            else ctx.showResult(sc.$('[data-role="res"]'), failMsg((r && r.error) || "未知原因"), false);
          }
        } catch (err) {
          if (!run.reported && err && err.timedOut) {
            /* 读超时**不等于失败**：捕获是在服务端后台进行的，这里放弃的只是这一次
               HTTP 读。所以先自己再问一次状态 —— 捕获窗口早就走完了，这一轮其实
               早就有结论了。问得到就据实报，问不到就交给还在跑的轮询。 */
            let s = null;
            try { s = await ctx.api("/api/wb/capture/status"); } catch { }
            if (s && s.done && s.startedAt != null && s.startedAt !== run.prevStartedAt) {
              finishFromPoll(sc, run, s);
            } else {
              run.keepPolling = true;
              ctx.showResult(sc.$('[data-role="res"]'),
                "⏳ 等待已超过显示上限，但**捕获仍在后台继续**（服务端还在等钩子）。\n"
                + "请到客户端里发一条消息触发；上方的进度会在捕获结束时给出结论。", true);
            }
          } else if (claimReport(run)) {
            ctx.showResult(sc.$('[data-role="res"]'), "✘ 获取失败：" + err.message, false);
          }
        } finally {
          /* keepPolling 时不收摊：进度面板与按钮都留给轮询，由它在捕获真正结束时
             报出结论并复原（finishFromPoll → settle）。 */
          if (!run.keepPolling) await settle(sc, run);
        }
      });
    }

    /* 「手动填写」仍然用委托：它没有进度面板，共享层的兜底实现够用，
       卡片只负责把四个输入框与保存按钮展开到行里。 */
    for (const sc of scoped) {
      sc.row.addEventListener("click", (e) => {
        const btn = e.target.closest('button[data-act="manual"]');
        if (btn) openManual(sc);
      });
    }

    for (const sc of scoped) paint(sc, ctx.status);

    return {
      update(status) { for (const sc of scoped) paint(sc, status); },
      refresh() { for (const sc of scoped) paint(sc, ctx.status); },
    };
  },
};
