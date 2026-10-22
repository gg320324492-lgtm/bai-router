/**
 * backup.mjs —— 配置快照 / 加密导出 / 解密导入
 * （纯逻辑、零 IO、零时钟、不依赖本仓库任何模块）
 *
 * ## 它补的是哪个洞
 *
 * 本项目吃过大亏：**用户配置被读失败当成空对象再写回去，用户的配置当场蒸发**
 * （那件事的教训写在 src/server/edit-json.mjs 的头注释里）。那次是「改文件」出的事，
 * 这一次要补的是另一半：**换电脑 / 重装时，配置根本不在了**。
 * `%APPDATA%\bai-router\config.json` 里有八家提供方的真实 API Key / JWT，
 * `~/.claude/settings.json` 里有用户自己写的权限与钩子——重装一次这些全没了，
 * 用户要一家一家重新配、重新登录、重新踩一遍已经踩过的坑。
 *
 * 本模块只做三件事，且**一个字节都不碰磁盘**：
 *   snapshotOf(cfg, opts)            —— 把配置变成一份「可迁移的快照」（带得走的 / 故意不带得分开）
 *   exportBundle(snapshot, pass, o)  —— 快照封成一段可保存的字节（带完整性校验）
 *   importBundle(bytes, pass, o)     —— 解密 + 校验 + 还原成快照；口令错/被改过 → 明确报错
 * 外加 restoreConfig(snapshot, cur) —— 把快照**合并**回当前配置（本机专属字段保持本机的）。
 *
 * ## 对标 magpie 的哪个文件
 *
 *   yetone/magpie  internal/backup/backup.go —— Bundle / Collect / Seal / Open
 *   yetone/magpie  internal/backup/data.go   —— 同一套封口给「非备份」的数据用
 *
 * 照抄的部分：
 *   · KDF = PBKDF2-HMAC-SHA256，迭代 600000 次（magpie backup.go:46 的 iterations）；
 *     读回时校验 100000 ≤ iterations ≤ 10000000（backup.go:310）；
 *   · 密钥 32 字节、IV 12 字节、盐 16 字节；
 *   · **信封自己的字段（格式/版本/KDF/迭代数/盐）进 AEAD 的附加认证数据（AAD）**
 *     ——magpie 的 header(e)（backup.go:330）：改了任何一个都开不出来；
 *   · **口令错与文件被改过不区分**（AEAD 的性质，谁也分不出来）：magpie 的
 *     ErrPassphrase「wrong passphrase, or the file was changed」，本模块照抄这个口径。
 *
 * ## 与 magpie 有意不同的点（及原因）
 *
 * 1. **容器是二进制，不是 JSON 信封。**
 *    magpie 的 envelope 是 JSON（MarshalIndent），本模块用固定 44 字节的头 + 密文 + 标签。
 *    原因：JSON 信封只能靠「开头是不是 `{"format":"magpie-backup"`」这种**启发式**
 *    判断「这是不是我们的文件」（magpie backup.go:54 的 isBackupJSON），而 magpie 自己
 *    就因此踩过坑——被截断的备份头部长得跟完好的一模一样，害得 syncOnce 得多做一整套
 *    「前缀比对 + 缓存整份好副本」才能判断文件是不是被截断（davsync.go:1139-1169）。
 *    固定 magic 头让「不是我们的文件」与「是我们的文件但坏了」分开只需要一次字节比较。
 *
 * 2. **字段是白名单，不是黑名单。**
 *    magpie 靠 Go 的结构体天然是白名单；本模块在 JS 里必须自己写一张表。
 *    若写成黑名单（列出「不带走的字段」），将来 config.json 里新增一个运行态字段
 *    （比如 `_modelsSynced` 那种「上次同步到哪个版本」的标记）会**默认被带走**，
 *    然后在对面的机器上复活。白名单相反：新增字段默认不带，要带走必须显式加进表里——
 *    漏带的代价是「少带一个字段」，漏屏蔽的代价是「把别台机器的运行态搬过来」，后者更难查。
 *
 * 3. **快照按「部件（part）」分桶，同步层才能按部件合并。**
 *    magpie 的 Bundle 有 Providers / Settings / Profiles / Agents / Library 五个部件，
 *    davsync 逐部件比哈希来合并（davsync.go:1174-1203）。本模块的三个部件是
 *    providers / settings / claude，取舍见 PART_NAMES 的注释。
 *
 * 4. **不实现 magpie 的「用上次读到的整份好副本重建远端」那条路。**
 *    那条路（davsync.go:1139-1169）要求 IO 层保留上一份完整副本的缓存，
 *    而本模块零 IO。远端文件坏了由 sync 层**停下并说清楚**，不偷偷重建——
 *    偷偷重建可能把另一台机器更新的配置覆盖掉。
 *
 * ## 边界（刻意不做的事）
 *
 *   · **不 import 本仓库任何模块**（edit-json.mjs 尤其不许）：那套是「改文件字节」的
 *     语义（保注释、保键序、保缩进、保 BOM/CRLF），本模块是「整份打包」的语义，
 *     两回事；混起来会把「打包」也做成「就地改字节」。
 *   · **不读磁盘、不写盘、不联网**：读用户的 config.json、写回用户的 config.json
 *     都由调用方做——而且**必须**沿用 edit-json.mjs 那套「改用户的文件时不丢任何东西」
 *     的写法，那不是本模块该管的。
 *   · **不取 Date.now()**：时刻一律由 opts.now 传入，整个模块可测、可回放。
 *   · **不写明文**：导出产物只有密文。快照里的凭据在封口前一直是内存里的普通对象，
 *     这跟本仓库 config.json 的处境一样（明文只落本机、已 gitignore）。
 */

