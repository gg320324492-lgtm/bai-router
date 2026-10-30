# Qoder（qd）额度探测 · 实测记录

> **日期：2026-10-23**
> **实测环境：Qoder 桌面端在运行（令牌会随客户端启动轮换），唯一一次真令牌。**
> 目的：把 qd 的额度端点与字段名从「猜」变成「已实测」，并把踩过的坑写下来，
> 下一个人不必再试一遍。

代码落点：`src/server/quota-probe.mjs`（qd 规格 + `qdQuotaHeaders`）、
`scripts/qd-quota-probe-test.mjs`（口径测试）。

---

## 一句话结论

> qd 的额度端点**存在**，但**不在原来猜的那个地址**，也不在推理那个域：
> `GET https://openapi.qoder.sh/api/v2/quota/usage`，
> 鉴权只要一条 `Authorization: Bearer <jt-令牌>`。

---

## ⚠ 落点变更（2026-10-30）：令牌文件从 `%TEMP%` 挪到**数据目录**

本文其余部分记的都是 2026-10-23 实测当时的情况 —— 令牌文件当时落在 `%TEMP%`。
**现在落点变了**：`src/server/qoder-patch.mjs` 的 `QODER_PATCH_PATHS.TOKFILE`
指向**数据目录**（`BAI_DATA_DIR`，没设时是 `%APPDATA%\bai-router`）下的
`qoder-token.json`，不再是 `os.tmpdir()`。

**为什么改**（这是一件真实的缺陷，不是一次整理）：

- 2026-10-23 用户要求「本项目不在系统盘留文件」⇒ **中转侧**的落点先改到了数据目录，
  **但补丁侧没跟着改** —— 而补丁才是**真正写文件的那一侧**。
- ⇒ 两边分叉：**补丁写 `%TEMP%`、中转读数据目录** ⇒ 面板永远显示「未读到」，
  令牌永远抓不到（**新机必现**；本机只是碰巧 config.json 里还留着旧的 `%TEMP%` 路径）。
- 现在补丁侧也搬到数据目录，且**中转侧不再自己另算一份**：
  `DEFAULTS.qd.tokenFile` 直接引用 `QODER_PATCH_PATHS.TOKFILE` ⇒ 落点只有一处出处。

⚠ 改落点 = 改补丁**字节**（落点路径硬编码在补丁的 preamble 里）⇒ 已经打过旧补丁的
副本要**先还原再重打**（`qpApply` 认得旧补丁态并自动从 `.orig` 还原）。

**这份文档为什么值得留下**：分叉的那半年里，代码注释、面板文案、实测记录三处
各说各话 —— 只有把「补丁写哪、中转读哪」钉成一处出处才不会再犯。

---

## 一、令牌：形态、位置、拼法

| 事实 | 值 | 出处 |
| --- | --- | --- |
| 令牌文件 | **数据目录**下的 `qoder-token.json`（2026-10-23 实测时在 `%TEMP%`，见上面「落点变更」） | `src/server/qoder-patch.mjs` 的 `QODER_PATCH_PATHS.TOKFILE` |
| 文件形状 | `{ token: string, userId: string, at: number }` | worker 补丁写的（`qoder-patch.mjs` 的 `zriReplacement`） |
| 令牌形态 | **裸串**，`jt-` 开头、**27 字符**、**不是 JWT**（无点分段） | 实测读 `qoder-token.json` |
| userId | UUID 形态（36 字符） | 同上 |
| 轮换周期 | **每次 Qoder 客户端启动换一把**（实测：启动后 3 秒写入新令牌） | 实测 |
| 中转怎么读 | `qdEnsureToken(cfg)` / `qdTokenRaw()` 现读该文件（5 秒缓存） | `src/server/server.mjs` |

**令牌不是 JWT**，别按 JWT 去解它的载荷。

### 客户端请求头的真实形状

抓包文件 `qoder-hdr.jsonl`（数据目录；2026-10-23 实测时在 `%TEMP%`）里 `via:"zri"` 的行带请求头（`via:"fetch"` 的行只有 url/body）：

```
Authorization: Bearer <jt-令牌>      ← 客户端就是这么发的（"Bearer " 前缀 + 令牌）
x-gw-user-id: <userId>               ← 客户端的**其它**接口要
Cosy-MachineId / Cosy-MachineToken  ← 机器身份，对 openapi 无用
```

### 实测：哪些头是必要的

