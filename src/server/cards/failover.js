/* cards/failover.js —— B.AI 页的「自动故障转移」卡（v1.0.43 加的）。
 *
 * 整块从 ui.html 搬过来：markup、折叠交互、renderFailover、保存逻辑都逐字保留，
 * 只是把原来直接摸全局的地方换成 ctx。
 *
 * ctx = { cfg, status, $, api, showInfo, showResult, setLed, withBusy, PROVIDER, slot }
 * 下面用到两个契约里没列、但最好由 panel-common.js 提供的钩子（都做了存在性判断）：
 *   ctx.poll()          —— 保存后重新拉一次状态（原 ui.html 里的同名函数）
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["failover"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const api = ctx.api;
    const slot = ctx.slot || $("slot-extra") || (() => {
      const d = document.createElement("div");
      (document.querySelector(".wrap") || document.body).appendChild(d);
      return d;
    })();

    slot.insertAdjacentHTML("beforeend", `
      <!-- 自动故障转移：Claude Code 只接一次线，额度用光/渠道挂掉时中转自己换人 -->
      <div class="card foldable collapsed" id="cardFo">
        <div class="head" id="headFo">
          <span class="eyebrow">可选</span><span class="title">自动故障转移</span>
          <span class="aux" id="foAux">额度用光时自动换渠道</span>
        </div>
        <div class="body">
          <label class="checks" style="font-size:13px;display:block;margin-bottom:10px">
            <input type="checkbox" id="ckFailover"> 开启——当前渠道 429/5xx/超时/断线时，自动改用下面的顺序重试
          </label>
          <div class="fld">
            <label for="fFoChain">转移顺序（当前渠道永远排第一，手动选的就是首选）</label>
            <input type="text" id="fFoChain" placeholder="qd, bai, sn, zen, wb">
          </div>
          <div class="hint" style="margin-top:10px">
            <b>只换渠道，不换请求语义</b>：换过去时会按新渠道自己的路由表重新解析模型名
            （Qoder 的 <span class="mono">lite</span>、Zen 的 <span class="mono">space-bunny-free</span>
            互不相通）。没配凭据的渠道会自动跳过。失败渠道会冷却 90 秒，避免每条请求都白等一遍超时。
            <br><b>不做转移的情况</b>：HTTP 400（请求本身有问题，换谁都一样）与上游 200 里裹的
            <span class="mono">event: error</span>（多半是模型名不被支持）——这类会把真实错误原样告诉你，而不是被下一次尝试盖掉。
            <br><b>流式的边界</b>：只在首个响应头写出之前转移。一旦 SSE 的 message_start 已发出就不会再换——
            否则等于把半截内容接上另一家的开头。
          </div>
          <div id="foCool" class="hint" style="margin-top:10px;display:none"></div>
          <div class="saverow">
            <button class="btn-main" id="btnSaveFo" style="padding:8px 20px">保存</button>
            <span class="checks" style="font-size:12px">改完立即生效，无需重启服务</span>
          </div>
          <div class="result" id="foResult"></div>
        </div>
      </div>`);

    // 自动故障转移卡：折叠交互 + 读写
    {
      const hd = $("headFo"), cd = $("cardFo");
      if (hd) hd.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("input")) return;
        cd.classList.toggle("collapsed");
      });
    }

    function renderFailover(fo) {
      const f = fo || {};
      if ($("ckFailover")) $("ckFailover").checked = f.enabled === true;
      if ($("fFoChain")) $("fFoChain").value = (f.chain || []).join(", ");
      const cool = f.cooling || {};
      const box = $("foCool");
      if (box) {
        const ks = Object.keys(cool);
        if (!ks.length) { box.style.display = "none"; }
        else {
          box.style.display = "";
          const zh = { bai: "B.AI", sn: "SenseNova", wb: "WorkBuddy", zen: "OpenCode Zen", qd: "Qoder" };
          box.innerHTML = "<b>冷却中</b>（暂时不会被选中，约 " +
            Math.min.apply(null, ks.map((k) => cool[k].cooldownLeftSec)) + " 秒后恢复）：<br>" +
            ks.map((k) => "· " + (zh[k] || k) + " —— " + (cool[k].lastErr || "")).join("<br>");
        }
      }
      const aux = $("foAux");
      if (aux) aux.textContent = f.enabled === true ? "已开启 · " + ((f.chain || []).length) + " 个候选渠道" : "额度用光时自动换渠道";
    }

    $("btnSaveFo").addEventListener("click", () => ctx.withBusy($("btnSaveFo"), async () => {
      const chain = $("fFoChain").value.split(/[,、\s]+/).map((x) => x.trim())
        .filter((x) => ["bai", "sn", "wb", "zen", "qd"].includes(x));
      const r = await api("/api/config", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: ctx.PROVIDER, failover: { enabled: $("ckFailover").checked, chain } }),
      });
      ctx.showResult($("foResult"), "✔ 已保存：故障转移已" + ($("ckFailover").checked ? "开启" : "关闭") + "（立即生效）", true);
      if (typeof ctx.poll === "function") ctx.poll();
    }));

    return {
      // 轮询刷新：既收整份 status，也容许直接传 status.failover
      update(status) {
        renderFailover(status && Object.prototype.hasOwnProperty.call(status, "failover") ? status.failover : status);
      },
    };
  },
};
