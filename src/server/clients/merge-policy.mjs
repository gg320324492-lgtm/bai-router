// src/server/clients/merge-policy.mjs —— 「我们要写的值」与「用户文件里的现值」怎么合
//
// ## 这一层解决什么
//
// 接线是**改用户环境**的动作。用户在客户端里手改过的东西（provider 名字、
// 关掉的开关、自己加的键、改过的模型名）不该在**下次接线**时被我们改回去；
// 但反过来，「机器该管的」（地址、key、方言/格式、模型 id 集合）必须由我们
// 说了算 —— 否则用户文件里残留的旧地址会把我们接回旧网关。
//
// ⇒ 关键不是一句「谁赢」，而是**逐个字段问一句：这个字段归谁**。
//
// ## 三层归属
//
// | 归属 | 典型字段 | 做什么 |
// | --- | --- | --- |
// | **机器的**（ours） | 地址、key、方言/格式、模型 id 集合 | 照写，**不比对** |
// | **用户的**（theirs） | 用户可能手改的字段（名字、开关、窗口、上限、思考档） | **逐值比对**：现值与我们的值不同 ⇒ 用户的赢 |
// | **没人管的**（unmanaged） | 我们压根没写的键 | **保留用户的**（magpie 的 theirsKept） |
//
// ## 为什么不记「我们上次写了什么」
//
// 记一份「上次写了什么」能分辨得更准，但那是**第二份状态**：会过期、
// 可能与真文件不一致（用户手改过、或文件被别的工具动过）。
// 逐值比对不需要额外状态。代价见 `docs/client-wiring-deep-plan.md` §2.2(d)：
// 上游的真相变了（窗口 200k→400k）会被当成「用户改过」⇒ 保留旧值。
// 那个代价在这一版**故意接受**（写错窗口比窗口过时更糟）。
//
// ## 与 magpie 的对应
//
// · `internal/agent/sync.go` 的 `theirsKept`/`mergeKept` = 本文件「没人管的」
//   那一层（我们没写的键保留用户的；两边都是对象就递归合并）。
// · `internal/agent/agents.go:459-493` 的 `openCodeKept` = 本文件「用户的」
//   那一层（逐值比对，用户改过的赢，用户新增的留着）。
// · `internal/agent/workbuddy.go:281` 的 `slices.Concat(kept[:at], add, kept[at:])`
//   = 本文件数组合并的**位置**语义（我们那几条**留在原位**，不重排用户的顺序）。
//
// ## 纯函数
//
// 这个文件**不碰文件、不碰网络**，只算值 —— 所以它能被单独测（不用起实例、
// 不用写用户文件），也能被每个客户端声明复用。
//
// ## 声明里怎么写（spec）
//
// ```js
// {
//   path: "provider.bai",
//   value: { name: "B.AI", enabled: true, options: { apiKey, baseURL } },
//   merge: {
//     theirs: ["name", "enabled", "models.*.name"],  // 逐值比对：用户改过就赢
//     whole:  ["models"],                            // 整块用我们的（不做深合并）
//     mode:   "array",                               // 可选：值是数组
//     key:    "providerId",                          // mode=array 时：按这个键认出「我们那一条」
//     aliasOf: "tier",                               // 可选：认出「同一条」时，还按这个别名比
//   },
// }
// ```
//
// ⚠ **`aliasOf` 为什么需要**（2026-10-24 补）：数组里认「同一条」原本只看
//   `key` 的**字面相等** ⇒ 而**键的含义变了、键本身也变了**时就认不出了
//   （模型 id 从 `claude-fable-5` 变成 `mm/claude-fable-5` —— 加了 provider 前缀）。
//   ⇒ 认不出 ⇒ 旧的当「用户自己加的条目」**原样留着** ⇒ **新旧两套并存**
//   ⇒ 用户选到旧的那套 ⇒ 客户端原样发给统一网关 ⇒ **400「没有 provider 前缀」**
//   （2026-10-25 用户实拍报错，根因就是桌面版的 `inferenceModels`）。
//   ⇒ `aliasOf: "tier"` 的意思是「**除了 key 相等，还要看「按别名规约后」是否相等**」
//   —— 别名规约 = 取 `provider/档位` 的**档位**部分（去掉前缀）。
//   ⇒ 认出是同一条 ⇒ 合并它（用户的 `labelOverride` 留着）**并把 key 换成我们的**
//   ⇒ 旧的裸档位那条**被替换掉**，不会两套并存。
//   ⚠ 只影响**数组**的认人方式（`mode: "array"`），别的合并路径不受影响。
//
// 路径是**相对 value 根**的分段：`"config.models"` = `config` 下的 `models`；
// 数组元素用 `*` 通配：`"models.*.name"` = 任意模型条目的 `name`。
//
// ⚠⚠ **「value 根」不是「write 的 path」** —— 这是最容易写错的一处：
//   `{ path: "provider.bai.models", value: <整张 models 表> }` 里，
//   value 根**就是**那张表 ⇒ 要写 `*.name`（不是 `models.*.name` ——
//   后者在「值就是那张表」时永远匹配不上）。
//   只有当 value 是**包着** models 的对象（`{ models: {...} }`）时，
//   才是 `models.*.name`。
//
// ⚠ spec 里的路径只写**我们自己点名的固定键**（`name`/`enabled`/`config`…），
//   不写模型 id —— 模型 id 是用户数据，可能带点（`sn/glm-5.2`），路径切分会切坏它。
//   （合并是按**对象的键**递归的，不走点分路径 ⇒ 带点的键名天然安全。）
//
// ### 根模式（`theirs: [""]`）
//
// 有些声明是「**一个 write 只写一个字段**」（`providers.bai.enabled` = true、
// `providers.bai.name` = "B.AI"）—— 这样的 write 的 value 是**标量**，
// 没有子路径可写，表达不了「这个字段归用户」。
//
// ⇒ `theirs: [""]` 表示「**整个值**归用户」：拿文件里的现值与我们要写的值
// 整体比 —— 一样 ⇒ 不动；不一样 ⇒ 用户的赢。
// 这是「用户在客户端里把某个 provider 关掉了」那种场景最直接的写法：
//
// ```js
// { path: "providers.bai.enabled", value: true, merge: { theirs: [""] } }
// ```
//
// ⚠ 根模式对**数组**不适用（整个数组归用户 = 我们写不进去自己的条目）⇒
//   数组一律我们的赢。

