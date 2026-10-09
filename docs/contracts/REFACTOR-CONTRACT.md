# 面板重构契约（所有 agent 必读）

目标：把 5 个几乎相同的提供方页面（现在 4467 行、54–70% 重复）收敛成
「1 个模板 + 1 份共享 CSS + 1 份共享 JS + 1 张清单」。以后加第 6 家 = 清单加一条。

## 文件职责

| 文件 | 归属 | 内容 |
|---|---|---|
| `provider.html` | Agent B | **唯一模板**。只有外壳 + 插槽 + `<script src>` 引用。**不得含任何 inline CSS/JS** |
| `panel-common.css` | Agent A | 共享样式。配色用 `html[data-provider="x"]` 覆盖 |
| `panel-common.js` | Agent C | 共享渲染逻辑（信号灯/路由表/设置卡/步骤条/徽章/底栏/目录） |
| `providers.js` | Agent D | 五家清单（数据），先定义、后填内容 |
| `cards/*.js` | Agent D | 专属卡片模块（插槽用） |

## 清单 schema（providers.js）

```js
window.BAI_PROVIDERS = {
  <key>: {
    key: "zen",              // bai|sn|wb|zen|qd
    path: "/zen",            // bai 为 "/"
    tab: "OpenCode Zen",     // 导航 tab 文字
    h1: "OpenCode Zen",      // 页面大标题
    sub: "Zen · 免费模型",   // 大标题旁的小字
    title: "OpenCode Zen 路由",          // <title>
    accentLabel: "接通",                // 按钮动词，接通/接入
    targetName: "Zen 模型",              // 路由表第二列表头
    relayHint: ":15752",                 // 接线提示里的端口
    guide: [                              // 两步引导
      { title: "…", desc: "…" },
      { title: "…", desc: "…" },
    ],
    hint: "…",                 // 路由表下方说明
    settingsTitle: "Zen 设置",
    settingsAux: "…",
    lamps: [ "relay", "upstream", "cred" ],   // 该页显示哪几盏灯（见下）
    extraCards: [ "model-catalog" ],          // 专属卡片，见下
    footNote: "…",             // 页脚 paths 文案
    notices: { stale: "…", ccSwitch: "…" },    // 两条提示条的文案（{btn} 会替换成按钮名）
  },
};
```

**lamp id 约定**（渲染层固定这三个 id，各页只声明显示哪几个）：
- `relay` → `ledRelay` / `txtRelay` / `subRelay`（中转）
- `upstream` → `ledUp` / `txtUp` / `subUp`（上游）
- `cred` → `ledTok` / `txtTok` / `subTok`（凭据）

**extraCards 插槽**：`<div id="slot-extra"></div>`，由 `panel-common.js` 按清单里的
`extraCards` 依次加载 `/cards/<name>.js` 并调用其 `mount(ctx)`。已约定三个模块：
- `token-capture`（WorkBuddy 的「一键获取令牌」）
- `model-catalog`（Zen / Qoder 的模型目录）
- `failover`（B.AI 页的「自动故障转移」卡）

## 元素 id 约定（模板与共享 JS 共同遵守，一处都不能改）

```
<nav class="prov-nav">  五个 .prov-tab，当前家带 .active
<span class="svc" id="svc">
<button id="themeBtn"> <span id="themeIcon"> <span id="themeText">
<span class="winCtrls"> #winMin #winMax #winClose

.lamps 里三盏灯：
  relay    #ledRelay #txtRelay #subRelay
  upstream #ledUp    #txtUp    #subUp
  cred     #ledTok   #txtTok   #subTok
  （sn 页只有 relay + upstream，cred 那盏整个不渲染）

接线卡：#patchTime #patchCli #cliBadge #patchDesk #deskBadge
        #btnApply(接通用例) #btnRestore #ckCli #ckDesk #applyResult
提示条：.notice（无 id，共享逻辑直接选第一个）

两步引导卡：#guideAux #step1 #state1 #step2 #state2 #btnApply
路由表卡：#routeBody（每行由共享逻辑生成：
          <td class="tier"> .zh  <span class="arrow"> <select> <input.lbl> <input.custom>）
          #btnSave #btnTest #ckAllTiers #testResult
插槽：  <div id="slot-extra"></div>
设置卡：#cardSys #headSys #fUpstream #fRelayPort #fModels #ckUseProxy
        #btnSaveSys #btnDeploy #sysResult
        （凭据输入框 id 由该 provider 的 extraCards 或清单决定，见 providers.js）
页脚：  <footer> #footPaths #verTxt（#updBtn #btnSelfUpd #stopBtn 由 panel-common.js 注入）
横幅：  .banner-wrap 里 #bnrUpdate（共享逻辑注入）与 #bnrInfo #bnrInfoTitle #bnrInfoMsg #bnrInfoX
```

## 硬约束

1. **不得改动任何服务端逻辑**（server.mjs / publish.cjs / package.json 都不在本次范围）。
2 不得删除现有功能：底栏三按钮、主题切换、窗口控制、折叠卡、两步引导、接回 CC Switch、
   「刷新模型列表」「测试连通」「保存映射」「刷新模型列表」等按钮全部保留。
3 所有中文文案必须与现在**逐字一致**（本轮刚修过一批复制粘贴留下的错配，别改回去）。
4 强调色变量统一叫 `--accent`（B.AI 页现在叫 `--amber`，要改过来）。
5 每个 agent 交付时必须自证：CSS 用「与现有页面 diff 无实质差异」自证；JS 用 `node --check`；
   页面用 Electron 无头渲染截图（渲染脚本在 `C:\Users\admin\Desktop\新建文件夹\bai-router\qd-render-check.js`
   与 `%TEMP%\qd-check-app\`，注意 Electron 会按当前目录 package.json 的 main 启动，
   必须把脚本拷到一个**独立目录**并配一个只含 `{"name":"x","version":"1.0.0","main":"main.js"}` 的 package.json）。

## 已知坑（务必避开）

- Git Bash 会吞 `/S`；多行内容用 python heredoc 写文件时 `\\n`/`\"` 会被吞，
  **优先用 Write/Edit 工具写文件，不要用 shell 重定向拼内容**。
- 改完服务端代码后先确认没有残留 node 进程，否则测的是旧代码（今天踩了三次）。
- 五页现在 `<body>` 都没有标识，模板里要加 `data-provider`。