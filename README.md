# bai-router

B.AI 路由台 —— Claude Code / Claude 桌面版 外接模型的一键切换与本地中转（Electron + 独立 Node 服务）。

## 升级方式（按推荐顺序）

1. **应用内自动更新**：启动 8 秒后与每 12 小时检查一次，就绪后面板右下角横幅点「重启安装」。
2. **面板「备用升级」按钮**（v1.0.24+）：不依赖内置更新器，由路由台自己从 GitHub 下载最新安装包、校验 sha512 + 数字签名后静默升级。内置更新器出问题时用它。
3. **一行命令救砖**（任何版本，包括更新器损坏的 ≤1.0.19 老版）——在目标电脑 PowerShell 里执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/upgrade.ps1 -UseBasicParsing | iex"
```

跨版本升级均原地覆盖安装，`%APPDATA%\bai-router` 里的配置/映射/备份自动保留。

## 三提供方路由（v1.0.31+）

面板顶部三个页签，各自独立的映射/密钥/中转端口，互不干扰，随时一键切换、一键接回 CC Switch：

| 提供方 | 上游 | 中转端口 | 协议 | 说明 |
| --- | --- | --- | --- | --- |
| B.AI | https://api.b.ai | 15722 | Anthropic 透传 | 默认页 |
| SenseNova | https://token.sensenova.cn | 15732 | Anthropic 透传 | 境内直连 |
| WorkBuddy | https://www.workbuddy.ai | 15742 | **内置 Anthropic↔OpenAI 协议桥** | 三款 0 积分免费模型，直连 |

WorkBuddy 说明：

- 免费模型（随版本推送默认）：`deepseek-v4.1-flash`（1M ctx）、`hy4-preview-f`（1M ctx）、`hy3`（192k ctx）。
- 上游只支持 OpenAI Chat Completions 且仅流式，本地协议桥负责请求/响应双向翻译（含工具调用、思考块、非流式聚合）。
- 认证为 WorkBuddy 客户端的 JWT（访问/刷新/设备令牌 + 用户 ID），访问令牌过期前自动用刷新令牌续期并写回配置。
- 桌面版与终端 CLI 都接到 `127.0.0.1:15742`，模型菜单四档即点即换；切换前自动快照，可一键接回。

## Release 资产

- `BARRouter-Setup-x.y.z.exe(+.blockmap)` — 安装包（差分包可选）
- `latest.yml` — electron-updater 清单
- `upgrade.ps1` — 一键升级脚本（方式 3）
