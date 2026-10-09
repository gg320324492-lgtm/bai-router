/* providers.js —— 五个提供方页面的「清单」（纯数据，无逻辑）。
 *
 * 由 provider.html 先加载，panel-common.js 再按 key 取用。
 * 文案全部从重构前的 ui.html / sn.html / wb.html / zen.html / qd.html 逐字搬过来，
 * 不要顺手改措辞：本轮刚修过一批复制粘贴留下的错配。
 *
 * 约定：
 *  - null = 该页没有这块内容，渲染层请判空后再写进 DOM（不要直接 innerHTML = null）。
 *  - {btn} 会被替换成 primaryBtn（主按钮的完整文字）。
 *  - 下面标注「契约外补充」的字段，是契约 schema 里没有、但文案无法由其它字段推导出来的，
 *    不写就会丢字；panel-common.js 需要读它们。
 *
 * v1.0.48 起，此前散落在 panel-common.js 的 FB 兜底表与形状开关也搬进来了。判据是
 * 「panel-common.js 里不再出现任何提供方名字」，所以本清单必须为每家提供：
 *  - brands / defaultModels / labelSuffix / noCallHint / testNote / modelsRefreshMsg /
 *    applyInfoMsg / resetModelsMsg / step1Hint / eventTitles / cred / sys：原先的 FB 字段
 *  - shape："flat"（本家数据在 /api/config 与 /api/status 顶层，只有 bai）或 "nested"
 *    （在同名子对象里）。config 与 status 的形状在本项目里总是相同，故合并成一个字段。
 *  - keyMatch：/api/status 里本页该比对的凭据字段（server.mjs 的 keyMatch/keyMatchSn/…）。
 *  - modelsEndpoint：拉模型目录的路由；null = 按默认 "?p=<key>" 拼接。
 *  - settingsLabels：设置卡里可被覆盖的标签（relayPort 必须有，否则回退到通用拼接）。
 *  - sys.*：按钮/字段显隐开关（deploy / modelsRefresh / useProxyRow / proxy / panelPort /
 *    proxyDetect / tokenView / apiKey）。
 */
