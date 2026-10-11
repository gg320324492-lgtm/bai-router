/* providers.js —— 路由台的「渠道清单」（纯数据，无逻辑）。
 *
 * 由 provider.html 先加载，panel-common.js 再按 key 取用。
 *
 * v17 起清单的语义变了：**条目是「渠道」，不是「页面」**（契约 REFACTOR-CONTRACT-v17 第一节）。
 * 七个 URL 全部保留，但它们都渲染同一张单页；清单里多了一个不对应独立 URL 的
 * ccswitch 条目（矩阵上的「交还区」），原先的 home 条目已删除——根路径 / 现在只是
 * 「不预选中任何渠道」的默认视图，不再是清单实体。
 *
 * 声明顺序 = 故障转移链顺序（契约第二节：矩阵格序 = 转移链顺序），
 * ccswitch 固定排在链尾之后。真实链序以 config.json 的 failover.chain 为准，
 * 清单顺序是它的出厂默认值，C1 会拿两者对账。
 *
 * 约定：
 *  - null = 该渠道没有这块内容，渲染层请判空后再写进 DOM（不要直接 innerHTML = null）。
 *  - **不许出现真实密钥、真实用户名、本机绝对路径**；真实映射值只来自
 *    %APPDATA%\bai-router\config.json（cfg[channel].mapping），本文件里的
 *    mappingDefaults 只是「恢复默认」的种子。
 *  - models 与 src/server/config.defaults.json 的 availableModels 逐项一致，
 *    C8 两边对账；深浅主题与 qd 都不例外。
 *  - 文案全部沿用重构前的原句，不要顺手改措辞：本轮刚修过一批复制粘贴留下的错配。
 *
 * 字段分组（渲染层读得到哪些，见 CONTRACT-v17 里程碑 1 的字段表）：
 *   定位     key / path / tab / h1 / title / shortName
 *   卡片     letter / name / tagline / badge / chainable
 *   凭据     credential { kind, label, hint }        ← 凭据视图按 kind 分派，渲染层不许出现渠道名
 *   模型     models（可选清单）/ brands（模型 id → 人话）/ defaultModels（恢复默认的种子）
 *             / mappingDefaults（四档 → 默认显示名）
 *   诊断     conclusion（就绪怎么判断）/ remedy（未就绪给什么建议）  ← C3 把关
 *   本机     settingsLabels（设置视图里的字段标签）
 *
 * window.BAI_VIEWS 是**视图级卡片表**（四视图各挂哪些 cards/*.js），不在本文件顶层的
 * 渠道条目里 —— 卡片属于视图而不属于渠道。C6 拿它与 cards/ 目录双向对账。
 */