/* ------------------------------------------------------------------ *
 * 值比较
 * ------------------------------------------------------------------ */

/**
 * sameValue —— 两个值结构相等吗。
 *
 * 语义照 magpie 的 `sameJSON`（internal/agent/sync.go:174）：**忽略键的顺序**、
 * 忽略空白与转义 —— 「JSON 说的是不是同一件事」。
 *
 * 数组**按顺序**比（顺序是数据的一部分：模型清单的顺序是有意义的）。
 */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!sameValue(a[k], b[k])) return false;
    }
    return true;
  }
  /* ⚠ 走到这里只有一种情况：`a` 与 `b` 都是 NaN（`NaN === NaN` 为假）。
   *   NaN !== NaN ⇒ 不相等（保守：宁可当成用户改过）。 */
  return false;
}

/* ------------------------------------------------------------------ *
 * 合并
 * ------------------------------------------------------------------ */

/**
 * mergeValue —— 把「我们要写的值」与「用户文件里的现值」合并。
 *
 * @param {*} have  用户文件里该键路径上的**现值**（`undefined` = 用户压根没这个键）
 * @param {*} ours  我们要写的值
 * @param {object} spec 归属声明（见文件头的说明）
 * @returns {{ value: *, kept: Array<{ path: string, theirs?: *, ours?: *, kind?: string }> } }}
 *   `value` = 真正该写进文件的值；
 *   `kept`  = 「保留了什么」的清单（`path` 是相对 `ours` 根的路径）。
 *
 * ⚠ **`kept` 里有两类东西，面板要分开说**（2026-10-23 定）：
 *   · **没写 `kind`**（缺省）= `theirs` —— 那个键**我们本来就会写**、但用户改过
 *     ⇒ 让给他 ⇒ 带 `theirs`（用户的值）与 `ours`（我们记的值）⇒ 面板显示
 *     「路径 · 你的值 · 我们记的值」。
 *   · **`kind: "unmanaged"`** —— **我们压根没写**的键、用户自己有的 ⇒ 弱保留层
 *     留下的 ⇒ **只报键名、不报值** ⇒ 面板显示「还留着你自己的 N 个键」。
 *   ⚠ 两者是**两回事**：一个是「我们本来要写、让你改了」，一个是「压根没碰、
 *     你的东西还在」—— 混在一句「我改的 N 处」里会让人以为他没改过的东西
 *     也在里头。
 *
 * ⚠ `have` 是 `undefined` ⇒ 用户没这个键 ⇒ 直接用我们的（没什么可比）。
 */
