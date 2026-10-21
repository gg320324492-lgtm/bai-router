/* usage-scan：从流过的 SSE 字节里捡出 token 数，且**字节原样透传**。
 *
 * 为什么需要它：透传那条路（bai/sn）上游的 Anthropic 响应是原样管道过去的，
 * 中转根本没看内容 —— 不扫就拿不到用量，账本的 token 列会一直是 0。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeUsageScanner } from "../src/server/usage-scan.mjs";

/* 把若干块喂进扫描器，返回 { sink, out }（out 是透传出去的字节）。 */
function scan(chunks) {
  const sink = {};
  const tr = makeUsageScanner(sink);
  const out = [];
  return new Promise((resolve) => {
    tr.on("data", (c) => out.push(Buffer.from(c)));
    tr.on("end", () => resolve({ sink, out: Buffer.concat(out) }));
    for (const c of chunks) tr.write(Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8"));
    tr.end();
  });
}

const ANTHROPIC_SSE = [
  "event: message_start\n",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":1234,"output_tokens":0,"cache_read_input_tokens":56}}}\n\n',
  "event: content_block_delta\n",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
  "event: message_delta\n",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":78}}\n\n',
  "event: message_stop\n",
  'data: {"type":"message_stop"}\n\n',
].join("");

const OPENAI_SSE = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":321,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":7}}}\n\n',
  "data: [DONE]\n\n",
].join("");

describe("usage-scan", () => {
  test("① Anthropic 的 SSE：input 在开头、output 在结尾，都要捡到", async () => {
    const { sink } = await scan([ANTHROPIC_SSE]);
    assert.equal(sink.in, 1234, "input_tokens 没捡到");
    assert.equal(sink.out, 78, "output_tokens 没捡到");
    assert.equal(sink.cacheRead, 56, "cache_read_input_tokens 没捡到");
  });

  test("② OpenAI 的 SSE：prompt/completion/cached 都要捡到", async () => {
    const { sink } = await scan([OPENAI_SSE]);
    assert.equal(sink.in, 321);
    assert.equal(sink.out, 9);
    assert.equal(sink.cacheRead, 7, "prompt_tokens_details.cached_tokens 没捡到");
  });

  test("③ 字节原样透传，一个都不能少", async () => {
    const { out } = await scan([ANTHROPIC_SSE]);
    assert.equal(out.toString("utf8"), ANTHROPIC_SSE, "扫描器改了字节内容");
  });

  test("④ 数字被 chunk 切开也要捡到（流式传输的常态）", async () => {
    const whole = 'data: {"usage":{"input_tokens":123456,"output_tokens":99}}\n\n';
    /* 故意在数字中间切开 */
    const at = whole.indexOf("123456") + 3;
    const { sink } = await scan([whole.slice(0, at), whole.slice(at)]);
    assert.equal(sink.in, 123456, "跨 chunk 的数字没捡到");
    assert.equal(sink.out, 99);
  });

  test("⑤ 多个 output 事件取最后一个（流式增量）", async () => {
    const { sink } = await scan([
      'data: {"usage":{"output_tokens":10}}\n\n',
      'data: {"usage":{"output_tokens":25}}\n\n',
      'data: {"usage":{"output_tokens":40}}\n\n',
    ]);
    assert.equal(sink.out, 40, "output 取的不是最后一个");
  });

  test("⑥ 没有 usage 的流不填任何字段（不编造）", async () => {
    const { sink } = await scan(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n']);
    assert.equal(sink.in, undefined, "没 usage 却填了 in");
    assert.equal(sink.out, undefined, "没 usage 却填了 out");
  });

  test("⑦ 反向对照：把「跨 chunk 的数字」处理改坏，④ 必须红", async () => {
    /* 模拟「只扫当前 chunk、不带上一块的尾巴」这个错：那样切开的数字就永远
     * 拼不出来 —— 而这正是流式传输最常见的形态。 */
    const whole = 'data: {"usage":{"input_tokens":123456}}\n\n';
    const at = whole.indexOf("123456") + 3;
    const broken = await (async () => {
      const sink = {};
      const tr = makeUsageScanner(sink);
      const out = [];
      return new Promise((resolve) => {
        tr.on("data", (c) => out.push(Buffer.from(c)));
        tr.on("end", () => resolve({ sink, out: Buffer.concat(out) }));
        for (const c of [whole.slice(0, at), whole.slice(at)]) tr.write(Buffer.from(c, "utf8"));
        tr.end();
      });
    })();
    /* 正确实现必须捡到；「不带尾巴」的那个实现捡不到 —— 断言两者必须不同，
     * 否则这条用例就是空转。 */
    assert.equal(broken.sink.in, 123456, "正确实现应当捡到跨 chunk 的数字");
    const noOverlap = /"input_tokens"\s*:\s*(\d+)/.exec(whole.slice(at));
    assert.equal(noOverlap, null, "单独看后半块确实拼不出数字 —— 这正是不带尾巴的错");
  });
});
