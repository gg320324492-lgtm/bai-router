/**
 * sync-targets-test.mjs —— src/server/sync-targets.mjs 的口径测试
 *
 * 测的是三件要命的事：
 *   ① **写之前必须先问状态、写的时候必须带条件**——「别把别人的更新盖掉」。
 *      三个目标各测一遍：本地目录（客户端比对内容哈希）、WebDAV（If-Match /
 *      If-None-Match: *）、GitHub（Contents API 的 sha）。
 *   ② **冲突口径不许出现第二套**：与 sync.mjs 的 compareState 逐字一致。
 *   ③ **凭据绝不出现在返回值、日志与错误信息里**。
 *
 * 全程离线：IO 全部是注入的假实现（内存里的假 fs、假 fetch），
 * 不联网、不碰磁盘——除了「反向对照」往系统临时目录写一份源码副本。
 * 本测试**不碰**真实的 %APPDATA%\bai-router 与 ~/.claude/settings.json。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashParts, compareState, runSync, REMOTE_CHANGED_CODES } from "../src/server/sync.mjs";
import {
  createLocalTarget,
  createWebDavTarget,
  createGitHubTarget,
  createTarget,
  readRemoteParts,
  compareTarget,
  resolveConflict,
  CONFLICT_POLICIES,
} from "../src/server/sync-targets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, "..", "src", "server");
const SRC = path.join(SERVER_DIR, "sync-targets.mjs");

const NOW = 1_700_000_000_000;
const OLD = NOW - 10_000;
const MTIME = NOW - 60_000;

/* 假凭据：一眼看出是假的。 */
const FAKE_WEBDAV_PASS = "dav-test-pass-0000";
const FAKE_GH_TOKEN = "ghp_test0000000000000000000000000000fake";

/* 四份夹具的关系（照抄 sync-test.mjs 的说法，这里是本文件最容易写错的地方）：
   BASE_* 是上一次同步时两边都有的那份；OLD_LOCAL / OLD_REMOTE 是上一次的本地/远端；
   LOCAL / REMOTE 是现在的本地/远端。只有 providers 在动。 */
const BASE_SETTINGS = { failover: { enabled: true, chain: ["bai", "sn"] } };
const BASE_CLAUDE = { permissions: { allow: ["Bash(npm test)"] } };
const OLD_LOCAL = {
  providers: { bai: { apiKey: "sk-test-0000-old-local" } },
  settings: BASE_SETTINGS,
  claude: BASE_CLAUDE,
};
const OLD_REMOTE = {
  providers: { bai: { apiKey: "sk-test-0000-old-remote" } },
  settings: BASE_SETTINGS,
  claude: BASE_CLAUDE,
};
const LOCAL = {
  providers: { bai: { apiKey: "sk-test-0000-local" } },
  settings: BASE_SETTINGS,
  claude: BASE_CLAUDE,
};
const REMOTE = {
  providers: { bai: { apiKey: "sk-test-0000-remote" } },
  settings: BASE_SETTINGS,
  claude: BASE_CLAUDE,
};

function stateOf(localParts, remoteParts) {
  return { local: hashParts(localParts), remote: hashParts(remoteParts), lastAt: OLD };
}

/** 一段字节的 sha256（本地目录目标的版本号就是它）。 */
function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/** 假的 seal/open：只做 JSON 编解码，把「加密归 backup.mjs 管」表达清楚。 */
function fakeSeal() {
  return async (parts, { now }) => Buffer.from(JSON.stringify({ parts, createdAt: now }), "utf8");
}
function fakeOpen() {
  return async (bytes) => JSON.parse(bytes.toString("utf8"));
}

/* ====================================================================== *
 * 假的 IO（全部在内存里）
 * ====================================================================== */

/**
 * 假的本地文件系统。
 *
 * 契约：readFile 对「文件不在」返回 null（不是抛错），对「在但读不出来」抛错——
 * 两种必须分得开，「读失败 = 未知，绝不是空」是本仓库吃过大亏的那条规矩。
 */
function fakeLocalFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  return {
    files,
    calls,
    async readFile(p) {
      calls.push(["readFile", p]);
      if (!files.has(p)) return null;
      const v = files.get(p);
      if (v instanceof Error) throw v;
      return Buffer.from(v);
    },
    async writeFile(p, bytes) {
      calls.push(["writeFile", p]);
      files.set(p, Buffer.from(bytes));
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      if (!files.has(from)) throw new Error("ENOENT: 临时文件不在");
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink(p) {
      calls.push(["unlink", p]);
      files.delete(p);
    },
    async stat(p) {
      calls.push(["stat", p]);
      if (!files.has(p)) return null;
      return { size: files.get(p).length, mtimeMs: MTIME };
    },
  };
}

function localTargetOf(fs, opts = {}) {
  return createLocalTarget({
    dir: "/snapshots",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    unlink: fs.unlink,
    stat: fs.stat,
    now: NOW,
    ...opts,
  });
}

/* --- WebDAV 的假服务器 --- */

