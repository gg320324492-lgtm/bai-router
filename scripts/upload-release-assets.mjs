/**
 * 传 release 资产并**逐个验大小**（2026-10-25）
 *
 * ## 为什么不用 `gh release upload`
 *
 * 那次 `gh release create` **报成功**，但远端的安装包只有 178KB（本地 112MB）
 * ⇒ **上传被截断而 gh 没报** ⇒ 客户端会自动更新到这个**残缺文件**。
 * ⇒ 所以这里改成：REST API 逐个传 + 传完**用 API 查回来比对大小** + 不对就重传。
 *
 * ## 两条路都试过
 *
 * · 直连：连上了，但 111MB 传到一半断了 ⇒ 远端是残缺的（**最坏**：看着成功）。
 * · 代理：GraphQL 那一步就 EOF。
 * ⇒ 所以每条路都试，并**以大小为准**。
 *
 * ⚠ 令牌只从 `gh auth token` 取，**不打印、不落盘**。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "gg320324492-lgtm/bai-router";
const TAG = process.argv[2] || "v1.0.108-beta.1";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const DIST = path.join(ROOT, "dist");

const ASSETS = [
  "BARRouter-Setup-1.0.108-beta.1.exe",
  "BARRouter-Setup-1.0.108-beta.1.exe.blockmap",
  "beta.yml",
  "upgrade.ps1",
  "rollback.ps1",
];

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
if (!token) { console.error("拿不到 gh 令牌"); process.exit(1); }

const ROUTES = [
  { name: "代理", env: { HTTPS_PROXY: "http://127.0.0.1:7897", HTTP_PROXY: "http://127.0.0.1:7897" } },
  { name: "直连", env: {} },
];

/** 查远端某资产的大小（没有 ⇒ null）。 */
function remoteSize(name) {
  const r = spawnSync("gh", ["api", `repos/${REPO}/releases/tags/${TAG}`, "--jq", ".assets[] | select(.name==\"'" + name + "'\") | .size"], {
    encoding: "utf8", env: { ...process.env, ...ROUTES[0].env },
  });
  if (r.status !== 0) return null;
  const s = parseInt(String(r.stdout).trim(), 10);
  return Number.isFinite(s) ? s : null;
}

/** 删掉远端某个资产。 */
function deleteAsset(id) {
  spawnSync("gh", ["api", "-X", "DELETE", `repos/${REPO}/releases/assets/${id}`], {
    stdio: "ignore", env: { ...process.env, ...ROUTES[0].env },
  });
}

function listAssets() {
  const r = spawnSync("gh", ["api", `repos/${REPO}/releases/tags/${TAG}`, "--jq", ".assets[] | \"\\(.id) \\(.name) \\(.size)\""], {
    encoding: "utf8", env: { ...process.env, ...ROUTES[0].env },
  });
  if (r.status !== 0) return [];
  return String(r.stdout).split(/\r?\n/).filter(Boolean).map((l) => {
    const [id, name, size] = l.trim().split(/\s+/);
    return { id, name, size: parseInt(size, 10) };
  });
}

const rel = spawnSync("gh", ["api", `repos/${REPO}/releases/tags/${TAG}`, "--jq", ".id"], {
  encoding: "utf8", env: { ...process.env, ...ROUTES[0].env },
});
let releaseId = String(rel.stdout || "").trim();
if (!releaseId) {
  /* ⚠ release 不存在 ⇒ **先用 REST 建一个**（不带资产 ⇒ 快，也不会碰到
   *   「上传被截断却报成功」那个坑）⇒ 再逐个传资产、逐个验大小。 */
  console.log(`release ${TAG} 不存在 ⇒ 先建一个（prerelease，不带资产）`);
  const body = JSON.stringify({
    tag_name: TAG,
    name: TAG,
    body: fs.existsSync(path.join(ROOT, "release-notes.md"))
      ? fs.readFileSync(path.join(ROOT, "release-notes.md"), "utf8") : TAG,
    prerelease: true,
    draft: false,
    target_commitish: process.argv[3] || "main",
  });
  const mk = spawnSync("curl", [
    "-sS", "--ssl-no-revoke", "-m", "120", "-X", "POST",
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28",
    "-H", "Content-Type: application/json",
    "--data-binary", body,
    "https://api.github.com/repos/" + REPO + "/releases",
    "-w", "\\n%{http_code}",
  ], { encoding: "utf8", env: { ...process.env, ...ROUTES[0].env } });
  const out = String(mk.stdout || "");
  const code = (out.trim().split(/\r?\n/).pop() || "").trim();
  if (code !== "201") {
    console.error("★ 建 release 失败：HTTP " + code + " " + out.slice(0, 300));
    process.exit(1);
  }
  const j = JSON.parse(out.slice(0, out.lastIndexOf("\n")));
  releaseId = String(j.id || "");
  console.log("  已建，id=" + releaseId);
}
console.log("release id:", releaseId);

for (const name of ASSETS) {
  const local = path.join(DIST, name);
  if (!fs.existsSync(local)) { console.log("跳过（本地没有）：", name); continue; }
  const localSize = fs.statSync(local).size;
  let remote = remoteSize(name);
  if (remote === localSize) { console.log(`✓ 已是最新：${name}（${localSize} 字节）`); continue; }
  if (remote !== null) {
    console.log(`✗ 远端大小不对（${remote} ≠ ${localSize}）⇒ 先删掉再重传`);
    const hit = listAssets().find((a) => a.name === name);
    if (hit) deleteAsset(hit.id);
  }
  let ok = false;
  for (const route of ROUTES) {
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      console.log(`  传 ${name}（${route.name} 第 ${attempt} 次，${Math.round(localSize / 1048576)}MB）…`);
      const r = spawnSync("curl", [
        "-sS", "--ssl-no-revoke", "-m", "900",
        "-X", "POST",
        "-H", `Authorization: Bearer ${token}`,
        "-H", "Content-Type: application/octet-stream",
        "-H", `X-GitHub-Api-Version: 2022-11-28`,
        "--data-binary", `@${local}`,
        `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        "-w", "\\n%{http_code}",
      ], { encoding: "utf8", env: { ...process.env, ...route.env } });
      const out = String(r.stdout || "");
      const code = (out.trim().split(/\r?\n/).pop() || "").trim();
      if (code !== "201") { console.log("    上传失败：HTTP", code, out.slice(0, 120).replace(/\s+/g, " ")); continue; }
      const back = remoteSize(name);
      if (back === localSize) { console.log(`    ✓ 传完且大小一致（${back} 字节）`); ok = true; }
      else {
        console.log(`    ✗ 大小不对（远端 ${back} ≠ 本地 ${localSize}）⇒ 删掉重来`);
        const hit = listAssets().find((a) => a.name === name);
        if (hit) deleteAsset(hit.id);
      }
    }
    if (ok) break;
  }
  console.log(ok ? `★ ${name} 完成` : `★★ ${name} 仍不对`);
}

console.log("\n最终远端状态：");
for (const a of listAssets()) {
  const localSize = fs.existsSync(path.join(DIST, a.name)) ? fs.statSync(path.join(DIST, a.name)).size : null;
  const mark = localSize === null ? "（本地无）" : (a.size === localSize ? "✓" : "✗ 大小不对");
  console.log(`  ${mark} ${a.name}  远端 ${a.size} 字节`);
}
