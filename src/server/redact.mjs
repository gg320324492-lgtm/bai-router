/**
 * redact.mjs —— 脱敏（等长掩码式）
 *
 * ## 它补的是哪个洞
 *
 * 仓库里已有的「洗敏感」是零散的：
 *   · src/server/candidates.mjs 的 redact() —— 给失败归因取证据用的**简化版**：
 *     只认三四种形态，且把整段换成「<凭据已抹除>」，**长度变了、形状没了**；
 *   · 面板/日志里手写的零星正则。
 *
 * 缺的是**一处成体系的、可复用、口径窄**的脱敏：凡是**要落盘**或**要发给人看**
 * 的文本（台账、日志、错误正文、面板状态）都该先过它一道，而现在的口径
 * 既**漏**（JWT、cookie、邮箱、各家 token 形态都不认）又**宽**
 * （>24 字符的任意串一律抹，模型名、base64 化的普通词全被误伤）。
 *
 * 本仓库最硬的一条规矩是「真实 API Key / JWT 绝不能进日志、面板状态、任何落盘文件」。
 * 这条规矩至今靠的是「写的时候小心」，没有一个能复用的闸门 —— 这就是本模块。
 *
 * ## magpie 的对应物
 *
 * yetone/magpie 的 internal/redact/（redact.go + known.go + rules.go）：
 *   一张**正则 + 边界 + 旁证**的规则表，每条规则带 kind / markers / bound / ok / at
 *   五个判据；命中的值换成 {{KIND_hash}} 占位符，vendor 答回来时 Restore() 换回原值。
 *   规则表本身（redact.go:120-180）我们基本照抄：形态、边界、占位符的名字。
 *
 * ## 与 magpie 的差异（三处，都是有意的）
 *
 * ① **不换占位符，换「等长掩码」。**
 *    magpie 的目标是「vendor 看不见真值、agent 看得见真值」，靠进程内的值表 +
 *    往返还原；本模块的目标是「**落盘的那一份**看不出真值」，所以掩码必须**自足**：
 *    输出不再需要任何还原能力，也没有谁会拿它去还原。
 *    代价：不能像 magpie 那样把整个值抹成一个 {{…}}（那会丢掉长度与形状），
 *    于是这里**头尾留几个字符、中间用 '*' 填满** —— 长度逐字不变，形状仍可辨。
 *
 * ② **不做 Restore、不做 known（已知值记忆）。**
 *    magpie 的 known.go 靠一张值表在**同一个进程**里认出「这个值以前见过」；
 *    本模块是**纯函数、无状态**：一段文本进、一段文本出，不依赖任何前一次调用，
 *    所以同一个值在两段不相干的文本里会被抹成两样。magpie 会给同一个占位符。
 *    对本模块无害 —— 我们要的是「看不出」，不是「同一个」；而且**不记值**正是
 *    「明文从不落到内存之外」的前提。
 *
 * ③ **口径更窄，只管凭据这一类。**
 *    magpie 的规则表还管身份证、银行卡、IBAN、IP、MAC —— 那是它「隐私」产品功能
 *    的一部分。本模块只管**凭据**，加邮箱/手机号是因为它们常跟凭据挤在同一段
 *    上游错误正文里（上游把请求里的东西原样回显）。**故意不做**的：信用卡、身份证、
 *    IBAN、IP、MAC —— 它们不是凭据，误伤代价（把一段正常的诊断文本搅乱）大于收益。
 *
 * ## 边界
 *
 *   · **零依赖、零 IO、零时钟** —— 纯函数，进什么出什么。
 *   · **不 import 本仓库任何其它模块** —— 它得能被单独 import 起来测。
 *   · **长度不变**：redact(s).length === s.length（逐字相等，不是「大概」）。
 *   · **不判断「这段要不要留」** —— 那是调用方的事；这里只回答「这段里哪些是凭据」。
 */

