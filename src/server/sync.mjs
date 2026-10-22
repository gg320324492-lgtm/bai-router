/**
 * sync.mjs —— 同步策略与冲突处理
 * （纯逻辑、零 IO、零时钟、不依赖本仓库任何模块）
 *
 * ## 它补的是哪个洞
 *
 * 本仓库至今**没有任何一处**能把用户的配置带走：换电脑 / 重装 = 从零开始，
 * 八家提供方重新配 Key、Claude Code 那侧的权限与钩子重新写一遍。
 * backup.mjs 解决「配置怎么安全地装进一个文件」，本模块解决另一半：
 * **那个文件放哪、什么时候放、两边都改过听谁的、面板上那句话怎么来。**
 *
 * ## 对标 magpie 的哪个文件
 *
 *   yetone/magpie  internal/davsync/davsync.go —— syncOnce 的合并、hashes、Notice
 *   yetone/magpie  internal/davsync/dav.go     —— remote 接口（读/条件写）
 *   yetone/magpie  internal/davsync/github.go  —— GitHub 目标（Contents API + blob SHA）
 *   yetone/magpie  internal/settings/settings.go —— KeepOwn（本机专属字段）
 *
 * 照抄的语义：
 *   · **按部件合并**：magpie 把设置拆成 providers / settings / profiles / agents /
 *     library 五个部件，逐部件比哈希（davsync.go:57、786-817）。本模块用三个部件
 *     （providers / settings / claude），口径见 backup.mjs 的 PART_NAMES。
 *   · **冲突时新的赢**：两边都改过 → 比「本地这份部件的改动时刻」与「远端快照的
 *     制作时刻」，本地更新则本地赢，否则远端赢（davsync.go:1195-1202）。
 *   · **第一次同步以远端为准**：新机器加入一个已有设置的远端 → 拿远端的，
 *     本机被顶掉的部分留一份给「撤销」（davsync.go:1188-1194）。
 *   · **两边都改过才提示**：magpie 的 Notice 只在「两边都改过」和「第一次同步」
 *     时出现（davsync.go:1243-1246）；普通的一边改另一边没改不算冲突，不打扰用户。
 *   · **条件写**：远端在读之后被别人改了 → 写被拒 → 走同一条合并路重试
 *     （davsync.go:1068、dav.go:116-125 的 remote 接口）。
 *   · **没变化就不写**：合并结果与远端一样时**不推**（davsync.go:1249），
 *     否则每同步一次就在远端多一个版本（GitHub 上多一个 commit）。
 *
 * ## 与 magpie 有意不同的点（及原因）
 *
 * 1. **IO 与网络全部由调用方注入，本模块一个字节都不自己发。**
 *    magpie 的 davsync 自己带 WebDAV/S3/GitHub 三套客户端（dav.go / s3.go / github.go）。
 *    本模块只定义**接口与语义**（TARGETS 里写着每种目标的版本号是什么、写是条件写还是盲写），
 *    真正的 read/write 由调用方实现。这样测试能在内存里跑完整条链路，
 *    也让「同步策略」这一层可以脱离网络单独审。
 *
 * 2. **不做 magpie 的「用上次读到的整份好副本重建远端」那条路。**
 *    那条路（davsync.go:1139-1169）要求 IO 层保留上一份完整副本的缓存，
 *    而本模块零 IO、没有那个缓存。远端文件坏了，本模块**停下并说清楚**
 *    （REMOTE_UNREADABLE），不偷偷用旧副本覆盖回去——旧副本可能比远端旧，
 *    偷偷重建会把另一台机器更新的配置顶掉（magpie 自己也在这条路上花了很多字解释风险）。
 *
 * 3. **口令与加密不归本模块管。**
 *    加密是 backup.mjs 的事（那是「整份打包」的语义）。本模块只跟「部件」打交道，
 *    密文怎么封、怎么开由调用方注入 seal / open 两个函数。
 *    代价：本模块不认识「快照」长什么样，只认识「部件名 → 值」的映射。
 *    好处：两个模块互不 import，各自能单测；将来换一种打包方式也不用动同步策略。
 *
 * 4. **冲突判定用「本地部件的改动时刻」对「远端快照的制作时刻」。**
 *    magpie 用的是各配置文件的 mtime（davsync.go:924-952 的 changed()）。
 *    本模块不碰文件，改动时刻由调用方按部件给（localChangedAt）。
 *
 * ## 边界（刻意不做的事）
 *
 *   · **不 import 本仓库任何模块**：canonicalJson 与 backup.mjs 里那份逐字相同，
 *     改一处必须改另一处。
 *   · **不读磁盘、不联网、不发 HTTP**：目标适配器由调用方给。
 *   · **不取 Date.now()**：时刻由 opts.now 传入。
 *   · **不写用户的文件**：拉下来的部件由调用方写回去，且必须走
 *     edit-json.mjs 那套「改用户的文件时不丢任何东西」的写法。
 */

