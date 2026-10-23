# agent plugin 声明示例（T15-g）

**一份 JSON 声明 ⇒ 多一个能接上 B.AI 的客户端。**

把这里的 `.json` 复制到 **`<数据目录>/agent-plugins/`**：

| 环境 | 目录 |
| --- | --- |
| 安装版 | `%APPDATA%\bai-router\agent-plugins\` |
| 开发模式 | `src/server/agent-plugins\`（已 gitignore） |

放完点面板「客户端」那一屏的**「重新扫描」** ⇒ 它就会出现在列表里，能「接上 / 断开」。

## 两个示例

- `aider-minimal.json` —— 最小的一份：只写**地址**与 **key**。
- `aider-full.json` —— 再加上**模型 id**与**模型清单**。

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `manifestVersion` | ✅ | 目前是 `1` |
| `id` | ✅ | 客户端 id（备份文件名、面板上的标识都用它） |
| `name` | ✅ | 面板上显示的名字 |
| `config` | ✅ | 配置文件路径（`~` 与 `$VAR` 会展开） |
| `protocol` | | `chat`（默认）/ `anthropic` / `responses` / `gemini` |
| `format` | | `json` / `toml` / `yaml` / `dotenv`；不给就按扩展名猜，猜不出**报错** |
| `note` | | 一句话说明（面板上显示） |
| `model` | | 模型 id 写进哪个键 |
| `writes` | ✅ | 要写哪几个键 → 写什么值（值是**模板**） |
| `modelList` | | 模型清单：写进哪个路径、什么形状 |
| `wired` | | 怎么判「现在接的是不是我们」 |

## 值的模板

主作用域：`${baseUrl}` / `${baseUrlV1}` / `${apiKey}` / `${providerId}` / `${providerName}` /
`${modelId}` / `${modelLabel}`；`modelList.item` 里另有 `${id}` / `${name}` /
`${provider}` / `${providerName}`。

**整串**就是一个值（数组/对象也行）；**夹在串里**则拼成文本。

⚠ **键路径里只许 `${providerId}`** —— 模型 id 是 `provider/档位`、档位可能带点
（`glm-5.2`），把它插进键路径会把「父路径」算错、断开时还原会炸。

## 为什么不执行 JS

magpie 那一套是 `*.agent.js`（**要被执行**的，它的 pluginrt 是进程内组合运行时）。
本仓**刻意不做**：客户端声明需要的只是数据，第三方 JS 与主程序同进程跑等于发了任意
代码执行权，而插件是要**分发给别人的**东西 —— 数据可以被「看一眼」，代码不能。
详见 `docs/replication-plan.md` 的 T15-g 段。
