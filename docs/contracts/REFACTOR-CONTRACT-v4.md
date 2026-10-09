# REFACTOR-CONTRACT v4 — 清理历史备份文件（v1.0.50）

给实施 agent 的边界契约。**只有一个工作项**，范围很小，但有一个容易做错的判断点。

---

## 背景

`src/server/` 下有 5 个 `.bak-*` 历史备份文件，共 ~247KB，自 v1.0.27/v1.0.30 时代
遗留下来：

```
src/server/server.mjs.bak-v1.0.27    54502 字节
src/server/server.mjs.bak-v1.0.30    66437 字节
src/server/sn.html.bak-v1.0.30       33727 字节
src/server/ui.html.bak-v1.0.27       44770 字节
src/server/ui.html.bak-v1.0.30       47786 字节
```

**关键事实（我已验证）：**

1. 这 5 个文件**全部被 git 跟踪**（`git ls-files` 能列出）。
   → 删除是**可逆的**：内容都在 git 历史里，`git show <旧提交>:<路径>` 随时可取回。
2. **无任何代码引用它们**。全仓库搜索 `.bak` 只在契约文档里出现（那是说明文字）。
3. 其中 `sn.html.bak-*` / `ui.html.bak-*` 备份的是**已经删除的页面**
   （`sn.html` / `ui.html` 已在 v1.0.49 删除），所以这两个备份更没意义。
4. `.gitignore` 里**没有** `.bak` 规则——所以将来如果再有人手工留备份，又会被提交进来。

---

## 工作项 — 删除备份文件并防止复发

### 步骤 1：确认可恢复（先做，别跳过）
在删除**之前**，先证明内容可从 git 取回。例如：
```bash
git log --oneline -- src/server/server.mjs.bak-v1.0.27
git show <该文件的最后一个提交>:src/server/server.mjs.bak-v1.0.27 | head -5
```
把**实际输出**贴进报告。如果发现某个文件**未被跟踪**（与我的结论不符），
**停下来报告**，不要删。

### 步骤 2：删除这 5 个文件
用 `git rm`（不是 `rm`），让删除进入暂存区。

### 步骤 3：加 `.gitignore` 规则防复发
在 `.gitignore` 末尾追加，并**写清注释说明为什么要防**：
```
# 手工留下的历史备份（*.bak / *.bak-v1.0.27 这类）。删掉旧页后这些备份备份的是
# 已不存在的文件，留在仓库里只是死重量；真要留档就走 git 历史。
*.bak
*.bak-*
```
**注意**：先确认这个规则**不会误伤**仓库里任何**需要保留**的文件。加完请验证：
```bash
git check-ignore -v src/server/server.mjs.bak-v1.0.27   # 应命中新规则
git status --porcelain                                   # 不该有意外文件被忽略
```

### 步骤 4：确认删除没影响任何东西
1. `node scripts/check-manifest.cjs` → **0 error**（闸门会读 src/ 下的文件，确认它不依赖 .bak）
2. `node scripts/verify-artifact.cjs` → 它会检查 `dist/`，而 `dist/` 是**旧构建**，
   可能仍含已删的旧页而报错。**这是预期的**（新 `dist` 下次打包才会生成）。
   请**只确认它没有因为 .bak 删除而新增报错**，把输出贴进报告。
3. `node --check src/server/server.mjs` 仍通过

---

## 禁止

- **不要删除 `REFACTOR-CONTRACT*.md`**（那是任务文档，不是备份）
- **不要动 `dist/`**（陈旧构建产物，下次打包会覆盖）
- **不要动 `.claude/` 目录**（工具配置）
- 不要改任何 `.mjs` / `.js` / `.cjs` / `.html` / `.css` / `.json` 的逻辑
  （本次**只删文件 + 改 .gitignore**）
- 不要删 `cert/` 下的任何东西

---

## 完成判据

1. 5 个 `.bak*` 文件已从工作区和 git 索引中消失
2. `.gitignore` 新增规则，且 `git check-ignore` 实测命中
3. 证明过内容可从 git 历史取回（步骤 1 的输出）
4. `node scripts/check-manifest.cjs` 0 error
5. **报告必须包含**：`git show` 的原始输出（证明可恢复）、`git status` 删除后的状态、
   闸门输出、以及**你不确定的任何地方**

## 报告要求

简短即可，但**必须有实际命令输出**，不要只写"已完成"。我会独立复验——
特别是"可恢复"这一点，我会自己 `git show` 一次确认。