import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/* ====================================================================== *
 * 常量
 * ====================================================================== */

export const APP_NAME = "bai-router";

/** 快照的格式标识：换格式时旧快照要能说清「不认识」，而不是被当成空的。 */
export const SNAPSHOT_FORMAT = "bai-router-backup";
export const SNAPSHOT_VERSION = 1;

/** 容器 magic：6 字节。读回时第一个字节对不上就**根本不是我们的文件**。 */
export const BUNDLE_MAGIC = "BAIRBK";
export const BUNDLE_VERSION = 1;
/** KDF 编号：1 = PBKDF2-HMAC-SHA256。加新算法时另编号，老文件照旧开。 */
export const KDF_PBKDF2_SHA256 = 1;

/**
 * PBKDF2 迭代次数。
 *
 * 600000 是 OWASP 对 PBKDF2-HMAC-SHA256 的现行建议，也是 magpie 的取值
 * （backup.go:46）。备份口令通常比密码短、熵低，迭代次数就是这份文件唯一的防线，
 * 少一个数量级就等于把「猜口令」这件事变便宜十倍。
 */
export const KDF_ITERATIONS = 600000;
/** 读回时的下限与上限：太低的迭代数说明文件被改过或来自更弱的实现。 */
export const MIN_KDF_ITERATIONS = 100000;
export const MAX_KDF_ITERATIONS = 10000000;

export const SALT_LEN = 16;
export const NONCE_LEN = 12;
export const KEY_LEN = 32;
export const TAG_LEN = 16;

/** 容器头的长度：magic(6) + 版本(1) + KDF(1) + 迭代数(4) + 盐(16) + IV(12) + 保留(4)。 */
export const HEADER_LEN = 44;