| 头 | 额度端点需要吗 | 依据 |
| --- | --- | --- |
| `Authorization: Bearer <jt-令牌>` | **必须** | 缺了回 401 `TOKEN_INVALID` |
| `x-gw-user-id` | **不必要** | 实测带与不带，回的是**同一份**应答（200） |
| `Cosy-MachineId` / `Cosy-MachineToken` | **无用** | 实测加上/去掉，应答完全相同 |

所以接线只需要一条 Authorization。别再去令牌文件里凑 `userId` —— 那只会多一个
「令牌文件里没写 userId 就探不到」的失败点。

---

## 二、端点：哪些真存在，哪些是 404

用**有效**令牌扫出来的（2026-10-23）：

| 端点（`openapi.qoder.sh`） | 结果 |
| --- | --- |
| `GET /api/v2/quota/usage` | **200** —— 额度数据，**主用这条** |
| `GET /sash/api/v2/me/usage` | **200** —— 同一份数据，外层多包一层 `qoderUsage` |
| `GET /api/v2/user/plan` | 200 —— 套餐信息（`plan_tier_name: "Free"` 等） |
| `GET /api/v3/user/status` | 200 —— 账号状态（**含邮箱，别存进台账**） |
| `GET /sash/api/v1/me/campaigns` | 200 —— 每日 credits 签到列表（magpie 已知的那条） |
| `GET /sash/api/v1/me/quota` | **404** ← 原来猜的那条 |
| `GET /sash/api/v1/me/usage` | **404** ← 原来猜的那条 |
| `GET /sash/api/v2/me/usage` | 200 —— 注意是 **v2**，不是 v1 |

### ★ 两条候选端点的关系

`/api/v2/quota/usage` 与 `/sash/api/v2/me/usage` **是同一份数据**，只是包法不同：

```
/api/v2/quota/usage          → { userId, userQuota, addOnQuota, … }
/sash/api/v2/me/usage        → { displayMode: "qoder", qoderUsage: { userId, userQuota, addOnQuota, … } }
```

所以规格里两条的字段路径只差一层前缀（`addOnQuota.*` vs `qoderUsage.addOnQuota.*`）。
留着 sash 那条是当**替补**用的 —— 两条路由族不同，一边改了另一边还在。

### ⚠⚠ 最要紧的一条教训：**401 不能证明端点存在**

- **过期令牌**打 `/sash/api/v1/me/quota` → **401** `{"code":"TOKEN_EXPIRE","message":"token is not active"}`
- **有效令牌**打**同一个地址** → **404** `{"errorCode":"NotFound","errorMessage":"Not found"}`

原因：**鉴权层先于路由执行**。所以「401 = 地址对、只是缺凭据」这个推断是错的 ——
它只说明鉴权层先拦下来了。**路由存不存在，必须用有效凭据去验。**

> 这条已经写进 `src/server/quota-probe.mjs` 的文件头与 qd 规格的注释里。
> 别再被 401 骗一次。

---

## 三、应答形状（脱敏）

`GET /api/v2/quota/usage` → 200（Free 档个人账号实测）：

```json
{
  "userId": "…", "userType": "personal_standard", "usageType": "credits",
  "totalUsagePercentage": 0,
  "isQuotaExceeded": false,
  "expiresAt": 253402214400000,
  "upgradeUrl": "https://qoder.com/pricing?client=qoder",
  "outerProviders": [],
  "userQuota":  { "total": 0,   "used": 0, "remaining": 0,   "percentage": 0, "unit": "credits" },
  "addOnQuota": { "total": 600, "used": 0, "remaining": 600, "percentage": 0, "unit": "credits",
                  "detailUrl": "https://qoder.com/account/usage" },
  "isPlanQuotaProrated": false
}
```

- 两个额度桶：`userQuota`（**套餐**积分）、`addOnQuota`（**加购**积分），
  形状都是 `{total, used, remaining, percentage, unit}`。
- **单位是积分（credits）**，不是 token、不是次数、不是金额。
- **没有重置时刻**：顶层 `expiresAt` = 253402214400000 是 9999 年的哨兵值；
  `/api/v3/user/status` 的 `nextResetAt` 实测等于账号创建时间，不是周期性重置。
  ⇒ 探测结果的 `resetAtMs` 就是 `null`。
