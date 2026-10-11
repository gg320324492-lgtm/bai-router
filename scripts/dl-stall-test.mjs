/* 验下载的「停滞检测 + 断点续传 + 重试」，用**本地 HTTP 服务制造真实停滞**。
 *
 * 为什么要真的造停滞：v1.0.71 那次是下载到 81MB 停住、290 秒零进展才发现的；
 * 而修复的第一版把检测写在 for-await 循环体里、只在收到 chunk 时判断——真停滞
 * （一个字节都不来）时循环根本不产出，检测永不触发，**又变回永远挂着**。
 * 这也是靠本地服务真造一次停滞才发现的。所以这一版刻意用**独立定时器**，
 * 与 server.mjs 里的实现同构。
 *
 * 场景：服务按 Range 正常应答，但中途掐断响应体——发一半就不再发、且**不关闭连接**。
 * 这正是上游半死不活时的形态：没有错误、没有 EOF、没有超时，只是没有数据。
 * 期望：看门狗到点中止 → 记一次失败 → 带 Range 从断点续传 → 拼完整份且 sha256 一致。
 */
import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";

const TOTAL = 300000;
const BODY = Buffer.alloc(TOTAL, 0x41);
const STALL_MS = 2000;        // 看门狗阈值（真实代码是 30s，测试缩短）
const ATTEMPTS = 5;
// 前三次分别在不同字节处掐断；之后放完（模拟续传最终成功）
const cuts = [80000, 180000, 240000];
const stats = { requests: 0, ranges: [], aborts: 0 };

const server = http.createServer((req, res) => {
  stats.requests++;
  const range = req.headers.range;
  let from = 0;
  if (range) {
    const m = /bytes=(\d+)-/.exec(range);
    if (m) { from = Number(m[1]); stats.ranges.push(from); }
  }
  res.writeHead(range ? 206 : 200, {
    "content-type": "application/octet-stream",
    "content-length": String(TOTAL - from),
    ...(range ? { "content-range": `bytes ${from}-${TOTAL - 1}/${TOTAL}` } : {}),
  });
  const cut = cuts.shift();
  if (cut != null && cut > from) {
    res.write(BODY.subarray(from, cut));
    // 发到这里就停：不 end()、不 destroy()，连接挂着但永不再来数据
    req.on("aborted", () => { stats.aborts++; });
  } else {
    res.end(BODY.subarray(from));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const TARGET = `http://127.0.0.1:${server.address().port}/setup.exe`;
const OUT = "C:/Users/pc/AppData/Local/Temp/dl-test.bin";

// ↓ 与 server.mjs 的 dlOne 同构：独立定时器看门狗 + Range 续传
const dlOne = async (from) => {
  const ctl = new AbortController();
  const headers = { "user-agent": "t" };
  if (from > 0) headers.Range = `bytes=${from}-`;
  const fr = await fetch(TARGET, { headers, signal: ctl.signal });
  if (fr.status === 200 && from > 0) throw new Error("HTTP 200");
  if (fr.status !== 200 && fr.status !== 206) throw new Error("HTTP " + fr.status);
  let got = from, lastData = Date.now(), stalled = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastData > STALL_MS) { stalled = true; ctl.abort(); }
  }, Math.min(400, STALL_MS / 4));
  const ws = fs.createWriteStream(OUT, { flags: from > 0 ? "a" : "w" });
  try {
    for await (const chunk of fr.body) {
      ws.write(chunk); got += chunk.length; lastData = Date.now();
    }
  } catch (e) {
    if (stalled) throw new Error("停滞");
    throw e;
  } finally { clearInterval(watchdog); ws.end(); }
  await new Promise((r) => ws.once("close", r));
  return got;
};

try { fs.rmSync(OUT, { force: true }); } catch { }
const t0 = Date.now();
let got = 0, err = null, attempts = 0;
for (let i = 1; i <= ATTEMPTS; i++) {
  attempts = i;
  try {
    got = await dlOne(got);
    if (got >= TOTAL) { err = null; break; }
    err = new Error("没收全");
  } catch (e) {
    err = e;
    let onDisk = 0; try { onDisk = fs.statSync(OUT).size; } catch { }
    got = onDisk;
    await new Promise((r) => setTimeout(r, 200));
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
server.close();

console.log(`  本地服务掐了 3 次；看门狗 ${STALL_MS / 1000}s；总耗时 ${secs}s`);
console.log("");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✗"} ${m}`); };

ok(stats.requests >= 4, `服务收到 ${stats.requests} 次请求（掐 3 次 → 至少 4 次）`);
ok(stats.ranges.length >= 3, `${stats.ranges.length} 次带 Range：${JSON.stringify(stats.ranges)}`);
ok(stats.ranges.every((v, i) => i === 0 || v > 0), "续传都带上了非零偏移（不是每次从头）");
ok(got === TOTAL, `最终收到 ${got} 字节 / 应为 ${TOTAL}`);
ok(err === null, `无残留错误（最后一次：${err ? err.message : "无"}）`);
if (fs.existsSync(OUT)) {
  const sha = createHash("sha256").update(fs.readFileSync(OUT)).digest("hex");
  const want = createHash("sha256").update(BODY).digest("hex");
  ok(sha === want, "拼出来的文件 sha256 与原文件一致（续传拼接正确，没丢没重）");
}
ok(+secs < 60, `总耗时 ${secs}s（没卡住——这是本次修复的核心）`);

try { fs.rmSync(OUT, { force: true }); } catch { }

// ── 场景二：服务端无视 Range（返回 200 而非 206）──
// 此时把 200 的响应追加到已有文件后面会拼出损坏的包，必须识别出来重来。
{
  const stats2 = { requests: 0 };
  const srv2 = http.createServer((req, res) => {
    stats2.requests++;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(TOTAL) });
    res.end(BODY);
  });
  await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv2.address().port}/s.bin`;
  const one = async (from) => {
    const h = { "user-agent": "t" }; if (from > 0) h.Range = `bytes=${from}-`;
    const fr = await fetch(url, { headers: h });
    if (fr.status === 200 && from > 0) throw new Error("HTTP 200");   // 与 server.mjs 同一条判据
    let n = from; for await (const c of fr.body) n += c.length;
    return n;
  };
  let caught = false;
  try { await one(50000); } catch (e) { caught = /HTTP 200/.test(e.message); }
  srv2.close();
  ok(caught, "服务端无视 Range 时识别出来（不把整份追加到半截后面拼出坏包）");
}

console.log(fail ? `\n  ✗ ${fail} 条失败` : `\n  ✔ 全部通过（${pass} 条）`);
process.exit(fail ? 1 : 0);