/* ====================================================================== *
 * 规则表
 *
 * 抄 magpie internal/redact/redact.go:120-180 的形态与边界，但口径按本仓库收窄。
 * 每条规则：kind（归类）、re（找）、pick（抹哪几段）、min（短于此不抹）、
 * guard（额外的判据）。
 * ====================================================================== */

/** 归类名。台账与日志按它归类，不按规则顺序归类。 */
export const KINDS = Object.freeze([
  "API_KEY",
  "AUTH_HEADER",
  "BEARER",
  "COOKIE",
  "JWT",
  "SECRET",
  "PASSWORD",
  "EMAIL",
  "PHONE",
  "HEX",
  "BASE64",
]);

/** 形状类掩码：保留「前缀 + 尾巴」，中间全用 '*'。 */
const SHAPE = Object.freeze({ mode: "shape", tail: 4 });

/** 定长类掩码：头尾各留固定几个字符。 */
function flat(head, tail) {
  return { mode: "flat", head, tail };
}

/**
 * 每类掩码留多少。
 *
 * 头留得比尾多：头是**形状**（sk- / eyJ / ghp_），尾是**定位**（末尾几位，
 * 用来在多行日志里认出是哪一条）。两头都只留几个 —— 留全了等于没脱敏。
 */
const KEEP = {
  API_KEY: SHAPE,
  BEARER: SHAPE,
  AUTH_HEADER: SHAPE,
  JWT: SHAPE,
  BASE64: SHAPE,
  HEX: SHAPE,
  COOKIE: SHAPE,
  SECRET: flat(2, 2),
  PASSWORD: flat(1, 1),
  EMAIL: { mode: "custom", fn: maskEmail },
  PHONE: flat(3, 2),
};

/**
 * 邮箱的掩码：**保留结构**（'@' 与域名里的点），其余抹掉。
 *
 * 为什么邮箱要单独一套：邮箱的形状就是那个 '@' 和那几点。
 * 把 '@' 也抹成 '*'，日志里就只剩一串星 —— 看的人不知道这里本来是个邮箱，
 * 那就等于「这里曾经有个被抹掉的东西」，定位价值全没了。
 * 域名保留 TLD（.com/.cn）：它不指向个人，却是判断「公司邮箱还是私人邮箱」
 * 最有用的一条线索。
 */
function maskEmail(raw) {
  const at = raw.lastIndexOf("@");
  if (at < 0) return "*".repeat(raw.length);
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const dHead = dot >= 0 ? domain.slice(0, dot) : domain;
  const tld = dot >= 0 ? domain.slice(dot) : "";
  const localOut = local.length <= 1 ? "*".repeat(local.length) : local[0] + "*".repeat(local.length - 1);
  const headOut = dHead.length <= 1 ? "*".repeat(dHead.length) : dHead[0] + "*".repeat(dHead.length - 1);
  return localOut + "@" + headOut + tld;
}

/** 整个匹配都抹。 */
function whole(m) {
  return [[m.index, m.index + m[0].length]];
}

/** 只抹第 n 个捕获组（组没参与时返回空）。 */
function group(n) {
  return (m) => {
    const idx = m.indices[n];
    return idx ? [[idx[0], idx[1]]] : [];
  };
}

/**
 * Cookie 的掩码：只抹每个 `name=value` 的**值**，名字留着。
 *
 * 整段抹掉的话，「这请求带了哪个 cookie」这条诊断线索也一起没了，
 * 而 cookie 名往往正是判断「是不是登录态掉了」的关键。
 */
function cookieValues(m) {
  const idx = m.indices[1];
  if (!idx) return [];
  const out = [];
  let off = idx[0];
  for (const part of m[1].split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0) {
      const a = off + eq + 1;
      const b = off + part.length;
      if (b > a) out.push([a, b]);
    }
    off += part.length + 1;
  }
  return out;
}

/**
 * 值长得「像凭据」吗（有数字也有字母）。
 *
 * 这一条是**误伤与漏伤的分界线**，所以取窄的那一侧：
 * 只有「有数字也有字母」（或「长且大小写混」）才算凭据。
 * 宽的那一侧（只要够长就算）会把日志里的普通词、状态值、时间戳全抹掉 ——
 * 那些抹掉之后，日志就没法读了，而它本来就不是秘密。
 */