/**
 * 快照的三个部件。
 *
 * 拆成三块的理由：用户往往在**不同的机器上改不同的东西**——
 * A 机器换了个 Key，B 机器调了模型映射。按整份比哈希的话，B 机器的一次改动
 * 会把 A 机器刚换的 Key 一起顶掉。部件粒度就是 magpie 逐部件合并的前提。
 *
 *   providers —— 八家提供方的凭据、端点、模型清单与映射（各家的配置块）
 *   settings  —— 全局设置（目前只有 failover 链）
 *   claude    —— Claude Code 那侧的 ~/.claude/settings.json（去掉路由台自己写的 env）
 *
 * 为什么不按「凭据 / 映射」再拆一层：magpie 的部件粒度就是「一份设置一块」，
 * 本模块跟它对齐，不另发明一套更细的口径——细到凭据与映射分开会让
 * 「同一个渠道的凭据和端点被拆到两个部件」这种半吊子状态出现。
 */
export const PART_NAMES = ["providers", "settings", "claude"];

/**
 * 渠道块里「带得走」的字段（白名单）。
 *
 * 凭据 + 端点 + 模型偏好：换台机器这些还是同一个意思。
 * 刻意不在表里的：relayPort（端口）、useProxy（走不走代理）、transport（本机的
 * OpenCode 传输层）、tokenFile / modelsFile（指向本机某个文件的绝对路径）——
 * 换台机器它们全是错的，带过去只会把对面的请求打到不存在的端口/文件上。
 */
export const PROVIDER_TRAVEL_FIELDS = [
  "apiKey", "token", "accessToken", "refreshToken", "deviceToken", "userId",
  "keys", "balanceToken", "accessKeyId", "secretAccessKey",
  "upstream", "defaultModel", "availableModels", "mapping",
];

/**
 * 根级「本机专属」字段：端口、代理、网关开关。
 * 导出成常量是为了让测试能逐个断言「它们绝不出现在快照里」——
 * 写成注释就只是许愿。
 */
export const LOCAL_ONLY_ROOT_FIELDS = ["proxy", "relayPort", "panelPort", "gatewayPort", "gatewayMode"];

/** 渠道块里的本机专属字段（同上，导出成常量是为了能被断言）。 */
export const LOCAL_ONLY_PROVIDER_FIELDS = ["relayPort", "useProxy", "transport", "tokenFile", "modelsFile"];

/** 纯运行态的标记：上次同步到哪个版本 —— 换台机器没有意义，绝不带走。 */
export const RUNTIME_ROOT_FIELDS = ["_modelsSynced"];

/** 根级里**不是渠道块**的键：它们要么进 settings 部件，要么是本机专属。 */
const GLOBAL_ROOT_KEYS = new Set([
  ...LOCAL_ONLY_ROOT_FIELDS,
  ...RUNTIME_ROOT_FIELDS,
  "failover",
]);

/** settings 部件里带得走的字段。 */
const SETTINGS_TRAVEL_FIELDS = ["failover"];
/** failover 块里带得走的字段。 */
const FAILOVER_TRAVEL_FIELDS = ["enabled", "chain"];

/**
 * 渠道块里算「凭据」的字段：「不带凭据导出」时这些一律清空。
 *
 * userId 不算凭据：它是账号的标识，不是秘密，带着它用户在别的机器上
 * 还能认出「这是哪个账号」，只是没有那把钥匙（magpie 的 withoutKeys 同理：
 * 留下名字与 id，只把 key 清空）。
 */
const CREDENTIAL_FIELDS = [
  "apiKey", "token", "accessToken", "refreshToken", "deviceToken",
  "balanceToken", "accessKeyId", "secretAccessKey",
];

/**
 * 路由台自己写进 ~/.claude/settings.json 的 env 键。
 *
 * 它们指向本机的 127.0.0.1:端口，搬到别的机器上必然是错的（端口都可能不同），
 * 所以**不带走**。名单对着 server.mjs 的 applyCcSettings 抄。
 * 漏一个的后果：新机器上的 Claude Code 指向一个不存在的旧端口，且症状是
 * 「连不上」而不是「配置不对」，很难往备份上想。
 */
export const ROUTER_OWNED_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "NODE_USE_ENV_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
];

