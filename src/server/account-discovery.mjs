/**
 * account-discovery.mjs —— 「这一家配好了吗 / 有几个号可用」的**统一判据**
 *
 * ## 补的是哪个洞
 *
 * 现状：判据散在 `src/server/server.mjs` 的 `providerConfigured(provider, cfg)` 里，
 * 一家一句；而八家的凭据来源**根本不是一回事**：
 *   · bai / sn —— 配置里的一把 key；
 *   · or       —— 配置里的**一组**轮换 key（面板「凭据」页最多三把）；
 *   · wb/wbai  —— 本机的**令牌仓库**（wbPoolOf 的账号池，可以有多个号；
 *                 令牌从桌面端登录态抓来，冷却与判死按**账号 id** 记）；
 *   · qd       —— Qoder 桌面端 worker 补丁写的**令牌文件**（Qoder 每次启动就换一把）；
 *   · mm       —— MiniMax 会员的 **OAuth 登录态**（只存内存，**不落盘**）；
 *   · zen      —— **OpenCode 传输层**自带认证，或直连时用 Zen 的 API Key。
 * 于是「配好了吗」在每一家的实现里都长得不一样：面板说不清，
 * 转移链也说不清（providerConfigured 只给一个 provider 级的布尔值）。
 * 更要命的是它**看不出粒度**：wb 的账号池里有几个号、哪几个能用，它答不出来 ——
 * 而「这家有几家可用、分别是谁」正是账号级候选的前提。
 *
 * 本模块把这些口径**收成一处**，并把粒度从 provider 级降到**账号级**。
 *
 * ## 边界：`usable` 只管「凭据在不在」，不管「现在能不能用」
 *
 * 这里的 usable = **这个号有凭据、没被停用、没被忽略**。
 * 「冷却中 / 额度用尽 / 已判死」是**运行期状态**，住在 wb-pool 内核的冷却表里
 * （那是候选层与休息表的事，见 candidates.mjs 的两级休息）——
 * 账号发现这一层看不见它，也不该看见它：内核状态随进程重启而重算，
 * 而「这个号配了没有」是**配置事实**，重启后不变。
 * 两者混在一起的话，面板上就会出现「配置里有 4 个号、界面只显示 2 个」
 * 这种用户说不清的落差（wb-pool-wiring.mjs 的 wbPoolStatus 记的就是这个教训）。
 *
 * ## magpie 的对应物
 *
 * `internal/provider/account.go` —— magpie 的 Account 结构（Agent / User / Plan，
 * 外加各家自己的身份与续期钩子）与 `internal/provider/discovery.go`（账号发现开关）。
 * 休息键口径来自 `internal/gateway/fallback.go` 的 restKey() / who()。
 * magpie 的核心做法是**账号发现取代「靠钩子注入」**：本机装了哪个 agent、
 * 那个 agent 登录了谁，路由台自己读出来，而不是让用户往表单里贴凭据。
 *
 * ## 与 magpie **有意**不同的点（及原因）
 *
 * 1. **不读盘、不联网、不取时钟。** 凭据从哪来一律由 `opts` 注入。
 *    magpie 是 Go 单进程，直接读各 agent 的凭据库；我们是 Electron + Node，
 *    读盘那几处都带 IO（qoder-patch 要扫文件、mm-auth 会把令牌写回磁盘），
 *    混进来就没法离线测。注入之后**口径与 IO 分开**：口径在这里，IO 在 server.mjs。
 * 2. **provider 级的休息键保持 provider id**（"wb"、"or"…），账号级键放在
 *    accounts[].restKey（"wb@acct-a"、"or#<keyId>"、"mm@<recordKey>"）。
 *    magpie 的 provider 对象是**一个登录态一个对象**，所以它的 provider 级休息键
 *    天然带账号后缀；我们一个 provider 下挂多个账号，provider 级就必须还是
 *    provider 级 —— 否则 failover.mjs 现在那张 provider 级休息表
 *    （`failoverCooldownFor(provider, …)`）的键会全部对不上。
 * 3. **不返回任何凭据本身**，只给 id / label / 指纹：
 *    · `fp`（fpOf）沿用仓库既有的 keyFp 口径（首 7 + 尾 2 + 长度），给人看；
 *    · `id`（keyIdOf）用 magpie KeyID 同口径（sha256 前 5 字节），
 *      给机器看、进休息键用 —— 它不可逆，而 keyFp 是**可逆**的
 *      （仓库自己在 server.mjs 的 wbAccountFp 注释里写过这条告警）。
 * 4. **「登录了但令牌读不到」与「压根没登录」必须分开说**：
 *    mm 那边这两种是两种病，药也不同（重新登录 vs 先登录）。
 *    所以 filePresent 单独一路传进来，判据不许替它猜。
 *
 * ## 接线契约（server.mjs 侧怎么调）
 *
 *   discoverAccounts(cfg, {
 *     now: Date.now(),                              // 可选；只用来算令牌新鲜度
 *     wbPool: (p) => wbPoolOf(cfg, p),             // wb / wbai 的账号池
 *     qdToken: (cfg) => ({ ok, token, via, reason, at }),  // qd 的令牌
 *     mmStatus: () => mmTokens.recheck(),          // mm 的登录态
 *     zenTransport: (cfg) => zenTransportOf(cfg),  // 可选，默认同口径
 *   })
 *
 * 三个注入点缺一个，对应那一家就判成「没接上」（source "none"），
 * **绝不**假装配好了 —— 读不到凭据 ≠ 配好了。
 *
 * ## 纪律
 *
 * · 零时钟：不调 Date.now()，时间由 opts.now 传进来。
 * · 零 IO：不 import fs/net，也不 import server.mjs / wb-pool-wiring.mjs /
 *   mm-auth.mjs / qoder-patch.mjs / oc-wiring.mjs（那几个都带 IO，
 *   混进来这个模块就没法离线测了）。
 * · 只读：不改 cfg，也不改 opts 传进来的对象。
 */