import { createHash } from "node:crypto";

/* ====================================================================== *
 * 常量与目标语义
 * ====================================================================== */

/**
 * 三种同步目标。
 *
 * `conditional` 说的是**写的时候能不能带条件**：带了条件，远端在你读之后被别人改过
 * 时，写会被拒（而不是把别人的改动静默盖掉）；magpie 的 WebDAV/S3 用 ETag、
 * GitHub 用 Contents API 的 blob SHA，都属于这一类（dav.go:116-125）。
 * 本地目录没有服务端版本号，只能盲写——magpie 的 version.Blind 那一路。
 *
 * `version` 说的是**版本号是什么**：调用方实现 read/write 时按它给。
 */
export const TARGETS = {
  local: {
    kind: "local",
    name: "本地目录",
    conditional: false,
    file: "bai-router.backup",
    version: "内容的哈希",
    note: "本地目录没有服务端版本号：写是盲写（magpie 的 blind 写），版本号自己算",
  },
  webdav: {
    kind: "webdav",
    name: "WebDAV",
    conditional: true,
    file: "bai-router.backup",
    version: "ETag",
    note: "条件写用 If-Match：远端变过就 412，调用方按 CHANGED 处理",
  },
  github: {
    kind: "github",
    name: "GitHub",
    conditional: true,
    file: "bai-router/bai-router.backup",
    version: "blob SHA",
    note: "走 Contents API，用读到的 blob SHA 做条件写；仓库必须是私有的",
  },
};

export const TARGET_KINDS = Object.keys(TARGETS);

/** 适配器抛出这些 code 之一就算「远端在中间被别人改了」。 */
export const REMOTE_CHANGED_CODES = ["CHANGED", "PRECONDITION_FAILED"];

/* ====================================================================== *
 * 错误
 * ====================================================================== */

/**
 * 本模块抛的全部错误都是这一个类，带一个 code。
 *
 * code 的用处：调用方要分「远端坏了」（该停、该让人去处理）与「远端被别人改了」
 * （该重跑一次同步），这两种的处置完全相反，不能靠 message 里的一句话去猜。
 */
export class SyncError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/* ====================================================================== *
 * 小工具
 * ====================================================================== */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 规范 JSON：对象的键按字典序排好再拼。
 *
 * 为什么：部件哈希是「这个部件变了没有」的唯一判据，而同一个内容用不同的键序
 * 写出来（用户手改过 config.json、或者从别的机器带过来的）不该算成变化。
 * JSON.stringify 不排序键 → 同样的内容算出两个哈希 → 平白一次「远端变了」，
 * 轻则白同步一次，重则把「谁改的」归因错。
 *
 * （backup.mjs 里有一份逐字相同的 canonicalJson：两个模块不许互相 import，
 *   改一处必须改另一处。）
 */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "]";
}

/** 一个部件的哈希。部件值是什么形状都行（对象、数组、标量）。 */
export function partHash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** 一组部件的哈希表。 */
export function hashParts(parts) {
  const out = {};
  if (!isPlainObject(parts)) return out;
  for (const k of Object.keys(parts)) out[k] = partHash(parts[k]);
  return out;
}

function requireNow(now) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new SyncError("NO_TIME", "需要 opts.now（毫秒时间戳）：本模块不取 Date.now()，时刻一律由调用方给");
  }
  return now;
}

