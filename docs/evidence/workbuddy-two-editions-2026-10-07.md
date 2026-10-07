# 证据存档 — WorkBuddy 两版差异（国际版带 AI / 国内版不带）（2026-10-07）

**状态：v1.0.59 契约 `REFACTOR-CONTRACT-v14.md` 执行中。** 本文档只存原始证据与复现命令。

---

## 1. 两版对照（全部实测）

| | 国际版 | 国内版 |
|---|---|---|
| 产品名 | **WorkBuddy AI**（带 AI） | **WorkBuddy**（不带） |
| `authentication.id` | `workbuddy-desktop-ai` | `workbuddy-desktop` |
| 登录域名 `auth.domain` | **`www.workbuddy.ai`** | **`www.workbuddy.cn`** |
| 配置目录 | `~/.workbuddy-ai` | `~/.workbuddy` |
| auth info 文件 | `workbuddy-desktop-ai.info` | `workbuddy-desktop.info` |

**本机证据**（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`，可复现）：

```
workbuddy-desktop-ai.info            ← 活跃（Oct 7 14:23 还在写）
    domain = www.workbuddy.ai   tokenType=Bearer   expiresAt=1821628708618（约1年）
    accessToken = {$wbEncrypted:1, envelope:<2656字符>}   ← 加密落盘
workbuddy-desktop.info.logged-out    ← 国内版历史（Sep 19 登出）
    domain = www.workbuddy.cn
```

## 2. 判定机制（bundle 逆向）

`codebuddy-lite-wb.mjs` 里 `resolveEnvFromSessionFileSync()`：

1. 读 `product.json` 的 `authentication.id`（国际版 = `workbuddy-desktop-ai`）
2. 拼 auth 文件路径：Windows `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<id>.info`
3. 读其中 `auth.domain`，对照 `product.json` 的域名四分类：
   - `internalDomain`（**国内**）：`copilot.tencent.com`, `staging-copilot.tencent.com`, `www.codebuddy.cn`
   - `externalDomain`（**国际**）：`www.codebuddy.ai`, `www.workbuddy.ai`, `staging.workbuddy.ai`
   - 命中 → `ProductEnviroment.Internal` / `.External`（另有 IOA / Cloudhosted / Selfhosted）

**注意**：本机国内版快照的域名是 **`www.workbuddy.cn`**——它不在国际版 product.json 的 `internalDomain` 列表里（那是国际包的列表；国内包的 product.json 必然把 `.cn` 列为 internal）。判定按**本包自己的 product.json 列表**。

## 3. 由此定位的问题（v1.0.59 修的三件）

1. 🔴 **中转上游写死 `https://www.workbuddy.ai`**（`server.mjs:137`、`config.defaults.json:176`）
   → **国内令牌打国际端点必 401**。`x-domain` 头由 `hostOf(base)` 动态派生（`server.mjs:796/2200`），**上游切对它自动对**。
   `main.js:164` 的 `addNoProxyHost(cfg.wb?.upstream || …)` 跟随上游值。
2. 🟡 **`wbCandidateBases()` 缺纯 `Program Files\WorkBuddy`**（有 `WorkBuddyAI`/`WorkBuddy AI`，没有国内版名）。
   注册表 regex `'WorkBuddy'` 两版都能中（本机实测 DisplayName=`WorkBuddy AI 5.6.2`）；
   **但本机注册表 `InstallLocation` 是空的**——全靠候选目录兜底，漏一个位置就「未找到程序」。
3. 🟡 错误提示只提「WorkBuddy AI 客户端」；状态面板不显示版别。

## 4. 走不通的路（别再试）

- **读盘拿明文 token**：`accessToken` 是 `{$wbEncrypted:1, envelope}`，解密钥不在
  `~/.workbuddy-key-fallback/`（那里是 `connector-keys/*.key`，32 字节 raw，与 auth envelope 无关）。
  解密入口疑似 Electron `safeStorage`/DPAPI（`main/credential-protection.js`），**未深入验证**。
  → v1.0.59 仍走注入捕获（v1.0.58 的踢侧车 + 自愈已覆盖）。

## 5. 复现命令

```powershell
# 版别 auth 文件
ls $env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\*.info
# 每个文件里的 domain（不含 token 明文）
#   {"auth":{"domain":"...", "accessToken":{"$wbEncrypted":1,"envelope":"…"}}}

# 安装版别（注册表）
Get-ChildItem 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' |
  %{ $p=Get-ItemProperty $_.PSPath; if($p.DisplayName -match 'WorkBuddy'){
       "$($p.DisplayName) | Loc=[$($p.InstallLocation)]" } }
# 本机输出: WorkBuddy AI 5.6.2 | Loc=[]     ← InstallLocation 为空！
```

## 6. 未验证（诚实标注）

- ⚠️ **`https://www.workbuddy.cn` 的聊天 API 路径**（假定与国际版同为 `/v2/chat/completions`）
  —— **没有国内版真机，未验证**。登录域名 `.cn` 是实测的；API base 是**按国际版对称推定**的。
  需要国内版机器验证：捕获 → 上游切换 → 真实对话。
- ⚠️ 国内版安装目录名/内部结构**未见过实物**（本机只有配置目录残留 `~/.workbuddy`，安装程序已不在）。
  假定与国际版同构（同产品家族），候选目录已按此补。
- 你那台超时的电脑（1.0.57）：**先升级 1.0.58/1.0.59 再试**——1.0.57 的超时主因
  （侧车不重读）已在 1.0.58 修；国内版还需要 1.0.59 的上游切换才能真正接通。