export function mergeValue(have, ours, spec) {
  const kept = [];
  if (!spec || typeof spec !== "object") return { value: ours, kept };
  const s = {
    theirs: toPatterns(spec.theirs),
    whole: toPatterns(spec.whole),
    key: spec.key ? String(spec.key) : "",
    mode: String(spec.mode || ""),
    /* ⚠ `dropUnmanaged`：**我们自己要删掉的键**，别报进「还留着你自己的 N 个键」。
     *   场景（OpenCode 迁移旧表名）：旧表名 `sn/claude-opus-5` 我们**删掉**，
     *   但合并层先看见它「我们没写」⇒ 报成「unmanaged（还留着）」⇒
     *   面板说「还留着你自己的 3 个键」，其实其中 2 个**已经被我们删了**。
     *   ⇒ 说错了。**值仍然保留**（合并层照旧把它放进结果里），
     *     只是**不报**——报不报由「我们删不删它」说了算。 */
    dropUnmanaged: new Set(
      Array.isArray(spec.dropUnmanaged) ? spec.dropUnmanaged.map((k) => String(k)) : []
    ),
    /* ⚠ `aliasOf`：**认出「同一条」的第二个口径**（只对数组有效）。
     *   键的含义变了、键本身也变了时（模型 id 加了 provider 前缀），
     *   只按 key 字面相等就认不出 ⇒ 旧的被当「用户自己加的」留着 ⇒ 新旧并存。
     *   这里给一个**别名规约**（目前只有 "tier"）：取 `provider/档位` 的档位部分。
     *   ⇒ 认出是同一条 ⇒ 合并它并把 key 换成我们的 ⇒ 旧的被**替换掉**。 */
    aliasOf: String(spec.aliasOf || ""),
  };
  /* ⚠ `mode: "array"` 但没给 `key` ⇒ **认不出「我们那一条」** ⇒ 不做数组合并
   *   （瞎猜会把用户的某一条当我们的改掉 —— 那比不合并更坏）。 */
  if (s.mode === "array" && !s.key) s.mode = "";
  if (have === undefined) {
    /* 用户压根没这个键。数组形状的（mode=array）⇒ 从零起一个数组 ——
     * 别写成单个对象：客户端读的是数组，形状不对它会当配置坏了。 */
    if (s.mode === "array") {
      const v = mergeArray([], ours, s, kept, "");
      return { value: v, kept };
    }
    return { value: ours, kept };
  }
  /* ⚠ **数组合并在入口分流**，不在 mergeNode 里判 ——
   *   否则**元素级**递归时会又进一次数组合并，把规则套进数组里
   *   （「一层数组里又是一个数组」—— 客户端读不出来）。 */
  const value = s.mode === "array"
    ? mergeArray(Array.isArray(have) ? have : [], ours, s, kept, "")
    : mergeNode(have, ours, [], s, kept, "");
  return { value, kept };
}

/**
 * mergeNode —— 递归合并一个节点。
 *
 * @param {*} have   用户那一份
 * @param {*} ours   我们那一份
 * @param {string[]} path  当前节点相对 value 根的分段路径（用来匹配 spec）
 * @param {object} s   编译过的 spec
 * @param {Array} kept 「保留了你手改」的清单（累加）
 * @param {string} prefix 报告用的路径前缀
 */