function webdavResp(status, { headers = {}, body = "" } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    status,
    headers,
    async arrayBuffer() {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

function multistatus(entries) {
  const parts = entries.map(
    (e) =>
      "<D:response>" +
      `<D:href>${e.href}</D:href>` +
      "<D:propstat><D:prop>" +
      (e.etag ? `<D:getetag>${e.etag}</D:getetag>` : "") +
      (e.lastModified ? `<D:getlastmodified>${e.lastModified}</D:getlastmodified>` : "") +
      (e.size != null ? `<D:getcontentlength>${e.size}</D:getcontentlength>` : "") +
      (e.collection ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>") +
      "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
      "</D:response>",
  );
  return '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' + parts.join("") + "</D:multistatus>";
}

const DAV_BASE = "https://dav.example.test/files";
const DAV_FILE = "bai-router.backup";
const LM = "Tue, 21 Oct 2026 12:00:00 GMT";

/** 内存里的假 WebDAV 服务器：认 PROPFIND / GET / PUT，并真的执行条件写。 */
function fakeWebDav(opts = {}) {
  const st = {
    files: new Map(),
    etagSeq: 0,
    reqs: [],
    propfindStatus: opts.propfindStatus || 207,
    noEtag: false,
    onRequest: opts.onRequest || null,
  };
  const fileUrl = `${DAV_BASE}/${DAV_FILE}`;
  const api = async (url, init) => {
    const method = String(init.method || "GET").toUpperCase();
    const h = init.headers || {};
    const req = { method, url, headers: h, body: init.body };
    st.reqs.push(req);
    if (st.onRequest) {
      const override = await st.onRequest(req, st);
      if (override) return override;
    }
    if (method === "PROPFIND") {
      if (st.propfindStatus !== 207) return webdavResp(st.propfindStatus);
      const entries = [{ href: `${DAV_BASE}/`, collection: true, lastModified: LM }];
      for (const [name, f] of st.files) {
        entries.push({
          href: `${DAV_BASE}/${name}`,
          etag: st.noEtag ? undefined : f.etag,
          size: f.bytes.length,
          lastModified: LM,
        });
      }
      return webdavResp(207, { body: multistatus(entries) });
    }
    if (method === "GET") {
      const f = st.files.get(DAV_FILE);
      if (!f) return webdavResp(404);
      const h = st.noEtag ? {} : { ETag: f.etag };
      return webdavResp(200, { headers: h, body: f.bytes });
    }
    if (method === "HEAD") {
      const f = st.files.get(DAV_FILE);
      if (!f) return webdavResp(404);
      const h = st.noEtag
        ? { "Content-Length": String(f.bytes.length) }
        : { ETag: f.etag, "Content-Length": String(f.bytes.length) };
      return webdavResp(200, { headers: h });
    }
    if (method === "PUT") {
      const cur = st.files.get(DAV_FILE);
      const ifMatch = h["If-Match"];
      const ifNone = h["If-None-Match"];
      if (ifNone === "*") {
        if (cur) return webdavResp(412);
      } else if (ifMatch) {
        if (!cur || cur.etag !== ifMatch) return webdavResp(412);
      }
      st.etagSeq += 1;
      const etag = `"etag-${st.etagSeq}"`;
      st.files.set(DAV_FILE, { bytes: Buffer.from(init.body), etag });
      return webdavResp(201, { headers: { ETag: etag } });
    }
    return webdavResp(405);
  };
  return { st, fetch: api };
}

function webdavTargetOf(dav, opts = {}) {
  return createWebDavTarget({
    baseUrl: DAV_BASE,
    auth: { user: "tester", pass: FAKE_WEBDAV_PASS },
    fetch: dav.fetch,
    ...opts,
  });
}

/* --- GitHub 的假服务器 --- */

const GH_REPO = "test-owner/test-repo";
const GH_FILE = "bai-router/bai-router.backup";

/** 内存里的假 GitHub：认仓库信息、内容读取、内容写入，并真的执行 sha 条件写。 */
function fakeGitHub(opts = {}) {
  const st = {
    files: new Map(),
    shaSeq: 0,
    reqs: [],
    private: opts.private !== false,
    defaultBranch: opts.defaultBranch || "main",
    repoStatus: opts.repoStatus || 200,
    onRequest: opts.onRequest || null,
  };
  const api = async (url, init) => {
    const method = String(init.method || "GET").toUpperCase();
    const h = init.headers || {};
    const req = { method, url, headers: h, body: init.body };
    st.reqs.push(req);
    if (st.onRequest) {
      const override = await st.onRequest(req, st);
      if (override) return override;
    }
    const prefix = `https://api.github.com/repos/${GH_REPO}`;
    if (method === "GET" && url === prefix) {
      if (st.repoStatus !== 200) return webdavResp(st.repoStatus, { body: '{"message":"nope"}' });
      return webdavResp(200, {
        body: JSON.stringify({ private: st.private, default_branch: st.defaultBranch }),
      });
    }
    if (method === "GET" && url.startsWith(`${prefix}/contents/`)) {
      const p = decodeURIComponent(url.slice(`${prefix}/contents/`.length).split("?")[0]);
      const f = st.files.get(p);
      if (!f) return webdavResp(404, { body: '{"message":"Not Found"}' });
      return webdavResp(200, {
        body: JSON.stringify({
          type: "file",
          name: p.split("/").pop(),
          path: p,
          sha: f.sha,
          size: f.bytes.length,
          encoding: "base64",
          content: f.bytes.toString("base64"),
        }),
      });
    }
    if (method === "PUT" && url === `${prefix}/contents/${GH_FILE.split("/").map(encodeURIComponent).join("/")}`) {
      const body = JSON.parse(init.body);
      const cur = st.files.get(GH_FILE);
      if (body.sha == null && cur) {
        return webdavResp(422, { body: '{"message":"\\"sha\\" wasn\'t supplied"}' });
      }
      if (body.sha != null && (!cur || cur.sha !== body.sha)) {
        return webdavResp(409, { body: '{"message":"is at ... but expected ..."}' });
      }
      st.shaSeq += 1;
      const sha = `blob-${st.shaSeq}`;
      const bytes = Buffer.from(String(body.content || ""), "base64");
      st.files.set(GH_FILE, { bytes, sha });
      return webdavResp(cur ? 200 : 201, {
        body: JSON.stringify({ content: { sha, path: GH_FILE, type: "file" } }),
      });
    }
    return webdavResp(404, { body: '{"message":"Not Found"}' });
  };
  return { st, fetch: api };
}

function githubTargetOf(gh, opts = {}) {
  return createGitHubTarget({
    repo: GH_REPO,
    token: FAKE_GH_TOKEN,
    fetch: gh.fetch,
    ...opts,
  });
}

/* ====================================================================== *
 * 断言（正向与反向对照共用）
 * ====================================================================== */

/** 本地目录：远端那份的哈希对不上 ⇒ 必须拒绝写，且不许动旧文件。 */
async function assertLocalRefusesVersionMismatch(mod) {
  const fs = fakeLocalFs({ "/snapshots/bai-router.backup": Buffer.from("旧内容") });
  const t = mod.createLocalTarget({
    dir: "/snapshots",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    unlink: fs.unlink,
    now: NOW,
  });
  let err = null;
  try {
    await t.write(Buffer.from("新内容"), { ifVersion: "这不是现文件的哈希" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "远端变过了还写 ⇒ 那就是覆盖别人的更新");
  assert.equal(err.code, "CHANGED", "「远端被别人改了」必须是 CHANGED");
  assert.ok(REMOTE_CHANGED_CODES.includes(err.code), "CHANGED 必须落在 sync.mjs 的 REMOTE_CHANGED_CODES 里");
  assert.equal(
    fs.files.get("/snapshots/bai-router.backup").toString("utf8"),
    "旧内容",
    "旧文件必须一个字都没动",
  );
}

/** 本地目录：远端已经有文件、而调用方说「那里还没有」⇒ 必须拒绝写。 */
async function assertLocalRefusesWhenFileExists(mod) {
  const fs = fakeLocalFs({ "/snapshots/bai-router.backup": Buffer.from("旧内容") });
  const t = mod.createLocalTarget({
    dir: "/snapshots",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    unlink: fs.unlink,
    now: NOW,
  });
  let err = null;
  try {
    await t.write(Buffer.from("新内容"), { ifVersion: null });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "远端已经有文件时还建一份 ⇒ 那就是覆盖");
  assert.equal(err.code, "CHANGED");
  assert.equal(fs.files.get("/snapshots/bai-router.backup").toString("utf8"), "旧内容");
}

/** WebDAV：条件写必须发 If-Match（不是 If-None-Match）。 */
async function assertWebDavUsesIfMatch(mod) {
  const dav = fakeWebDav();
  const t = mod.createWebDavTarget({ baseUrl: DAV_BASE, fetch: dav.fetch });
  await t.write(Buffer.from("第一份"), { ifVersion: null });
  const put = dav.st.reqs.filter((r) => r.method === "PUT").pop();
  assert.ok(put, "写远端必须真的发 PUT");
  assert.equal(put.headers["If-None-Match"], "*", "新建时发的是 If-None-Match: *");
  assert.equal(put.headers["If-Match"], undefined, "新建时不该同时发 If-Match");
  const etag = dav.st.files.get(DAV_FILE).etag;
  await t.write(Buffer.from("第二份"), { ifVersion: etag });
  const put2 = dav.st.reqs.filter((r) => r.method === "PUT").pop();
  assert.equal(put2.headers["If-Match"], etag, "覆盖时发的是 If-Match: <etag>");
  assert.equal(put2.headers["If-None-Match"], undefined, "覆盖时不该发 If-None-Match（它问的是「在不在」）");
}

/** WebDAV：412 必须翻译成 CHANGED（远端被别人改了），不是普通错误。 */
async function assertWebDavMaps412ToChanged(mod) {
  const dav = fakeWebDav();
  /* 远端已经有文件，且它的 ETag 与我们读到的不一样 ⇒ PUT 必须被服务器拒绝。 */
  dav.st.files.set(DAV_FILE, { bytes: Buffer.from("别人的"), etag: '"etag-1"' });
  const t = mod.createWebDavTarget({ baseUrl: DAV_BASE, fetch: dav.fetch });
  let err = null;
  try {
    await t.write(Buffer.from("内容"), { ifVersion: '"etag-0"' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "412 必须报出来，不许当没事");
  assert.equal(err.code, "CHANGED", "412 是「远端被别人改了」，不是「写失败」");
  assert.equal(dav.st.files.get(DAV_FILE).bytes.toString("utf8"), "别人的", "别人的内容不许被盖掉");
}

/** GitHub：写必须带上读到的 blob sha（那才是条件写）。 */
async function assertGitHubSendsSha(mod) {
  const gh = fakeGitHub();
  const t = mod.createGitHubTarget({ repo: GH_REPO, token: FAKE_GH_TOKEN, fetch: gh.fetch });
  await t.write(Buffer.from("第一份"), { ifVersion: null });
  const put1 = gh.st.reqs.find((r) => r.method === "PUT");
  const body1 = JSON.parse(put1.body);
  assert.equal(body1.sha, undefined, "新建时不该带 sha：带了就是覆盖");
  const sha = gh.st.files.get(GH_FILE).sha;
  await t.write(Buffer.from("第二份"), { ifVersion: sha });
  const put2 = gh.st.reqs.filter((r) => r.method === "PUT").pop();
  const body2 = JSON.parse(put2.body);
  assert.equal(body2.sha, sha, "覆盖时必须带读到的 blob sha");
}

/** GitHub：token 绝不能出现在返回值或错误信息里。 */
async function assertGitHubNeverLeaksToken(mod) {
  const gh = fakeGitHub();
  gh.st.onRequest = () => {
    const e = new Error(`请求失败：Authorization: Bearer ${FAKE_GH_TOKEN}`);
    throw e;
  };
  const t = mod.createGitHubTarget({ repo: GH_REPO, token: FAKE_GH_TOKEN, fetch: gh.fetch });
  let err = null;
  try {
    await t.read();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "请求失败必须报出来");
  const text = `${err.message} ${err.stack || ""}`;
  assert.ok(!text.includes(FAKE_GH_TOKEN), "token 绝不能进错误信息");
  assert.ok(!JSON.stringify(t).includes(FAKE_GH_TOKEN), "token 绝不能进返回值");
}

/** 本地目录：写必须是「临时文件 + rename」，不许直接写目标文件。 */
async function assertLocalWriteIsAtomic(mod) {
  const fs = fakeLocalFs();
  const t = mod.createLocalTarget({
    dir: "/snapshots",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    unlink: fs.unlink,
    now: NOW,
  });
  await t.write(Buffer.from("内容"), { ifVersion: null });
  const writes = fs.calls.filter((c) => c[0] === "writeFile");
  const renames = fs.calls.filter((c) => c[0] === "rename");
  assert.equal(writes.length, 1, "只该写一次");
  assert.notEqual(writes[0][1], "/snapshots/bai-router.backup", "不许直接写目标文件：那不是原子的");
  assert.match(writes[0][1], /bai-router\.backup\.tmp-/, "写的是临时文件");
  assert.equal(renames.length, 1, "必须 rename 一次");
  assert.equal(renames[0][1], writes[0][1], "rename 的源是那个临时文件");
  assert.equal(renames[0][2], "/snapshots/bai-router.backup", "rename 的目标是那个正式文件");
}

/* ====================================================================== *
 * ① 本地目录目标
 * ====================================================================== */

describe("① 本地目录目标 —— 读、写、问状态", () => {
  test("①a 文件不在 ⇒ read 返回 null（不是空字节）", async () => {
    const fs = fakeLocalFs();
    const t = localTargetOf(fs);
    assert.equal(await t.read(), null, "没有文件就是 null；空字节会被当成坏文件");
  });

  test("①b 文件在 ⇒ read 给出字节与版本号（内容的哈希）", async () => {
    const fs = fakeLocalFs({ "/snapshots/bai-router.backup": Buffer.from("内容") });
    const t = localTargetOf(fs);
    const r = await t.read();
    assert.equal(r.bytes.toString("utf8"), "内容");
    assert.equal(typeof r.version, "string");
    assert.match(r.version, /^[0-9a-f]{64}$/, "本地目录的版本号是内容的 sha256");
  });

  test("①c 文件在但读不出来 ⇒ 明确报错，绝不当成「远端没有」", async () => {
    const fs = fakeLocalFs({ "/snapshots/bai-router.backup": new Error("EACCES: 权限不对") });
    const t = localTargetOf(fs);
    let err = null;
    try {
      await t.read();
    } catch (e) {
      err = e;
    }
    assert.ok(err, "读失败必须报出来");
    assert.equal(err.code, "REMOTE_UNREADABLE", "读失败 = 未知，绝不是空");
  });

  test("①d 写是原子的：先写临时文件，再 rename", async () => {
    await assertLocalWriteIsAtomic({ createLocalTarget });
  });

  test("①e 远端变过了 ⇒ 拒绝写（CHANGED），旧文件一个字都不动", async () => {
    await assertLocalRefusesVersionMismatch({ createLocalTarget });
  });

  test("①f 远端已经有文件而调用方说「那里还没有」⇒ 拒绝写", async () => {
    await assertLocalRefusesWhenFileExists({ createLocalTarget });
  });

  test("①g 版本对得上 ⇒ 写成功，返回新内容的哈希", async () => {
    const fs = fakeLocalFs({ "/snapshots/bai-router.backup": Buffer.from("旧内容") });
    const t = localTargetOf(fs);
    const cur = await t.read();
    const r = await t.write(Buffer.from("新内容"), { ifVersion: cur.version });
    assert.equal(fs.files.get("/snapshots/bai-router.backup").toString("utf8"), "新内容");
    assert.match(r.version, /^[0-9a-f]{64}$/);
    assert.notEqual(r.version, cur.version, "内容变了，版本号必须跟着变");
  });

  test("①h 写失败时临时文件不许留在那儿", async () => {
    const fs = fakeLocalFs();
    fs.rename = async () => {
      throw new Error("EPERM: 改名失败");
    };
    const t = localTargetOf(fs);
    let err = null;
    try {
      await t.write(Buffer.from("内容"), { ifVersion: null });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "WRITE_FAILED");
    assert.equal(fs.files.has("/snapshots/bai-router.backup.tmp-"), false, "临时文件必须清掉");
    assert.equal(fs.files.has("/snapshots/bai-router.backup"), false, "写失败不许留下半份正式文件");
  });

  test("①i status 回答「远端现在是什么状态」", async () => {
    const fs = fakeLocalFs({ "/snapshots/bai-router.backup": Buffer.from("内容") });
    const t = localTargetOf(fs);
    const st = await t.status();
    assert.equal(st.exists, true);
    assert.equal(st.size, 6);
    assert.equal(st.modifiedAt, MTIME);
    assert.match(st.version, /^[0-9a-f]{64}$/);
  });

  test("①j 没有 opts.now ⇒ 明确报错（本模块不取 Date.now()）", async () => {
    const fs = fakeLocalFs();
    const t = createLocalTarget({
      dir: "/snapshots",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      rename: fs.rename,
    });
    await assert.rejects(
      () => t.write(Buffer.from("内容"), { ifVersion: null }),
      (e) => e.code === "NO_TIME",
    );
  });

  test("①k IO 没注入 ⇒ 明确报错（本模块自己不碰磁盘）", () => {
    assert.throws(
      () => createLocalTarget({ dir: "/snapshots" }),
      (e) => e.code === "BAD_OPTION",
    );
  });
});

/* ====================================================================== *
 * ② WebDAV 目标
 * ====================================================================== */

describe("② WebDAV 目标 —— PROPFIND / GET / PUT", () => {
  test("②a PROPFIND 列目录 ⇒ status 给出 ETag、修改时间、大小", async () => {
    const dav = fakeWebDav();
    dav.st.files.set(DAV_FILE, { bytes: Buffer.from("内容"), etag: '"etag-1"' });
    const t = webdavTargetOf(dav);
    const st = await t.status();
    assert.equal(st.exists, true);
    assert.equal(st.version, '"etag-1"', "版本号就是 ETag（原样带引号）");
    assert.equal(st.size, 6);
    assert.equal(typeof st.modifiedAt, "number");
    const propfind = dav.st.reqs.find((r) => r.method === "PROPFIND");
    assert.ok(propfind, "问状态必须先列目录");
    assert.equal(propfind.headers.Depth, "1");
  });

  test("②b 目录里没有那个文件 ⇒ status 说没有", async () => {
    const dav = fakeWebDav();
    const t = webdavTargetOf(dav);
    const st = await t.status();
    assert.equal(st.exists, false);
    assert.equal(st.version, null);
  });

  test("②c GET 取快照，版本号是回答里的 ETag", async () => {
    const dav = fakeWebDav();
    dav.st.files.set(DAV_FILE, { bytes: Buffer.from("内容"), etag: '"etag-1"' });
    const t = webdavTargetOf(dav);
    const r = await t.read();
    assert.equal(r.bytes.toString("utf8"), "内容");
    assert.equal(r.version, '"etag-1"');
    const get = dav.st.reqs.find((r2) => r2.method === "GET");
    assert.equal(get.headers["Accept-Encoding"], "identity", "必须要求不压缩：压缩过的 ETag 与 If-Match 对不上（magpie #1362）");
  });

  test("②d 文件不在 ⇒ read 返回 null", async () => {
    const dav = fakeWebDav();
    const t = webdavTargetOf(dav);
    assert.equal(await t.read(), null);
  });

  test("②e 写之前必须先问状态（PROPFIND），再发 PUT", async () => {
    const dav = fakeWebDav();
    const t = webdavTargetOf(dav);
    await t.write(Buffer.from("内容"), { ifVersion: null });
    const order = dav.st.reqs.map((r) => r.method);
    assert.ok(order.indexOf("PROPFIND") >= 0, "写之前必须问状态");
    assert.ok(order.indexOf("PROPFIND") < order.indexOf("PUT"), "问状态必须在写之前");
  });

  test("②f 新建发 If-None-Match: *；覆盖发 If-Match: <etag>", async () => {
    await assertWebDavUsesIfMatch({ createWebDavTarget });
  });

  test("②g 412 ⇒ CHANGED（远端被别人改了）", async () => {
    await assertWebDavMaps412ToChanged({ createWebDavTarget });
  });

  test("②h 服务器不给 PROPFIND（405）⇒ 退回 HEAD 问同一个文件", async () => {
    const dav = fakeWebDav({ propfindStatus: 405 });
    dav.st.files.set(DAV_FILE, { bytes: Buffer.from("内容"), etag: '"etag-9"' });
    const t = webdavTargetOf(dav);
    const st = await t.status();
    assert.equal(st.exists, true);
    assert.equal(st.version, '"etag-9"');
    assert.ok(dav.st.reqs.some((r) => r.method === "HEAD"), "退路是 HEAD");
  });

  test("②i 401 ⇒ 明确报「口令不对」这一类，不许含糊", async () => {
    const dav = fakeWebDav();
    dav.st.onRequest = () => webdavResp(401, { body: "no" });
    const t = webdavTargetOf(dav);
    await assert.rejects(() => t.read(), (e) => e.code === "AUTH_FAILED");
  });

  test("②j 口令绝不出现在错误信息里", async () => {
    const dav = fakeWebDav();
    dav.st.onRequest = () => {
      throw new Error(`连接失败：Authorization: Basic ${Buffer.from(`tester:${FAKE_WEBDAV_PASS}`).toString("base64")}`);
    };
    const t = webdavTargetOf(dav);
    let err = null;
    try {
      await t.read();
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    const text = `${err.message} ${err.stack || ""}`;
    assert.ok(!text.includes(FAKE_WEBDAV_PASS), "口令绝不能进错误信息");
    assert.ok(!text.includes(Buffer.from(`tester:${FAKE_WEBDAV_PASS}`).toString("base64")), "口令的 base64 也不能进");
  });

  test("②k fetch 没注入 ⇒ 明确报错（本模块自己不联网）", () => {
    assert.throws(
      () => createWebDavTarget({ baseUrl: DAV_BASE }),
      (e) => e.code === "BAD_OPTION",
    );
  });

  test("②l 服务器不给 ETag ⇒ 不许覆盖已有文件（不退化成盲写）", async () => {
    const dav = fakeWebDav();
    dav.st.noEtag = true;
    dav.st.files.set(DAV_FILE, { bytes: Buffer.from("旧内容"), etag: '"etag-1"' });
    const t = webdavTargetOf(dav);
    let err = null;
    try {
      await t.write(Buffer.from("新内容"), { ifVersion: null });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "没有 ETag 就写下去 ⇒ 那就是覆盖别人的更新");
    assert.equal(err.code, "NO_VERSION", "要说清楚是「这个服务器没有版本号」，不是「远端被人改了」");
    assert.equal(dav.st.files.get(DAV_FILE).bytes.toString("utf8"), "旧内容", "旧文件不许被动");
  });
});

/* ====================================================================== *
 * ③ GitHub 目标
 * ====================================================================== */

describe("③ GitHub 目标 —— Contents API + blob SHA", () => {
  test("③a 读：Contents API 的 base64 解成字节，版本号是 blob SHA", async () => {
    const gh = fakeGitHub();
    gh.st.files.set(GH_FILE, { bytes: Buffer.from("内容"), sha: "blob-1" });
    const t = githubTargetOf(gh);
    const r = await t.read();
    assert.equal(r.bytes.toString("utf8"), "内容");
    assert.equal(r.version, "blob-1");
  });

  test("③b 文件不在 ⇒ read 返回 null", async () => {
    const gh = fakeGitHub();
    const t = githubTargetOf(gh);
    assert.equal(await t.read(), null);
  });

  test("③c 写必须带读到的 blob sha（那才是条件写）", async () => {
    await assertGitHubSendsSha({ createGitHubTarget });
  });

  test("③d sha 过期 ⇒ 409 ⇒ CHANGED", async () => {
    const gh = fakeGitHub();
    gh.st.files.set(GH_FILE, { bytes: Buffer.from("别人的"), sha: "blob-1" });
    const t = githubTargetOf(gh);
    let err = null;
    try {
      await t.write(Buffer.from("我的"), { ifVersion: "blob-old" });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "CHANGED", "409 是「远端被别人改了」");
    assert.equal(gh.st.files.get(GH_FILE).bytes.toString("utf8"), "别人的", "别人的内容不许被盖掉");
  });

  test("③e 不带 sha 写一个已存在的文件 ⇒ 422 ⇒ CHANGED", async () => {
    const gh = fakeGitHub();
    gh.st.files.set(GH_FILE, { bytes: Buffer.from("别人的"), sha: "blob-1" });
    const t = githubTargetOf(gh);
    let err = null;
    try {
      await t.write(Buffer.from("我的"), { ifVersion: null });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "CHANGED");
  });

  test("③f 公开仓库被拒：公开的历史等于把每一版加密备份交给别人猜口令", async () => {
    const gh = fakeGitHub({ private: false });
    const t = githubTargetOf(gh);
    await assert.rejects(() => t.read(), (e) => e.code === "REPO_NOT_PRIVATE");
  });

  test("③g token 绝不出现在返回值与错误信息里", async () => {
    await assertGitHubNeverLeaksToken({ createGitHubTarget });
  });

  test("③h 401 ⇒ 明确报「令牌不行」这一类", async () => {
    const gh = fakeGitHub({ repoStatus: 401 });
    const t = githubTargetOf(gh);
    await assert.rejects(() => t.read(), (e) => e.code === "AUTH_FAILED");
  });

  test("③i token 只发给 api.github.com", async () => {
    const gh = fakeGitHub();
    const t = githubTargetOf(gh);
    await t.read();
    for (const r of gh.st.reqs) {
      assert.match(r.url, /^https:\/\/api\.github\.com\//, "token 只发给 GitHub 的 API");
    }
  });

  test("③j token 不进 commit message", async () => {
    const gh = fakeGitHub();
    const t = githubTargetOf(gh);
    await t.write(Buffer.from("内容"), { ifVersion: null });
    const put = gh.st.reqs.find((r) => r.method === "PUT");
    const body = JSON.parse(put.body);
    assert.ok(!JSON.stringify(body).includes(FAKE_GH_TOKEN), "commit message 里不许有 token");
  });

  test("③k token / 仓库没给 ⇒ 明确报错", () => {
    assert.throws(() => createGitHubTarget({ repo: GH_REPO, fetch: async () => ({}) }), (e) => e.code === "BAD_OPTION");
    assert.throws(() => createGitHubTarget({ repo: "不是一个仓库", token: FAKE_GH_TOKEN, fetch: async () => ({}) }), (e) => e.code === "BAD_OPTION");
  });

  test("③l 写之前必须先问状态（GET Contents），再发 PUT", async () => {
    const gh = fakeGitHub();
    const t = githubTargetOf(gh);
    await t.write(Buffer.from("内容"), { ifVersion: null });
    const order = gh.st.reqs.map((r) => `${r.method} ${r.url}`);
    const putAt = order.findIndex((o) => o.startsWith("PUT"));
    const getAt = order.findIndex((o) => o.startsWith("GET ") && o.includes("/contents/"));
    assert.ok(getAt >= 0, "写之前必须问状态");
    assert.ok(getAt < putAt, "问状态必须在写之前");
  });
});

/* ====================================================================== *
 * ④ 三个目标统一：runSync 能吃、比较口径一致、冲突策略说清选哪边
 * ====================================================================== */

describe("④ 三个目标统一 —— runSync / compareState / 冲突策略", () => {
  test("④a 本地目录：跑通 runSync（第一次推、第二次不动）", async () => {
    const fs = fakeLocalFs();
    const target = localTargetOf(fs);
    const seal = fakeSeal();
    const open = fakeOpen();
    const r1 = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: null, seal, open, now: NOW,
    });
    assert.equal(r1.pushed, true, "第一次同步必须把本地的推上去");
    const r2 = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: r1.state, seal, open, now: NOW + 1,
    });
    assert.equal(r2.pushed, false, "同一份配置再同步一次不许产生新版本");
  });

  test("④b WebDAV：跑通 runSync（第一次推、第二次不动）", async () => {
    const dav = fakeWebDav();
    const target = webdavTargetOf(dav);
    const seal = fakeSeal();
    const open = fakeOpen();
    const r1 = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: null, seal, open, now: NOW,
    });
    assert.equal(r1.pushed, true);
    const putsAfterFirst = dav.st.reqs.filter((r) => r.method === "PUT").length;
    const r2 = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: r1.state, seal, open, now: NOW + 1,
    });
    assert.equal(r2.pushed, false);
    assert.equal(
      dav.st.reqs.filter((r) => r.method === "PUT").length,
      putsAfterFirst,
      "第二次同步不许再写远端（否则远端多一串一模一样的版本）",
    );
  });

  test("④c GitHub：跑通 runSync（第一次推、第二次不动）", async () => {
    const gh = fakeGitHub();
    const target = githubTargetOf(gh);
    const seal = fakeSeal();
    const open = fakeOpen();
    const r1 = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: null, seal, open, now: NOW,
    });
    assert.equal(r1.pushed, true);
    const r2 = await runSync({
      target, localParts: LOCAL, localChangedAt: { providers: NOW }, state: r1.state, seal, open, now: NOW + 1,
    });
    assert.equal(r2.pushed, false);
  });

  test("④d runSync 遇条件写被拒 ⇒ 说清是「远端被改了」", async () => {
    const dav = fakeWebDav();
    const remoteBytes = Buffer.from(JSON.stringify({ parts: OLD_REMOTE, createdAt: OLD }), "utf8");
    dav.st.files.set(DAV_FILE, { bytes: remoteBytes, etag: '"etag-1"' });
    /* 模拟另一台机器在我们读完之后抢先写了一次：PUT 的 If-Match 于是对不上。 */
    dav.st.onRequest = (req, st) => {
      if (req.method === "PUT") {
        st.files.set(DAV_FILE, { bytes: Buffer.from("别人的"), etag: '"etag-2"' });
      }
      return null;
    };
    const target = webdavTargetOf(dav);
    await assert.rejects(
      () =>
        runSync({
          target,
          localParts: LOCAL,
          localChangedAt: { providers: NOW },
          state: stateOf(OLD_LOCAL, OLD_REMOTE),
          seal: fakeSeal(),
          open: fakeOpen(),
          now: NOW,
        }),
      (e) => e.code === "REMOTE_CHANGED",
    );
  });

  test("④e compareTarget 与 sync.mjs 的 compareState 是同一套口径", async () => {
    const remoteBytes = Buffer.from(JSON.stringify({ parts: REMOTE, createdAt: NOW }), "utf8");
    const fs = fakeLocalFs({ "/snapshots/bai-router.backup": remoteBytes });
    const target = localTargetOf(fs);
    const state = stateOf(OLD_LOCAL, OLD_REMOTE);
    const mine = await compareTarget(target, { localParts: LOCAL, state, open: fakeOpen() });
    const theirs = compareState({
      localParts: LOCAL,
      remote: { parts: REMOTE, createdAt: NOW, version: sha256(remoteBytes) },
      state,
    });
    assert.deepEqual(mine, theirs, "本模块不许造第二套口径");
    assert.equal(mine.relation, "diverged", "两边都改了 ⇒ 分歧");
  });

  test("④f 四种关系：same / local-newer / remote-newer / diverged 都拿得出来", async () => {
    const cases = [
      { name: "两边一样", local: LOCAL, remote: LOCAL, state: stateOf(LOCAL, LOCAL), expect: "same" },
      { name: "只有本地改了", local: LOCAL, remote: OLD_REMOTE, state: stateOf(OLD_LOCAL, OLD_REMOTE), expect: "local-newer" },
      { name: "只有远端改了", local: OLD_LOCAL, remote: REMOTE, state: stateOf(OLD_LOCAL, OLD_REMOTE), expect: "remote-newer" },
      { name: "两边都改了", local: LOCAL, remote: REMOTE, state: stateOf(OLD_LOCAL, OLD_REMOTE), expect: "diverged" },
    ];
    for (const c of cases) {
      const fs = fakeLocalFs({
        "/snapshots/bai-router.backup": Buffer.from(JSON.stringify({ parts: c.remote, createdAt: NOW }), "utf8"),
      });
      const target = localTargetOf(fs);
      const r = await compareTarget(target, { localParts: c.local, state: c.state, open: fakeOpen() });
      assert.equal(r.relation, c.expect, `${c.name} 的关系判错了`);
    }
  });

  test("④g 冲突不许静默覆盖：默认报出来，显式选边时说清选了哪边", () => {
    const abort = resolveConflict({ relation: "diverged" });
    assert.equal(abort.action, "abort", "默认必须报出来");
    assert.equal(abort.winner, null);
    const local = resolveConflict({ relation: "diverged", policy: "local" });
    assert.equal(local.action, "use-local");
    assert.equal(local.winner, "local", "选了哪边必须写在返回值里");
    const remote = resolveConflict({ relation: "diverged", policy: "remote" });
    assert.equal(remote.action, "use-remote");
    assert.equal(remote.winner, "remote");
  });

  test("④h 单边改动不算冲突（口径跟 compareState 一样）", () => {
    assert.equal(resolveConflict({ relation: "local-newer" }).action, "use-local");
    assert.equal(resolveConflict({ relation: "remote-newer" }).action, "use-remote");
    assert.equal(resolveConflict({ relation: "same" }).action, "none");
    assert.equal(resolveConflict({ relation: "unknown" }).action, "none");
  });

  test("④i 冲突策略写错 ⇒ 明确报错", () => {
    assert.throws(() => resolveConflict({ relation: "diverged", policy: "随便" }), (e) => e.code === "BAD_OPTION");
    assert.deepEqual(CONFLICT_POLICIES, ["error", "local", "remote"]);
  });

  test("④j createTarget 按名字建目标；不认识的目标 ⇒ 明确报错", () => {
    const fs = fakeLocalFs();
    const t = createTarget("local", {
      dir: "/snapshots",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      rename: fs.rename,
      now: NOW,
    });
    assert.equal(t.kind, "local");
    assert.equal(t.file, "bai-router.backup");
    assert.throws(() => createTarget("ftp", {}), (e) => e.code === "BAD_TARGET");
  });

  test("④k 三个目标都有同一组动作：read / write / status", async () => {
    const fs = fakeLocalFs();
    const local = localTargetOf(fs);
    const dav = webdavTargetOf(fakeWebDav());
    const gh = githubTargetOf(fakeGitHub());
    for (const t of [local, dav, gh]) {
      for (const m of ["read", "write", "status"]) {
        assert.equal(typeof t[m], "function", `${t.kind} 少了 ${m}`);
      }
      const st = await t.status();
      assert.equal(typeof st.exists, "boolean");
      assert.ok("version" in st && "modifiedAt" in st && "size" in st, "status 的形状必须一样");
    }
  });

  test("④l readRemoteParts：远端没有文件 ⇒ null；远端是空文件 ⇒ 明确报错", async () => {
    const fs = fakeLocalFs();
    const target = localTargetOf(fs);
    assert.equal(await readRemoteParts(target, fakeOpen()), null);
    const fs2 = fakeLocalFs({ "/snapshots/bai-router.backup": Buffer.alloc(0) });
    await assert.rejects(
      () => readRemoteParts(localTargetOf(fs2), fakeOpen()),
      (e) => e.code === "REMOTE_UNREADABLE",
    );
  });
});

