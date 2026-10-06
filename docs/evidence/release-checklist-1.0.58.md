# 发布前检查清单 — v1.0.58

> **谁执行**：编排者（我）准备**内容与验证**；**`npm run publish` 由用户授权后才跑**。
> 我**从不**自行执行 `publish.cjs`（它会 `gh release create`，是不可逆的对外动作）。

---

## A. 代码层（全部任务完成后）

- [ ] `node scripts/check-manifest.cjs` → **0 error**（C1–C13 全绿）
- [ ] `node scripts/verify-artifact.cjs` → 通过（**依赖重新打包的 `dist/`**）
      ⚠️ 当前 `dist/win-unpacked` 是 **v1.0.57 旧产物**，加第 6 家后**必须重打**
- [ ] `python` 读 `package.json` → `version = 1.0.58`（**由用户或我手动 bump，见 D**）
- [ ] `git diff | grep -c "sk-or-v1-"` → **0**（OpenRouter key 不得进源码）
- [ ] `config.defaults.json` 无本机路径（C13 已把关）
- [ ] 源码目录无 `*.log` 残留

## B. 回归确认（前三个任务的关键代码不被第 6 家回退）

```bash
grep -c FreeUsageLimitError   src/server/server.mjs   # ≥9
grep -c rate_limit_quota      src/server/server.mjs   # ≥1
grep -c upstream_500          src/server/server.mjs   # ≥2
grep -c dumpUpstreamBody      src/server/server.mjs   # ≥3
grep -c "中转端口只承接"       src/server/server.mjs   # ≥1
grep -c wbCaptureSelfHeal     src/server/server.mjs   # ≥3
grep -c failoverQuotaBlocked  src/server/failover.mjs # ≥1
```

## C. 第 6 家（OpenRouter）专属

- [ ] **C1**：`6 providers, 13 required fields each`（基线是 5）
- [ ] **C7**：6 个 `html[data-provider="…"]`（基线 5）
- [ ] **C9**：nav tabs 含新 key（基线 `bai, sn, wb, zen, qd`）
- [ ] **端口 15772** 未与现有冲突（15722/32/42/52/62 + 面板 15723）
- [ ] **`noProxyList` 两处同步**：
  - `src/main.js` 的 `addNoProxyHost(...)` 多一行
  - `src/server/server.mjs` 的 `computeNoProxy` 多一行 `add(hostOf(...))`
  - 启动日志**不出现** `⚠ NO_PROXY 与本进程计算结果不一致`

## D. 发布内容

- [ ] **`release-notes.md` 整份替换**为 v1.0.58（草稿在
      `docs/evidence/release-notes-1.0.58-draft.md`，**完成 OpenRouter 后补最后一条**）
      ⚠️ 该文件当前仍是 **v1.0.57 已发布内容**，不可提前改
- [ ] `package.json` `version` → `1.0.58`（**用户授权后我改，或用户自己改**）
- [ ] 打包：`export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY="127.0.0.1,localhost"`
      然后 `npm run dist`
- [ ] `node scripts/verify-artifact.cjs`（对**新** `dist/` 跑）

## E. 提交与推送

- [ ] 当前未推提交 **11 个**（`git log origin/main..HEAD --oneline`）
- [ ] 新增改动一并提交
- [ ] 远端当前是 **https** 形式 `https://github.com/gg320324492-lgtm/bai-router.git`
      （用户给的是 `git@github.com:gg320324492-lgtm/bai-router.git` —— **同仓库，ssh vs https**，
      推送前确认本机有对应凭证）
- [ ] **`git push`** —— 我**不会自行 push**，需要你确认

## F. 发布（**仅在用户授权后**）

- [ ] `npm run publish` → 内部跑 `check-manifest` → `gh release create v1.0.58 …`
- [ ] 代理必须先设（否则 GitHub 直连 ETIMEDOUT，见 memory `bai-router-publish-proxy.md`）

---

## 已知风险（执行时留意）

1. **`dist/` 是旧的** —— 不重新打包就 `verify-artifact`，会检查到 v1.0.57 的产物（**假绿灯**）
2. **`release-notes.md` 别提前改** —— 它是 v1.0.57 的已发布内容
3. **`gh release create` 不可逆** —— 只能由用户授权触发
4. **`noProxyList` 漏同步 → 重启死循环**（v1.0.37 加 zen 时真实发生过）