function mergeNode(have, ours, path, s, kept, prefix) {
  /* ① **整块用我们的**（whole）：模型清单这种「我们说了算」的东西，
   *    不做深合并、也不比对 —— 用户在里面加的东西也一起被换掉（magpie 的 whole）。 */
  if (hit(s.whole, path)) return ours;

  /* ② **逐值比对**（theirs）：用户可能手改的字段。
   *    · 命中的是**根**（theirs 里写了空串 `""`）⇒ 整个值归用户：
   *      整体比 —— 一样 ⇒ 不动；不一样 ⇒ 用户的赢。
   *      ⚠ 数组例外：整个数组归用户没意义（我们要把自己的条目写进去）⇒ 我们的赢。
   *    · 命中的是**子路径**且两边都是对象 ⇒ 递归合并（更深层的 theirs/whole 仍生效）；
   *    · 否则 ⇒ 整体比：一样 ⇒ 不动；不一样 ⇒ **用户的赢**。 */
  if (hit(s.theirs, path)) {
    if (path.length === 0) {
      if (Array.isArray(ours)) return ours;
      if (sameValue(have, ours)) return ours;
      kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });
      return have;
    }
    if (isObj(have) && isObj(ours)) return mergeObj(have, ours, path, s, kept, prefix);
    if (sameValue(have, ours)) return ours;
    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });
    return have;
  }

  /* ③ 默认：**弱保留**（magpie 的 theirsKept）——
   *    我们没写的键保留用户的；两边都是对象就递归合并，我们的那份赢。 */
  if (isObj(have) && isObj(ours)) return mergeObj(have, ours, path, s, kept, prefix);

  return ours;
}

/**
 * mergeObj —— 两个对象合并（弱保留那一层）。
 *
 * 我们没写的键 ⇒ **保留用户的**（那是用户或别的工具加的）。
 * 两边都有的键 ⇒ 递归合并（走到 mergeNode，theirs/whole 在深层仍生效）。
 */
function mergeObj(have, ours, path, s, kept, prefix) {
  const out = { ...ours };
  for (const [k, hv] of Object.entries(have)) {
    if (!Object.prototype.hasOwnProperty.call(ours, k)) {
      out[k] = hv;                    /* 我们没写 ⇒ 用户的留下 */
      /* ⚠ **也要报出来**（2026-10-23）：这一条是「**我们压根没写**、用户自己
       *   有的键」⇒ 与「显式归用户」那组是**两回事**（设计稿 §2.2(b)：
       *   「用户赢 + **说一句**」—— 留住却一个字不说，等于没留住）。
       *   ⇒ `kind: "unmanaged"`；**不报值**（那些值是「用户自己的一堆东西」，
       *     一个个列出来太长 —— 面板上只列**键名**）。
       *   ⚠ 值不报 ⇒ 也就不用脱敏（没有值会流出去）。
       *   ⚠ **但我们要删掉的键不报**（`dropUnmanaged`）—— 报成「还留着」而
       *     其实已经被我们删了 ⇒ 面板在骗人。 */
      if (!(path.length === 0 && s.dropUnmanaged.has(k))) {
        kept.push({ path: joinPath(prefix, k), kind: "unmanaged" });
      }
      continue;
    }
    out[k] = mergeNode(hv, ours[k], path.concat(k), s, kept, joinPath(prefix, k));
  }
  return out;
}

/**
 * mergeArray —— 数组怎么合。
 *
 * 两种情形：
 *
 * · **ours 是数组**（我们要写一整份清单，WorkBuddy 那种）：
 *   逐个元素按 `key` 认出「同一条」⇒ 合并它并**留在原位**；
 *   我们多出来的元素追加到末尾（magpie 的 at<0 ⇒ append）。
 *   ⇒ 用户的相对顺序**不变**。
 * · **ours 是单个元素**（我们只写一条，ZCode 的 providerRules 那种）：
 *   在用户的清单里认出 `key` 相同的那一条 ⇒ 合并它并留在原位；
 *   没有 ⇒ 追加到末尾。
 *
 * ⚠ 认出「同一条」靠的是 `key` 的**值**相等（`providerId` 是我们的 id），
 *   不是位置 —— 用户把我们的条目挪个位置，我们照样认得出。
 */