function looksSecret(v) {
  if (!v || v.length < 8) return false;
  if (isPlaceholder(v)) return false;
  if (/\d/.test(v) && /[A-Za-z]/.test(v)) return true;
  // 纯字母的长口令（CorrectHorseBatteryStaple 这种）也得认
  return v.length >= 16 && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

/**
 * 长得像「占位符/引用」而不是真值的东西，不抹。
 *
 * 抹掉 `${API_KEY}` 之类只会让日志变得没法读，而它本来就不含秘密。
 */
function isPlaceholder(v) {
  if (/^[$%{<[*]/.test(v)) return true; // ${X} <X> %X {X} *X
  if (/^(null|undefined|none|nil|true|false|empty|redacted|removed|omitted|none)$/i.test(v)) return true;
  if (/(^|[.\s])(env|environ)\b/i.test(v)) return true; // process.env.X / os.environ
  if (/^[A-Z][A-Z0-9_]*$/.test(v) && v.length <= 40) return true; // 环境变量名
  return false;
}

/**
 * 文件名，不是邮箱。
 *
 * magpie 在 #3029 上踩过：一张图被存成 `261020_14-16-11@2x.jpg`，发去模型时
 * 整段被当成邮箱抹了，模型再也读不出那个文件。
 * 判据是 @ 后面那截的**后缀**在不在常见文件扩展名表里。
 */
const FILE_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "avif", "bmp", "tif", "tiff",
  "ico", "icns", "pdf", "psd", "zip", "mp4", "mov", "mkv", "avi", "webm", "mp3",
  "wav", "flac", "ttf", "otf", "woff", "woff2", "json", "yaml", "yml", "toml",
  "xml", "txt", "csv", "tsv", "log", "html", "htm", "css", "js", "mjs", "ts",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "gz", "tar", "rar", "7z",
]);

function isFileHost(email) {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const host = email.slice(at + 1).toLowerCase();
  const dot = host.lastIndexOf(".");
  if (dot < 0) return false;
  return FILE_EXT.has(host.slice(dot + 1));
}

/**
 * 长随机串（base64 / base64url）吗。
 *
 * 判据四条同时成立才算：
 *   ① 够长（32+）——短的 id、模型名、哈希前缀都不到这条线；
 *   ② 大小写都有、还有数字 —— 全小写的长英文词（标识符、句子）不是随机串；
 *   ③ '-' 与 '_' 加起来不超过 3 个 —— 模型名几乎全是这种短横线串
 *      （anthropic/claude-opus-4-1-20250805），真随机串里的分隔符很少。
 * 这三条一起把「模型名被当密钥抹掉」这个最大的误伤源挡在外面。
 */
function looksRandom(v) {
  if (!/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/\d/.test(v)) return false;
  let seps = 0;
  for (const ch of v) if (ch === "-" || ch === "_") seps++;
  return seps <= 3;
}

/**
 * 规则表。
 *
 * 顺序有讲究：形态明确的排前面（API_KEY、JWT、BEARER…），
 * 兜底的（长 hex、长 base64）排最后 —— 同一起点同样长度时，**先到的赢**，
 * 所以 `sk-ant-…` 归 API_KEY 而不是归 BASE64。
 */
const RULES = [
  {
    /* ① OpenAI / Anthropic 风格：sk-…（含 ant-/proj-/or- 等变体）。 */
    kind: "API_KEY",
    re: /(?<![A-Za-z0-9_-])(?:sk|rk|pk)-(?:ant|proj|or|svcacct|admin|live|test)?-?[A-Za-z0-9_-]{20,}/g,
    pick: whole,
    min: 20,
  },
  {
    /* ② 中转/网关自己的 key：oc_sk_… / or_sk_…（magpie #195）。 */
    kind: "API_KEY",
    re: /(?<![A-Za-z0-9_-])[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}/g,
    pick: whole,
    min: 20,
  },
  {
    /* ③ 其它各家的 token 形态（照抄 magpie redact.go:130-145）。 */
    kind: "API_KEY",
    re: /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[0-9A-Za-z-]{10,}|(?:sk|rk)_live_[0-9A-Za-z]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|xai-[A-Za-z0-9]{40,}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/g,
    pick: whole,
    min: 20,
  },
  {
    /* ④ JWT：三段 base64url 用 . 连着。
     *    头段必然以 eyJ 开头（base64url 之后的 JSON 头）—— 这是把「三段点分」
     *    收窄成「JWT」的关键，否则任何 a.b.c 的点分串都会被抹。
     *    签名段可以为空（alg:none 那类），所以是 {0,}。 */
    kind: "JWT",
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    pick: whole,
    min: 20,
  },
  {
    /* ⑤ 头部里的凭据：authorization / x-api-key / x-refresh-token …
     *    凭据本体在第 1 组，头名与「Bearer 」这类方案词留着 —— 那是诊断线索。
     *    名字后面那个可选的引号是给 JSON 里的 "authorization": "…" 用的 ——
     *    少了它，JSON 里的头一个都认不出来。 */
    kind: "AUTH_HEADER",
    re: /(?:^|[\s,{;])(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token|x-refresh-token|anthropic-api-key)["']?\s*[:=]\s*(?:(?:bearer|basic|token|digest)\s+)?([^\s"',;\]}]{8,})/gimd,
    pick: group(1),
    min: 8,
  },
  {
    /* ⑥ Bearer / Basic 头里裸着的那串。 */
    kind: "BEARER",
    re: /(?<![A-Za-z0-9])(?:bearer|basic|digest)\s+([A-Za-z0-9\-._~+/]{12,}={0,2})/gimd,
    pick: group(1),
    min: 12,
  },
  {
    /* ⑦ Cookie：只抹值，名字留着。 */
    kind: "COOKIE",
    re: /(?:^|[\s,{;])(?:cookie|set-cookie)\s*[:=]\s*([^\r\n]{1,})/gimd,
    pick: cookieValues,
    min: 4,
  },
  {
    /* ⑧ 赋值式凭据：password=… / api_key: "…" / DB_PASSWORD = …
     *    名字里带关键词、值长得像凭据，才算。
     *    `token: expired`、`tokenizer: …` 这种**不算**（词边界挡掉了）。
     *    排在形态规则之后：`key=sk-ant-…` 该显示成 API_KEY 的样子，
     *    而不是退化成一条看不出形状的赋值。 */
    kind: "SECRET",
    re: /((?:[A-Za-z0-9]+[_\-.])*(?:password|passwd|secret|token|api[_\-]?key|access[_\-]?key|client[_\-]?secret|credential|private[_\-]?key|refresh[_\-]?token|auth[_\-]?token)(?:[_\-.][A-Za-z0-9]+)*(?![A-Za-z0-9])["']?\s*[:=]\s*)(["']?)([^\s"',;]{8,})/gimd,
    pick: group(3),
    min: 8,
    guard: looksSecret,
  },
  {
    /* ⑨ 名为 key 的字段：providers.json 里就是 "key": "…" 这种。
     *    要求长且像凭据 —— 代码里 "key" 太泛（map 的键、sort_key、keyboard）。 */
    kind: "SECRET",
    re: /(?:^|[^A-Za-z0-9_.\-])(?:key|apiKey)["']?\s*[:=]\s*(["']?)([^\s"',;]{16,})/gimd,
    pick: group(2),
    min: 16,
    guard: looksSecret,
  },
  {
    /* ⑩ URL 里的口令：https://user:pass@host */
    kind: "PASSWORD",
    re: /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/?#"'<>\/]+:)([^\s@/?#"'<>\/]{3,})@/gimd,
    pick: group(2),
    min: 3,
  },
  {
    /* ⑪ 邮箱。fileExt 那条是 magpie #3029 的教训。 */
    kind: "EMAIL",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g,
    pick: whole,
    min: 6,
    guard: (v) => !isFileHost(v),
  },
  {
    /* ⑫ 手机号（国内号段）。前后不许挨着数字，否则 13 位时间戳会被切出来。 */
    kind: "PHONE",
    re: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g,
    pick: whole,
    min: 11,
  },
  {
    /* ⑬ 长十六进制：哈希、摘要、十六进制的 key。 */
    kind: "HEX",
    re: /(?<![A-Za-z0-9_-])[0-9a-fA-F]{32,}(?![A-Za-z0-9_-])/g,
    pick: whole,
    min: 32,
  },
  {
    /* ⑭ 长 base64 / base64url：无前缀可认的凭据只剩这一条兜底。 */
    kind: "BASE64",
    re: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])/g,
    pick: whole,
    min: 32,
    guard: looksRandom,
  },
];

/* ====================================================================== *
 * 掩码
 * ====================================================================== */

/**
 * 形状头：这个值**开头那段能认出它是什么**的部分。
 *
 * 取开头最多 8 个字符的词串，遇到分隔符（- 或 _）就停在那后面：
 *   sk-ant-api03-… → "sk-ant-"（认得出是 Anthropic）
 *   ghp_ABCDEFG…    → "ghp_"（认得出是 GitHub）
 *   AIzaSyABCDEFG…  → "AIza"（没有分隔符，只留 4 个）
 * 认不出形状的（纯随机）只留 4 个字符。
 */
function shapeHead(v) {
  const cap = 8;
  let run = 0;
  while (run < v.length && run < cap && /[A-Za-z0-9_-]/.test(v[run])) run++;
  if (run === 0) return 0;
  let cut = -1;
  for (let i = 0; i < run; i++) if (v[i] === "-" || v[i] === "_") cut = i;
  if (cut >= 0) return cut + 1;
  return Math.min(4, run);
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 把一段值换成「等长的掩码」。
 *
 * 长度**逐字不变**：这是本模块的硬契约（redact(s).length === s.length）。
 * 不变长的好处：日志里凭据那一行的位置、字符偏移都对得上，定位一条记录时
 * 不用重新数位置；而且「长度」本身也是一条线索（key 有 48 位），
 * 把整段删掉反而把它一起删了。
 */
function maskValue(raw, kind) {
  const n = raw.length;
  if (n <= 0) return raw;
  const keep = KEEP[kind] || KEEP.SECRET;
  if (keep.mode === "custom") return keep.fn(raw);
  let h;
  let t;
  if (keep.mode === "shape") {
    h = Math.min(shapeHead(raw), n);
    t = Math.min(keep.tail, n - h);
  } else {
    h = Math.min(keep.head, n);
    t = Math.min(keep.tail, n - h);
  }
  // 至少得抹掉一个字符 —— 全留下等于没脱敏
  while (h + t >= n) {
    if (t > 0) t--;
    else if (h > 0) h--;
    else break;
  }
  let mid = n - h - t;
  if (mid <= 0) return "*".repeat(n);
  // 别把代理对劈开：劈开了输出就不是合法的 UTF-16 了
  if (h > 0 && h < n && isHighSurrogate(raw.charCodeAt(h - 1))) h--;
  if (t > 0 && n - t > 0 && isLowSurrogate(raw.charCodeAt(n - t))) t--;
  mid = n - h - t;
  return raw.slice(0, h) + "*".repeat(mid) + (t > 0 ? raw.slice(n - t) : "");
}

/* ====================================================================== *
 * 主流程
 * ====================================================================== */

/**
 * 找出 s 里所有该抹的区间。
 *
 * 规则表逐条跑，命中的区间交给下面排重叠。
 */
function findSpans(s, kinds) {
  const spans = [];
  for (let r = 0; r < RULES.length; r++) {
    const rule = RULES[r];
    if (kinds && !kinds.has(rule.kind)) continue;
    for (const m of s.matchAll(rule.re)) {
      if (m[0].length === 0) continue;
      const picked = rule.pick(m);
      for (const [a, b] of picked) {
        if (b <= a) continue;
        if (a < 0 || b > s.length) continue;
        const value = s.slice(a, b);
        if (value.length < rule.min) continue;
        if (rule.guard && !rule.guard(value)) continue;
        spans.push({ start: a, end: b, kind: rule.kind, order: r });
      }
    }
  }
  return spans;
}

/**
 * 排重叠、逐段掩码。
 *
 * 排序口径（照抄 magpie redact.go 的 apply）：**起点靠前优先；同起点，长的优先；
 * 同起点同长，规则表里靠前的优先**。
 * 靠前的赢是刻意的 —— 同一个值被两条规则认出来时，它该是什么类别要**每次都一样**，
 * 否则同一份凭据在两条日志里会显示成两种形状，排查的人会以为是两回事。
 */
function applySpans(s, spans) {
  if (!spans.length) return { text: s, hits: [] };
  spans.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const kept = [];
  let last = 0;
  for (const sp of spans) {
    if (sp.start < last) continue;
    kept.push(sp);
    last = sp.end;
  }
  if (!kept.length) return { text: s, hits: [] };
  let out = "";
  let cur = 0;
  const byKind = new Map();
  for (const sp of kept) {
    out += s.slice(cur, sp.start);
    const raw = s.slice(sp.start, sp.end);
    out += maskValue(raw, sp.kind);
    const agg = byKind.get(sp.kind) || { kind: sp.kind, count: 0, chars: 0 };
    agg.count += 1;
    agg.chars += raw.length;
    byKind.set(sp.kind, agg);
    cur = sp.end;
  }
  out += s.slice(cur);
  return { text: out, hits: [...byKind.values()] };
}

/**
 * 把一段文本里的凭据换成等长的掩码。
 *
 * @param {unknown} text 要洗的文本（非字符串按字符串处理，null/undefined → ""）
 * @param {{kinds?: string[]}} [opts] kinds 限定只洗哪几类（默认全洗）
 * @returns {string} 长度与输入逐字相同的文本
 */
export function redact(text, opts = {}) {
  const s = text == null ? "" : String(text);
  if (s === "") return "";
  const kinds = opts && Array.isArray(opts.kinds) ? new Set(opts.kinds) : null;
  return applySpans(s, findSpans(s, kinds)).text;
}

/**
 * 脱敏，并报告「洗掉了什么」。
 *
 * 台账要记「这一条里有没有凭据」时用这个；只要文本的话用 redact() 就够。
 *
 * @returns {{text: string, hits: {kind: string, count: number, chars: number}[]}}
 */
export function redactWithHits(text, opts = {}) {
  const s = text == null ? "" : String(text);
  if (s === "") return { text: "", hits: [] };
  const kinds = opts && Array.isArray(opts.kinds) ? new Set(opts.kinds) : null;
  return applySpans(s, findSpans(s, kinds));
}

/**
 * 这段文本里有没有凭据。
 *
 * 与 redact() 共用同一张规则表 —— 判据和洗的时候**必须一致**，
 * 否则会出现「面板说没有凭据、日志里却有」这种对不上的情况。
 */
export function hasSecret(text, opts = {}) {
  const s = text == null ? "" : String(text);
  if (s === "") return false;
  const kinds = opts && Array.isArray(opts.kinds) ? new Set(opts.kinds) : null;
  return findSpans(s, kinds).length > 0;
}

/**
 * 深拷贝一份并把里面所有字符串洗掉。
 *
 * 只处理 plain object / 数组；函数、Date、Buffer 之类原样带着（它们不是文本）。
 * 循环引用的对象只展开一层（用 WeakSet 记住来路），再深就栈溢出了 ——
 * 而台账/日志这类数据不该有循环引用，撞上了也不该把进程带崩。
 */
export function redactDeep(value, opts = {}, seen = new WeakSet()) {
  if (typeof value === "string") return redact(value, opts);
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts, seen));
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = redactDeep(value[key], opts, seen);
  }
  return out;
}
