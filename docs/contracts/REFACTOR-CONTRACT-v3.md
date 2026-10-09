# REFACTOR-CONTRACT v3 — 删除旧五页 + 日志措辞（v1.0.49）

给实施 agent 的边界契约。两个工作项，**互相独立**，可以并行。

---

## 背景（已由协调者查证，可直接采信，但请自行复核关键点）

`src/server/` 下有五个**已废弃**的旧页面：`ui.html`(49KB) / `sn.html`(40KB) /
`wb.html`(53KB) / `zen.html`(48KB) / `qd.html`(50KB)。v1.0.46 把它们收敛成一份
`provider.html` + 一份 `providers.js` 清单，但旧文件一直留在仓库和安装包里。

**关键事实（我已逐条验证）：**

1. `server.mjs:2140-2144` 的 `PROVIDER_ALIAS` 把 `/ui.html`→`/`、`/sn.html`→`/sn` 等
   一律 **302 重定向**。这是**硬编码字符串映射，从不读文件**。
   → 所以删掉文件不影响这些 URL，用户访问 `/sn.html` 仍会正常跳到 `/sn`。
2. `package.json:38-41` 的 `build.extraResources[0].filter` 逐行列了这五个文件名。
   → 必须同步删掉，否则 `electron-builder` 会因为找不到文件而报错或告警。
3. `scripts/verify-artifact.cjs:35` 硬编码了这五个名字做"仍在包内的旧页"报告。
   → 删掉文件后它会打印"（无）"，这是**正确的**，但要确认它不会把"找不到"当失败。
4. `panel-common.js:314` 有一段**过渡期兜底**：注释说"页面不是新模板（没有
   `#slot-extra` 插槽，说明还是旧的 ui/sn/wb/zen/qd.html）"。旧页删掉后，**这个
   理由不再成立**，但该分支的另一半理由（清单里没有当前路径）**仍然有效**，必须保留。
5. 旧页对已在 v1.0.48 删除的全局有依赖（这正是它们已成陷阱的原因）：
   - `ui.html`：**0 处**（它最老，早于那两个全局）
   - `sn.html`：`baiIsOurs` × 2
   - `wb.html`：`baiIsOurs` × 2、`baiKeyMatchField` × 1
   - `zen.html`：`baiIsOurs` × 2、`baiKeyMatchField` × 1
   - `qd.html`：`baiIsOurs` × 2、`baiKeyMatchField` × 1
6. 还有一批 `.bak-*` 备份文件（`server.mjs.bak-v1.0.27`、`ui.html.bak-v1.0.30` 等）。
   **本契约不处理它们**——那是历史包袱，动它超出范围。

---

## 工作项 A — 删除旧五页及其引用（agent A）

### A1 删除文件
```
src/server/ui.html
src/server/sn.html
src/server/wb.html
src/server/zen.html
src/server/qd.html
```

### A2 同步 `package.json`
删掉 `build.extraResources[0].filter` 里这五行。**逐字核对删完后的数组**，
确认 `provider.html` / `providers.js` / `panel-common.css` / `panel-common.js` /
`config.defaults.json` / `server.mjs` / `failover.mjs` / `diag.html` 仍在列表里。

### A3 同步 `scripts/verify-artifact.cjs`
第 35 行的 `legacy` 数组：现在它会打印"仍在包内的旧页"。旧页删除后这一项**永久为空**。
两个选择，**你选一个并说明理由**：
- (a) 删掉这段 legacy 报告（它已无意义）
- (b) 改写成**反向断言**：这五个文件**必须不存在**，存在就报错（防止哪天被误加回来）

我倾向 (b)——它把"删掉了"变成一个**可验证的约束**而不是沉默。但你来判断。

### A4 处理 `panel-common.js:308-318` 的过渡期兜底
现在的代码：
```js
if (!P || !has("slot-extra")) {
  console.warn("[panel-common] " + here + " 不是新模板（无 #slot-extra），只启用保留区");
  return;
}
```
旧页删除后，`!has("slot-extra")` 这个条件的**解释**变了：不再可能是"旧页"，
只可能是"模板坏了 / 加载顺序出错"。

要求：**保留这个守卫**（它仍然是有效的防御），但更新注释与告警文案，让它们反映
真实含义。别删——模板万一损坏时它仍能防止共享层与内联脚本双重绑定。

