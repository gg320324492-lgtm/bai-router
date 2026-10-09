# REFACTOR-CONTRACT v2 — 清单化收尾（v1.0.48）

本文件是给本次实施的 agent 看的**边界契约**。目标：让"加第 6 家提供方 = 只写一条清单"这句承诺真正成立。

## 唯一目标

`src/server/panel-common.js` 里还残留着**按提供方硬编码**的分支。把它们全部搬进 `src/server/providers.js` 清单，使 panel-common.js 成为**纯通用渲染层**——不再认识任何一个具体提供方的名字。

判断标准（唯一）：实施完成后，在 `panel-common.js` 中搜索 `"bai"` / `"sn"` / `"wb"` / `"zen"` / `"qd"` 这五个字符串，**除白名单外一处都不应剩下**。

## 允许保留的白名单（这些不是"提供方特判"，是数据形状）

| 位置 | 内容 | 为什么保留 |
|---|---|---|
| `sliceOf` / `stOf` 的返回值 | — | 见下，改为清单驱动 |
| `cards/*.js` | 各卡自己的 PROVIDER 判断 | cards 是提供方专属模块，不在本契约范围 |
| 注释文字 | — | 注释里出现提供方名字是正常的 |

## 工作项

### W1 — FB 兜底表整体迁入清单

`panel-common.js` 第 342–396 行的 `FB` 常量（五家各自的兜底表）整表搬到 `providers.js` 对应条目里，**逐字保留**，不要改写措辞。

字段清单（每家都要补，缺的填合理值或 `null`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `brands` | obj | 模型前缀 → 显示名。bai/sn/wb/zen/qd 五家各样 |
| `defaultModels` | strArr | 兜底模型列表 |
| `labelSuffix` | str | 只在 bai 有（`" 1M"`） |
| `noCallHint` | str | 只在 bai 有 |
| `testNote` | obj `{single, all}` | 档位说明 |
| `modelsRefreshMsg` | str | 含 `{count}` 占位 |
| `applyInfoMsg` | str | |
| `resetModelsMsg` | str | 含 `{list}` 占位 |
| `step1Hint` | str | |
| `eventTitles` | obj | 事件标题覆盖 |
| `cred` | obj | 凭据卡文案（zen/qd 有，zen 已部分在清单） |
| `sys` | obj | 见 W2，**这是形状开关不是文案** |

搬迁后：
- 删除 `panel-common.js` 里的 `FB` 常量定义
- `const opt = (name) => (P[name] != null ? P[name] : FB[name]);` 改为 `const opt = (name) => P[name];` 或直接内联
- 所有 `opt("...")` 调用点保留（它们现在只读清单）
- **保留**那些 `|| "默认值"` 的兜底字面量（那是"清单漏字段时不至于空白"，不是提供方特判）

### W2 — 形状开关也进清单

`sliceOf` / `stOf` 现在是 `p === "bai" ? c : c[p]`。改为清单驱动：

- 在每家条目加 `configShape: "flat"`（bai）或 `"nested"`（其余四家）
- 同样加 `statusShape`（bai 是 `"flat"`，其余 `"nested"`；若两者总是相同，合并成一个 `shape` 字段即可，**你来判断并说明理由**）

按钮显隐同理：
- `showEl($("btnDeploy"), ...)` 现在是 `FB.sys.deploy || key === "bai"` → 改为读清单 `sys.deploy`
- `showEl($("btnModels"), key === "bai" || key === "sn")` → 加清单字段 `sys.modelsRefresh`（bai/sn 为 true）
- `FB.sys.useProxyRow !== false` → 清单 `sys.useProxyRow`

### W2b — 另外两处容易漏的提供方特判

这两处我在基线扫描里发现，契约初稿漏写了。它们同样是"加第 6 家会踩"的坑，必须一并清单化：

1. **`/api/models` 的 URL 形状**（约 1051 行）：
   ```js
   const r = await api(key === "bai" ? "/api/models" : "/api/models?p=" + key);
   ```
   bai 的服务端路由不带 `?p=`，其余四家带。加清单字段 `modelsEndpoint`（bai 填 `"/api/models"`，其余填 `null` 表示按默认拼 `?p=<key>`），或你认为更合适的表达。**说明你选哪种及理由。**

2. **中转端口的标签**（约 549 行）：
   ```js
   applyText("lblRelayPort", SL.relayPort || `${key === "bai" ? "" : SHORT + " "}中转端口`);
   ```
   只有 bai 不加提供方前缀。注意这里已有 `settingsLabels.relayPort` 覆盖机制——**先确认五家是不是都已经在清单里填了 `settingsLabels.relayPort`**；如果都填了，那这个三元表达式其实永远走不到，直接删掉更干净。如果没填全，就补齐清单再删。

这两处属于W2，一起做。

### W3 — 闸门升级（check-manifest.cjs）

1. **C8 改为只认清单**：删掉对 `FB.defaultModels` 的来源检查（那个表不存在了），改为：每家的 `defaultModels` 必须是清单里的非空字符串数组。
2. **新增 C11**：扫描 `panel-common.js`，若出现 `key === "bai"` 这类**提供方字面量等值判断**就报错。白名单：
   - `cards/*.js` 不扫
   - 注释行不扫（先剥注释再扫）
3. 新增 C12：清单里每家都必须有 `defaultModels` / `brands` / `configShape`（或你定的合并字段名），缺了报错——这是"加第 6 家漏改"的新防线。

## 禁止

- 不要改 `cards/*.js`
- 不要改 `server.mjs`
- 不要动 `provider.html` 的 52 个契约 id
- 不要改任何**用户可见文案的措辞**（这次是搬家，不是改写）
- 不要改 `panel-common.css`

## 完成判据（你必须自证）

1. `node --check` 三个文件全过
2. `node scripts/check-manifest.cjs` → 0 error
3. 搜 `panel-common.js` 里五个提供方名字，列出每一处残留并说明为什么该留
4. 起隔离实例（`BAI_DATA_DIR` 指向临时目录、端口挪到 17xxx/18xxx），**真实配置一个字节都不能动**，实测五页：
   - 五页都能渲染（非白屏）
   - 路由表下拉有模型
   - 保存映射/测试连通仍能写对 `provider` 字段
   - 控制台 0 error
5. 报告里给出你**删掉了哪些行**（`git diff --stat` 数字），别只报"已完成"

## 报告要求

按 W1/W2/W3 分节写。每节写：改了什么、删了什么、怎么验的、**哪些你没做到或不确定**。

不确定的地方**明确列出来**，不要含糊过去——我会独立复验，含糊的地方我会当成缺陷。