function mergeArray(have, ours, s, kept, prefix) {
  const list = Array.isArray(have) ? have : [];

  if (!Array.isArray(ours)) {
    /* ours 是**一条**。 */
    const k = keyOf(ours, s.key);
    const out = [];
    let merged = false;
    for (const el of list) {
      if (!merged && s.key && keyOf(el, s.key) === k) {
        out.push(mergeNode(el, ours, [], s, kept, `${prefix}[${s.key}=${k}]`));
        merged = true;
        continue;
      }
      out.push(el);
      /* ⚠ **也要报出来**（2026-10-23）：「我们清单里没有的那一条」也是
       *   「我们压根没写」⇒ 面板上归到「还留着你自己的 N 个键」那组。 */
      kept.push({ path: `${prefix}${elemLabel(el, s.key)}`, kind: "unmanaged" });
    }
    if (!merged) out.push(ours);
    return out;
  }

  /* ours 是一整份清单。 */
  const out = [];
  const used = new Set();
  for (const el of list) {
    const k = keyOf(el, s.key);
    let idx = -1;
    for (let i = 0; i < ours.length; i++) {
      if (used.has(i)) continue;
      if (!s.key || keyOf(ours[i], s.key) === k) { idx = i; break; }
    }
    /* ⚠ **别名口径**（`aliasOf`，2026-10-24 补）：key 字面不相等，但**按别名规约后
     *   相等** ⇒ 那是**同一条**（只是键的写法变了：模型 id 加了 provider 前缀）。
     *   ⇒ 认出它 ⇒ 合并它（用户的 labelOverride 留着）**并把 key 换成我们的**
     *   ⇒ 旧写法那条被**替换掉**，不会新旧两套并存。
     *   ⚠ 不认出的代价很具体：两套并存 ⇒ 用户选到旧的那套 ⇒ 客户端原样发给
     *     统一网关 ⇒ 400「没有 provider 前缀」（2026-10-25 用户实拍）。 */
    if (idx < 0 && s.aliasOf) {
      const ak = aliasKeyOf(el, s.key, s.aliasOf);
      if (ak) {
        for (let i = 0; i < ours.length; i++) {
          const ok = aliasKeyOf(ours[i], s.key, s.aliasOf);
          /* ⚠ **前缀必须对得上**：`sn/claude-fable-5` 与 `mm/claude-fable-5` 的
           *   档位部分一样，但**它们是两家的不同模型** ⇒ 不能认成同一条。
           *   ⇒ 只有「前缀相同」或「其中一边没有前缀」才算。 */
          if (!ok || ok.tier !== ak.tier) continue;
          if (!ak.prov || !ok.prov || ak.prov === ok.prov) {
            if (used.has(i)) {
              /* ⚠⚠ **同一条被认了两次**（2026-10-24 修）：用户清单里同时有
               *   **旧写法**（裸档位）与**新写法**（带前缀）⇒ 别名口径下它们是
               *   同一条 ⇒ 第二次认到的那条**已经合并过**⇒ 不能再合并一次
               *   （否则同一条输出两遍 ⇒ 桌面版菜单里同一个模型出现两次）。
               *   ⇒ 丢弃这条重复项，保留前面那条（已合并过的）。 */
              idx = -2;   // 标记：重复项
              break;
            }
            idx = i; break;
          }
        }
      }
    }
    if (idx === -2) continue;   // 重复项：丢弃（前面那条已合并过）
    if (idx < 0) {
      out.push(el);                                /* 用户的条目原样留着 */
      /* ⚠ **也要报出来**（2026-10-23）—— 见上面那条注释。 */
      kept.push({ path: `${prefix}${elemLabel(el, s.key)}`, kind: "unmanaged" });
      continue;
    }
    used.add(idx);
    out.push(mergeNode(el, ours[idx], [], s, kept, `${prefix}[${s.key}=${k}]`));
  }
  for (let i = 0; i < ours.length; i++) if (!used.has(i)) out.push(ours[i]);
  return out;
}