/**
 * 看着像密钥的环境变量名（magpie 的 provider.SecretHeader，同一条正则）。
 * 「不带凭据导出」时，这些一律清空。
 */
const SECRET_NAME = /auth|key|token|secret|cookie|session|password/i;

/* ====================================================================== *
 * 错误
 * ====================================================================== */

/**
 * 本模块抛的全部错误都是这一个类，带一个 code。
 *
 * 为什么要有 code：调用方（面板）要分「口令打错了」和「这个文件根本不是备份」，
 * 前者该让用户重输，后者该让用户去选文件——两者的处置完全不同，
 * 只靠 message 里的一句话去匹配，等于把判断写回每个调用点。
 */
export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

/* ====================================================================== *
 * 小工具
 * ====================================================================== */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clone(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}

function pick(obj, fields) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(obj, f)) continue;
    if (obj[f] === undefined) continue;
    out[f] = clone(obj[f]);
  }
  return out;
}

/**
 * 规范 JSON：对象的键按字典序排好再拼。
 *
 * 为什么：导出的字节要能逐字复现（同一份快照 + 同一份盐/IV ⇒ 同一段字节），
 * 否则测试没法断言「改一个字节 ⇒ 一定报错」。
 * 键序也要定死：同一份内容用不同的键序写出来（用户手改过 config.json、
 * 或者从别的机器带过来的）不该算成两个不同的东西——
 * JSON.stringify 不排序键，而排序不排序只差几行，却直接决定哈希对不对得上。
 *
 * （sync.mjs 里有一份逐字相同的 canonicalJson：两个模块不许互相 import，
 *   改一处必须改另一处。）
 */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

function requireNow(now) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new BackupError(
      "NO_TIME",
      "需要 opts.now（毫秒时间戳）：本模块不取 Date.now()，时刻一律由调用方给",
    );
  }
  return now;
}

function requirePassphrase(pass) {
  if (typeof pass !== "string" || pass.length === 0) {
    throw new BackupError("NO_PASSPHRASE", "备份要用口令封起来：没有口令的备份等于把配置明文摊在磁盘上");
  }
  return pass;
}

/* ====================================================================== *
 * ① 快照
 * ====================================================================== */

/**
 * 把配置变成一份可迁移的快照。
 *
 * cfg   —— 当前配置（%APPDATA%\bai-router\config.json 的内容，已解析）
 * opts.now       —— 快照的时刻（毫秒）。必填。
 * opts.keys      —— 是否带走凭据。默认 true；false 时凭据一律清空（magpie 的 Collect(keys)）。
 * opts.claude    —— ~/.claude/settings.json 的内容（已解析）。给了就带走（去掉路由台自己写的 env）。
 * opts.appVersion—— 写下这份快照的路由台版本，写进快照里便于日后认账。
 *
 * cfg 传 null / undefined / 非对象 → **明确报错**，不当成空配置：
 * 调用方读不出来就该自己停。「读不出来」和「本来就是空的」是两件事，
 * 把前者当成后者再打包带走，正是本仓库吃过大亏的那个错误的另一副面孔。
 */
export function snapshotOf(cfg, opts = {}) {
  const now = requireNow(opts.now);
  if (!isPlainObject(cfg)) {
    throw new BackupError("BAD_CONFIG", "配置不是一个对象：读不出来就别当成空的");
  }
  const keys = opts.keys !== false;

  /* providers：根级平铺的那一份就是 bai（仓库里 bai 没有自己的子对象），
     其它根级的对象值就是各家渠道块。 */
  const providers = { bai: pickProvider(cfg, keys) };
  for (const name of Object.keys(cfg)) {
    if (GLOBAL_ROOT_KEYS.has(name)) continue;
    if (!isPlainObject(cfg[name])) continue;
    providers[name] = pickProvider(cfg[name], keys);
  }

  const settings = {};
  for (const f of SETTINGS_TRAVEL_FIELDS) {
    if (f === "failover") {
      if (isPlainObject(cfg.failover)) settings.failover = pick(cfg.failover, FAILOVER_TRAVEL_FIELDS);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(cfg, f) && cfg[f] !== undefined) settings[f] = clone(cfg[f]);
  }

  const claude = opts.claude == null ? null : pickClaude(opts.claude, keys);

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: now,
    app: { name: APP_NAME, version: String(opts.appVersion || "") },
    carriesKeys: keys,
    parts: { providers, settings, claude },
  };
}