### A5 检查其余引用
搜全仓库还有哪些地方提到这五个文件名。我已经查到的（**你需自行再搜一遍确认没漏**）：
- 若干**注释**里提到（`cards/failover.js:3,8`、`cards/token-capture.js:3,10`、
  `cards/model-catalog.js:4,5`、`providers.js:4,211`、`server.mjs:2128`）——
  这些是**历史来源说明**（"这块是从 ui.html 搬过来的"），**保留**，有价值。
- `server.mjs:2128` 那段回退说明里提到旧页文件名——**保留**，它解释的是回退路径。

**原则：注释里的文件名不动；代码里的引用必须清干净。**

### 禁止
- 不要动 `.bak-*` 文件
- 不要改 `server.mjs` 的 `PROVIDER_ALIAS`（重定向必须保留，URL 兼容性靠它）
- 不要改 `provider.html` / `providers.js` / `cards/*.js`
- 不要改任何用户可见文案

### 完成判据
1. `node scripts/check-manifest.cjs` → 0 error（**注意：C10 会检查别名路由与清单 path 的对应关系，删文件不该影响它，但请确认**）
2. `node scripts/verify-artifact.cjs` 在**未打包**状态下会因找不到 dist 而失败——这是正常的。
   请改用它需要的验证方式：确认脚本本身逻辑正确。
3. **实测五个别名 URL 仍然 302 到正确目标**（起隔离实例，`curl -sI` 看 location）
4. **实测五个规范页仍正常渲染**（200 且含 `slot-extra`）
5. 报告：删了哪些文件、改了哪几处引用、A3 你选了哪个方案及理由

---

## 工作项 B — 修正 400 未转移时的日志措辞（agent B）

### 问题
`server.mjs` 约 1545-1551 行：
```js
if (!shouldFailover(status)) {
  // 不该转移（多半是 400 请求本身有问题）——把这次的真实错误原样还给客户端
  noteFailoverEvent(fo.provider, tries);     // ← 这里
  if (cap.flushBuffered()) return;
  return wbAnthroError(res, status || 502, ...);
}
```
`noteFailoverEvent`（约 1572 行）打的是：
```
故障转移（入口 wb）→ wb:失败[st=400/...]
```
但**实际上没有发生任何转移**——代码在这个分支直接返回了原错误。日志措辞与行为不符，
排查时会让人以为渠道切换过。

### 要求
让它如实描述。建议（**你可以改进**）：给 `noteFailoverEvent` 加一个"是否真的转移了"
的参数，或在此分支改用另一个函数/另一套措辞，例如：
```
渠道尝试（入口 wb，未转移）→ wb:失败[st=400/...]
```

**注意：**
- `noteFailoverEvent` 有**三个调用点**（约 1539、1547、1556）。只有 1547 是"没转移"，
  另外两个都真的转移了。别把三处的措辞改成一样。
- 这是**纯服务端日志**，用户看不到。不要改任何返回给客户端的错误文案。
- `log()` 函数在文件里已有，直接用。

### 完成判据
1. `node --check src/server/server.mjs` 通过
2. **实测**：起隔离实例，构造一个会返回 400 的请求（例如往 `/v1/messages` 发一个
   缺字段的 body），确认日志现在如实说明"未转移"
3. 确认另外两个调用点的日志**措辞未变**
4. 报告：改了哪几行、怎么构造的 400、日志实际输出是什么

---

## 通用要求（两个 agent 都必须遵守）

- **绝对不许写真实的 `%APPDATA%\bai-router\config.json`**。起隔离实例必须：
  复制配置到临时目录 → 把端口挪到 17xxx/18xxx → `BAI_DATA_DIR=<临时目录>` 启动。
  有一台正式实例正在运行（占用 15722/15723）。测完 `taskkill //PID <pid> //F`。
- 代码注释与文案**都是中文**，保持风格。注释密度较高、解释"为什么"，别删有价值的。
- 改完跑 `node scripts/check-manifest.cjs`，**0 error 才算完成**。
- 报告里必须如实列出：**你不确定的、你没做到的、你偏离契约的地方**。
  含糊过去的地方我会当成缺陷。

## 文件边界（避免两个 agent 冲突）

- **agent A**：`src/server/*.html`（仅删除）、`package.json`、`scripts/verify-artifact.cjs`、`src/server/panel-common.js`（仅 A4 那一处）
- **agent B**：`src/server/server.mjs`（仅日志措辞那几行）

**两个 agent 的文件不重叠。** 不要越界改对方的文件。