- Free 档实测：`userQuota` = 0/0（**没有套餐额度**），`addOnQuota` = 600/0（真在用的是它）。
  ⇒ 规格里每个窗口都写了 `minLimit: 1`：**上限为 0 的桶不算额度池**
  （否则面板会显示成「0 / 0（0%）」，那看着像「额度已经用完」）。

---

## 四、客户端（worker）里的对应实现

Qoder 自己的 worker 里就有同一套读法，是最权威的「接口文档」：

文件：`D:\Users\admin\AppData\Local\Programs\Qoder\.qoder-versions\0.4.9\resources\
app.asar.unpacked\node_modules\@qoder-ai\qoder-agent-sdk\dist\_worker\qoder-worker-runtime.obf.mjs`
（本机共 3 份 worker 副本：`.qoder-versions/0.4.8`、`.qoder-versions/0.4.9`、根 `resources`）

| 函数 | 端点 |
| --- | --- |
| `getQuotaUsage()` / `fetchQuotaUsage()` | `GET {openapi}/api/v2/quota/usage` |
| `getUsagePresentation()` / `fetchUsagePresentation()` | `GET {openapi}/sash/api/v2/me/usage` |
| `normalizeQuotaUsage()` | 上面的形状归一化 |

它认的字段名：`user_quota`/`userQuota`、`add_on_quota`/`addOnQuota`、
`org_resource_package`/`shared_quota`、`dedicated_resource_packages`、
`total_usage_percentage`、`is_quota_exceeded`、`expires_at`、`upgrade_url`、`usageType`。

⚠ **线上格式是 camelCase** —— snake_case 只是客户端归一化时的别名，
别把 snake_case 当线格式写进规格。

---

## 五、哪些是实测、哪些是候选

| 候选 id | 端点 | 状态 |
| --- | --- | --- |
| `quota-usage` | `https://openapi.qoder.sh/api/v2/quota/usage` | ✅ **实测**（200 + 字段名已认） |
| `sash-me-usage` | `https://openapi.qoder.sh/sash/api/v2/me/usage` | ✅ **实测**（200 + 字段名已认） |
| `quota-usage-cn` | `https://openapi.qoder.com.cn/api/v2/quota/usage` | ⚠ **候选 —— 路径与字段名都是从国际版推的，字段名未实测** |

**国内版那条必须当候选看**：

- 国内版是**另一个域**（`openapi.qoder.com.cn`；magpie 的国内版签到端点也是这个域）；
- 本仓的补丁**有意不打国内版**（`qoder-patch.mjs` 的 `REL_CN` / `cnCopies()`），
  所以令牌文件里**只可能是国际站的令牌**；
- 实测拿国际站的令牌打国内版 → 401 `TOKEN_EXPIRE`（那个域不认这把令牌），
  于是**无法验证国内版的路由与字段**；
- 保留它只是为了：用户手工填了国内版令牌（`cfg.qd.token` 兜底）时也许能命中。
  命中与否看它自己读不读得到字段 —— 读不到就 unknown，不会报错数。

---

## 六、想自己再验一遍

```bash
# 1. 令牌：先让 Qoder 跑起来（令牌随客户端启动写入，3 秒内落盘）
#    没跑的话 令牌文件里那把可能是过期的（回 401 TOKEN_EXPIRE）
# 2. 端点（换成你自己的令牌，别把令牌写进任何文件）
curl -s -H "Authorization: Bearer <jt-令牌>" \
     https://openapi.qoder.sh/api/v2/quota/usage
# 3. 头够不够：去掉 x-gw-user-id 再打一次，应答应完全相同
```

抓包文件 `qoder-hdr.jsonl` 里有**真令牌**，别把它的内容抄进任何文件。
本记录里所有值都是脱敏过的。

---

## 七、踩过的坑

1. **令牌会过期**：磁盘上那把是 58 小时前的，打过去是 `TOKEN_EXPIRE`。
   要实测先启动 Qoder 桌面端。**别把过期令牌的 401 当成「地址对、缺凭据」** ——
   那是本次最容易走错的一步。
2. **Qoder 装在 D 盘**：`D:\Users\admin\AppData\Local\Programs\Qoder`
   （C 盘的 `AppData\Local\Qoder` 只是 Launcher）。
3. **`sliceOf(cfg,"qd").key` 是占位符 `"qd-local"`**：探测若直接用它当 Bearer 发出去，
   只会换一个 401 回来 —— 中转侧接线时必须**整个替换**请求头，不能叠加。
4. **`/api/v3/user/status` 含邮箱**：别把它当额度来源（也别存进台账）。
