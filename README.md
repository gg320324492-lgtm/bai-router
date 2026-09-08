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

## Release 资产

- `BARRouter-Setup-x.y.z.exe(+.blockmap)` — 安装包（差分包可选）
- `latest.yml` — electron-updater 清单
- `upgrade.ps1` — 一键升级脚本（方式 3）