window.BAI_PROVIDERS = {

  /* ================= Qoder（/qd）—— 转移链第 1 位 =================
   * 账号额度型：补丁把登录令牌实时写进临时目录，中转每次请求现读，手上不需要任何明文密钥。 */
  qd: {
    key: "qd",
    path: "/qd",
    tab: "Qoder",
    h1: "Qoder",
    title: "Qoder 路由 · B.AI 路由台",
    shortName: "Qoder",

    letter: "QD",
    name: "Qoder",
    tagline: "账号额度 · 免费档 + 付费档",
    badge: { text: "免费", kind: "free" },
    chainable: true,
    credential: {
      kind: "jobToken",
      label: "访问令牌",
      hint: "补丁从 Qoder 客户端抓取，启动即轮换",
    },

    models: [
      "lite", "auto", "performance", "ultimate",
      "qmodel", "kmodel", "dmodel", "mmodel", "gmodel",
    ],
    brands: { lite: "Qoder Lite", auto: "Qoder Auto", performance: "Qoder Performance", ultimate: "Qoder Ultimate", qmodel: "Qoder Q-Model", kmodel: "Qoder K-Model", dmodel: "Qoder D-Model", mmodel: "Qoder M-Model", gmodel: "Qoder G-Model" },
    /* 「恢复默认模型」只装免费档 lite：按这个按钮不该让用户开始烧积分。 */
    defaultModels: ["lite"],
    mappingDefaults: {
      "claude-fable-5": "Qoder Lite",
      "claude-sonnet-5": "Qoder Lite",
      "claude-opus-5": "Qoder Lite",
      "claude-haiku-4-5": "Qoder Lite",
    },

    conclusion: "补丁已装 + Qoder 客户端在跑、令牌文件是新鲜的，就算就绪；四档默认全走免费档 lite。",
    remedy: "先点「一键装补丁」再启动 Qoder 桌面端并保持运行。令牌每次客户端启动会轮换，中转自动跟随，无需手动粘贴。",

    settingsLabels: { relayPort: "Qoder 中转端口" },
  },

  /* ================= B.AI（/bai）—— 转移链第 2 位 =================
   * 主力 API 站。上游本身兼容 Anthropic 协议，不需要协议桥，CLI 可直连。 */
  bai: {
    key: "bai",
    path: "/bai",
    tab: "B.AI",
    h1: "B.AI 路由台",
    title: "B.AI 路由台",
    shortName: "B.AI",

    letter: "BAI",
    name: "B.AI",
    tagline: "主力 API 站 · 国内外模型都有",
    badge: { text: "付费", kind: "paid" },
    chainable: true,
    credential: {
      kind: "apiKey",
      label: "API Key",
      hint: "在上游控制台生成，形如 sk-…",
    },

    models: [
      "claude-fable-5", "claude-fable-5.1", "claude-haiku-4.5",
      "claude-opus-4.5", "claude-opus-4.6", "claude-opus-4.7", "claude-opus-4.8", "claude-opus-5",
      "claude-sonnet-4.5", "claude-sonnet-4.6", "claude-sonnet-5",
      "deepseek-v4-pro", "deepseek-v4.1-flash",
      "gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.5-flash-lite",
      "gemini-3.6-flash", "gemini-3.8-flash",
      "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash",
      "gpt-5-mini", "gpt-5-nano", "gpt-5.2",
      "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro",
      "gpt-5.5", "gpt-5.5-instant",
      "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
      "gpt-6-astra", "hy3", "hy4-preview",
      "kimi-k2.6", "kimi-k3",
      "mimo-v2.5", "mimo-v2.5-pro",
      "minimax-m2.7", "minimax-m3",
      "qwen3.8-27b", "qwen3.8-flash", "qwen3.8-max",
      "claude-haiku-5.5", "claude-opus-5.5", "claude-sonnet-5.5",
      "glm-5.3-flashx",
      "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol",
      "gpt-image-2", "jev-1.13.0", "jev-latest",
      "kimi-k2.8-preview", "mimo-v2.6-flash", "mimo-v2.6-pro",
    ],
    brands: { qwen: "Qwen", glm: "GLM", deepseek: "DeepSeek", hy: "HY", mimo: "MiMo", kimi: "Kimi", minimax: "MiniMax" },
    defaultModels: [],                 // 本渠道没有「恢复默认模型」按钮（无固定清单）
    mappingDefaults: {
      "claude-fable-5": "Qwen3.8-Flash",
      "claude-sonnet-5": "HY3",
      "claude-opus-5": "HY3",
      "claude-haiku-4-5": "MiMo-V2.5",
    },

    conclusion: "面板里填了 API Key、且本地中转起得来，就算就绪；上游没探测过只算「未验」，不算故障。",
    remedy: "先点「测试连通」探一次上游。中转按请求自带的 key 计费，面板改过 key 不会自动更新已接线的客户端 —— 要重开对应终端/桌面版。",

    settingsLabels: { relayPort: "B.AI 中转端口" },
  },

  /* ================= SenseNova（/sn）—— 转移链第 3 位 =================
   * 境内服务：CLI 直连、不需要出海代理；桌面版经由本地中转。上游兼容 Anthropic 协议。 */
  sn: {
    key: "sn",
    path: "/sn",
    tab: "SenseNova",
    h1: "SenseNova 路由",
    title: "SenseNova 路由 · B.AI 路由台",
    shortName: "SenseNova",

    letter: "SN",
    name: "SenseNova",
    tagline: "商汤日日新 · 境内直连",
    badge: { text: "境内付费", kind: "cn" },
    chainable: true,
    credential: {
      kind: "apiKey",
      label: "API Key",
      hint: "token-plan 密钥，形如 sk-…",
    },

    models: [
      "deepseek-v4-flash", "glm-5.2", "kimi-k3",
      "sensenova-6.8-flash-lite", "deepseek-flash", "deepseek-v4.1-flash",
    ],
    brands: { sensenova: "SenseNova", deepseek: "DeepSeek", glm: "GLM", kimi: "Kimi", neo: "Neo", u: "U" },
    defaultModels: [],
    mappingDefaults: {
      "claude-fable-5": "SenseNova-6.8-Flash-Lite",
      "claude-sonnet-5": "DeepSeek-V4-Flash",
      "claude-opus-5": "GLM-5.2",
      "claude-haiku-4-5": "Kimi-K3",
    },

    conclusion: "填了 token-plan 密钥、且本地中转起得来，就算就绪；境内直连，出海代理不可用不影响它。",
    remedy: "先点「测试连通」探一次上游。SenseNova 有 TPM 限流，429 稍候再测即可；刷新模型列表时图像模型已自动排除。",

    settingsLabels: { relayPort: "SenseNova 中转端口" },
  },

  /* ================= OpenCode Zen（/zen）—— 转移链第 4 位 ================= */
  zen: {
    key: "zen",
    path: "/zen",
    tab: "OpenCode Zen",
    h1: "OpenCode Zen",
    title: "OpenCode Zen 路由 · B.AI 路由台",
    shortName: "OpenCode Zen",

    letter: "ZEN",
    name: "OpenCode Zen",
    tagline: "免费模型 · 接入需自备 Key",
    badge: { text: "免费 · 海外", kind: "intl" },
    chainable: true,
    credential: {
      kind: "apiKey",
      label: "API Key",
      hint: "opencode.ai/console 生成，形如 oc_sk_…",
    },

    models: ["space-bunny-free"],
    brands: { deepseek: "DeepSeek", hy: "Hy", glm: "GLM", kimi: "Kimi", qwen: "Qwen" },
    /* 免费档里唯一能外部调用的就是 space-bunny-free，所以四档全部指向它。 */
    defaultModels: ["space-bunny-free"],
    mappingDefaults: {
      "claude-fable-5": "Space-Bunny-Free",
      "claude-sonnet-5": "Space-Bunny-Free",
      "claude-opus-5": "Space-Bunny-Free",
      "claude-haiku-4-5": "Space-Bunny-Free",
    },

    conclusion: "填了 oc_sk_ 密钥就算就绪；免费档只有一个模型，四档全部指向它，接通即代表四档都可用。",
    remedy: "先在上游控制台生成 API Key 再保存。额度用尽会返回 429，由故障转移自动换渠道。",

    settingsLabels: { relayPort: "OpenCode Zen 中转端口" },
  },

  /* ================= WorkBuddy（/wb）—— 转移链第 5 位 =================
   * 凭据是从本机客户端抓的登录令牌（JWT，只存内存），上游只讲 OpenAI 协议，需要协议桥。 */
  wb: {
    key: "wb",
    path: "/wb",
    tab: "WorkBuddy",
    h1: "WorkBuddy 路由",
    title: "WorkBuddy 路由 · B.AI 路由台",
    shortName: "WorkBuddy",

    letter: "WB",
    name: "WorkBuddy",
    tagline: "腾讯 · 三款 0 积分模型",
    badge: { text: "0 积分", kind: "cn" },
    chainable: true,
    credential: {
      kind: "jwt",
      label: "访问令牌",
      hint: "从本机 WorkBuddy 客户端一键捕获，只存内存",
    },

    models: ["deepseek-v4.1-flash", "hy4-preview-f", "hy3"],
    brands: { deepseek: "DeepSeek", hy: "Hy", glm: "GLM", kimi: "Kimi", qwen: "Qwen" },
    defaultModels: ["deepseek-v4.1-flash", "hy4-preview-f", "hy3"],
    mappingDefaults: {
      "claude-fable-5": "DeepSeek-V4.1-Flash",
      "claude-sonnet-5": "Hy4-Preview-F",
      "claude-opus-5": "HY3",
      "claude-haiku-4-5": "DeepSeek-V4.1-Flash",
    },

    conclusion: "捕获到 JWT 且未过期就算就绪；本渠道不比对 key（令牌由客户端带、中转只转发）。",
    remedy: "点「一键获取令牌」重取。没有刷新令牌，到期需重新捕获；国内版与国际版按登录域名自动判定。",

    settingsLabels: { relayPort: "WorkBuddy 中转端口" },
  },

  /* ================= OpenRouter（/or）—— 转移链第 6 位（兜底） =================
   * 凭据是最多三把 key 的轮换区，模型是按 pricing 全 0 筛出来的免费目录。
   * 429 分两种（limit_source），分别换模型 / 换 key。这些逻辑在 server.mjs。 */
  or: {
    key: "or",
    path: "/or",
    tab: "OpenRouter",
    h1: "OpenRouter 免费流水区",
    title: "OpenRouter 路由 · B.AI 路由台",
    shortName: "OpenRouter",

    letter: "OR",
    name: "OpenRouter",
    tagline: "免费流水区 · 两层轮换兜底",
    badge: { text: "免费 · 海外", kind: "intl" },
    chainable: true,
    credential: {
      kind: "keys3",
      label: "API Key 轮换区",
      hint: "最多 3 把，429 时自动换下一把",
    },

    models: [
      "inclusionai/ling-3.1-flash",
      "apodex/apodex-1.1-mini:free",
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
      "openrouter/free",
    ],
    brands: { openrouter: "OpenRouter", inclusionai: "InclusionAI", nvidia: "NVIDIA", google: "Google", cohere: "Cohere", thinkingmachines: "Thinking Machines", poolside: "Poolside", dots: "Dots", liquid: "Liquid", apodex: "Apodex" },
    defaultModels: ["openrouter/free"],
    mappingDefaults: {
      "claude-fable-5": "OpenRouter Free",
      "claude-sonnet-5": "OpenRouter Free",
      "claude-opus-5": "OpenRouter Free",
      "claude-haiku-4-5": "OpenRouter Free",
    },

    conclusion: "至少配了 1 把 key 就算就绪；三把全在冷却才算不可用。额度接口对非免费档账号读不到用量，页面上如实说没有。",
    remedy: "三把都冷却时会如实失败并给出重置时间，不会空转重试；可点「刷新额度」查看账号级用量，或「刷新免费模型目录」按 pricing 全 0 重筛。",

    settingsLabels: { relayPort: "OpenRouter 中转端口" },
  },

  /* ================= CC Switch —— 矩阵上的「交还区」，不是本台渠道 =================
   * 它没有独立 URL（path: null）、不进转移转移链（chainable: false）、没有凭据要配
   * （credential.kind: "none"）。它存在的意义是：配置随时可以还回去给它。 */
  ccswitch: {
    key: "ccswitch",
    path: null,                      // 不对应独立 URL，只出现在矩阵的交还区格子里
    tab: "CC Switch",
    h1: "CC Switch",
    title: "CC Switch · B.AI 路由台",
    shortName: "CC Switch",

    letter: "CC",
    name: "CC Switch",
    tagline: "你已有的第三方配置管理器 · 配置交还的去处",
    badge: { text: "非本台渠道", kind: "neutral" },
    chainable: false,
    credential: {
      kind: "none",
      label: "非本台渠道",
      hint: "它自己管配置，本路由台不持有它的凭据",
    },

    models: [],                      // 不是本台渠道，没有可选模型清单
    brands: {},                      // 同上
    defaultModels: [],
    mappingDefaults: {},             // 没有映射编辑区

    conclusion: "它不参与本台的状态判定，只看当前是否在运行：运行中就随时可能把配置改回它自己的端口。",
    remedy: "想让它退场：点顶部「一键最优」，或从任意渠道卡点接通；原来的接线已自动快照，随时能接回来。",

    settingsLabels: { relayPort: "中转端口" },
  },
};