/**
 * 一个渠道块里带得走的字段。
 *
 * keys 为 false 时（magpie 的 Collect(keys=false) / withoutKeys）：凭据一律清空，
 * 但**键还留着**（空串 / 空数组）——形状不变，用户能看出「这把钥匙没带走」，
 * 而不是以为「这个渠道本来就没配过」。
 */
function pickProvider(src, keys) {
  const out = pick(src, PROVIDER_TRAVEL_FIELDS);
  if (keys) return out;
  for (const f of CREDENTIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(out, f)) out[f] = "";
  }
  if (Array.isArray(out.keys)) out.keys = [];
  return out;
}

/**
 * Claude Code 那侧要带走的东西。
 *
 * 两类东西被剔除，理由不同：
 *   · 路由台自己写的 env（ROUTER_OWNED_ENV）：指向本机端口，带过去必错 → **删掉**。
 *   · 看着像密钥的 env（用户自己设的 ANTHROPIC_API_KEY 之类）：不带凭据导出时 → **清空**
 *     （magpie 的 withoutKeys 把凭据置空而不是删键，形状不变，用户能看出少了什么）。
 * 其余（permissions、hooks、statusLine……）是用户自己写的，**原样带走**——
 * 那些东西重装一次就再也写不回来了。
 */
function pickClaude(settings, keys) {
  const out = clone(settings);
  if (!isPlainObject(out)) return {};
  if (!isPlainObject(out.env)) {
    if (out.env === undefined) delete out.env;
    return out;
  }
  const env = {};
  for (const k of Object.keys(out.env)) {
    if (ROUTER_OWNED_ENV.includes(k)) continue;
    const v = out.env[k];
    if (!keys && typeof v === "string" && SECRET_NAME.test(k)) {
      env[k] = "";
      continue;
    }
    env[k] = clone(v);
  }
  out.env = env;
  return out;
}

/* ====================================================================== *
 * ② 导出（封口）
 * ====================================================================== */

/**
 * 把快照封成一段可保存的字节。
 *
 * 算法：**AES-256-GCM**（Node 内置 crypto，即 OpenSSL 的成熟实现），密钥由
 * **PBKDF2-HMAC-SHA256** 从口令派生。
 *
 * 为什么不用自己造的算法：自己造的密码学只有一个结局——被攻破，而且是那种
 * 「先被默默用几年、某天突然爆出来」的破法。GCM 一个原语同时给三样东西：
 * 机密性（读不到）、完整性（改一个字节就开不出来）、可认证（AAD 把容器头也管住）。
 * 自己拼「加密 + 校验和」十有八九会把校验和放在密文外面，于是攻击者可以改校验和
 * 一起重算——那等于没有校验。
 *
 * 为什么 KDF 要迭代：备份口令通常是人自己想的，熵低。迭代次数是这份文件唯一的
 * 防线，600000 次（OWASP 对 PBKDF2-HMAC-SHA256 的现行建议、magpie 的同值）
 * 让每猜一次口令的代价高到劝退。
 *
 * 为什么不用现成的「加密压缩包」格式（AES 加密的 zip）：那类格式把「密文里放什么」
 * 的自由度交给调用方，容器自己的完整性又常常只靠 CRC32；而且它们多半把
 * 口令派生次数写死在格式里，改不动。
 *
 * opts.salt / opts.nonce —— **必须可注入**：测试要逐字断言「同一份盐与 IV 下
 * 两次导出字节相同」，随机量不给注入就断言不了。生产不传就用随机。
 * opts.iterations —— 同上，默认 KDF_ITERATIONS。
 *
 * 返回 Buffer（是 Uint8Array 的子类，存盘直接 writeFileSync 即可）。
 */
