/**
 * src/server/nsis-args.cjs —— 静默安装时「装到哪儿」的参数（纯逻辑，可测）
 *
 * ## 为什么需要
 *
 * NSIS 安装器（electron-builder 产的那个）决定安装目录的顺序是：
 *   ① 命令行 `/D=<dir>`（若给了）
 *   ② 注册表里上一版的 `InstallLocation`
 *   ③ 默认目录（%LOCALAPPDATA%\Programs\）
 *
 * ⚠⚠ 还有一条容易踩的规矩（`assistedInstaller.nsh` 的 `instFilesPre`）：
 *   **目标目录名里不含产品名时，安装器会自动补一层**
 *   （`${APP_FILENAME}` = `B.AI Router`）⇒ 传 `G:\bai-router\app` 会变成
 *   `G:\bai-router\app\B.AI Router`（多一层）⇒ 桌面图标指到不存在的文件
 *   ⇒ 症状是「装上了但用不了」（2026-10-25 真实踩到）。
 *
 * ⇒ 所以传给 `/D=` 的应当是**已经含产品名的目录** ——
 *   也就是当前 exe 所在的目录（`path.dirname(exe)`）。
 *
 * ## 两条边界
 *
 * · `/D=` 必须是**最后一个参数**；路径含空格时把**整个参数**引起来即可。
 * · 路径含 cmd 的元字符（`" & | ^ < >`）⇒ 不传（靠注册表那一格兜底）。
 */

/**
 * @param {string} exePath 当前安装的那份 exe（来自 BAI_ROUTER_EXE）
 * @returns {string} 追加到安装器命令行的参数（含前导空格），或空串
 */
function installDirArg(exePath) {
  const exe = String(exePath || "");
  if (!exe) return "";                       // 绿色/开发模式：没有安装目录这回事
  const dir = exe.replace(/[\\/][^\\/]*$/, "");   // dirname，不依赖 path 模块的平台行为
  if (!dir) return "";
  if (/["&|^<>]/.test(dir)) return "";       // 传不了 ⇒ 靠注册表
  return /\s/.test(dir) ? ` "/D=${dir}"` : ` /D=${dir}`;
}

/** 判断一个目录名是否「含产品名」（NSIS 不会补一层）。 */
function looksLikeAppDir(dir, appName = "B.AI Router") {
  const s = String(dir || "").replace(/[\\/]+$/, "");
  const leaf = s.split(/[\\/]/).pop() || "";
  return leaf === appName;
}

module.exports = { installDirArg, looksLikeAppDir };
