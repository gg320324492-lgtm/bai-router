## v1.0.95-beta.1 更新内容

**这一版是测试版（beta）。想稳的人别升；想试的人从托盘菜单「更新通道」切到测试版。**

相对 **v1.0.94-beta.1**，这一版把三块 magpie 的能力接进了真实链路，另外**修掉了两个
「以为在判、其实没判」的老 bug**。

**回退**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/rollback.ps1 -UseBasicParsing | iex"
```

---

### 一、入口不再只认 Anthropic 规范：Codex 与 Gemini CLI 能直接连上来了

之前网关只听得懂 Anthropic 的话（Claude Code / Claude 桌面版都这么说）。现在多认两种：

| 客户端 | 说的协议 | 走哪个端点 |
| --- | --- | --- |
| Codex / 新版 OpenAI SDK | OpenAI **Responses** | `POST /v1/responses` |
| Gemini CLI / Google SDK | Gemini `generateContent` | `POST /v1beta/models/{model}:generateContent` |

- 客户端的话 → **统一协议 IR** → 翻成 Anthropic 形状 → 交给那家的中转。
  翻完之后**与 Anthropic 那条路完全一样**：一样的模型解析、一样的故障转移、一样的冷却、
  一样的账本。所以「到了那家之后」的行为逐字相同。
- 回程也翻回来：上游的应答 → 客户端自己那个协议的形状（Responses 的
  `response.output_text.delta` 事件、Gemini 的 `candidates` 数组）。
- **模型 id 的约定与 Anthropic 那条路一样**：`provider/档位`（如 `sn/claude-opus-5`）。
  Gemini 的模型名在路径里，所以那一段要 URL 编码（`sn%2Fclaude-opus-5`）。
- ⚠ 明确**不支持**的字段一律**报错**，不静默丢：Responses 的 `previous_response_id`
  / `store` / `background`；Gemini 的 `cachedContent` / `safetySettings` 与一批采样参数。
  静默丢字段会让模型看不到上一轮，还答得像模像样——那比报错更坏。

### 二、一份 JSON 声明就能加一家渠道（不用改代码）

把一份声明放进 `<数据目录>\plugins\*.json`，重启（或面板上点「重新扫描目录」）即可：

```json
{
  "manifestVersion": 1, "id": "acme", "name": "Acme",
  "upstream": "https://api.acme.example/v1", "protocol": "openai", "auth": "apikey",
  "models": ["acme-pro"], "relayPort": 15802,
  "mapping": { "claude-fable-5": "acme-lite", "claude-sonnet-5": "acme-pro",
               "claude-opus-5": "acme-pro", "claude-haiku-4-5": "acme-lite" }
}
```

- ⚠ **声明里不许带凭据**。插件是要分发给别人的东西，里面带 key 等于把你的 key
  发给所有装它的人。凭据在面板的「插件渠道」卡里填（存进你的配置，不进声明）。
- ⚠ **撞出厂渠道的键一律报错不覆盖**——覆盖等于让一个插件改掉你已有的 bai 配置。
- ⚠ **装不上的插件不拖垮启动**，而且面板会**说清为什么**（人话，不是 "invalid schema"）。
- 插件渠道有自己的中转端口，也进统一网关的落点表，与出厂八家用同一批 handler 逻辑。

### 三、审计台账：链路上发生过什么，事后能翻

面板「控制台」新增「审计台账」卡：**每一次对外尝试**记一条——时间、渠道、模型、结果、
耗时、失败被归成哪一类（额度 / 限流 / 不被服务 / 认证…）。按归类分布、按渠道、最近尝试三张表。

- 它与「用量账本」不是一回事：用量账本记**钱花到哪儿**（token、费用），审计台账记
  **链路上发生过什么**。用途是复盘：「昨天 Claude 卡了」，能翻出那段时间每条请求去了哪、
  哪一家在拖后腿。
- ⚠ 台账里**绝不能出现凭据**：上游的错误正文常把请求里的东西原样回显（连
  `authorization` 都可能吐回来），所以每一个字段都过一遍脱敏。

### 四、限流：别把某一家打爆（**默认关着**）

面板「故障转移」新增「限流」卡：每家的**并发上限**与**每分钟请求上限**（0 = 不限）。

- ⚠ **默认不限**。限流是你自己开的开关，不该突然开始拦你的请求。
- 两道闸的顺序是「先并发名额、后每分钟名额」：每分钟名额记的是**真发出去的请求**，
  先占它会在并发排队时白耗额度。
- ⚠ 释放写在 `finally` 里（成功、失败、抛异常，三条路都还）。漏一次 = 永久占一个坑 =
  那家的请求从此全排队——用户看到的是「卡住」而不是「并发上限」，那种 bug 极难查。

### 五、配置备份：重装一次，这些还在

面板「设置」新增「配置备份」卡：**导出**一份（口令加密）到 `<数据目录>\backups\*.bak`，
**导入**一份（合并回当前配置，不是整份替换）。

- 备份里**有**你的真实凭据（那正是它的用处），所以**明文绝不落盘**：AES-256-GCM +
  PBKDF2（60 万次），定长二进制容器（盐与 IV 都在里面）。
- ⚠ 导入**之前**先把当前配置另存一份 `before-import-*.json`——还原是破坏性的，
  得留一条回头路。
- ⚠ **只还原路由台自己的配置**，不动 `~/.claude/settings.json`（那是整份覆盖会抹掉
  注释与键序的地方）。

### 六、★ 修两个「以为在判、其实没判」的老 bug

**① `ir.mjs` 的 `anthropicDecoder` 从来没跑过。**
它调 `emit`，而 `emit` 只定义在 `chatDecoder` 的闭包里 —— 于是它**第一次解事件就
ReferenceError**。而 `scripts/ir-test.mjs` **import 了它却从没调用过**，所以这个 bug
从写下那天起一直活着（是这一轮接协议时撞出来的）。

> 教训：**「import 了」不等于「跑过了」**。一个从没被调用的导出函数，它里面的一切
> 都可能没被验证过 —— 跟「装饰性代码」是同一类病。

**② 账本上的 token 数按协议不一样。**
OpenAI 的 `prompt_tokens` **含**缓存命中的那部分，Anthropic 的 `input_tokens` **不含**。
两边不一样的话，同一段提示词换个协议上游，账本上的「输入 token」就差一截；而面板把
「输入」与「缓存读」摆成两格，含缓存的那份会让两者**加起来超过**真实提示词（重复计）。
现已统一成 Anthropic 那一套（magpie 也是这个口径）。

### 七、其它

- 救砖脚本的「校验 sha512」不再是装饰（详见 v1.0.94-beta.1 的说明）。
- 发版脚本的远端核对**自己挑一条能通的路**（探测量的是 `api.github.com`，核对打的是
  `github.com`，两条路的时延差一个数量级 —— 以前探测的决定会顺手把核对那条路断掉）。

---

### 验证

- `npm test` —— **全绿**
- `node scripts/check-manifest.cjs` —— **0 error 0 warn**
- 协议入口有**活体**用例：真起服务、真上游、真客户端 —— Responses 流式与非流式、
  Gemini、以及「模型名没前缀 → 400 说清怎么写」。
- Anthropic 那条路**逐字等价**的性质没破（老路与新路对拍，上游收到的 body 逐字相同）。

### 这一版**没有**做的

- 插件体系只做了**声明式 provider 插件**；agent / middleware 插件（magpie 的
  `pluginrt` 那套）还没做。
- **远端同步**（WebDAV / GitHub）：模块已就位且有单测，但**接线未做**（要远端目标与
  凭据的 UI）。所以目前只有**本地**备份。
- 供应商配额的**真探测**仍缺（magpie 靠 OAuth 登录态查配额接口，本仓没有这个前提，
  只能吃被动信号）——转移链的排序目前保持配置里的顺序。
- 面板的广度远没到 magpie 那个规模。