/* ====================================================================== *
 * ⑤ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */

/**
 * 把源码抄一份到临时目录，打上补丁，import 进来。
 *
 * 补丁没打上（锚点对不上）就直接失败——「反向对照是假的」比「没有反向对照」更糟。
 * sync.mjs 也要一起抄过去：被抄的那份靠相对路径 import 它。
 */
async function brokenModule(from, to) {
  const src = (await readFile(SRC, "utf8")).replace(/\r\n/g, "\n");
  const anchor = from.replace(/\r\n/g, "\n");
  const hits = src.split(anchor).length - 1;
  assert.equal(hits, 1, `反向对照的锚点必须恰好命中一次，实际 ${hits} 次`);
  const patched = src.replace(anchor, to.replace(/\r\n/g, "\n"));
  const dir = await mkdtemp(path.join(tmpdir(), "bai-sync-targets-sabotage-"));
  await writeFile(path.join(dir, "sync-targets.mjs"), patched, "utf8");
  await copyFile(path.join(SERVER_DIR, "sync.mjs"), path.join(dir, "sync.mjs"));
  return import(pathToFileURL(path.join(dir, "sync-targets.mjs")).href);
}

describe("⑤ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑤a 本地目录的版本比对拆了（盲写）⇒ ①e 必须红", async () => {
    const broken = await brokenModule(
      "} else if (st.version !== ifVersion) {",
      "} else if (false) {",
    );
    await assert.rejects(
      () => assertLocalRefusesVersionMismatch(broken),
      "远端变过了还写 ⇒ ①e 那条断言必须失败，否则「条件写」是假做的",
    );
  });

  test("⑤b 本地目录的「已有文件不许覆盖」拆了 ⇒ ①f 必须红", async () => {
    const broken = await brokenModule(
      `      if (st.exists) {
        throw changedError("远端已经有文件了，不许覆盖：只许在还没有文件时写");
      }
    } else if (!st.exists) {`,
      `      if (false) {
        throw changedError("远端已经有文件了，不许覆盖：只许在还没有文件时写");
      }
    } else if (!st.exists) {`,
    );
    await assert.rejects(
      () => assertLocalRefusesWhenFileExists(broken),
      "远端已经有文件还盖上去 ⇒ ①f 那条断言必须失败",
    );
  });

  test("⑤c 本地目录不 rename（直接写目标文件）⇒ ①d 必须红", async () => {
    const broken = await brokenModule(
      "await rename(tmp, targetPath);",
      "await writeFile(targetPath, data);",
    );
    await assert.rejects(
      () => assertLocalWriteIsAtomic(broken),
      "直接写目标文件 ⇒ ①d 那条断言必须失败，否则「原子写」是假做的",
    );
  });

  test("⑤d WebDAV 把 If-Match 写成 If-None-Match ⇒ ②f 必须红", async () => {
    const broken = await brokenModule(
      'h["If-Match"] = ifVersion;',
      'h["If-None-Match"] = ifVersion;',
    );
    await assert.rejects(
      () => assertWebDavUsesIfMatch(broken),
      "覆盖时发 If-None-Match ⇒ ②f 那条断言必须失败：那是「在不在」，不是「还是不是那一份」",
    );
  });

  test("⑤e WebDAV 不认 412 ⇒ ②g 必须红", async () => {
    const broken = await brokenModule(
      "if (res.status === 412) {",
      "if (false) {",
    );
    await assert.rejects(
      () => assertWebDavMaps412ToChanged(broken),
      "412 不翻译成 CHANGED ⇒ ②g 那条断言必须失败，否则「远端被改了」会被当成普通写失败",
    );
  });

  test("⑤f GitHub 写的时候不带 sha ⇒ ③c 必须红", async () => {
    const broken = await brokenModule(
      "if (ifVersion != null) body.sha = ifVersion;",
      "if (false) body.sha = ifVersion;",
    );
    await assert.rejects(
      () => assertGitHubSendsSha(broken),
      "不带 sha ⇒ ③c 那条断言必须失败，否则「覆盖」就变成盲写",
    );
  });

  test("⑤g GitHub 的错误信息不抹凭据 ⇒ ③g 必须红", async () => {
    const broken = await brokenModule(
      "`GitHub 请求失败：${scrub(e && e.message ? e.message : String(e))}`",
      "`GitHub 请求失败：${e && e.message ? e.message : String(e)}`",
    );
    await assert.rejects(
      () => assertGitHubNeverLeaksToken(broken),
      "错误信息里留着 token ⇒ ③g 那条断言必须失败",
    );
  });
});