/**
 * aliasKeyOf —— **别名口径**下的「这条是谁」（认不出 ⇒ null）。
 *
 * ⚠ 目前只支持 `"tier"`：**`provider/档位` 的档位部分**（去掉 provider 前缀）。
 *   认「同一条」时用它 ⇒ 模型 id 从 `claude-fable-5` 变成 `mm/claude-fable-5`
 *   （加前缀）之后仍认得出是同一条 ⇒ 旧的被替换而不是并存。
 *
 * ⚠ **前缀也要留着**（返回值是 `{prov, tier}`）—— 因为 `sn/claude-fable-5` 与
 *   `mm/claude-fable-5` 的**档位部分一样**，但它们是两家的**不同模型** ⇒
 *   认成同一条就等于把 A 家的模型显示成 B 家的。⇒ 比较时前缀必须对得上
 *   （或其中一边没有前缀 —— 那才是「旧写法」）。
 *
 * @param {*} el 数组元素
 * @param {string} key 识别键名
 * @param {string} aliasOf 别名口径（目前只有 "tier"）
 * @returns {{prov:string, tier:string}|null} 别名；认不出 ⇒ null
 */
function aliasKeyOf(el, key, aliasOf) {
  const k = keyOf(el, key);
  if (k === undefined || k === null) return null;
  const s = String(k);
  if (aliasOf === "tier") {
    const at = s.indexOf("/");
    if (at < 0) return { prov: "", tier: s.trim() };
    const prov = s.slice(0, at).trim().toLowerCase();
    const tier = s.slice(at + 1).trim();
    if (!prov || !tier) return null;
    return { prov, tier };
  }
  return null;
}

/**
 * elemLabel —— 数组合并里「这个元素是谁」的那一段标签（报告用）。
 *
 * 认得出识别键 ⇒ `[键=值]`（与合并时用的路径段同一形状）；
 * 认不出（元素不是对象 / 没有那个键）⇒ `[值]`（标量元素就是它自己）。
 */
function elemLabel(el, key) {
  const k = keyOf(el, key);
  if (k !== undefined && k !== null) return `[${key}=${k}]`;
  if (typeof el === "string" || typeof el === "number" || typeof el === "boolean") {
    return `[${String(el)}]`;
  }
  return "[?]";
}

/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */

/** 是不是普通对象（不是数组、不是 null）。 */
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * keyOf —— 取一个元素上「认出它是谁」的那个键的值。
 *
 * 没有 `key` ⇒ 返回 undefined（调用方据此不认任何一条）。
 */
function keyOf(el, key) {
  if (!key) return undefined;
  if (!isObj(el)) return undefined;
  return el[key];
}

/**
 * toPatterns —— 把 spec 里的路径列表规整成「分段数组」。
 *
 * 字符串按 `.` 切（浅层键名用着方便）；数组直接当分段用（键名本身带点时用）。
 * ⚠ **空串 `""` 表示「根」** —— 那是「这个 write 的值本身归用户」的写法，
 *   给「一个 write 只写一个字段」的声明用（`providers.bai.enabled` 那种）：
 *   标量值没法用子路径表达归属，只能整体比。
 */
function toPatterns(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => {
    if (Array.isArray(p)) return p.map(String);
    const s = String(p);
    return s === "" ? [] : s.split(".");
  });
}

/**
 * hit —— 当前路径命中了哪条模式。
 *
 * `*` 匹配任意一段（数组元素用）。段数必须相等。
 */
function hit(patterns, path) {
  for (const p of patterns) {
    if (p.length !== path.length) continue;
    let ok = true;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === "*") continue;
      if (p[i] !== path[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** joinPath —— 报告用的路径拼接。 */
function joinPath(prefix, key) {
  return prefix ? `${prefix}.${key}` : String(key);
}

/**
 * safeValue —— 「保留了你手改」清单里带出来的值，**过一道凭据脱敏**。
 *
 * ⚠ 这份清单会流向面板（给人看的），所以**凭据不能原样出去** ——
 *   与「凭据不进声明文件」「凭据不进任何文件」是同一条纪律的延伸。
 *   判据与仓库里 credentialish 的思路一致：**长、无空格**的串 = 令牌那种东西。
 *
 * 数字、短字符串（名字、档位、窗口）都原样带出 ——
 * 设计稿 §2.2(b) 要的那句「保留了你手改的窗口 128000（我们记的是 200000）」
 * 靠的就是它们。
 */
function safeValue(v) {
  if (typeof v === "string" && v.length >= 16 && !/\s/.test(v)) {
    return `（长度 ${v.length} 的长串 —— 可能是凭据，不原样带出）`;
  }
  if (Array.isArray(v)) return v.map(safeValue);
  if (isObj(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = safeValue(x);
    return out;
  }
  return v;
}