export function exportBundle(snapshot, passphrase, opts = {}) {
  const pass = requirePassphrase(passphrase);
  assertSnapshot(snapshot);

  const salt = opts.salt == null ? randomBytes(SALT_LEN) : fixedBytes(opts.salt, SALT_LEN, "salt");
  const nonce = opts.nonce == null ? randomBytes(NONCE_LEN) : fixedBytes(opts.nonce, NONCE_LEN, "nonce");
  const iterations = opts.iterations == null ? KDF_ITERATIONS : opts.iterations;
  if (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new BackupError(
      "BAD_OPTION",
      `迭代次数必须在 ${MIN_KDF_ITERATIONS} 到 ${MAX_KDF_ITERATIONS} 之间（收到 ${iterations}）`,
    );
  }

  const header = buildHeader(iterations, salt, nonce);
  const key = pbkdf2Sync(pass, salt, iterations, KEY_LEN, "sha256");

  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  /* AAD = 容器头：版本、KDF、迭代数、盐、IV 全在里面。
     改了任何一个，认证就过不去——否则攻击者可以把迭代数改成 1、把盐换掉，
     让整份文件的防线自己塌下来。 */
  cipher.setAAD(header);
  const plain = Buffer.from(canonicalJson(snapshot), "utf8");
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, body, tag]);
}

function buildHeader(iterations, salt, nonce) {
  const h = Buffer.alloc(HEADER_LEN);
  h.write(BUNDLE_MAGIC, 0, "latin1");
  h[6] = BUNDLE_VERSION;
  h[7] = KDF_PBKDF2_SHA256;
  h.writeUInt32BE(iterations, 8);
  salt.copy(h, 12);
  nonce.copy(h, 28);
  /* 40..43 保留：写 0。它现在是空的，但留着它，以后加字段（比如「这是不是带凭据的
     备份」的标记）时头部长度不用变，向后兼容的解析就不用改。 */
  return h;
}

function fixedBytes(v, len, name) {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
  if (b.length !== len) {
    throw new BackupError("BAD_OPTION", `${name} 必须是 ${len} 字节（收到 ${b.length}）`);
  }
  return b;
}

/* ====================================================================== *
 * ③ 导入（开封）
 * ====================================================================== */

/**
 * 解开一段备份字节，还原成快照。
 *
 * 失败一律抛 BackupError，**绝不返回半个东西**：
 *   NOT_A_BUNDLE        —— 魔数不对 / 长度不对 / 头里的 KDF 或迭代数不合法
 *   UNSUPPORTED_VERSION —— 是备份，但格式版本比本模块新
 *   BAD_PASSPHRASE      —— 口令不对，或文件被改过（这两者分不出来，也不该分）
 *   BAD_SNAPSHOT        —— 解开了，但里面的东西不是一份快照
 *
 * 错误信息里说清楚「口令不对**或**文件被改过」而不是二选一：
 * GCM 的认证标签只能证明「有人动过其中一样」，分不出是哪样。
 * 猜错方向比猜错答案更耽误事——用户会以为文件坏了，去找备份，其实只是口令打错了一个字符。
 *
 * opts —— 预留（当前没有可调项）：迭代次数在容器头里，读回时按固定下限校验，
 * 调用方改不动它——那个下限是防线，不是参数。
 */