/* ====================================================================== *
 * ⑥ 纪律自检
 * ====================================================================== */

describe("⑥ 纪律自检", () => {
  test("⑥a 源码里没有 Date.now()：时刻一律由参数传入", async () => {
    const src = codeOnly(await readFile(SRC, "utf8"));
    assert.doesNotMatch(src, /Date\.now\(\)/, "本模块不许自己取时刻");
    assert.doesNotMatch(src, /new Date\(\)/, "本模块不许自己取时刻");
  });

  test("⑥b 源码里没有 fs / http：这层不碰磁盘也不联网", async () => {
    const src = codeOnly(await readFile(SRC, "utf8"));
    assert.doesNotMatch(src, /node:fs/, "这层不许读磁盘写磁盘");
    assert.doesNotMatch(src, /node:http|node:net|node:https/, "这层不许发网络请求");
    assert.doesNotMatch(src, /\bfetch\s*\(/, "这层不许发网络请求");
  });

  test("⑥c 只 import ./sync.mjs 与 node: 内置模块", async () => {
    const src = await readFile(SRC, "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(imports.length > 0, "总得 import 点什么");
    for (const im of imports) {
      assert.ok(
        im.startsWith("node:") || im === "./sync.mjs",
        `只许 import node: 内置模块与 ./sync.mjs，found ${im}`,
      );
    }
  });

  test("⑥d 头注释说清了：三目标的条件写语义、与 magpie 的差异", async () => {
    const src = await readFile(SRC, "utf8");
    for (const must of [
      "If-Match",
      "If-None-Match: *",
      "blob SHA",
      "与 magpie 有意不同的点",
      "不碰网络",
    ]) {
      assert.ok(src.includes(must), `头注释里必须讲清楚「${must}」`);
    }
  });
});

/* ====================================================================== *
 * 工具
 * ====================================================================== */

/**
 * 把注释与字符串字面量去掉，只留代码（纪律自检用）。
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}