window.BAI_PROVIDERS = {

  /* ================= B.AI（/） ================= */
  bai: {
    key: "bai",
    path: "/",
    tab: "B.AI",
    h1: "B.AI 路由台",
    sub: "MODEL ROUTER",
    title: "B.AI 路由台",
    accentLabel: "接通",
    primaryBtn: "接通 B.AI",                  // 契约外补充：主按钮完整文字
    targetName: "B.AI 模型",                  // 路由表第二列表头
    relayHint: null,                          // 本页接线卡没有那句带端口的提示
    guide: [],                                // 本页没有两步引导卡
    hint: null,                               // 路由表下方没有说明
    settingsTitle: "本机设置",
    settingsAux: "换电脑 / 换代理时改这里",
    settingsEyebrow: "03",                    // 契约外补充
    foldKey: "bai.sec3",                      // 契约外补充：折叠状态记忆
    lamps: ["clash", "relay", "upstream", "cc"],
    lampNames: {                              // 契约外补充：四盏灯的名字（逐字）
      clash: "Clash 代理",
      relay: "本地中转",
      upstream: "B.AI 上游",
      cc: "CC Switch",
    },
    lampSubs: {                               // 契约外补充：副行初始文字
      clash: ":7890 → 外网",
      relay: ":15722 → 上游",
    },
    extraCards: ["failover", "model-sync"],
    footNote: "数据保存在 %APPDATA%\\bai-router · 切换前自动快照到 backups/",
    footNoteAlt: null,                        // 本页没有浏览器直开时的分支
    cardEyebrow: "01",                        // 契约外补充：「当前接线」卡的编号
    routeEyebrow: "02",                       // 契约外补充：「路由表」卡的编号
    routeTitle: "路由表 · 模型映射",
    routeKey: { label: "API Key", placeholder: "" },   // 契约外补充：路由表里的密钥行
    wireHint: null,                           // 契约外补充：本页接线卡没有说明句

    /* ---- v1.0.48 清单化：原先散在 panel-common.js 的 FB 兜底表与形状开关 ---- */
    brands: { qwen: "Qwen", glm: "GLM", deepseek: "DeepSeek", hy: "HY", mimo: "MiMo", kimi: "Kimi", minimax: "MiniMax" },
    defaultModels: [],                        // 本页没有「恢复默认模型」按钮（无固定清单）
    labelSuffix: " 1M",
    noCallHint: "尚未观察到 Claude Code 调用",
    testNote: {
      single: "（测试的就是你 Claude Code 里显示的那个模型，名字完全一致）",
      all: "（最近 30 分钟没观察到真实对话流量，已测全部四档；在 Claude Code 发条消息后再点，会自动对准当前档位）",
    },
    modelsRefreshMsg: "✔ 已拉取上游模型目录 {count} 个\n已更新可选模型列表（四个映射目标强制保留）",
    eventTitles: { check: "检查更新 / 部署" },
    keyMatch: "keyMatch",                     // status 里本页该比对的凭据字段
    shape: "flat",                            // /api/config 与 /api/status 里本家数据在顶层
    sys: { proxy: true, panelPort: true, proxyDetect: true, useProxyRow: false, deploy: true, modelsRefresh: true },
    modelsEndpoint: "/api/models",            // 本页拉模型目录的路由不带 ?p=
    settingsLabels: { relayPort: "中转端口" },   // 本页不加提供方前缀（旧三元表达式 key === "bai" ? "" : …）
        notices: {
      // 通用兜底：另一端接在本路由台的任一渠道上。措辞与其余四页一致。
      stale: "当前有一端接在本路由台的其他渠道上——点「{btn}」会把它换过来（切换前自动快照，可一键接回）。",
      // 以下按「另一端具体接在哪家」分列——panel-common.js 取值是 NT[other.mode]，
      // 缺哪个 mode 就会落到通用 stale 上，于是显示成别的家名字。
      sn: "有一端当前接在 SenseNova 上（见顶部「SenseNova」页）。点本页「{btn}」可把它换回来；两方映射互相独立，切换只动接线不动对方配置。",
      wb: "有一端当前接在 WorkBuddy 上（见顶部「WorkBuddy」页）。点本页「{btn}」可把它换回来；各提供方映射互相独立，切换只动接线不动对方配置。",
      zen: "有一端当前接在 OpenCode Zen 上（见顶部「OpenCode Zen」页）。点本页「{btn}」可把它换回来；各提供方映射互相独立，切换只动接线不动对方配置。",
      qd: "有一端当前接在 Qoder 上（见顶部「Qoder」页）。点本页「{btn}」可把它换回来；各提供方映射互相独立，切换只动接线不动对方配置。",
      or: "有一端当前接在 OpenRouter 上（见顶部「OpenRouter」页）。点本页「{btn}」可把它换回来；各提供方映射互相独立，切换只动接线不动对方配置。",
      ccSwitch: "CC Switch 正在运行——它可能随时把配置改回 15721。若 B.AI 突然失效，回到这里点「{btn}」一键恢复即可。",
      keyMismatch: "⚠ 有客户端正在用的密钥和面板里填的不一致——中转是按请求自带 key 计费的，面板改了 key 不会自动更新已接线的客户端。请重开对应终端/桌面版，或重新点「{btn}」。",
      ccBoth: "检测到配置在 CC Switch 手里。点「{btn}」切换；想用 CC Switch 就保持现状。",
    },
    // 别从灯名反推简称：「本地中转」会反推成「本地」、「Zen 中转」会丢掉「OpenCode」。
    shortName: "B.AI",
  },

  /* ================= SenseNova（/sn） ================= */
  sn: {
    key: "sn",
    path: "/sn",
    tab: "SenseNova",
    h1: "SenseNova 路由",
    sub: "商汤 · 日日新",
    title: "SenseNova 路由 · B.AI 路由台",
    accentLabel: "接通",
    primaryBtn: "接通 SenseNova",
    targetName: "SenseNova 模型",
    relayHint: ":15732",
    guide: [],
    hint: null,
    settingsTitle: "SenseNova 设置",
    settingsAux: "上游 / 中转端口 / 通道",
    settingsEyebrow: "03",
    foldKey: "bai.snsec3",
    lamps: ["relay", "upstream", "cc"],       // 3 盏，没有凭据灯
    lampNames: {
      relay: "SenseNova 中转",
      upstream: "SenseNova 上游",
      cc: "CC Switch",
    },
    lampSubs: { relay: ":15732 → 上游" },
    extraCards: ["model-sync"],
    footNote: "SenseNova 与 B.AI 各自独立配置，共用同一个路由台服务",
    footNoteAlt: "数据保存在 %APPDATA%\\bai-router · 与 B.AI 页共用配置存储",
    cardEyebrow: "01",
    routeEyebrow: "02",
    routeTitle: "路由表 · 模型映射",
    routeKey: { label: "API Key", placeholder: "sk-…（SenseNova token-plan 密钥）" },
    wireHint: "SenseNova 是境内服务，CLI 直连、不需要 Clash；桌面版经由本地中转 <span id=\"hintRelayPort\">:15732</span>。切到 SenseNova 会顶掉当前 B.AI 接线，随时可「接回 CC Switch」或用 B.AI 页重新接通。",

    /* ---- v1.0.48 清单化 ---- */
    brands: { sensenova: "SenseNova", deepseek: "DeepSeek", glm: "GLM", kimi: "Kimi", neo: "Neo", u: "U" },
    defaultModels: [],                        // 本页没有「恢复默认模型」按钮
    testNote: { all: "（最近 30 分钟没观察到真实对话流量，已测全部四档；SenseNova 有 TPM 限流，429 稍候再测即可）" },
    modelsRefreshMsg: "✔ 已拉取可对话模型 {count} 个（图像模型已自动排除）\n下拉框已更新（映射目标强制保留）",
    keyMatch: "keyMatchSn",
    shape: "nested",
    sys: { modelsRefresh: true },
    modelsEndpoint: null,                     // 默认按 ?p=<key> 拼接
    settingsLabels: { relayPort: "SenseNova 中转端口" },
    notices: {
      stale: "当前有一端接在本路由台的其他渠道上——点「{btn}」会把它换过来（切换前自动快照，可一键接回）。",
      ccSwitch: "CC Switch 正在运行——它可能随时把配置改回 15721。若 SenseNova 突然失效，回到这里点「{btn}」恢复。",
    },
    // 别从灯名反推简称：「本地中转」会反推成「本地」、「Zen 中转」会丢掉「OpenCode」。
    shortName: "SenseNova",
  },

  /* ================= WorkBuddy（/wb） ================= */
  wb: {
    key: "wb",
    path: "/wb",
    tab: "WorkBuddy",
    h1: "WorkBuddy 路由",
    sub: "腾讯 · 免费模型",
    title: "WorkBuddy 路由 · B.AI 路由台",
    accentLabel: "接入",
    primaryBtn: "一键接入 WorkBuddy",
    targetName: "WorkBuddy 模型",
    relayHint: ":15742",
    guide: [
      {
        title: "一键获取令牌",
        desc: "自动从本机 WorkBuddy 客户端取登录令牌（令牌只存内存，必须取一次）。",
        act: "一键获取令牌",                  // 契约外补充：第 1 步自带按钮（其余页没有）
      },
      {
        title: "接入 WorkBuddy",
        desc: "把 Claude Code（终端 + 桌面版）接到 WorkBuddy 的三款免费模型。",
      },
    ],
    guideEyebrow: "用法",                     // 契约外补充
    guideTitle: "两步开始使用（新电脑照做即可）",
    hint: "三款均为 WorkBuddy 账号下 0 积分不限量的免费模型：DeepSeek-V4.1-Flash（100 万上下文）、Hy4-Preview-F（100 万上下文）、HY3（19.2 万上下文）。促销结束后若恢复计费，WorkBuddy 客户端里会显示需积分的模型。",
    settingsTitle: "WorkBuddy 设置",
    settingsAux: "上游 / 中转端口 / 通道",
    settingsEyebrow: "设置",
    foldKey: "bai.wbsec4",
    lamps: ["relay", "upstream", "cred"],
    lampNames: {
      relay: "WorkBuddy 中转",
      upstream: "WorkBuddy 上游",
      cred: "访问令牌",
    },
    lampSubs: { relay: ":15742 → 协议桥 → 上游", cred: "JWT 有效期" },
    // 旧 wb 页未配置时副行是「在下方粘贴访问令牌」；缺这项会落到通用兜底
    // 「在下方「WorkBuddy 设置」里填」，与旧文案不一致。
    cred: { subNone: "在下方粘贴访问令牌" },
    extraCards: ["token-capture", "model-sync"],
    footNote: "WorkBuddy 与 B.AI/SenseNova 各自独立配置，共用同一个路由台服务",
    footNoteAlt: "数据保存在 %APPDATA%\\bai-router · 与 B.AI 页共用配置存储",
    cardEyebrow: "状态",
    routeEyebrow: "模型",
    routeTitle: "路由表 · 模型映射（三款免费模型）",
    routeKey: null,                           // 路由表里没有密钥行，凭据在「手动填写令牌」卡里
    wireHint: "接通后：终端 CLI 与桌面版都指向本地协议桥 <span id=\"hintRelayPort\">:15742</span>（CLI 讲 Anthropic 协议、WorkBuddy 上游只讲 OpenAI，桥负责双向翻译）。四档 Claude 档位映射见下方路由表，模型菜单里即点即换；切换前自动快照，随时可「接回 CC Switch」或回 B.AI 页重新接通。",

    /* ---- v1.0.48 清单化 ---- */
    brands: { deepseek: "DeepSeek", hy: "Hy", glm: "GLM", kimi: "Kimi", qwen: "Qwen" },
    defaultModels: ["deepseek-v4.1-flash", "hy4-preview-f", "hy3"],
    applyInfoMsg: "现在可以在 Claude Code 的模型菜单里选择 WorkBuddy 的三款免费模型了。",
    resetModelsMsg: "✔ 已恢复为三款免费模型：{list}",
    step1Hint: "请先完成第 1 步「一键获取令牌」。",
    keyMatch: "keyMatchWb",
    shape: "nested",
    sys: {},
    modelsEndpoint: null,
    settingsLabels: { relayPort: "WorkBuddy 中转端口" },
    notices: {
      // 注意：wb.html 原文这里写的是「接通 WorkBuddy」，而按钮文字是「一键接入 WorkBuddy」。
      // 按契约统一用 {btn}，因此渲染出来会变成「一键接入 WorkBuddy」——见交付说明，待确认。
      stale: "当前有一端接在本路由台的其他渠道上——点「{btn}」会把它换过来（切换前自动快照，可一键接回）。",
      ccSwitch: "CC Switch 正在运行——它可能随时把配置改回 15721。若 WorkBuddy 突然失效，回到这里点「{btn}」恢复。",
    },
    // 别从灯名反推简称：「本地中转」会反推成「本地」、「Zen 中转」会丢掉「OpenCode」。
    shortName: "WorkBuddy",
  },

  /* ================= OpenCode Zen（/zen） ================= */
  zen: {
    key: "zen",
    path: "/zen",
    tab: "OpenCode Zen",
    h1: "OpenCode Zen",
    sub: "Zen · 免费模型",
    title: "OpenCode Zen 路由 · B.AI 路由台",
    accentLabel: "接入",
    primaryBtn: "一键接入 OpenCode Zen",
    targetName: "Zen 模型",
    relayHint: ":15752",
    guide: [
      {
        title: "填写 API Key",
        desc: "在 <b>opencode.ai/console</b> 生成 API Key（形如 <span class=\"mono\">oc_sk_…</span>），填到下方「Zen 设置」保存即可。",
      },
      {
        title: "一键接入",
        desc: "把 Claude Code（终端 + 桌面版）接到 Zen 的免费模型。",
      },
    ],
    guideEyebrow: "用法",
    guideTitle: "接入 OpenCode Zen",
    hint: null,                               // 路由表下方那句说明已并进「模型目录」卡（cards/model-catalog.js）
    settingsTitle: "Zen 设置",
    settingsAux: "API Key / 上游 / 中转端口",
    settingsEyebrow: "设置",
    foldKey: "bai.wbsec4",
    lamps: ["relay", "upstream", "cred"],
    lampNames: {
      relay: "Zen 中转",
      upstream: "Zen 上游",
      cred: "API Key",
    },
    lampSubs: { relay: ":15752 → 协议桥 → 上游", cred: "oc_sk_… 密钥" },
    extraCards: ["model-catalog", "model-sync"],
    footNote: "OpenCode Zen 与 B.AI/SenseNova/WorkBuddy 各自独立配置，共用同一个路由台服务",
    footNoteAlt: "数据保存在 %APPDATA%\\bai-router · 与 B.AI 页共用配置存储",
    cardEyebrow: "状态",
    routeEyebrow: "模型",
    routeTitle: "路由表 · 模型映射",
    routeKey: null,                           // 密钥填在「Zen 设置」里
    wireHint: "接通后：终端 CLI 与桌面版都指向本地协议桥 <span id=\"hintRelayPort\">:15752</span>（CLI 讲 Anthropic 协议、Zen 上游只讲 OpenAI，桥负责双向翻译）。四档 Claude 档位映射见下方路由表，模型菜单里即点即换；切换前自动快照，随时可「接回 CC Switch」或回 B.AI 页重新接通。",

    /* ---- v1.0.48 清单化 ---- */
    brands: { deepseek: "DeepSeek", hy: "Hy", glm: "GLM", kimi: "Kimi", qwen: "Qwen" },
    // 原先抄的是 WorkBuddy 的三款（deepseek-v4.1-flash/hy4-preview-f/hy3）——
    // Zen 免费档里唯一能外部调用的是 space-bunny-free。
    defaultModels: ["space-bunny-free"],
    cred: { txtOk: "已配置", subOk: "在下方「Zen 设置」管理", subNone: "在下方「Zen 设置」填 oc_sk_ 密钥" },
    applyInfoMsg: "现在可以在 Claude Code 的模型菜单里选择 Zen 的免费模型了。",
    resetModelsMsg: "✔ 已恢复为 Zen 免费模型：{list}",
    step1Hint: "请先完成第 1 步：在下方「Zen 设置」填入 API Key 并保存。",
    keyMatch: "keyMatchZen",
    badgeText: "ZEN",                         // 本页徽章写 ZEN（其余家 = tab 大写）
    shape: "nested",
    sys: { apiKey: true },
    modelsEndpoint: null,
    settingsLabels: { relayPort: "OpenCode Zen 中转端口" },
    notices: {
      stale: "当前有一端接在本路由台的其他渠道上——点「{btn}」会把它换过来（切换前自动快照，可一键接回）。",
      ccSwitch: "CC Switch 正在运行——它可能随时把配置改回 15721。若 OpenCode Zen 突然失效，回到这里点「{btn}」恢复。",
    },
    // 别从灯名反推简称：「本地中转」会反推成「本地」、「Zen 中转」会丢掉「OpenCode」。
    shortName: "OpenCode Zen",
  },

  /* ================= Qoder（/qd） ================= */
  qd: {
    key: "qd",
    path: "/qd",
    tab: "Qoder",
    h1: "Qoder",
    sub: "Qoder · 免费 + 付费档",
    title: "Qoder 路由 · B.AI 路由台",
    accentLabel: "接入",
    primaryBtn: "一键接入 Qoder",
    targetName: "Qoder 模型",
    relayHint: ":15762",
    guide: [
      {
        title: "装补丁并启动 Qoder 桌面端",
        desc: "新电脑先展开下方「令牌从哪来」卡片，点<b>「一键装补丁」</b>（路由台内置，无需装 Python）；然后登录 Qoder 桌面端并保持运行。补丁会在它的 worker 里挂一个钩子，把当前 <span class=\"mono\">jt-…</span> 令牌实时写到 <span class=\"mono\">%TEMP%/qoder-token.json</span>，本中转每次请求现读——<b>无需任何手动粘贴</b>。令牌每次 Qoder 启动会轮换，中转自动跟随。",
      },
      {
        title: "一键接入",
        desc: "把 Claude Code（终端 + 桌面版）接到 Qoder 账号额度。默认四档都走 <b>免费档</b>，不会自动烧积分；要用付费模型就在下方路由表里主动选（下拉里已标出倍率）。",
      },
    ],
    guideEyebrow: "用法",
    guideTitle: "接入 Qoder",
    hint: "下拉里的模型按 Qoder 的 <span class=\"mono\">price_factor</span> 如实标注：<b>免费</b>不扣积分，其余标注倍率（如 0.8×积分）。默认映射与「恢复默认模型」都只用免费档 <b>lite</b>。<br><b>ultimate</b> 为 Qoder 服务端侧的间歇性故障（其 AWS Bedrock 权限报错，非本机问题），面板下拉里已注明；命中时会由故障转移自动换渠道。",
    settingsTitle: "Qoder 设置",
    settingsAux: "API Key / 上游 / 中转端口",
    settingsEyebrow: "设置",
    foldKey: "bai.wbsec4",
    lamps: ["relay", "upstream", "cred"],
    lampNames: {
      relay: "Qoder 中转",
      upstream: "Qoder 上游",
      cred: "访问令牌",
    },
    lampSubs: { relay: ":15762 → 协议桥 → 上游", cred: "读取自 Qoder 客户端" },
    extraCards: ["model-catalog", "model-sync"],
    footNote: "Qoder 与 B.AI/SenseNova/WorkBuddy/Zen 各自独立配置，共用同一个路由台服务",
    footNoteAlt: "数据保存在 %APPDATA%\\bai-router · 与 B.AI 页共用配置存储",
    cardEyebrow: "状态",
    routeEyebrow: "模型",
    routeTitle: "路由表 · 模型映射",
    routeKey: null,                           // 令牌由补丁实时写入，没有手填框
    wireHint: "接通后：终端 CLI 与桌面版都指向本地协议桥 <span id=\"hintRelayPort\">:15762</span>（CLI 讲 Anthropic 协议、Qoder 上游只讲 OpenAI，桥负责双向翻译）。四档 Claude 档位映射见下方路由表，模型菜单里即点即换；切换前自动快照，随时可「接回 CC Switch」或回 B.AI 页重新接通。",

    /* ---- v1.0.48 清单化 ---- */
    brands: { lite: "Qoder Lite", auto: "Qoder Auto" },
    // 「恢复默认模型」的目标清单：只含免费档 auto（0.5×）之外的东西一律不进来——
    // 按这个按钮不该让用户开始烧积分。付费档在下拉里可选，但不会被"恢复默认"装上。
    defaultModels: ["lite"],
    cred: { kind: "file", txtOk: "已就绪", subOk: "随 Qoder 启动自动轮换", txtNone: "未读到", subNone: "未装补丁或 Qoder 未启动", preview: "jt-…（已就绪）" },
    applyInfoMsg: "现在可以在 Claude Code 的模型菜单里选择 Qoder 的模型了（默认走免费档 lite）。",
    resetModelsMsg: "✔ 已恢复为 Qoder 默认模型（免费档）：{list}",
    step1Hint: "请先完成第 1 步：在「令牌从哪来」卡片点「一键装补丁」，再启动 Qoder 桌面端并保持运行（令牌会自动写入 %TEMP%/qoder-token.json）。",
    keyMatch: "keyMatchQd",
    shape: "nested",
    sys: { tokenView: true },
    modelsEndpoint: null,
    settingsLabels: { relayPort: "Qoder 中转端口" },
    notices: {
      stale: "当前有一端接在本路由台的其他渠道上——点「{btn}」会把它换过来（切换前自动快照，可一键接回）。",
      ccSwitch: "CC Switch 正在运行——它可能随时把配置改回 15721。若 Claude Code 突然失效，回到这里点「{btn}」恢复。",
    },
    // 别从灯名反推简称：「本地中转」会反推成「本地」、「Zen 中转」会丢掉「OpenCode」。
    shortName: "Qoder",
  },

  /* ================= OpenRouter（/or）—— 免费兜底区（第 6 个提供方） =================
   * 定位（用户原话）：「没有任何模型可用时的兜底」——所以在故障转移链里排最后。
   * 与前五家的差别：凭据是**最多三个 key 的轮换区**，模型是**按 pricing 全 0 筛出来的
   * 免费目录**；429 分两种（limit_source），分别换模型 / 换 key。这些逻辑在 server.mjs，
   * 本条目只管这一页显示什么。 */
  or: {
    key: "or",
    path: "/or",
    tab: "OpenRouter",
    h1: "OpenRouter 免费流水区",
    sub: "OR · 免费模型",
    title: "OpenRouter 路由 · B.AI 路由台",
    accentLabel: "接入",
    primaryBtn: "一键接入 OpenRouter",
    targetName: "OpenRouter 模型",
    relayHint: ":15772",
    guide: [
      {
        title: "填写 OpenRouter API Key",
        desc: "在 <b>openrouter.ai/keys</b> 生成 API Key（形如 <span class=\"mono\">sk-or-v1…</span>），最多可填 <b>3 个</b>——三把 key 在下方「OpenRouter 免费流水区」里保存，页面只显示指纹、不回显明文。",
      },
      {
        title: "一键接入",
        desc: "把 Claude Code（终端 + 档位映射都指向免费模型）接到 OpenRouter 免费流水区；免费额度用尽时自动换模型、再用尽换 key。",
      },
    ],
    guideEyebrow: "用法",
    guideTitle: "接入 OpenRouter 免费兜底",
    hint: "下拉里的模型按 OpenRouter 的 <span class=\"mono\">pricing.prompt/completion 全为 0</span> 实测筛出（<b>不能只看 <span class=\"mono\">:free</span> 后缀</b>——inclusionai/ling-3.1-flash 没有后缀但免费）。四档默认指向 <b>openrouter/free</b>（自动路由到当前可用的免费模型）；模型级限流会自动换下一个免费模型，账号级 50 次/天用尽会自动换下一把 key。",
    settingsTitle: "OpenRouter 设置",
    settingsAux: "上游 / 中转端口 / 通道",
    settingsEyebrow: "设置",
    foldKey: "bai.orsec3",
    lamps: ["relay", "upstream", "cred"],
    lampNames: {
      relay: "OpenRouter 中转",
      upstream: "OpenRouter 上游",
      cred: "API Key",
    },
    lampSubs: { relay: ":15772 → 协议桥 → 上游", cred: "sk-or-v1… 密钥" },
    extraCards: ["or-rotation", "model-sync"],
    footNote: "OpenRouter 与 B.AI/SenseNova/WorkBuddy/Zen/Qoder 各自独立配置，共用同一个路由台服务",
    footNoteAlt: "数据保存在 %APPDATA%\\bai-router · 与 B.AI 页共用配置存储",
    cardEyebrow: "状态",
    routeEyebrow: "模型",
    routeTitle: "路由表 · 模型映射",
    routeKey: null,                           // 密钥填在「免费流水区」卡里（三个 key 的轮换区）
    wireHint: "接通后：终端 CLI 与桌面版都指向本地协议桥 <span id=\"hintRelayPort\">:15772</span>（CLI 讲 Anthropic 协议、OpenRouter 上游只讲 OpenAI，桥负责双向翻译）。四档 Claude 档位映射见下方路由表，模型菜单里即点即换；切换前自动快照，随时可「接回 CC Switch」或回 B.AI 页重新接通。",

    /* ---- v1.0.48 清单化字段（C12 强制） ---- */
    // brand 表用于路由表里把模型 id 显示成人话（openrouter/free → Openrouter Free…）
    brands: { openrouter: "OpenRouter", inclusionai: "InclusionAI", nvidia: "NVIDIA", google: "Google", cohere: "Cohere", thinkingmachines: "Thinking Machines", poolside: "Poolside", dots: "Dots", liquid: "Liquid", apodex: "Apodex" },
    defaultModels: [
      "openrouter/free",
      "inclusionai/ling-3.1-flash",
      "apodex/apodex-1.1-mini:free",
      "inclusionai/ling-3.0-flash-sante:free",
      "dots-studio/dots-3-note-preview:free",
      "liquid/lfm-2.5-2.6b:free",
      "nvidia/nemotron-3.5-lightning:free",
      "thinkingmachines/inkling-small:free",
      "poolside/laguna-s-2.1:free",
      "thinkingmachines/inkling:free",
      "poolside/laguna-xs-2.1:free",
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3.5-content-safety:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ],
    cred: { txtOk: "已配置", subOk: "在下方「免费流水区」管理 3 把 key", txtNone: "未配置", subNone: "在下方「免费流水区」粘贴 sk-or-v1 密钥（最多 3 把）" },
    applyInfoMsg: "现在可以在 Claude Code 的模型菜单里选择 OpenRouter 的免费模型了（四档默认都指向 openrouter/free）。",
    resetModelsMsg: "✔ 已恢复为发布机默认的 OpenRouter 免费模型：{list}",
    step1Hint: "请先完成第 1 步：在下方「OpenRouter 免费流水区」里填入至少 1 个 API Key 并保存。",
    keyMatch: "keyMatchOr",
    shape: "nested",
    sys: { modelsRefresh: true },             // 「刷新模型列表」→ /api/models?p=or 按 pricing 重筛免费目录
    modelsEndpoint: null,
    settingsLabels: { relayPort: "OpenRouter 中转端口" },
    notices: {
      stale: "当前有一端接在本路由台的其他渠道上——点「{btn}」会把它换过来（切换前自动快照，可一键接回）。",
      ccSwitch: "CC Switch 正在运行——它可能随时把配置改回 15721。若 OpenRouter 突然失效，回到这里点「{btn}」恢复。",
    },
    // 别从灯名反推简称：「本地中转」会反推成「本地」、「Zen 中转」会丢掉「OpenCode」。
    shortName: "OpenRouter",
  },
};
