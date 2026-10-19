/* providers.js —— 路由台的「渠道清单」（纯数据，无逻辑）。
 *
 * 由 provider.html 先加载，panel-common.js 再按 key 取用。
 *
 * v17 起清单的语义变了：**条目是「渠道」，不是「页面」**（契约 REFACTOR-CONTRACT-v17 第一节）。
 * 八个 URL 全部保留，但它们都渲染同一张单页；清单里多了一个不对应独立 URL 的
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
    /* 档位徽章（v1.0.74 T4）：Zen 有免费档与 Go 档两套完全不同的可用性——
     * 免费档走**直连**时会被拒（403 FreeTierError）：上游要求「发给模型的请求里必须带工具」，
     * 而直连中转的请求不带工具。改走 OpenCode 客户端中转即可（那条路模型手上就有工具）。
     * Go 档能用但要 $10/月订阅。
     * 判据是上游地址里有没有 /zen/go/，**不新增配置字段**：用户直接在设置里改上游即可。
     * 这里只声明"这一格要显示档位"，档位本身由服务端 /api/status 的 zen.tier* 给出——
     * 渲染层因此不需要认识任何渠道名（C11）。 */
    tierBadge: true,
    /* 能力探测按钮（v1.0.74 T3+T6）：这一家是唯一有「逐模型能力探测」的渠道——
     * 目录只给 id，可用性只能靠真实请求测出来（出厂白名单已于 2026-10-12 实测复核
     * 为不成立）。这里只声明"要画这个按钮"，端点、判定与文案全在服务端，
     * 渲染层因此不需要认识任何渠道名（C11）。 */
    capabilityProbe: true,
    /* 传输方式开关（v1.0.75）：这一档的请求可以走两条完全不同的路，**默认直连**
     * ——出厂值写在 config.defaults.json 的 zen.transport，与接线之前一致；
     * 缺省值与认不出来的值一律 direct（判据与 oc-wiring 的 zenTransportOf 同一处）。
     *
     * 这里只声明「这一格要画传输开关」+ 两个选项各自的**前置条件**；
     * 当前档位与前置条件在本机满足没有，由 /api/status 的 zen.transport /
     * zen.transportProbe 给出（探针复用 oc-runtime 的 findOpenCodeBinary，不另造一套）。
     * 于是渲染层不需要认识任何渠道名，也不需要自己判断「装没装」（C11）。 */
    transportSwitch: true,
    transportOptions: [
      {
        value: "direct",
        label: "直连",
        desc: "本程序直接调 Zen 接口 —— 改动前的路径，一行都不变。",
        need: "前置条件：免费档会被拒（上游要求发给模型的请求里必须带工具，直连这条路不带）；Go 档要账号已订阅 OpenCode Go（$10/月）。",
      },
      {
        value: "opencode",
        label: "OpenCode 客户端中转",
        desc: "经本机的 OpenCode 走，用它自己的身份发请求 —— 模型手上因此有工具。",
        need: "前置条件：本机必须已装 OpenCode（npm i -g opencode-ai）。免费模型不需要任何订阅。",
        /* 打开这一档前要先把「本机装没装」摆出来；摆不出来（探测出错）时
         * 如实说检测失败，**不要**当成「没装」——两者的处置完全不同。 */
        requiresProbe: "opencode",
      },
    ],
    chainable: true,
    credential: {
      kind: "apiKey",
      label: "API Key",
      hint: "opencode.ai/console 生成，形如 oc_sk_…",
    },

    models: ["space-bunny-free"],
    brands: { deepseek: "DeepSeek", hy: "Hy", glm: "GLM", kimi: "Kimi", qwen: "Qwen" },
    /* 出厂四档仍指向 space-bunny-free：它是**默认档位（免费档）**里唯一的免费模型，
     * 换掉就得写死一个付费模型，而付费模型按设计一律不进探测、也不该被默认选中。
     * ⚠️ 但「免费档里它能外部调用」这句话已于 2026-10-12 用真 key 实测推翻
     * （403 FreeTierError，围栏在鉴权之后、推理之前拦）。所以它出厂时是**未检测**
     * 状态，不是「已知可用」——点一次「检测可用性」才会拿到真实结论。 */
    defaultModels: ["space-bunny-free"],
    mappingDefaults: {
      "claude-fable-5": "Space-Bunny-Free",
      "claude-sonnet-5": "Space-Bunny-Free",
      "claude-opus-5": "Space-Bunny-Free",
      "claude-haiku-4-5": "Space-Bunny-Free",
    },

    /* 出厂映射仍指向免费档的 space-bunny-free：那是**默认档位**下唯一曾被实测标注可用的。
     * 切到 Go 档（改上游地址）后请点「刷新模型列表」，下拉会换成 Go 档自己的目录
     * —— 两档的清单互不通用（免费档 83 个 / Go 档 38 个）。
     * 更好的做法是点「检测可用性」：它按真实请求逐个探测，并逐模型标出
     * 「可用 · 支持工具」/「可用 · 仅对话」/「探不通」。 */
    conclusion: "两档的可用性完全不同，看矩阵卡上的档位徽章："
      + "「免费档」走**直连**时会被拒（403 FreeTierError）——上游要求发给模型的请求里必须带工具，"
      + "而直连中转的请求不带工具（执行权在 Claude Code 那边）。换模型无效，解法是改走 OpenCode 客户端中转；"
      + "「Go 档」能用，但要账号已订阅 OpenCode Go（$10/月）。判据只有上游地址里有没有 /zen/go/，不新增配置项。"
      + "⚠ **免费档实测约四分之三的请求会挂起**（2026-10-15 实测，12 发只成 3 发）："
      + "成功的都是 1.7~2.6 秒，失败的一律打满 60 秒，**中间没有过渡值**，也**不挑会话新旧、不挑权限配置**"
      + "（每发都新建会话，旧的反而正常）。这是**上游后端的随机行为**，与本机配置、令牌、中转、OpenCode 都无关——"
      + "同一个社区项目报的 issue #42「长任务流式零字节挂起，上游收下请求不吐首 token」是同一件事。"
      + "所以**不要往本机方向排查**：换会话、换模型、改配置都没用，因为随机。"
      + "免费档唯一的干净解是订阅 Go 档；不打算花钱的话，就当它是个抽签服务，"
      + "Claude Code 正常一聊就是几十上百轮，**几乎必然中途卡住**，建议别拿它干正事。",
    caveat: "免费档实测约 75% 的请求会随机挂起（12 发只成 3 发），与会话新旧、权限配置都无关。这是上游后端的随机行为，换会话换模型都没用；要稳定请订阅 Go 档",
    remedy: "要先在上游控制台生成 oc_ 开头的 API Key 再保存。要用免费档，把传输方式切到 OpenCode 客户端中转"
      + "（需本机已装 OpenCode：点「传输方式」卡上的「一键安装」，或 npm i -g opencode-ai）；否则把设置里的上游地址改成 "
      + "https://opencode.ai/zen/go/v1 并到 https://opencode.ai/auth 订阅 Go，然后点「刷新模型列表」换成 Go 档目录。"
      + "目录里的可用性标着「未检测」就点「检测可用性」——只有真实请求说了算。检测只跑免费模型、并发 2、每个 10 秒，付费模型一次都不探（探了要花钱）。",

    settingsLabels: { relayPort: "OpenCode Zen 中转端口" },
  },

  /* ================= WorkBuddy 国内版（/wb）—— 转移链第 5 位 =================
   * 凭据是从本机客户端抓的登录令牌（JWT，只存内存），上游只讲 OpenAI 协议，需要协议桥。
   * 本格**钉死国内版**：上游恒为 www.workbuddy.cn，凭据取 workbuddy-desktop.info。
   * 国际版是下一条 wbai，两版各自独立的中转端口与独立的令牌，不要互相自愈。 */
  wb: {
    key: "wb",
    // 同一产品的另一版别。令牌归属对不上时要提示"去另一版重抓"，
    // 而渲染层不许写死渠道名（C11），所以这条指向关系写在清单里。
    counterpart: "wbai",
    path: "/wb",
    tab: "WorkBuddy",
    h1: "WorkBuddy 路由",
    title: "WorkBuddy 路由 · B.AI 路由台",
    shortName: "WorkBuddy",

    letter: "WB",
    name: "WorkBuddy",
    tagline: "腾讯 · 国内版 · 31 款里仅 2 款 0 积分",
    /* ⚠ v1.0.88 改：原来写「0 积分」+「三款 0 积分模型」，**两处都不准**——
     * 实测本机目录（2026-10-17，31 款）只有 **2 款** 是 credits=x0.00
     * （hy3、step-5-preview），其余 **29 款全部收费**（hy4-preview x0.29、
     * space-bunny x0.08、deepseek-v4.1-flash x0.11 …）。
     * 一个「0 积分」的徽章会被读成「这家全免费」，于是用户在该家选个别的模型
     * 就开始烧积分而毫无提示——这跟「静默换人被换到计费渠道」是同一类伤害。
     * 徽章只说**有一款免费**这个事实，不概括整家。 */
    badge: { text: "有免费款", kind: "cn" },
    chainable: true,
    /* 账号池卡（v1.0.77）：这一格可以挂多个账号，按「同一段对话粘一个号、
       那个号真用不了才换」的规矩自动轮换。老配置只有一个令牌时池子合成为
       单条目，行为与池化之前逐字一致（面板会如实说「当前是单账号」）。
       这里只声明「这一格要画这张卡」；每个账号的状态、处置指引、「本次被跳过」
       全部由 /api/status 的 pool 字段给出——渲染层因此既不需要认识渠道名，
       也不需要认识 reason 码（C11）。 */
    accountPool: true,
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

    conclusion: "捕获到 JWT 且未过期就算就绪；本渠道不比对 key（令牌由客户端带、中转只转发）。上游同样会按 system prompt 的**内容**认客户端（与国际版同一套逻辑，中转发出前会自动剥除已知指纹，实测可正常对话与调工具）；上游日后若新增尚未覆盖的指纹，才会返回 400「Illegal API invocation from an unapproved channel」。",
    caveat: "与国际版同一套客户端指纹校验：已知指纹中转会自动剥除。若报 400「unapproved channel」，多半是上游新增了尚未覆盖的指纹",
    remedy: "点「一键获取令牌」重取。没有刷新令牌，到期需重新捕获；国际版请到「WorkBuddy AI」格单独捕获，两个版本的令牌互不相同。",

    settingsLabels: { relayPort: "WorkBuddy 中转端口" },
  },

  /* ================= WorkBuddy 国际版（/wbai）—— 转移链第 6 位 =================
   * 与 wb 是**两套东西**（实测 2026-10-11，见契约 v18 §1.5）：模型目录、定价、凭据文件
   * 全部独立。上游恒为 www.workbuddy.ai，凭据取 workbuddy-desktop-ai.info，中转端口也另起一个。
   * models 只是出厂兜底清单——面板「刷新模型列表」会按上游 /v3/config 覆盖它，
   * **不要把这里的三个 id 当成真实目录**。 */
  wbai: {
    key: "wbai",
    counterpart: "wb",        // 见 wb.counterpart
    path: "/wbai",
    tab: "WorkBuddy AI",
    h1: "WorkBuddy AI 路由",
    title: "WorkBuddy AI 路由 · B.AI 路由台",
    shortName: "WorkBuddy AI",

    letter: "WAI",
    name: "WorkBuddy AI",
    tagline: "腾讯 · 国际版 · 出海 · 28 款里仅 3 款 0 积分",
    /* ⚠ 同 wb：实测 28 款里只有 3 款 credits=x0.00（deepseek-v4.1-flash、hy3、
     * step-5-preview），其余收费。写「0 积分」会被读成整家免费。 */
    badge: { text: "有免费款 · 海外", kind: "intl" },
    chainable: true,
    /* 账号池卡（v1.0.77）：见 wb.accountPool。与 wb **分池不混** ——
       两版令牌互不通用，装进同一个池子必然有一半是死的。 */
    accountPool: true,
    credential: {
      kind: "jwt",
      label: "访问令牌",
      hint: "从本机 WorkBuddy AI（国际版）客户端一键捕获，只存内存",
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

    conclusion: "捕获到国际版 JWT 且未过期就算就绪；本渠道不比对 key（令牌由客户端带、中转只转发）。上游会对 system prompt 做**内容**指纹校验（不是看长度）：认得 Claude Code 的几处标识就判「非官方客户端」并返回 400「Illegal API invocation from an unapproved channel」。中转在发出前会自动剥除这些标识（开场指纹行、计费指纹行、反馈链接行），实测**国内外两版**带真实 Claude Code system + 12 个工具的请求都能正常应答，工具调用也通。所以这不是这条渠道的既有限制；真正的残余风险是**上游日后新增了新的指纹**——规则表没覆盖到时才会真被拒，届时报上面那个 400。",
    // caveat：卡片上直接显示的限制提示（短句版）。完整解释在 conclusion/remedy 里。
    // 闸门 C1/C12 只校验必填字段的**存在**，不禁止额外字段，所以加这个是安全的。
    caveat: "上游按 system prompt 的**内容**认客户端，不是看长度；已知指纹中转会自动剥除，实测可正常对话与调工具。若报 400「unapproved channel」，多半是上游新增了尚未覆盖的指纹",
    remedy: "先启动「国际版」客户端（国内版那个不行，两者令牌文件不同）再点「一键获取令牌」。没有刷新令牌，到期需重新捕获。模型清单以面板「刷新模型列表」从上游拉到的为准，本格出厂的三项只是兜底。真实对话若报上面那个 400，是上游新增指纹未覆盖，不是本机配置问题——国内外两版都一样，此时可先用 OpenCode Zen 等不挑客户端的渠道顶上。",

    settingsLabels: { relayPort: "WorkBuddy AI 中转端口" },
  },

  /* ================= MiniMax 会员（/mm）—— 转移链在 wbai 之后、or 之前 =================
   * **会员额度**通道：凭据是 MiniMax Code 桌面端登录态里换来的 Bearer 令牌，
   * 只存在内存（不落 config.json / 不进日志 / 面板上看不到明文）。
   * 上游是 Anthropic Messages **原生协议**（不做协议翻译）。
   * ⚠ 实测（2026-10-19，MiniMax Code 3.1.4）：上游真正硬要求的只有**两样**——
   *   鉴权令牌（`authorization: Bearer`）与 `content-type: application/json`；
   *   UA / Origin / Referer / system prompt **都不是校验对象**（去掉照样 200）。
   *   真正被挑刺的是**工具定义的形状**（本中转已做转换）。
   * ⚠ 与「开放平台 BYOK（按量计费）」是两回事，面板上必须分开说。 */
  mm: {
    key: "mm",
    path: "/mm",
    tab: "MiniMax 会员",
    h1: "MiniMax 会员路由",
    title: "MiniMax 会员路由 · B.AI 路由台",
    shortName: "MiniMax 会员",

    letter: "MM",
    name: "MiniMax 会员",
    tagline: "会员额度 · 令牌只存内存",
    /* 徽章只说「会员额度」这个事实，**不写「免费」**：
     * 会员额度里能用多少取决于用户自己的套餐，写成「免费」会被读成「这家全免费」，
     * 于是用户随便发消息就开始烧额度而毫无提示——跟 wb 那次「0 积分」是同一类伤害。 */
    badge: { text: "会员额度", kind: "cn" },
    chainable: true,
    /* 凭据**不由用户填写**：中转从本机的 MiniMax Code 登录态自取。
     * kind 用 jobToken —— 枚举里唯一表示「令牌由中转自取、不落配置」的那一档
     * （qd 的 jobToken 也是这个性质：轮换的、每次现读）。 */
    credential: {
      kind: "jobToken",
      label: "会员登录态",
      hint: "从本机 MiniMax Code 的登录态读取，只存内存",
    },
    /* 凭据自取型：这一行画成**只读**（没有输入框），只给一个「重新读取登录态」的动作。
     * 渲染层据此分派，不认渠道名（C11）；endpoint 与文案都在清单里给。 */
    credentialReadonly: { api: "/api/mm/reread", label: "重新读取登录态" },
    /* 会员额度通道卡（cards/mm-member.js）：只画清单声明了 memberQuota 的那一格。 */
    memberQuota: true,

    models: ["MiniMax-M3.1-Flash"],
    brands: { minimax: "MiniMax" },
    defaultModels: ["MiniMax-M3.1-Flash"],
    mappingDefaults: {
      "claude-fable-5": "MiniMax-M3.1-Flash",
      "claude-sonnet-5": "MiniMax-M3.1-Flash",
      "claude-opus-5": "MiniMax-M3.1-Flash",
      "claude-haiku-4-5": "MiniMax-M3.1-Flash",
    },

    conclusion: "本机读到了 MiniMax Code 的登录态就算就绪（会员令牌在内存里，快到期会自动续期）。"
      + "这一格走的是**会员额度**——MiniMax Code 登录的那个账号自带的免费/会员额度，"
      + "**不是**开放平台按量计费的 API Key：能用多少取决于你自己的套餐，两回事，别混。",
    caveat: "会员额度通道 · 令牌只存内存 · 上游只认鉴权令牌与工具定义的形状",
    remedy: "先在 **MiniMax Code 里登录**（凭据从它的登录态拿），再回本页点「重新读取登录态」。"
      + "令牌**只存在内存**里：不写进 config.json、不写进日志、面板上也看不到明文；"
      + "重启路由台要重新读一次（重新登录 MiniMax Code 即可恢复）。"
      + "⚠ 上游真正挑刺的只有两处：**鉴权令牌**与**工具定义的形状**"
      + "（本中转已把嵌套形状转成上游要的扁平形状，能正常对话与调工具）；"
      + "请求头与 system prompt 都不是校验对象——换句话说，这一格出问题时"
      + "先看这两处，而不是去调 UA。",

    settingsLabels: { relayPort: "MiniMax 会员中转端口" },
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
  { id: "console", nav: "控制台", dom: "viewConsole", hint: "渠道矩阵 · 映射编辑 · 诊断抽屉", cards: ["model-sync", "oc-transport"] },
  { id: "cred", nav: "凭据", dom: "viewCred", hint: "每家渠道各自要的东西", cards: ["token-capture", "model-catalog", "or-rotation", "wb-pool", "mm-member"] },
  { id: "fo", nav: "故障转移", dom: "viewFo", hint: "开关 · 顺序 · 冷却", cards: ["failover"] },
  { id: "settings", nav: "设置", dom: "viewSettings", hint: "代理 · 端口 · 更新 · 数据目录", cards: [] },
];