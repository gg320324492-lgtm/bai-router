// 随包默认快照（config.defaults.json）的同步：**纯函数**，可被测试直接求值。
//
// 为什么要抽出来：这段逻辑里有**按渠道名写死的名单**，而加一家渠道时最容易漏改一处
// —— 后果是**静默**的（见下面 SEED_CHANNELS 的注释）。仓库里已有的两个同族模块
// （publish-proxy.cjs / publish-source.cjs）都是这个思路：把会出错的判断抽成纯函数，
// 由测试直接求值，而不是让它埋在发布脚本的副作用里、只能靠"发一版看看"来验。
//
// 🔴 本模块**不碰文件、不联网、不读环境变量**：只接收两个对象、返回一个新对象。
//    真实令牌一个都不进来（也不出去）。
"use strict";

/* ---------- 渠道名单：全仓库**只许写这一处** ----------
 *
 * 🔴 这里的名字与另外两处「按渠道名循环」的名单是同一份东西，写成三份就一定会漂。
 *    v1.0.65 加第 7 家（wbai）时，发布脚本里的故障转移链白名单漏了 wbai，
 *    随包快照里的链被**静默剔掉国际版**——没有任何报错（当时闸门全绿、发布成功）。
 *    v1.0.89 加第 8 家（mm）时同一处又漏了 mm。
 *
 *    后果是「用户机器上的链和仓库里的链不是一条」——面板显示的转移顺序是假的。
 *
 *    所以：名单只写这一处，测试（scripts/publish-seed-test.mjs）会拿
 *    config.defaults.json 的 failover.chain 逐条比对——**加了第 9 家忘了改这里，当场红**。
 *
 *  bai 不在「子渠道」名单里：它的字段（upstream / relayPort / defaultModel /
 *  availableModels / mapping）是**顶层**字段，不是嵌套块。
 */
const SEED_CHANNELS = ["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"];
/** 嵌套成块的渠道（bai 除外）。下面两处「按渠道循环」用它。 */
const SEED_SUB_CHANNELS = SEED_CHANNELS.filter((k) => k !== "bai");

/**
 * 按 ref 的键顺序重建 obj（只含 obj 里真有的键；ref 没有的追加在后面）。
 *
 * @param {object} ref
 * @param {object} obj
 * @returns {object}
 */