export function importBundle(bytes, passphrase, opts = {}) {
  const pass = requirePassphrase(passphrase);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buf.length < HEADER_LEN + TAG_LEN) {
    throw new BackupError("NOT_A_BUNDLE", "这段字节太短，不是一份完整的备份");
  }
  const header = buf.subarray(0, HEADER_LEN);
  if (header.subarray(0, BUNDLE_MAGIC.length).toString("latin1") !== BUNDLE_MAGIC) {
    throw new BackupError("NOT_A_BUNDLE", "这不是 B.AI 路由台的备份文件");
  }
  const version = header[6];
  if (version !== BUNDLE_VERSION) {
    throw new BackupError("UNSUPPORTED_VERSION", `备份格式版本 ${version} 不是本版本认识的（${BUNDLE_VERSION}）`);
  }
  const kdf = header[7];
  if (kdf !== KDF_PBKDF2_SHA256) {
    throw new BackupError("NOT_A_BUNDLE", "这个备份用了本版本不认识的密钥派生方式");
  }
  const iterations = header.readUInt32BE(8);
  if (iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new BackupError("NOT_A_BUNDLE", "备份头里的迭代次数不合法，这个文件不是本程序写的");
  }
  const salt = header.subarray(12, 12 + SALT_LEN);
  const nonce = header.subarray(28, 28 + NONCE_LEN);
  const body = buf.subarray(HEADER_LEN, buf.length - TAG_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);

  const key = pbkdf2Sync(pass, salt, iterations, KEY_LEN, "sha256");
  const dec = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  dec.setAAD(header);
  dec.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([dec.update(body), dec.final()]);
  } catch {
    /* 认证标签对不上：口令不对，或者密文/头被改过。
       这里**不能**退而求其次返回半截明文——半个快照比没有快照更坏：
       写回去就是把用户配置替换成一份残缺的东西。 */
    throw new BackupError("BAD_PASSPHRASE", "口令不对，或这个文件被改过");
  }

  let snap;
  try {
    snap = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new BackupError("BAD_SNAPSHOT", "备份解开了，但里面不是一份能读的快照");
  }
  return assertSnapshot(snap);
}

/**
 * 校验快照的结构。
 * 导出前也过这一遍：封一个结构坏掉的快照，等于把问题推到几周后解密失败的那一天。
 */
export function assertSnapshot(snap) {
  if (!isPlainObject(snap)) {
    throw new BackupError("BAD_SNAPSHOT", "快照不是一个对象");
  }
  if (snap.format !== SNAPSHOT_FORMAT) {
    throw new BackupError("BAD_SNAPSHOT", "这不是 B.AI 路由台的快照");
  }
  if (typeof snap.version !== "number" || !Number.isInteger(snap.version) || snap.version < 1) {
    throw new BackupError("BAD_SNAPSHOT", "快照的版本号不合法");
  }
  if (snap.version > SNAPSHOT_VERSION) {
    throw new BackupError("UNSUPPORTED_VERSION", `快照版本 ${snap.version} 比本版本新（${SNAPSHOT_VERSION}）`);
  }
  if (!isPlainObject(snap.parts)) {
    throw new BackupError("BAD_SNAPSHOT", "快照里没有部件");
  }
  return snap;
}

/* ====================================================================== *
 * ④ 还原（把快照合并回当前配置）
 * ====================================================================== */

/**
 * 把快照**合并**回当前配置，而不是整个替换掉。
 *
 * 为什么要合并而不是替换：用户在这台机器上已经调好的东西（端口、代理、
 * 本机的 OpenCode 传输层）不该被一份旧快照覆盖——那是 magpie 的 KeepOwn
 * （settings.go:1012）做的事：同步或还原带来的设置里，把「这台机器自己的」
 * 那些换回本机的原值。
 *
 * 还有一条同源的规矩：**不带凭据的快照还原过来时，不许把本机配好的凭据抹掉**。
 * 那份快照里的凭据格是空的（magpie 的 withoutKeys），直接盖上去就等于
 * 「还原一份不带钥匙的备份 ⇒ 把本机的钥匙也清空」——用户刚配好的 Key 当场消失。
 * magpie 的口径是「没带钥匙的那份，钥匙留本机的」（provider.KeepSecrets）。
 *
 * 返回 { config, claude, changed }：
 *   config —— 合并后的配置对象（调用方自己写盘，写法得走 edit-json.mjs 那套）
 *   claude —— 合并后的 Claude Code 设置；快照里没有这一部分时原样返回当前的
 *   changed —— 合并后的配置与当前配置是否真的不一样（面板可以据此决定要不要写盘）
 */