import { createHash } from "node:crypto";

/* ====================================================================== *
 * 指纹：两个口径，不能混用
 * ====================================================================== */

/**
 * 给人看的指纹 —— 与 server.mjs 的 keyFp **逐字同口径**（首 7 + 尾 2 + 长度）。
 *
 * 为什么照抄它而不是自己发明：面板上「凭据」页、/api/status、账号池状态
 * 全都已经用这个口径，用户拿两处的字符串对着看才对得上；
 * 两套口径同时存在时，用户只会说「这两个数不一样，你到底哪个是对的」。
 *
 * ⚠ 它是**可逆**的（两段明文加长度足以把候选集缩到可枚举）——
 *   所以只能出现在给人看的字段里，**绝不**进休息键、进文件名、进日志。
 */
export function fpOf(k) {
  const s = String(k == null ? "" : k);
  if (!s) return "(空)";
  return s.length <= 12 ? "***" : s.slice(0, 7) + "…" + s.slice(-2) + "(" + s.length + ")";
}

/**
 * 给机器看的身份 —— magpie 的 KeyID 同口径：sha256 前 5 字节的十六进制（10 位）。
 *
 * 为什么不用 fpOf：fpOf 可逆，而休息键会进冷却表、进候选顺序；
 * 不可逆的那一份才配放进键里。
 * 为什么长度取 5 字节：与 magpie 一致 —— 同一个 key 在两边的 id 长得一样，
 * 将来对着看日志不用换算。
 *
 * ⚠ 令牌续期后指纹会变：这是**故意**的（仓库 wbAccountFp 的注释里也是这个取舍）——
 *   宁可这一号的冷却痕迹作废，也不能让新旧令牌共用一个身份键。
 */
