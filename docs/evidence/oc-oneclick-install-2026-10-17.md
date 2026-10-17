# 一键安装 OpenCode CLI（2026-10-17）

## 动机

「OpenCode 客户端中转」（v1.0.75）要求本机有一个 **opencode 命令行版（1.x）**。新机器的实际
情况通常是：装了 OpenCode **桌面版**，但没有命令行版。桌面版自带的 CLI 经实测**不可用**：

| 测试 | 结果 |
|---|---|
| 探测 | 桌面版 CLI 在 `%APPDATA%\ai.opencode.desktop\cli\2.0.31-x64\opencode-cli.exe`，**不在**二进制发现名单里 |
| `serve --pure`（现有代码的硬编码参数） | 直接退出（2.x CLI **没有 `--pure`**） |
| `serve`（不带 --pure）后打 API | `GET /session` 返回的是**网页首页**；`POST /session` = 405；`/api/*` = **401 需它自己的鉴权** |

也就是说桌面版是**另一代协议（v2）**，把它接进本桥是一次新集成，不是配置问题。
用户要的是「装好路由台就能一键用」，于是产品提供**从官方源一键安装 1.x CLI**。

## 原则修订（重要）

`oc-runtime` / `oc-wiring` 旧文案：「本产品不会替你下载」——那条纪律防的是**猜一种装法硬装下去**
（猜错 = 用户以为装好了，其实只是换了个坏路径）。

一键安装**不是猜**，所以文案修订为「**只在你点了『一键安装』时才下载，除此之外不自动下载任何东西**」：

- 来源固定：npm 官方 registry 平台包 `opencode-windows-x64`
- 版本固定：`1.19.3`（= 2026-10-17 完整验证过的那一版；换版本必须重跑真机 e2e）
- 落地前 **sha512 校验**（integrity 缺失就不下载）；解包后还查 PE 的 MZ 头与最小体积
- 落点 = 官方安装脚本自己的位置 `~/.opencode/bin/opencode.exe`（发现逻辑本来就找它）
- **只有点击触发**：`POST /api/oc/install`，没有任何自动调用路径；已装（探测 found）则直接回 `already`

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/server/oc-install.mjs` | **新增**：下载 / 校验 / 解包 / 落盘（纯逻辑可注入，测试不联网） |
| `src/server/server.mjs` | 新增 `POST /api/oc/install`（单飞 `ocInstallPending`；装完重置探测缓存并回传新状态） |
| `src/server/cards/oc-transport.js` | missing 态画「一键安装」按钮；点击 → 调接口 → 成功后自动切到 opencode 档 |
| `src/server/oc-wiring.mjs` / `oc-runtime.mjs` | 安装指引文案修订（含一键安装入口） |
| `src/server/oc-transport-info.mjs` | 文件头三态说明同步修订 |
| `src/server/providers.js` | zen remedy 增加「一键安装」入口 |
| `package.json` | `extraResources` 加 `oc-install.mjs`；`npm test` 列表加 `scripts/oc-install-test.mjs` |
| `scripts/oc-install-test.mjs` | **新增**：合成 tar.gz / sha512 / 编排 / 纪律（不联网、不碰真实 HOME） |
| `scripts/oc-ui-test.mjs` / `oc-wiring-test.mjs` | 文案断言更新 + 按钮三态断言 + 安装挂载用例 |

## 实测记录（2026-10-17 本机）

- 单元测试：`node --test scripts/oc-install-test.mjs` → **12/12**；改动过的
  `oc-ui-test.mjs + oc-wiring-test.mjs` → **74/74**；全量 `npm test` → **812/812**（0 fail）。
- 闸门：`node scripts/check-manifest.cjs` → **0 error / 0 warn**（15 道全过，C15 认到新模块）。
- 真实下载（模块直调）：官方源 → sha512 通过 → 180,982,664 字节落盘；
  sha256 与手工放置的官方二进制**逐字节一致**（`81BB8DDC…`）。
- 产品内端到端（本机热修后的真应用）：
  1. 把 `~/.opencode/bin/opencode.exe` 改名模拟「新电脑没装」→ `/api/status` 探测 = `missing`，提示含「一键安装」；
  2. `POST /api/oc/install` → **10.4 秒**完成 → 返回 `{ok:true, bytes:180982664, version:"1.19.3", probe:{state:"found"}}`；
  3. 中继实弹（`POST 127.0.0.1:15752/v1/messages`）→ `space-bunny-free` 回 `OK`。
- 新电脑流程（发布含本改动的版本后）：装路由台 → Zen 页点「一键安装」→ 面板自动切到
  「OpenCode 客户端中转」→ 点「接通」→ 重启 Claude Code。**全程不需要手工放任何文件。**