export function restoreConfig(snapshot, current, opts = {}) {
  const snap = assertSnapshot(snapshot);
  const cur = isPlainObject(current) ? current : {};
  const out = clone(cur);
  const providers = isPlainObject(snap.parts.providers) ? snap.parts.providers : {};
  const keepLocalKeys = snap.carriesKeys === false;

  for (const name of Object.keys(providers)) {
    const block = providers[name];
    if (!isPlainObject(block)) continue;
    if (name === "bai") {
      /* bai 平铺在根级：直接盖到根上。 */
      for (const k of Object.keys(block)) out[k] = clone(block[k]);
      if (keepLocalKeys) keepCredentials(out, cur);
      continue;
    }
    const base = isPlainObject(out[name]) ? out[name] : {};
    const merged = { ...base, ...clone(block) };
    if (keepLocalKeys) keepCredentials(merged, base);
    out[name] = merged;
  }

  const settings = isPlainObject(snap.parts.settings) ? snap.parts.settings : {};
  if (isPlainObject(settings.failover)) {
    const base = isPlainObject(out.failover) ? out.failover : {};
    out.failover = { ...base, ...clone(settings.failover) };
  }

  const claude = mergeClaude(snap.parts.claude, opts.claude, keepLocalKeys);
  return { config: out, claude, changed: canonicalJson(out) !== canonicalJson(cur) };
}

/**
 * 快照没带凭据时，把本机的凭据留在原处。
 *
 * 「没带」在快照里的样子是空串 / 空数组（见 pickProvider），
 * 所以这里认的是「空的那一格」，不是「键不存在」。
 */
function keepCredentials(merged, base) {
  if (!isPlainObject(base)) return;
  for (const f of CREDENTIAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(merged, f)) continue;
    if (merged[f] !== "") continue;
    if (Object.prototype.hasOwnProperty.call(base, f)) merged[f] = clone(base[f]);
    else delete merged[f];
  }
  if (Array.isArray(merged.keys) && merged.keys.length === 0 && Array.isArray(base.keys)) {
    merged.keys = clone(base.keys);
  }
}

/**
 * Claude Code 那侧的合并。
 *
 * 口径：快照的 claude 部分打底，**路由台自己写的 env 用本机的现值**——
 * 那些值指向本机的端口，本机的现值才是对的（路由台随后还会重写一遍）。
 * 其余 env（用户自己设的）以快照为准：还原一份备份就是这个意思。
 * 但快照没带凭据时（那些值被清空了），本机的原值要留着（同 keepCredentials）。
 */
function mergeClaude(snapPart, current, keepLocalKeys) {
  const cur = isPlainObject(current) ? current : null;
  if (!isPlainObject(snapPart)) return cur;
  const out = clone(snapPart);
  if (cur && isPlainObject(cur.env)) {
    const env = isPlainObject(out.env) ? { ...out.env } : {};
    for (const k of ROUTER_OWNED_ENV) {
      if (Object.prototype.hasOwnProperty.call(cur.env, k)) env[k] = clone(cur.env[k]);
    }
    if (keepLocalKeys) {
      for (const k of Object.keys(env)) {
        if (env[k] !== "") continue;
        if (!SECRET_NAME.test(k)) continue;
        if (Object.prototype.hasOwnProperty.call(cur.env, k)) env[k] = clone(cur.env[k]);
      }
    }
    out.env = env;
  }
  return out;
}
