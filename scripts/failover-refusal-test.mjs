/* 故障转移的「该不该换一家」判据 —— **要同时看状态码与响应体**。
 *
 * 起因（2026-10-21 实测）：并行 agent 的请求走本中转时，上游回
 * **HTTP 400「request illegal」**，而旧判据只看状态码 —— 400 被当成
 * 「请求本身有问题，换几家都一样失败」→ **不转移**。日志里那次就是这样死的：
 *
 *   渠道尝试（入口 mm，未转移）→ mm:429；qd:冷却中；bai:冷却中；sn:未配置；
 *   zen:冷却中；wb:冷却中；wbai:失败[st=400/[WorkBuddy AI] request illegal]；or:…
 *
 * 那个 400 出现在**倒数第二个**渠道上，却直接终结了整条链 —— 最后那个 `or`
 * 根本没被试。
 *
 * 修法：400/404/422 **看响应体**。正文明说了「这家不接」（request illegal /
 * unapproved channel / 模型不被服务）→ 换一家有用 → 转移；正文含糊 → 仍然不转移。
 * magpie 的 `failure(status, body)` 就是同时看两者的。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldFailover, providerRefusal } from "../src/server/failover.mjs";

describe("shouldFailover —— 状态码 + 响应体", () => {
  test("① 旧语义一字不变：没有响应体时，400/404/422 仍然不转移", () => {
    assert.equal(shouldFailover(400), false, "普通 400 是请求本身有问题，不该转移");
    assert.equal(shouldFailover(404), false);
    assert.equal(shouldFailover(422), false);
    assert.equal(shouldFailover(400, ""), false, "空正文＝没明说理由，不该转移");
  });

  test("② 供应商明说「不接」时，400/404/422 要转移", () => {
    /* 实测撞到的那句 */
    assert.equal(shouldFailover(400, '{"error":{"message":"request illegal"}}'), true);
    assert.equal(shouldFailover(400, "request illegal"), true);
    assert.equal(shouldFailover(400, "[WorkBuddy AI] request illegal"), true);
    assert.equal(shouldFailover(400, "[MiniMax 会员] request illegal"), true);
    /* 客户端不被认 */
    assert.equal(shouldFailover(400, "Illegal API invocation from an unapproved channel"), true);
    /* 模型不被这家服务（magpie 的 unservedWords 口径） */
    assert.equal(shouldFailover(400, "model_not_found"), true);
    assert.equal(shouldFailover(404, "The model gpt-9 does not exist"), true);
    assert.equal(shouldFailover(422, "unsupported model"), true);
    assert.equal(shouldFailover(400, "该模型不存在"), true);
  });

  test("③ 口径必须窄：真的参数错不许转移", () => {
    assert.equal(shouldFailover(400, '{"error":{"message":"missing required field: messages"}}'), false);
    assert.equal(shouldFailover(400, "invalid request: malformed body"), false);
    assert.equal(shouldFailover(400, "上下文超长，请开新对话"), false);
    assert.equal(shouldFailover(422, "参数类型不对"), false);
  });

  test("④ 其它状态码的老语义一字不变", () => {
    assert.equal(shouldFailover(429), true, "限流要转移");
    assert.equal(shouldFailover(401), true);
    assert.equal(shouldFailover(403), true);
    assert.equal(shouldFailover(500), true);
    assert.equal(shouldFailover(502), true);
    assert.equal(shouldFailover(0), true, "网络错/超时（还没拿到状态码）");
  });

  test("⑤ providerRefusal 单独可用", () => {
    assert.equal(providerRefusal("request illegal"), true);
    assert.equal(providerRefusal(""), false);
    assert.equal(providerRefusal(undefined), false);
    assert.equal(providerRefusal("missing required field"), false);
  });

  test("⑥ 反向对照：把「看响应体」这条改坏，② 必须红", () => {
    /* 模拟「实现退回只看状态码」：正文里的拒绝理由此时不起作用 */
    const body = "request illegal";
    const statusOnly = (st) => shouldFailover(st);          // 旧实现：没有 body 参数
    assert.equal(statusOnly(400), false, "旧实现不转移");
    assert.equal(shouldFailover(400, body), true, "新实现要转移");
    /* 两者必须不同——否则这条判据等于没写 */
    assert.notEqual(statusOnly(400), shouldFailover(400, body),
      "带正文与不带正文的结论必须不同，否则新判据是空转");
  });
});