/* ============================================================================
 * 视图级卡片表：四个视图各挂哪些 cards/*.js。
 *
 * 卡片属于**视图**而不属于渠道（旧架构的 extraCards 是每页一份，才会出现同一张卡
 * 在总览页挂一份、各家页挂另一份的漂移）。C6 拿本表与 cards/ 目录双向对账：
 * 本表引用了不存在的文件 = 错；目录里有文件没人引用 = 死卡。
 *
 * 视图 id 必须同时是三样东西：#navViews 里的 data-view、URL hash 段（#/console）、
 * 以及本表的 id（DOM 容器 id 在 dom 字段）。C9 逐个核对。
 * ========================================================================== */
window.BAI_VIEWS = [
  { id: "console", nav: "控制台", dom: "viewConsole", hint: "渠道矩阵 · 映射编辑 · 诊断抽屉", cards: ["model-sync"] },
  { id: "cred", nav: "凭据", dom: "viewCred", hint: "每家渠道各自要的东西", cards: ["token-capture", "model-catalog", "or-rotation"] },
  { id: "fo", nav: "故障转移", dom: "viewFo", hint: "开关 · 顺序 · 冷却", cards: ["failover"] },
  { id: "settings", nav: "设置", dom: "viewSettings", hint: "代理 · 端口 · 更新 · 数据目录", cards: [] },
];