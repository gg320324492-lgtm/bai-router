# OpenCode 通道：子进程数据目录必须隔离（2026-10-17）

## 现象（本机 v1.0.86 实测复现）

在装有 **OpenCode 桌面版（2.x）** 的机器上，`transport=opencode` 的请求启动
`opencode serve`（npm 官方 1.19.3）后**进程立即退出**，现场表现只是
「OpenCode 没起来」——因为子进程输出默认只进环形缓冲、不进日志。

把子进程 stderr 抓出来，真正的报错是：

```
Error: Unexpected error
Database is not empty and has no session table
```

## 根因（实测确证，非推断）

- opencode **1.x CLI 与桌面版 2.x 共用同一个默认数据目录**：`~/.local/share/opencode`。
- 桌面版 2.x 的库表（`sqlite3 .tables` 输出）里有 **`session_v2`**，**没有** 1.x 需要的 `session`：

  ```
  account  account_state  control_account  credential  event  event_sequence
  instruction_blob  instruction_entry  instruction_state  kv  migration
  permission  project  project_directory  session_inbox  session_message
  session_pending  session_v2  workspace  worktree
  ```

- 于是一旦机器上跑过桌面版，1.x 再来开这个库就必然拒启。

## 对照组（同一台机器、同一个二进制）

| 环境 | 结果 |
|---|---|
| 默认 env（不隔离） | 立即退出（上面的报错） |
| 只隔离 `XDG_DATA_HOME` | `GET /session` → HTTP 200 |
| 四件套隔离（DATA/CONFIG/CACHE/STATE） | 真调 `space-bunny-free` → `finish=stop`，正文 `OK` |
| 四件套隔离 + `scripts/oc-native-tool-e2e.mjs` | 两种形态全过（① 2649ms、② 4515ms，exit=0） |

## 修复

- `oc-wiring.mjs` 新增 `ocSpawnEnv(env, base)`：四件套 XDG 统一指向 `base/xdg/*`，
  并**不改传入的 env 对象**；没有任何落点时原样返回（不猜路径）。
- `runtime()` 里把传给 `createRuntime` 的 `env` 换成 `ocSpawnEnv(env, wd)`；
  **二进制发现仍用原始 env**（探测路径是 PATH / APPDATA，与 XDG 无关）。
- 测试：`scripts/oc-wiring-test.mjs` 新增 ①.5 组（纯函数 + 源码级接线断言）；
  真机端到端复验命令：`npm run test:oc-e2e`（本机装有桌面版、库冲突存在时才具有判别力）。

## 复验记录（2026-10-17 本机，均为当日实测）

- `node --test --test-concurrency=1 scripts/oc-wiring-test.mjs`（含端到端）：**40/40 通过**
  —— ⑧ 三条端到端（真 server + 真 opencode + 真免费档）**首次尝试即 200**：
  流式 tool_use 8.9s / 非流式 4.3s / 会话复用 5.3s。本机装有桌面版、库冲突真实存在，
  这是补丁最有判别力的一次运行。
- 中继实弹（接线后的真产品）：`POST http://127.0.0.1:15752/v1/messages`
  → `model=space-bunny-free, stop_reason=end_turn, text=OK`。
- `node scripts/check-manifest.cjs` → **0 error / 0 warn**（15 道闸门全过）。