function sameHashes(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/* ====================================================================== *
 * ① 目标适配器的语义
 * ====================================================================== */

/**
 * 同步目标适配器 —— 由调用方实现（这三个实现会碰网络/磁盘，本模块一个都不做）。
 *
 * @typedef {Object} SyncTarget
 * @property {"local"|"webdav"|"github"} kind
 * @property {string} [file] 远端文件名/路径（各目标的默认约定见 TARGETS）
 * @property {() => Promise<{bytes: Uint8Array, version: string}|null>} read
 *   读远端。**没有文件时返回 null**（不是空 bytes：空文件是「坏文件」，要报错）。
 *   version 按 TARGETS 里写的来（ETag / blob SHA / 自己算的哈希）。
 * @property {(bytes: Uint8Array, opts: {ifVersion: string|null}) => Promise<{version: string}>} write
 *   写远端。ifVersion 非空 → 条件写：远端已被别人改过就抛一个 code 为 CHANGED 的错。
 *   ifVersion 为 null → 「只有那里还没有文件时才写」（新建远端用）。
 *   本地目录没有条件写：ifVersion 传 null，写完自己读回来算版本。
 */

/**
 * 说出一个目标该怎么用。给面板用：用户填了地址，面板得知道这是 WebDAV 还是 GitHub、
 * 文件名该是什么、会不会覆盖别人的东西。
 */
export function describeTarget(kind) {
  const t = TARGETS[String(kind || "").toLowerCase()];
  if (!t) {
    throw new SyncError("BAD_TARGET", `不认识的同步目标：${kind}`);
  }
  return { ...t };
}

/* ====================================================================== *
 * ② 合并计划（纯函数）
 * ====================================================================== */

/**
 * 算出「这次同步该做什么」。**不碰任何 IO**，不推也不拉，只说清楚。
 *
 * 输入：
 *   localParts      —— 本地的部件 { 部件名: 值 }
 *   localChangedAt  —— 本地各部件的改动时刻（毫秒），缺省视为 0
 *   remote          —— 远端 { parts, createdAt, version }；null = 远端还没有文件
 *   state           —— 上一次同步的状态 { local: {部件:哈希}, remote: {部件:哈希} }；
 *                      null / 空 = 从来没同步过（第一次同步）
 *   parts           —— 参与同步的部件名；不给就取两边的并集
 *   now             —— 这次同步的时刻（毫秒），写进提示里
 *
 * 输出（计划）：
 *   action      —— "noop" | "push" | "pull" | "both"
 *   mergedParts —— 合并之后各部件该是什么值（要推上去的就是它）
 *   pull        —— 要写回本地的部件（远端赢的那些）
 *   push        —— 要推到远端的部件（本地赢的那些）
 *   shouldPush  —— 合并结果与远端不一样才推。**一样就不推**，
 *                  否则每同步一次远端就多一个版本（GitHub 上多一个 commit）。
 *   conflicts   —— 两边都改过的部件，以及谁赢了、为什么
 *   notice      —— 要提示用户什么（magpie 的 Notice：here = 本机被顶掉的部件，
 *                  there = 远端被顶掉的部件；只有冲突与第一次同步才有）
 *   nextState   —— 下一次同步要用的状态。
 *                  里面的 local 是**合并之后**本机该有的样子：拉下来的部件算进去了。
 *                  所以调用方必须把 pull 里的部件真的写回本机再去存这个状态——
 *                  写回失败却存了状态，下一轮就会以为本机已经是合并后的样子，
 *                  那部分改动就再也不会被推上去了。
 */
export function planSync(input) {
  const now = requireNow(input.now);
  const localParts = isPlainObject(input.localParts) ? input.localParts : {};
  const localChangedAt = isPlainObject(input.localChangedAt) ? input.localChangedAt : {};
  const remote = input.remote || null;
  const state = isPlainObject(input.state) ? input.state : null;
  const first = !state || !isPlainObject(state.local);

  const names = Array.isArray(input.parts) && input.parts.length
    ? input.parts.slice()
    : [...new Set([...Object.keys(localParts), ...(remote ? Object.keys(remote.parts || {}) : [])])];

  const L = hashParts(localParts);
  const R = remote ? hashParts(remote.parts || {}) : {};
  const stLocal = first ? {} : (state.local || {});
  const stRemote = first ? {} : (state.remote || {});

  const mergedParts = {};
  const pull = {};
  const push = {};
  const conflicts = [];
  const changed = { local: [], remote: [], both: [] };
  const notice = { at: now, here: [], there: [] };

  /* 远端一个文件都没有 → 本地这份直接推上去（magpie davsync.go:1101-1107）。
     这也是「第一次同步到一个空远端」的唯一结果：没有可比的东西。 */
  if (!remote) {
    for (const p of names) {
      if (localParts[p] === undefined) continue;
      mergedParts[p] = localParts[p];
      push[p] = localParts[p];
      changed.local.push(p);
    }
    return finish({
      action: "push",
      first,
      names,
      L, R,
      mergedParts, pull, push, conflicts, changed, notice,
      remoteVersion: null,
      shouldPush: true,
      now,
    });
  }

  const remoteCreatedAt = typeof remote.createdAt === "number" ? remote.createdAt : 0;

  for (const p of names) {
    const lv = localParts[p];
    const rv = (remote.parts || {})[p];
    const lh = L[p];
    const rh = R[p];

    /* 两边一样 → 不动它。 */
    if (lh === rh) {
      if (lv !== undefined) mergedParts[p] = lv;
      else if (rv !== undefined) mergedParts[p] = rv;
      continue;
    }

    /* 远端压根没有这个部件（老版本的备份、还没配这一块）→ 本地的推上去。
       magpie 对 library 就是这么处理的（davsync.go:1178-1181）。 */
    if (rv === undefined) {
      if (lv !== undefined) {
        mergedParts[p] = lv;
        push[p] = lv;
        changed.local.push(p);
      }
      continue;
    }

    /* 本地没有这个部件 → 远端的拉下来。 */
    if (lv === undefined) {
      mergedParts[p] = rv;
      pull[p] = rv;
      changed.remote.push(p);
      if (first) notice.here.push(p);
      continue;
    }

    /* 本地相对上次同步变了没有 / 远端相对上次同步变了没有。
       第一次同步：远端一律算「变了」（magpie davsync.go:1182-1183 的 first 口径），
       本地不算——第一次同步时本地没有「上次」可比。 */
    const lc = !first && lh !== stLocal[p];
    const rc = first || rh !== stRemote[p];

    if (lc && rc) {
      /* 两边都改过了 → 新的赢（magpie davsync.go:1195-1202）。
         判据是「本地这份的改动时刻」与「远端快照的制作时刻」比大小；
         一样大（同一毫秒）算远端赢——保守：远端赢意味着本机的改动还留在本机，
         而本地赢意味着远端那份被覆盖。 */
      const localAt = typeof localChangedAt[p] === "number" ? localChangedAt[p] : 0;
      changed.both.push(p);
      if (localAt > remoteCreatedAt) {
        mergedParts[p] = lv;
        push[p] = lv;
        notice.there.push(p);
        conflicts.push({ part: p, winner: "local", localChangedAt: localAt, remoteCreatedAt });
      } else {
        mergedParts[p] = rv;
        pull[p] = rv;
        notice.here.push(p);
        conflicts.push({ part: p, winner: "remote", localChangedAt: localAt, remoteCreatedAt });
      }
      continue;
    }
    if (lc && !rc) {
      /* 只有本地改了 → 推上去。 */
      mergedParts[p] = lv;
      push[p] = lv;
      changed.local.push(p);
      continue;
    }
    if (rc && !lc) {
      /* 只有远端改了 → 拉下来。 */
      mergedParts[p] = rv;
      pull[p] = rv;
      changed.remote.push(p);
      if (first) notice.here.push(p);
      continue;
    }

    /* 两边相对上次同步都没变，内容却不一样：状态与内容对不上
       （上次同步的结果没落回去，或者状态是别处写来的）。
       magpie 在这里三个分支都不中、什么都不做（davsync.go:1184-1203 的 switch），
       合并结果保留远端那份——本地这份的差异上次就被判过一回，
       这一回不要再改一次口径，更不许顺手把它推上去。 */
    mergedParts[p] = rv;
  }

  /* 合并结果与远端一样 → 不推。
     这一条是「同一份配置同步两次不会产生第二个版本」的保证：
     推上去的密文每次都不一样（盐/IV 是随机的），
     所以只有靠内容比对才能不把远端撑出一串一模一样的版本。 */
  const mergedHashes = hashParts(mergedParts);
  const shouldPush = !sameHashes(mergedHashes, R);
  const shouldPull = Object.keys(pull).length > 0;

  return finish({
    action: shouldPush && shouldPull ? "both" : shouldPush ? "push" : shouldPull ? "pull" : "noop",
    first,
    names,
    L, R,
    mergedParts, pull, push, conflicts, changed, notice,
    remoteVersion: remote.version == null ? null : remote.version,
    shouldPush,
    now,
  });
}

function finish(p) {
  const mergedHashes = hashParts(p.mergedParts);
  /* 推上去之后，远端就是合并后的样子；没推，远端还是它自己的样子。 */
  const remoteAfter = p.shouldPush ? mergedHashes : p.R;
  return {
    action: p.action,
    first: p.first,
    parts: p.names,
    localHashes: p.L,
    remoteHashes: p.R,
    mergedHashes,
    mergedParts: p.mergedParts,
    pull: p.pull,
    push: p.push,
    conflicts: p.conflicts,
    changed: p.changed,
    notice: p.notice,
    shouldPush: p.shouldPush,
    shouldPull: Object.keys(p.pull).length > 0,
    nextState: {
      local: mergedHashes,
      remote: remoteAfter,
      lastAt: p.now,
      lastVersion: p.remoteVersion == null ? null : p.remoteVersion,
    },
  };
}

/* ====================================================================== *
 * ③ 状态比较（面板上那句话的数据来源）
 * ====================================================================== */

/**
 * 回答面板要问的三句话：远端比我新吗 / 我比远端新吗 / 两边一样吗。
 *
 * 返回：
 *   relation   —— "same" | "local-newer" | "remote-newer" | "diverged" | "unknown"
 *   parts      —— 逐部件："same" | "local" | "remote" | "both"
 *   needsBackup—— 该不该提示用户「配置变了，备份一下」
 *   lastAt     —— 上次同步的时刻（毫秒）；面板显示「上次备份是什么时候」用它
 *
 * relation 的口径：
 *   same        —— 两边都一样
 *   local-newer —— 只有本地变了（该备份）
 *   remote-newer—— 只有远端变了（该拉）
 *   diverged    —— 两边都变了（不论是同一个部件各改各的，还是不同部件各改各的）
 *   unknown     —— 从来没同步过，或远端压根没有文件
 */
export function compareState(input) {
  const localParts = isPlainObject(input.localParts) ? input.localParts : {};
  const remote = input.remote || null;
  const state = isPlainObject(input.state) ? input.state : null;
  const first = !state || !isPlainObject(state.local);

  const L = hashParts(localParts);
  const R = remote ? hashParts(remote.parts || {}) : {};
  const stLocal = first ? {} : (state.local || {});
  const stRemote = first ? {} : (state.remote || {});

  const names = [...new Set([...Object.keys(L), ...Object.keys(R)])];
  const parts = {};
  let localChanged = 0;
  let remoteChanged = 0;
  let both = 0;

  for (const p of names) {
    const lc = first ? true : L[p] !== stLocal[p];
    const rc = first ? true : R[p] !== stRemote[p];
    if (lc && rc) { parts[p] = "both"; both++; localChanged++; remoteChanged++; continue; }
    if (lc) { parts[p] = "local"; localChanged++; continue; }
    if (rc) { parts[p] = "remote"; remoteChanged++; continue; }
    parts[p] = "same";
  }

  let relation;
  if (first && !remote) relation = "unknown";
  else if (first) relation = "remote-newer";
  else if (!localChanged && !remoteChanged) relation = "same";
  else if (both > 0) relation = "diverged";
  else if (localChanged && remoteChanged) relation = "diverged";
  else if (localChanged) relation = "local-newer";
  else relation = "remote-newer";

  return {
    relation,
    parts,
    needsBackup: localChanged > 0,
    lastAt: state && typeof state.lastAt === "number" ? state.lastAt : null,
    remoteCreatedAt: remote && typeof remote.createdAt === "number" ? remote.createdAt : null,
    remoteVersion: remote && remote.version != null ? remote.version : null,
  };
}

/* ====================================================================== *
 * ④ 跑一次同步（只调注入进来的适配器）
 * ====================================================================== */

/**
 * 跑一次同步：读远端 → 算计划 → 需要就推 → 返回结果。
 *
 * 本函数**自己不发一个字节的网络请求、不碰一次磁盘**：它只调调用方注入的
 * target.read / target.write。调用方实现这两个函数时，才真正碰到网络/文件。
 *
 * seal(parts, { now }) → bytes ：把合并后的部件封成密文（backup.mjs 的活，注入进来）
 * open(bytes)           → 快照 : 把远端的密文解开（backup.mjs 的活，注入进来）
 *   open 返回的快照要有 parts 与 createdAt 两个字段。
 *
 * 返回 { plan, state, pushed, pull, notice }：
 *   pull —— 要写回本地的部件。**本模块不写文件**，写盘是调用方的活，
 *           且必须走 edit-json.mjs 那套「改用户的文件时不丢任何东西」的写法。
 */
export async function runSync(input) {
  const now = requireNow(input.now);
  const target = input.target;
  if (!target || typeof target.read !== "function" || typeof target.write !== "function") {
    throw new SyncError("BAD_TARGET", "同步目标必须提供 read 与 write 两个函数");
  }
  if (typeof input.open !== "function" || typeof input.seal !== "function") {
    throw new SyncError("BAD_OPTION", "runSync 需要 open 与 seal 两个函数（加密归 backup.mjs 管）");
  }

  const file = await target.read();
  let remote = null;
  if (file) {
    if (!file.bytes) {
      throw new SyncError("REMOTE_UNREADABLE", "远端文件是空的，读不出备份");
    }
    let opened;
    try {
      opened = await input.open(file.bytes);
    } catch (e) {
      /* 远端文件坏了 / 口令不对 → 停下。
         绝不拿本机的配置悄悄盖上去：那样另一台机器的更新就没了，
         而用户连「远端出事了」都不知道（magpie davsync.go:1139-1169 的教训）。 */
      throw new SyncError(
        "REMOTE_UNREADABLE",
        `远端的备份打不开：${e && e.message ? e.message : String(e)}`,
        e,
      );
    }
    if (!opened || !isPlainObject(opened.parts)) {
      throw new SyncError("REMOTE_UNREADABLE", "远端那份解开之后不是一份备份");
    }
    remote = {
      parts: opened.parts,
      createdAt: typeof opened.createdAt === "number" ? opened.createdAt : 0,
      version: file.version == null ? null : file.version,
    };
  }

  const plan = planSync({
    localParts: input.localParts,
    localChangedAt: input.localChangedAt,
    remote,
    state: input.state,
    parts: input.parts,
    now,
  });

  let pushed = false;
  if (plan.shouldPush) {
    const bytes = await input.seal(plan.mergedParts, { now });
    try {
      await target.write(bytes, { ifVersion: remote ? remote.version : null });
      pushed = true;
    } catch (e) {
      const code = e && e.code;
      if (REMOTE_CHANGED_CODES.includes(code)) {
        /* 远端在我们读它之后被别人改了 → 重跑一次就是走同一条合并路
           （magpie davsync.go:1068 的做法）。这里不自己重试：
           重试要重新读一次远端，那是调用方决定什么时候做的事。 */
        throw new SyncError("REMOTE_CHANGED", "远端在你读它之后被别的机器改了，再同步一次即可", e);
      }
      throw new SyncError("WRITE_FAILED", `写远端失败：${e && e.message ? e.message : String(e)}`, e);
    }
  }

  return {
    plan,
    state: plan.nextState,
    pushed,
    pull: plan.pull,
    notice: plan.notice,
  };
}
