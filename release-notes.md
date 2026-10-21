## v1.0.93-beta.1 更新内容

**这一版是测试版（beta）：想稳的人别升，想试的人从托盘菜单切过去。**

---

### 一、更新通道：稳定版 / 测试版两条路（本次新增）

托盘菜单 →「更新通道」可切：

| 通道 | 读哪份清单 | 谁会拿到 |
| --- | --- | --- |
| 稳定版（默认） | `latest.yml` | 所有人 |
| 测试版（beta） | `beta.yml` | 主动切过去的人 |

- 切到测试版后**只**会收到 beta 版本，稳定版用户完全不受影响——这就是「选择性升级」。
- 预发布版本在 GitHub 上标成 prerelease，**不会**占住 Latest（Latest 是人从 releases
  页面点下载时的默认落点，测试版占了它就等于推给了所有人）。
- 通道选择存在 `%APPDATA%\bai-router\config.json` 的 `updateChannel` 字段。
- 两条通道都开着 `allowPrerelease`：否则 `1.0.93-beta.1` 这种版本在版本比较里
  根本不算「更新」，用户永远看不到。

**回退**：一行命令（列出可用版本让你选）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/rollback.ps1 -UseBasicParsing | iex"
```

流程是：下载 → 校验 sha512 与数字签名 → 关程序 → 静默装旧版 → 重新启动。
**任何一步失败都不会动当前安装**——下载与校验都排在关程序之前。

---

### 二、故障转移：上游回 400「这家不接」不再终结整条链

**现象**

上游回 **HTTP 400** 时，旧逻辑一律判「请求本身有问题（参数错、上下文超长），
换几家都一样失败」→ **不转移**。于是当 400 出现在倒数第二个渠道上，整条链就死在那里，
最后一个渠道根本没被试。

实测日志（2026-10-21）：

```
渠道尝试（入口 mm，未转移）→ mm:失败[st=429/…]；qd:冷却中；bai:冷却中；sn:未配置；
zen:冷却中；wb:冷却中；wbai:失败[st=400/[WorkBuddy AI] request illegal]；or:…
```

**原因**

上游回 400 时还有另一种含义：「**这家不接这类请求**」——同一个请求换个供应商完全能通。
只按状态码判就把它误当成了「请求本身有问题」。

**改法**（窄口径，照 magpie 的 `failure(status, body)` 思路）

- 400 / 404 / 422 时**看响应体**。正文明说了拒绝理由才转移：
  「request illegal」「Illegal API invocation from an unapproved channel」
  「model_not_found」「该模型不存在」等。
- **正文含糊的 400 一律仍不转移** —— 真·参数错（missing required field、
  malformed body）换几家一样失败，转移只会白耗别家的额度、还把真实报错埋掉。
- 其它状态码的旧语义**一字未动**（429 / 401 / 403 / 5xx / 网络错照旧转移）。

---

### 三、接线写 settings.json：不再抹掉你的注释与配置

**这一条会丢数据，值得单独说。**

**旧行为**

1. 读 `~/.claude/settings.json` 用的是裸 `JSON.parse`；**读失败被当成空对象**，
   然后照样写回去。于是你的 settings.json 里只要有一处解析不过（手滑多一个逗号、
   别的工具写了注释），**下一次接线就把整个文件改写成只剩 `env` 的样子**——
   权限、钩子、MCP 配置当场蒸发。
2. 每次切模型都用 `JSON.stringify(s, null, 2)` **整份重写**：注释、键顺序、缩进风格
   全被抹平；文件 mtime 一直在跳，面板那套「这次是谁改的」归因也跟着失真。

**新行为**

- **读不懂 ≠ 空**（magpie 明令的 *failed read means unknown, never empty*）：
  文件在但读不懂 → 另存一份备份（`settings.json.unreadable-<时间戳>`）→ **中止接线** →
  **一个字都不改**。文件不存在才是合法状态，从空开始建。
- 写入改用**保格式编辑器**（移植 magpie 的 `internal/edit/json.go`）：不反序列化、
  不重新序列化，只对**一个字节区间**做 splice，于是注释、键顺序、缩进、CRLF、BOM
  天然全保留。
- **只在真的变了才写盘**：不改就不动文件，mtime 不变。

**顺带修**：`/api/apply` 里两个分支各调一次 `snapshotExternal`，然后**互相挑错了对方的
警告**（CLI 分支挑「桌面版没有可恢复的快照」，桌面分支挑「CLI 没有…」），正好反了。

---

### 四、README 里那条「一行命令救砖」从来没跑通过

`scripts/upgrade.ps1` 第 19 行**多了一个右括号**（4 个左对 5 个右）——那条命令
**从来没执行成功过**。而它恰恰是「内置更新器坏了、面板也开不了」时用户唯一的救命稻草。
一个自己都跑不起来的救援脚本，等于没有。

同时给它和新的 `rollback.ps1` 都加了 **UTF-8 BOM**：Windows PowerShell 5.1 从磁盘读
`.ps1` 时，没 BOM 就按系统 ANSI 代码页读（本机是 GBK/936）。UTF-8 里一个中文字 3 字节、
第三个字节落在 GBK 的前导字节区；当中文字紧挨着收尾引号时，那个引号会被当成续字节
吃掉 → 字符串失去闭合 → 语法错。

新增 `scripts/ps-parse-test.mjs` 守住这类 bug：括号配平（纯 JS，任何平台都能跑）+
含非 ASCII 必须有 BOM + 有 PowerShell 时真解析一遍。

---

### 五、新增的地基（**暂未接入面板，行为对用户无感**）

这一版开始按 **magpie**（[yetone/magpie](https://github.com/yetone/magpie)）的形态盖楼。
本次落地的是几块**底层模块**，都是零依赖、可单测：

| 模块 | 对应 magpie | 作用 |
| --- | --- | --- |
| `src/server/ir.mjs` | `internal/gateway/ir.go` | 统一协议中间表示。`Part.kind` 一个枚举收敛全部协议差异；**流式与非流式共用一条事件管道**；签名与密封推理逐字节保留 |
| `src/server/routes.mjs` | `internal/routes/` | 路由策略内核：`Seat`/`Strategy` + 7 种策略（smart/order/rotate/usage/pace/weight/free）+ 可注册表。策略是**纯函数**（时间由参数传入，内部绝不取 `Date.now()`） |
| `src/server/edit-json.mjs` | `internal/edit/json.go` | 保格式 JSON/JSONC 编辑器（本次已接进生产路径，见第三节） |
| `src/server/session-id.mjs` | `internal/gateway/sessionHeaders` | 会话身份。magpie 的铁律照抄：**从不为没有 session id 的请求编造 id** |
| `src/server/usage-ledger.mjs` | `internal/usage/` | 用量账本（JSONL 追加）。magpie 那条「accounting must never break a call」照抄：写失败不抛 |

**统一网关入口**（`src/server/gateway.mjs`，端口 15799）：magpie 是「一个端口」，模型 id
写成 `provider/模型`，网关自己拆前缀决定走哪；本版把这个入口**建出来了**，
但**默认不启用**、8 个旧中转端口一字未动。切换默认是后续版本的事。

配套研究文档：`docs/magpie-study.md`（对标分析）与 `docs/replication-plan.md`（任务队列）。

---

### 验证

- `npm test` —— **1102 全绿 / 0 失败**（比上一版多 185 条新测试）
- `node scripts/check-manifest.cjs` —— **0 error 0 warn**
- `scripts/edit-json-sabotage-run.mjs` —— **反向对照 5/5 手法确认会把测试打红**（进出都逐字还原）
- `scripts/gateway-test.mjs` —— **等价性对拍**：同一请求走「直连端口给档位名」与
  「统一网关给 provider/真实模型名」，**上游收到的请求体逐字相同**；反向对照在**副本**上
  改坏短路那一行后必须不再等价（改的是副本，不碰仓库源码）

---

### 这一版**没有**做的事

- 统一网关**没有**切成默认，8 个旧端口照旧
- 用量账本、会话身份**没有**接进面板
- 没有改任何供应商的上游地址与凭据处理方式
- **稳定版用户不受影响**：这一版只上传 `beta.yml`，`latest.yml` 仍指向 v1.0.92