export function keyIdOf(k) {
  const s = String(k == null ? "" : k);
  if (!s) return null;
  return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

/* ====================================================================== *
 * 八家的名字与顺序
 * ====================================================================== */

/** 与 server.mjs 的 relaySpec 同一份标签（面板上显示的就是它）。 */
const NAMES = Object.freeze({
  bai: "B.AI",
  sn: "SenseNova",
  wb: "WorkBuddy",
  wbai: "WorkBuddy AI",
  zen: "OpenCode Zen",
  qd: "Qoder",
  mm: "MiniMax 会员",
  or: "OpenRouter",
});

/** 八家。不含插件渠道：插件渠道的凭据形状是它自己声明的，判据不通用。 */
const CANONICAL = Object.freeze(["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"]);

/**
 * 输出顺序：先按用户配的转移链，再补上链外的。
 *
 * 为什么按链排：面板上这一块紧挨着「故障转移链」，两处顺序一致，
 * 用户顺着链往下看就知道「下一家是谁、它配好了没」。
 */
function providerOrder(cfg) {
  const chain = Array.isArray(cfg && cfg.failover && cfg.failover.chain)
    ? cfg.failover.chain : [];
  const out = [];
  for (const p of chain) {
    const k = String(p == null ? "" : p);
    if (CANONICAL.includes(k) && !out.includes(k)) out.push(k);
  }
  for (const k of CANONICAL) if (!out.includes(k)) out.push(k);
  return out;
}

/** 一条 provider 记录的骨架。 */
function entry(key, extra) {
  return {
    key,
    name: NAMES[key] || key,
    configured: false,
    source: "none",
    detail: "",
    accounts: [],
    restKey: key,
    canRefresh: false,
    missing: null,
    ...(extra || {}),
  };
}

/* ====================================================================== *
 * 各家判据
 * ====================================================================== */

/**
 * 配置里的一把 key（bai / sn / zen 直连 / or 的一把）。
 *
 * 单凭 key 时 restKey 就是 provider id —— magpie 的规矩：
 * 「provider 只有一个 key 时整家就以 provider 的名义休息，多了一个才按 key 分开」。
 * 照抄这条，一家的冷却记录才不会在加第二个 key 之后突然失效。
 */
function keyAccount(provider, key, label) {
  return {
    id: keyIdOf(key),
    label,
    kind: "config-key",
    usable: true,
    fp: fpOf(key),
    restKey: provider,
    canRefresh: false,
  };
}

/** bai —— 顶层的 apiKey（不是 cfg.bai.apiKey；bai 的切片是顶层那一份）。 */
function discoverBai(cfg) {
  const key = String(cfg.apiKey || "");
  const ok = !!key;
  return entry("bai", {
    configured: ok,
    source: ok ? "config" : "none",
    detail: ok ? `配置里的 1 把 key（${fpOf(key)}）` : "配置里还没有 B.AI 的 key",
    accounts: ok ? [keyAccount("bai", key, "B.AI 的 key")] : [],
    missing: ok ? null : "在「B.AI」页填入 API Key",
  });
}

/** sn —— 自己的那一份 apiKey（与 bai 分开：两家的 key 互不通用）。 */
function discoverSn(cfg) {
  const key = String((cfg.sn && cfg.sn.apiKey) || "");
  const ok = !!key;
  return entry("sn", {
    configured: ok,
    source: ok ? "config" : "none",
    detail: ok ? `配置里的 1 把 key（${fpOf(key)}）` : "配置里还没有 SenseNova 的 key",
    accounts: ok ? [keyAccount("sn", key, "SenseNova 的 key")] : [],
    missing: ok ? null : "在「SenseNova」页填入 API Key",
  });
}

/**
 * wb / wbai —— 本机的令牌仓库（账号池）。
 *
 * ⚠ 与现有 providerConfigured 的**分歧**在这里（详见文件末的「已知分歧」）：
 *   providerConfigured 只看顶层的 accessToken，而**实际取令牌的路径**（wbPickAccount）
 *   走的是账号池。所以「配了池子但没填顶层 accessToken」在旧判据下是**未配置**，
 *   而令牌明明就在池子里 —— 用户配了号却发现这一家被转移链跳过，就是这么来的。
 *   这里按**池子的真实状态**判，不按旧判据抄。
 *
 * 池子本身由调用方注入（opts.wbPool → wbPoolOf）：
 * 这个模块不 import wb-pool-wiring.mjs（它带 IO，还会把运行期缓存搅进来）。
 */
function discoverPool(cfg, p, opts) {
  const name = NAMES[p];
  const slice = cfg && cfg[p] && typeof cfg[p] === "object" ? cfg[p] : null;
  if (!slice) {
    return entry(p, {
      detail: `还没有「${name}」这一格的配置`,
      missing: `在「${name}」页配置一次`,
    });
  }
  if (typeof opts.wbPool !== "function") {
    return entry(p, {
      detail: "接线层没有注入令牌仓库（opts.wbPool），这一格判不了",
      missing: "接线层未接入 opts.wbPool（这一格目前判不了）",
    });
  }
  let pool = null;
  try { pool = opts.wbPool(p, cfg); } catch { pool = null; }
  const raw = pool && Array.isArray(pool.accounts) ? pool.accounts : [];

  const accounts = raw.map((a) => {
    const id = String((a && a.id) != null ? a.id : "");
    const tok = String((a && a.accessToken) || "");
    const disabled = a && a.disabled === true;
    const ignored = a && a.ignored === true;
    const usable = !!tok && !disabled && !ignored;
    return {
      id,
      label: String((a && a.label) != null ? a.label : id),
      kind: "pool-account",
      usable,
      fp: fpOf(tok),
      restKey: `${p}@${id.toLowerCase()}`,
      canRefresh: !!(a && a.refreshToken),
    };
  });

  const usable = accounts.filter((a) => a.usable);
  const noToken = accounts.filter((a) => !a.fp || a.fp === "(空)").length;
  const off = accounts.filter((a) => !a.usable && (a.fp && a.fp !== "(空)")).length;

  let detail = `账号池 ${usable.length}/${accounts.length} 个号可用`;
  if (noToken) detail += `；${noToken} 个没填令牌`;
  if (off) detail += `；${off} 个已停用或已忽略`;
  if (!accounts.length) detail = "账号池是空的";

  return entry(p, {
    configured: usable.length > 0,
    source: usable.length > 0 ? "token-pool" : "none",
    detail,
    accounts,
    canRefresh: accounts.some((a) => a.canRefresh),
    missing: usable.length > 0 ? null
      : (accounts.length
        ? `在「${name}」页粘贴访问令牌（或到桌面端重新登录后重新抓取）`
        : `在「${name}」页配置访问令牌`),
  });
}

/**
 * zen —— 两条路，判据完全不同。
 *
 * transport=opencode 时**不读**这把 key：走 OpenCode 自己的认证，
 * 配置里没填 key 也算配好了（否则用户选了 zen 却被转移链把入口渠道自己跳过，
 * 报出来的是「所有渠道都失败了」—— server.mjs 那段注释记的就是这个坑）。
 */
function discoverZen(cfg, opts) {
  const transport = zenTransportOf(cfg, opts);
  if (transport === "opencode") {
    return entry("zen", {
      configured: true,
      source: "transport",
      detail: "走 OpenCode 传输层：凭据由 OpenCode 自己的登录态带，Zen 的 API Key 这条路用不上",
      accounts: [{
        id: "opencode",
        label: "OpenCode 传输层",
        kind: "transport",
        usable: true,
        fp: null,
        restKey: "zen",
        canRefresh: false,
      }],
    });
  }
  const key = String((cfg.zen && cfg.zen.apiKey) || "");
  const ok = !!key;
  return entry("zen", {
    configured: ok,
    source: ok ? "config" : "none",
    detail: ok ? `直连模式，配置里的 1 把 key（${fpOf(key)}）` : "直连模式，配置里还没有 Zen 的 key",
    accounts: ok ? [keyAccount("zen", key, "Zen 的 key")] : [],
    missing: ok ? null : "填入 OpenCode Zen 的 API Key，或把传输方式切成 OpenCode",
  });
}

/**
 * 读传输方式。默认与 oc-wiring.mjs 的 zenTransportOf **同口径**：
 * 认不出来的值一律回 "direct"（出厂值必须是 direct，而直连路径怎么失败
 * 是用户可配置的状态，不能被接线悄悄改成另一条没被验证过的路）。
 * 接线层可以注入自己的 zenTransportOf，避免两处将来走岔。
 */
function zenTransportOf(cfg, opts) {
  if (typeof opts.zenTransport === "function") {
    try { return String(opts.zenTransport(cfg) || "direct"); } catch { return "direct"; }
  }
  const raw = cfg && cfg.zen ? cfg.zen.transport : undefined;
  return raw === "opencode" ? "opencode" : "direct";
}

/**
 * qd —— 令牌文件（Qoder 桌面端 worker 补丁写的）。
 *
 * ⚠ 令牌**每次 Qoder 启动都会轮换**，所以它从不落 config；
 *   token 字段只是手动粘贴的兜底。
 * ⚠ 「补丁没装」与「Qoder 没开」是**两种**失败，提示必须不同
 *   （server.mjs v1.0.57 记的就是这个：新电脑上最常见的就是这两种）。
 *   所以注入的 reason 由调用方判，这里只负责把它翻成人话。
 */
const QD_REASONS = Object.freeze({
  "patch-missing": "本机的 Qoder worker 还没打补丁：点「一键装补丁」自动完成（无需装 Python）",
  "not-running": "补丁已装，请启动 Qoder 桌面端并保持运行（令牌会随 Qoder 启动写进令牌文件）",
  "no-file": "令牌文件不在：装好补丁并启动 Qoder 后它会写出来",
  "empty": "令牌文件是空的：请重启 Qoder 桌面端后再试",
  "read-error": "令牌文件读不出来（可能损坏或被占用）：删掉它并重启 Qoder",
});

function discoverQd(cfg, opts, now) {
  if (typeof opts.qdToken !== "function") {
    return entry("qd", {
      detail: "接线层没有注入令牌读取（opts.qdToken），这一格判不了",
      missing: "接线层未接入 opts.qdToken（这一格目前判不了）",
    });
  }
  let st = null;
  try { st = opts.qdToken(cfg); } catch { st = null; }
  if (!st || st.ok !== true) {
    const reason = String((st && st.reason) || "");
    return entry("qd", {
      detail: reason ? (QD_REASONS[reason] || reason) : "没读到 Qoder 令牌",
      missing: reason ? (QD_REASONS[reason] || reason) : "装好 Qoder 补丁并启动 Qoder 桌面端",
    });
  }
  const token = String(st.token || "");
  const manual = String((cfg.qd && cfg.qd.token) || "").trim();
  const via = st.via || (manual && manual === token ? "manual" : "file");
  const isManual = via === "manual";
  let detail = isManual
    ? "用的是手动填写的令牌（兜底路径，Qoder 每次启动换的那把不会更新它）"
    : "令牌来自 Qoder 写的令牌文件";
  const at = Number(st.at);
  if (Number.isFinite(at) && at > 0 && now != null) {
    const ageMin = Math.floor((now - at) / 60000);
    if (ageMin >= 5) detail += `；文件是 ${ageMin} 分钟前写的（Qoder 大概没在跑）`;
    else detail += `；${ageMin} 分钟前写的`;
  }
  return entry("qd", {
    configured: true,
    source: isManual ? "config" : "token-file",
    detail,
    accounts: [{
      id: "qd",
      label: isManual ? "手动填写的令牌" : "Qoder 令牌文件",
      kind: isManual ? "config-key" : "token-file",
      usable: true,
      fp: fpOf(token),
      restKey: "qd",
      canRefresh: false,
    }],
  });
}

/**
 * mm —— MiniMax 会员的 OAuth 登录态（只存内存，**不落盘**）。
 *
 * ⚠ 登录态有**三种**状态，判据不许混成一种：
 *   ① 有可用令牌         → 配好了（中转请求时会自己续期）；
 *   ② 登录态作废（invalid_grant）→ 不算配好，要用户回 MiniMax Code 重新登录；
 *   ③ 登录态文件在、但令牌读不出来 → 与 ④ 分开说，两者的药不同；
 *   ④ 压根没登录         → 说「请去登录」。
 *   ③ 与 ④ 用 filePresent 分开：注入方没给这个信息时只能说「未知」，
 *   不能替它猜 —— 猜错的话用户会去修错的地方（重装 vs 重新登录）。
 */
function discoverMm(cfg, opts) {
  if (typeof opts.mmStatus !== "function") {
    return entry("mm", {
      detail: "接线层没有注入登录态（opts.mmStatus），这一格判不了",
      missing: "接线层未接入 opts.mmStatus（这一格目前判不了）",
    });
  }
  let st = null;
  try { st = opts.mmStatus(); } catch { st = null; }
  if (!st || typeof st !== "object") {
    return entry("mm", {
      detail: "没读到 MiniMax 登录态",
      missing: "在 MiniMax Code 里登录一次",
    });
  }
  const invalid = st.invalid === true;
  const ok = st.configured === true && !invalid;
  const recordKey = st.recordKey ? String(st.recordKey) : "";
  const filePresent = st.filePresent === true ? true : st.filePresent === false ? false : null;

  const account = {
    id: recordKey || "local",
    label: recordKey ? `MiniMax 会员（账号键 ${recordKey}）` : "MiniMax 会员",
    kind: "oauth",
    usable: ok,
    fp: null,
    restKey: recordKey ? `mm@${recordKey.toLowerCase()}` : "mm",
    canRefresh: st.hasRefresh === true,
  };

  if (ok) {
    return entry("mm", {
      configured: true,
      source: "oauth",
      detail: "内存里有会员令牌，可用（到期会自己续期）",
      accounts: [account],
      canRefresh: account.canRefresh,
    });
  }
  if (invalid) {
    return entry("mm", {
      detail: "登录态已作废（上游 invalid_grant）：这一格不能再用",
      accounts: [{ ...account, usable: false, label: recordKey ? `MiniMax 会员（账号键 ${recordKey}，已作废）` : "MiniMax 会员（已作废）" }],
      missing: "在 MiniMax Code 里重新登录",
    });
  }
  if (filePresent === true) {
    const detail = recordKey
      ? "登录态文件在、账号记录也在，但令牌读不出来"
      : "登录态文件在，但里面没有账号记录";
    return entry("mm", {
      detail,
      accounts: [{ ...account, usable: false }],
      missing: "在 MiniMax Code 里重新登录（先试「重新读取登录态」）",
    });
  }
  if (filePresent === false) {
    return entry("mm", {
      detail: "本机没有 MiniMax Code 的登录态",
      missing: "在 MiniMax Code 里登录一次",
    });
  }
  return entry("mm", {
    detail: "内存里没有令牌（登录态在不在由接线层判定，它没给这个信息）",
    accounts: [{ ...account, usable: false }],
    missing: "在 MiniMax Code 里登录一次",
  });
}

/**
 * or —— 配置里的**一组**轮换 key。
 *
 * 一把 key 时整家以 "or" 的名义休息；两把以上时按 key 分开休息
 * （magpie 的 perKeyBarred：rest = p.ID + "#" + KeyID(key)）。
 * 照抄这条的理由：只有一把 key 时它就是这一家，分开记只是把同一件事记两遍；
 * 而真的加到第二把，两把必须能各自休息 —— 否则一把额度用尽会把另一把也拖下水。
 */
function discoverOr(cfg) {
  const raw = (cfg && cfg.or && cfg.or.keys) || [];
  const keys = (Array.isArray(raw) ? raw : [])
    .filter((k) => typeof k === "string" && k.trim());
  const multi = keys.length > 1;
  const accounts = keys.map((k, i) => ({
    id: keyIdOf(k),
    label: `第 ${i + 1} 把 key`,
    kind: "config-key",
    usable: true,
    fp: fpOf(k),
    restKey: multi ? `or#${keyIdOf(k)}` : "or",
    canRefresh: false,
  }));
  return entry("or", {
    configured: keys.length > 0,
    source: keys.length > 0 ? "config" : "none",
    detail: keys.length
      ? `配置里 ${keys.length} 把 key${multi ? "，轮换着用" : ""}`
      : "配置里还没有 OpenRouter 的 key",
    accounts,
    missing: keys.length > 0 ? null : "在「OpenRouter」页加至少一把 key",
  });
}

/* ====================================================================== *
 * 对外
 * ====================================================================== */

/**
 * 找出这台机器上八家各自有哪些凭据、哪些能用。
 *
 * @param {object} cfg 完整配置（server.mjs 的 loadCfg 产物）
 * @param {object} [opts]
 * @param {number} [opts.now] 当前时刻（epoch ms）；只用来算令牌新鲜度
 * @param {Function} [opts.wbPool] (p, cfg) => 账号池；wb / wbai 用
 * @param {Function} [opts.qdToken] (cfg) => {ok,token,via,reason,at}；qd 用
 * @param {Function} [opts.mmStatus] () => 登录态快照；mm 用
 * @param {Function} [opts.zenTransport] (cfg) => "direct"|"opencode"；zen 用
 * @returns {{providers: object[]}}
 */
export function discoverAccounts(cfg, opts = {}) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const o = opts && typeof opts === "object" ? opts : {};
  const now = Number.isFinite(Number(o.now)) ? Number(o.now) : null;
  const providers = providerOrder(c).map((p) => {
    switch (p) {
      case "bai": return discoverBai(c);
      case "sn": return discoverSn(c);
      case "wb": return discoverPool(c, p, o);
      case "wbai": return discoverPool(c, p, o);
      case "zen": return discoverZen(c, o);
      case "qd": return discoverQd(c, o, now);
      case "mm": return discoverMm(c, o);
      case "or": return discoverOr(c);
      default: return entry(p, { detail: "未知渠道", missing: "—" });
    }
  });
  return { providers };
}

