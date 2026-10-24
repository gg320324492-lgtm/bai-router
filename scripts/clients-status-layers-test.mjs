/**
 * 客户端状态判定：逐层 + 如实（scripts/clients-status-layers-test.mjs）
 *
 * ## 测什么
 *
 * ★ ① **逐层判定**：一个客户端可能有多份文件，而**每一份都得对**才算接上。
 *   早先只看 `list[0]`（第一份文件）⇒ Cline 那个**认证门**在
 *   globalState.json + secrets.json 里 —— 只写 providers.json 的话 CLI 一个请求
 *   都发不出去（实测：「Not authenticated」），而面板上却说「已接上」⇒ **骗人**。
 * ★ ② **只接了一半**要说清**还差哪几层**（只报文件名，不含任何值）。
 * ★ ③ **半个接线**（声明层的 `partial`）不能被说成「已接到 B.AI」——
 *   Cursor CLI 那一格：magpie 也只接管 model 一个字段 ⇒ 它的请求仍然走 Cursor
 *   自己的后端 ⇒ 说「已接上」是误导。
 * ★ ④ **装没装**看客户端自己的目录（`installedDir`）—— 配置文件在更深的子目录里
 *   的那些（Cline 的 `~/.cline/data/settings/` 是**第一次运行才建**的），
 *   不然刚装上、还没跑过的客户端会被误判成「没装」。
 *
 * ## 红线
 *
 * 纯源码 + 临时目录断言：不碰真实用户目录、不联网、不含任何真实凭据。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientStatus, backupFileOf } from "../src/server/clients/base.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bai-clst-${tag}-`));
}

/** 一份「两层」客户端声明：providers.json（第一层）+ state.json（第二层）。 */
function twoLayerDef(dir, opts = {}) {
  const a = path.join(dir, "providers.json");
  const b = path.join(dir, "state.json");
  return {
    id: "two-layer",
    name: "两层客户端",
    partial: !!opts.partial,
    partialNote: opts.partialNote || "",
    installedDir: opts.installedDir || null,
    files: () => [
      {
        path: a,
        format: "json",
        wired: (text) => /"ours"/.test(text),
      },
      {
        path: b,
        format: "json",
        wired: (text) => /"ours"/.test(text),
      },
    ],
  };
}

describe("① 逐层判定", () => {
  test("①a 只接好第一层 ⇒ 不算接上，且说清还差哪一层", () => {
    const dir = tmpDir("one");
    try {
      fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify({ k: "ours" }), "utf8");
      /* state.json 不写（= 第二层没到位） */
      const st = clientStatus(twoLayerDef(dir), { home: dir }, { dataDir: dir });
      assert.equal(st.wired, false, "★ 缺一层就不能算接上");
      assert.equal(st.halfWired, true, "★ 缺一层要报「只接了一半」");
      assert.match(st.detail, /state\.json/, "★ 要说清还差哪一份（只报文件名）");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("①b 两层都到位 + 有备份 ⇒ 接上了", () => {
    const dir = tmpDir("both");
    try {
      fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify({ k: "ours" }), "utf8");
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ k: "ours" }), "utf8");
      fs.mkdirSync(path.dirname(backupFileOf("two-layer", dir)), { recursive: true });
      fs.writeFileSync(backupFileOf("two-layer", dir), "{}", "utf8");

      const st = clientStatus(twoLayerDef(dir), { home: dir }, { dataDir: dir });
      assert.equal(st.wired, true);
      assert.equal(st.halfWired, false);
      assert.match(st.detail, /已接到 B\.AI/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("①c 两层都到位但**没有备份** ⇒ 配置里有，但不是本机接的", () => {
    const dir = tmpDir("nobackup");
    try {
      fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify({ k: "ours" }), "utf8");
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ k: "ours" }), "utf8");
      const st = clientStatus(twoLayerDef(dir), { home: dir }, { dataDir: dir });
      assert.equal(st.wired, false, "没有备份 ⇒ 不能算我们接的");
      assert.equal(st.configured, true);
      assert.match(st.detail, /没有备份记录/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("② 半个接线（如实）", () => {
  test("②a partial 客户端：不能出现「已接到 B.AI」", () => {
    const dir = tmpDir("partial");
    try {
      fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify({ k: "ours" }), "utf8");
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ k: "ours" }), "utf8");
      fs.mkdirSync(path.dirname(backupFileOf("two-layer", dir)), { recursive: true });
      fs.writeFileSync(backupFileOf("two-layer", dir), "{}", "utf8");

      const st = clientStatus(
        twoLayerDef(dir, { partial: true, partialNote: "只设了模型（不走 B.AI）" }),
        { home: dir }, { dataDir: dir });
      assert.equal(st.partial, true, "partial 标记要透传给面板");
      assert.equal(st.partialNote, "只设了模型（不走 B.AI）");
      assert.doesNotMatch(st.detail, /已接到 B\.AI/,
        "★ 半个接线不能写成「已接到 B.AI」—— 它的请求根本不走 B.AI");
      assert.match(st.detail, /只设了模型/, "detail 要说清接到哪、没接到哪");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("②b 面板上那一格得**行为**上不出现「已接上」（判据在 clients-card-test.mjs）", () => {
    /* 面板的措辞是**渲染出来**才知道的 ⇒ 那个断言在 clients-card-test.mjs 里
     * （那儿有 DOM 替身，能读到卡片真的画了什么）。
     * 这里只钉住一件事：**状态对象带着 partial 与那句说明**。 */
    const dir = tmpDir("partial2");
    try {
      fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify({ k: "ours" }), "utf8");
      const st = clientStatus(
        twoLayerDef(dir, { partial: true, partialNote: "只设了模型（不走 B.AI）" }),
        { home: dir }, { dataDir: dir });
      assert.equal(st.partial, true);
      assert.equal(st.partialNote, "只设了模型（不走 B.AI）");
      assert.ok(!/已接到 B\.AI/.test(st.detail), "★ 半个接线不能写「已接到 B.AI」");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("③ 装没装：看客户端自己的目录", () => {
  test("③a 配置文件在更深的子目录里、客户端目录在 ⇒ 「装了但还没生成过配置」", () => {
    const dir = tmpDir("installed");
    try {
      const clientRoot = path.join(dir, ".cline");
      const deep = path.join(clientRoot, "data", "settings");
      fs.mkdirSync(deep, { recursive: true });   // 客户端目录在（配置还没生成）
      const def = {
        id: "deep",
        name: "深目录客户端",
        installedDir: () => clientRoot,
        files: () => [{ path: path.join(deep, "providers.json"), format: "json", wired: () => true }],
      };
      const st = clientStatus(def, { home: dir }, { dataDir: dir });
      assert.equal(st.missing, false, "★ 装了就不该说「没装」");
      assert.equal(st.notConfigured, true, "★ 该说「装了，还没生成过配置」");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("③b 客户端目录也不在 ⇒ 「没装」", () => {
    const dir = tmpDir("notinstalled");
    try {
      const def = {
        id: "deep2",
        name: "深目录客户端",
        installedDir: () => path.join(dir, ".not-there"),
        files: () => [{ path: path.join(dir, ".not-there", "x.json"), format: "json", wired: () => true }],
      };
      const st = clientStatus(def, { home: dir }, { dataDir: dir });
      assert.equal(st.missing, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