function reorderLike(ref, obj) {
  if (!ref || typeof ref !== "object") return obj;
  const out = {};
  for (const k of Object.keys(ref)) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

/** WorkBuddy 两版：本机登录态的四个字段，一律清空（v1.0.65 血的教训）。 */
const WBD = { accessToken: "", refreshToken: "", deviceToken: "", userId: "" };

/**
 * 把「发布机当前配置」同步成「随包默认快照」。
 *
 * @param {object} local 发布机的 config.json（**含真实凭据**——本函数不把它原样吐出去）
 * @param {object} CUR   仓库里已提交的 config.defaults.json（**权威**）
 * @returns {{seed: object, notes: string[]}} seed 是要写回仓库的那份
 */
function syncSeed(local, CUR) {
  const notes = [];
  const def = { ...local, apiKey: "" };
  delete def._modelsSynced;
  /* ⚠⚠ **用户的「更新通道」不进出厂默认**（2026-10-25 修）。
   *
   *   上面那句 `def = { ...local }` 是**整份**本地配置 ⇒ 发布机上多出来的任何字段
   *   都会原样进随包快照。而 `updateChannel` 是**每个用户自己的选择**
   *   （托盘菜单里切的）⇒ 把它烘进出厂默认 = **所有新用户默认都是测试版用户**
   *   ⇒ 稳定版用户会收到 beta ⇒ 「选择性升级」就没了。
   *
   *   这不是假想：2026-10-25 发布 v1.0.106 时，发布机因为装的是 beta 版而把
   *   `updateChannel: "beta"` 抄进了 config.defaults.json ⇒ 被发布闸门拦下
   *   （工作区变脏）⇒ 拦对了，但闸门只是兜底，**根因在这里**。
   *
   *   规矩：**凡是「每个用户自己选」的字段，一律不进出厂默认**
   *   （与凭据同一类：它描述的是「这台机器上的用户」，不是「产品默认」）。 */
  delete def.updateChannel;

  /* ---------- 凭据：一条都不许进快照 ---------- */
  // sn（SenseNova）块：发布机 config 可能还没有（旧版未写入）或残留密钥——一律以代码默认+脱敏为准
  if (def.sn) { def.sn = { ...def.sn, apiKey: "" }; }
  else if (CUR.sn) { def.sn = { ...CUR.sn, apiKey: "" }; }
  // wb / wbai（WorkBuddy 两版）块：JWT 令牌绝不进发布机快照；发布机没配过就沿用代码默认（同样脱敏）
  // 两版凭据彼此独立，必须各清各的 —— 漏掉 wbai 就等于把国际版的 1411 字符 JWT 随安装包发给所有机器。
  // userId 一起清：它是指名账号的标识（请求里当 x-user-id 头带），本身不能鉴权，
  // 但它是本机登录态的一部分，与令牌同源。运行期 wbEnsureToken() 会从用户自己的
  // 登录态回填，出厂默认留空才是对的。v1.0.65 实测产物里两版都带着真实 UUID 发出去过。
  if (def.wb) { def.wb = { ...def.wb, ...WBD }; }
  else if (CUR.wb) { def.wb = { ...CUR.wb, ...WBD }; }
  if (def.wbai) { def.wbai = { ...def.wbai, ...WBD }; }
  else if (CUR.wbai) { def.wbai = { ...CUR.wbai, ...WBD }; }
  // zen（OpenCode Zen）块：API Key 同样绝不进快照
  if (def.zen) { def.zen = { ...def.zen, apiKey: "" }; }
  else if (CUR.zen) { def.zen = { ...CUR.zen, apiKey: "" }; }
  // or（OpenRouter）块：三把 API Key 绝不进发布机快照——快照随安装包发给所有机器，
  // key 进去等于公开泄露（v1.0.58 加第 6 家时补上；本机没配过时从仓库 defaults 继承结构、keys 仍清空）。
  if (def.or) { def.or = { ...def.or, keys: [] }; }
  else if (CUR.or) { def.or = { ...CUR.or, keys: [] }; }

  /* ---------- mm（MiniMax 会员）：整块取仓库的 ----------
   *
   * 这一格**没有凭据字段**（令牌只存内存，见 src/server/mm-auth.mjs），
   * 所以不需要清任何东西——但**必须**把块带上：
   *
   * 🔴 发布机跑的是**上一版**（v1.0.88 写的 config.json 里根本没有 mm 块），
   *   而 `def = {...local}` 不会凭空长出 mm → 不补这一句，mm 会被
   *   **整个从随包快照里抹掉**，用户机器上这一格直接消失。
   *   与 wbai 那次同源：靠"发一版看看"发现太晚，所以现在有测试钉住。
   *
   * ⚠ 这一句与下面「顶层合并补齐 CUR 的键」**互为双保险**：单独拿掉任何一道，
   *   mm 仍然在快照里（测试实测过）。真正会致坏的是两道都没有——那正是原代码的样子。
   *   改这两处时**别只删一道就以为另一道还在**：另一道也要跟着确认。
   */
  if (CUR.mm) def.mm = { ...CUR.mm };

  /* ---------- 「本机状态」字段：仓库里的值才是出厂默认 ----------
   *
   * 发布机那份只是这台机器当前的样子。快照是随包发给所有机器的，
   * 把本机状态烘进去等于让发布者替所有用户做决定。
   *
   * · failover  「这台机器勾没勾故障转移」是用户偏好。旧实现 `def.failover || 仓库`
   *              让发布机的设置只要存在就赢——发布机关着开关，每次发布都把随包快照的
   *              enabled 改成 false，发给所有新用户。
   * · proxy     出厂默认就该是空（= 直连）。历史上存的是本机端口（v1.0.1 起 7890、
   *              v1.0.19 改 7897），等于把一个只在你机器上成立的地址发给所有人。
   *              启动自检会纠正它，所以一直没暴露——但那只是掩盖，不是没问题。
   * · wb.upstream  发布机那条是 loadCfg 的 wbHealUpstream 按登录域名**自愈**的结果
   *              （v1.0.59 起 .ai/.cn 之间切换），把自愈结果当出厂默认，等于替所有
   *              新用户选了版别。自愈本身在运行期还会再跑一次。
   * · zen.transport 「这台机器走直连还是走 OpenCode 客户端中转」是本机选择。
   *              v1.0.75 加这一档时漏在这里：发布机那份 config.json 里不带该字段，
   *              随包快照里也就没有它——出厂默认「靠缺失兜底成 direct」虽然行为正确，
   *              但**更糟的情况是发布者自己切到了 opencode 再发版**，
   *              快照就会把 opencode 当出厂默认发给所有新用户。
   *              与 proxy 完全同类，故按规矩写进这一段。
   *
   * 四者共同点：运行期 server.mjs 都会按各自机器修正它们，所以留在出厂默认里没有
   * 任何好处，只有"看起来配置齐全"的错觉。新增同类字段请写进这一段，别再散着写。
   *
   * ⚠ 自检：发布后请看 `git status`。这段改写的是**仓库里的** config.defaults.json，
   * 若它变脏了，说明上面某个「本机状态」字段漏在了这一段之外——那就是要修的地方。
   */
  if (CUR.failover) {
    const fo = { ...CUR.failover };
    /* 允许清单要跟着 providers.js 走。漏一个渠道的后果是静默的：仓库 defaults 里
       明明写了 wbai（v1.0.65 加的第 7 家）、mm（v1.0.89 加的第 8 家），
       这里会被当"未知渠道"剔掉，随包快照的故障转移链就少了它，且没有任何报错。 */
    const chain = (fo.chain || []).filter((x) => SEED_CHANNELS.includes(x));
    /* 收敛后为空就原样保留仓库里写的 chain：这段只做"剔除未知渠道 / 兜底垫末尾"，
       不该把一份完整的出厂默认改写成空链。 */
    if (chain.length) {
      if (!chain.includes("or")) chain.push("or");
      fo.chain = chain;
    }
    def.failover = fo;
  } else {
    delete def.failover;   // 仓库里没写这个块，就别把发布机的带进随包快照
  }
  def.proxy = CUR.proxy == null ? "" : CUR.proxy;
  /* zen.transport 同样只认仓库的（本机选择不进出厂默认，见上面那段说明）。
   *
   * 键顺序也要跟仓库一致：上面那句赋值是**追加**，会把 transport 挪到 zen 对象的末尾，
   * 于是每次发布 config.defaults.json 都变脏——而「发布后看 git status」正是我刚
   * 加的自检，顺序一变它就永远报警，等于废掉。 */
  if (def.zen) {
    def.zen.transport = (CUR.zen && CUR.zen.transport) || "direct";
    def.zen = reorderLike(CUR.zen, def.zen);
  }
  if (def.wb && CUR.wb && CUR.wb.upstream) def.wb.upstream = CUR.wb.upstream;

  /* availableModels 也取仓库的，不取发布机的。
   *
   * 理由与上面 failover/proxy 同一类，而且后果更直接：清单（providers.js）的 models
   * 才是映射下拉真正渲染的那一份，C8 闸门要求两者**逐条完全相等**。把发布机
   * 扫出来的目录烘进随包快照，就等于让这台机器的目录覆盖掉清单——两者一旦不同，
   * 闸门直接拦下发布（v1.0.65 实测：发布机的 wb 目录已长到 33 个、wbai 23 个，
   * 而清单里各只有 3 个，闸门报「在 seed config 里多出 30 个」）。
   *
   * 以前没暴露，是因为发布机的目录一直和清单一样短。用户扫了一次目录就漂了。
   * 随包默认应该反映项目认定的模型集合；要更新就改仓库里那份，两边一起改。 */
  if (Array.isArray(CUR.availableModels)) def.availableModels = CUR.availableModels;
  /* 顶层 mapping 是 **bai 那一格**的档位映射（bai 的字段在顶层，不在嵌套块里）。
   * ⚠ v1.0.89 修：它原先**没有**跟着 defaultModel / availableModels 一起「取自仓库」，
   *   于是发布机上被改过的 bai 映射会**原样烘进随包快照**发给所有用户——
   *   与旁边两行「同样以仓库为准」的做法自相矛盾。
   *   顶层三个字段（availableModels / defaultModel / mapping）现在是一套。 */
  if (CUR.mapping && typeof CUR.mapping === "object") def.mapping = CUR.mapping;
  for (const k of SEED_SUB_CHANNELS) {
    if (def[k] && Array.isArray(CUR[k] && CUR[k].availableModels)) {
      def[k] = { ...def[k], availableModels: CUR[k].availableModels };
    }
  }
  /* 档位映射（tier → 目标模型 / 显示名）与默认模型，同样以仓库为准。
   *
   * 与 availableModels 同一类理由：它是**这台机器的用户偏好**，不是出厂默认。
   * 随包快照发给的是每一个新装用户，把发布者挑的模型烘进去，等于替所有用户做了
   * 这个选择。实测：v1.0.68 发布时本机的 `or` 档位是 nvidia/nemotron-3.5-lightning:free，
   * 仓库里写的是 openrouter/free——发布脚本把前者写回了随包默认。
   * （C8 闸门放行了它：那个模型确实在仓库的 or.availableModels 里，所以不算错，
   *   但「不算错」和「该由谁决定」是两件事。）
   *
   * 要改出厂默认就改仓库里这份，两边一起改——和 availableModels 同一套做法。 */
  for (const k of SEED_SUB_CHANNELS) {
    if (!def[k]) continue;
    const cur = CUR[k] || {};
    if (cur.mapping && typeof cur.mapping === "object") def[k].mapping = cur.mapping;
    if (typeof cur.defaultModel === "string" && cur.defaultModel) def[k].defaultModel = cur.defaultModel;
  }
  if (typeof CUR.defaultModel === "string" && CUR.defaultModel) def.defaultModel = CUR.defaultModel;

  // qd（Qoder）块：token 是手动兜底用的 jt- jobToken，绝不进快照
  // （正常路径下它恒为空——真实令牌由 worker 补丁写在 %TEMP%\qoder-token.json，不落 config）
  // tokenFile/modelsFile 是发布机的 %TEMP% 绝对路径，原样进快照会被 C13 闸门拦下；
  // 清空即可——运行期 fixQdFile() 会把空值/异机路径自愈回本机 os.tmpdir()。
  if (def.qd) { def.qd = { ...def.qd, token: "", tokenFile: "", modelsFile: "" }; }
  else if (CUR.qd) { def.qd = { ...CUR.qd, token: "", tokenFile: "", modelsFile: "" }; }

  /* ---------- 顶层键顺序：必须与仓库那份一致 ----------
   *
   * mm 要落在 wbai 与 or **之间**（清单顺序 = 转移优先级顺序，C8 闸门在查这件事）。
   * 而 `def = {...local}` 的键顺序来自发布机那份 config.json——**上一版写的那份
   * 根本没有 mm 键** → 直接写出去的话 mm 会被排到末尾 → 键顺序与仓库不一致 →
   * 「发布后看 git status」永远报警（等于废掉这条自检）。
   *
   * ⚠ 这里不能直接用 reorderLike：那个函数只搬动**两边都有**的键，
   *   顶层若缺一个键就会**被丢掉**。所以先 `{...CUR, ...def}` 把 CUR 的键补齐
   *   （def 的值优先），再排序——这样既不丢键，顺序又与仓库一致。
   */
  const seed = reorderLike(CUR, { ...CUR, ...def });

  notes.push(`本机状态字段取自仓库 defaults: proxy=${seed.proxy || "(空=直连)"}`
    + ` failover.enabled=${seed.failover ? seed.failover.enabled : "(无)"}`
    + ` wb.upstream=${(seed.wb && seed.wb.upstream) || "(无)"}`);
  notes.push(`默认快照已同步发布机: ${(seed.availableModels || []).length} 个模型`
    + `${seed.sn ? " + SenseNova " + seed.sn.availableModels.length + " 个" : ""}`);

  return { seed, notes };
}

module.exports = { syncSeed, reorderLike, SEED_CHANNELS, SEED_SUB_CHANNELS };