/* ====================================================================== *
 * 已知分歧（接线前必须先看一眼这里）
 * ====================================================================== *
 *
 * ① wb / wbai：providerConfigured 只看**顶层** accessToken，
 *    而实际取令牌的路径（wbPickAccount）走的是**账号池**。于是有两种配置会被旧判据说错：
 *      · 配了 accounts[] 池子但没填顶层 accessToken → 旧判据说「未配置」，
 *        转移链直接跳过这一格，而令牌明明就在池子里（**用户配了号却用不上**）；
 *      · 填了顶层 accessToken、同时 accounts[] 里一个号都没填令牌
 *        → 旧判据说「已配置」，转移链会去撞，池子里却根本没有令牌。
 *    本模块按**池子的真实状态**判（usable 的号有没有），两处都与实际取令牌的路径一致。
 *    ⚠ 接线层换过去之后，这两种配置的转移链行为会变 —— 是修正，不是回归。
 *
 * ② zen：providerConfigured 把 transport=opencode 算作「已配置」，
 *    本模块同样算已配置，但 source 标成 "transport"、accounts 里给的是传输层
 *    而不是一把 key —— 面板上「配上的是哪一把」这句话对这一家不成立。
 *
 * ③ qd / mm：providerConfigured 只给布尔值，分不出「补丁没装 / Qoder 没开 /
 *    令牌文件是空的」和「登录态作废 / 登录态在但令牌读不出来 / 压根没登录」。
 *    本模块把这些拆开（missing 一栏），因为它们的**处置动作不同**。
 *
 * ④ 别的七家逐项一致：bai/sn 看配置里的 key；or 看轮换区有没有 key；
 *    zen 直连看 Zen 的 key。
 *
 * ⑤ or 的 keys 字段**类型不对**时（配置被手改成字符串之类）：server.mjs 的
 *    orKeys 会在 .filter 上抛 TypeError，本模块判成「没有 key」。
 *    方向是**更安全**的一边（配置坏了不该把整个面板带崩），但严格说这是一处
 *    不一致 —— 实际不会走到：loadCfg 合并配置时已经把 or.keys 归一成数组。
 */
