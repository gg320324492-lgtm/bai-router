/* 网关模式下「现在接的是哪一家」的判定。
 *
 * 为什么要有这个：单网关化之后**所有请求都走同一个端口**，URL 不再能标识供应商。
 * 这时只能靠**模型 id 的 provider 前缀**认——网关本来就是靠它分流的。
 *
 * ⚠ 本测试盯的是**认错**这件事：wb（国内版）与 wbai（国际版）是**两套东西**
 * （凭据/目录/端口全独立），把 wbai 认成 wb = 把请求发到另一家去。
 * 所以规矩是：**认不出就说「other」，绝不猜**。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "src/server/server.mjs"), "utf8");

function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `源码里找不到锚点：${anchor}`);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`锚点 ${anchor} 的大括号没配平`);
}
const SRC_CLI_MODE = sliceFn(SRC, "function cliMode");

const CHANNELS = ["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"];
const DEFAULTS = {
  upstream: "https://api.b.ai",
  /* 每家的 relayPort 都要有：cliMode 认「本地中转端口」时读的是
   * `c[ch].relayPort || DEFAULTS[ch].relayPort` —— 缺了就会拿 undefined 去
   * `includes(":undefined")`，恒假，于是谁都认不出来。 */
  sn: { upstream: "https://token.sensenova.cn", relayPort: 15732 },
  relayPort: 15722, panelPort: 15723, gatewayPort: 15799,
  wb: { relayPort: 15742 }, wbai: { relayPort: 15782 },
  zen: { relayPort: 15752 }, qd: { relayPort: 15762 },
  mm: { relayPort: 15792 }, or: { relayPort: 15772 },
};

/** 用假依赖跑真的 cliMode。 */
function modeOf(settings, cfg) {
  const factory = new Function(
    "SETTINGS", "readJson", "keyFp", "loadCfg", "channelCredentials", "CHANNELS",
    "cliViaRelay", "hostOf", "DEFAULTS", "PROXY_MANAGED_TOKEN",
    `${SRC_CLI_MODE}\nreturn cliMode;`,
  );
  return factory(
    "unused-settings-path",
    () => settings,
    (k) => String(k).slice(0, 4),
    () => cfg,
    () => ({}),
    CHANNELS,
    () => false,
    (u) => { try { return new URL(String(u)).host; } catch { return ""; } },
    DEFAULTS,
    "PROXY_MANAGED",
  )(cfg);
}

const GW = "http://127.0.0.1:15799";

describe("网关模式下的供应商判定", () => {
  test("① 网关 + 模型 id 带 provider 前缀 → 认出那一家", () => {
    const m = modeOf({ env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_DEFAULT_OPUS_MODEL: "sn/glm-5.2" } }, {});
    assert.equal(m.mode, "sn");
  });

  test("② 网关 + 国际版前缀 → 必须是 wbai，不能是 wb", () => {
    const m = modeOf({ env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_DEFAULT_OPUS_MODEL: "wbai/hy4-preview-f" } }, {});
    assert.equal(m.mode, "wbai", "国际版被认成国内版了 —— 那会把请求发到另一家去");
  });

  test("③ 网关 + 模型 id 没有前缀 → 说 other，**不猜**", () => {
    const m = modeOf({ env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2" } }, {});
    assert.equal(m.mode, "other", "没有前缀却认出了一家 —— 那是猜");
  });

  test("④ 网关 + 前缀是不认识的渠道 → 说 other", () => {
    const m = modeOf({ env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_DEFAULT_OPUS_MODEL: "nope/x" } }, {});
    assert.equal(m.mode, "other");
  });

  test("⑤ 网关 + 一个模型 id 都没有 → 说 other", () => {
    const m = modeOf({ env: { ANTHROPIC_BASE_URL: GW } }, {});
    assert.equal(m.mode, "other");
  });

  test("⑥ 没走网关时，老的判定一字不变", () => {
    /* bai / sn 的 CLI **直连上游**（它们不走本地桥），所以只能靠**上游域名**认；
     * 走本地桥的那几家（wb/wbai/zen/qd/mm/or）靠**本地中转端口**认。
     * 端口相邻的 wb(15742) / wbai(15782) 顺序不能反，反了国际版会被国内版抢走。 */
    assert.equal(modeOf({ env: { ANTHROPIC_BASE_URL: "https://api.b.ai" } }, {}).mode, "bai");
    assert.equal(modeOf({ env: { ANTHROPIC_BASE_URL: "https://token.sensenova.cn" } }, {}).mode, "sn");
    assert.equal(modeOf({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15742" } }, {}).mode, "wb");
    assert.equal(modeOf({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15782" } }, {}).mode, "wbai");
    assert.equal(modeOf({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15752" } }, {}).mode, "zen");
    assert.equal(modeOf({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721" } }, {}).mode, "ccswitch");
  });

  test("⑦ 网关端口可配（配成别的号也认）", () => {
    const cfg = { gatewayPort: 19999 };
    const m = modeOf({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:19999", ANTHROPIC_MODEL: "qd/lite" } }, cfg);
    assert.equal(m.mode, "qd");
  });
});
