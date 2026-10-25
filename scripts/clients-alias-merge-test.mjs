/**
 * 「同一条」的第二口径：别名（scripts/clients-alias-merge-test.mjs）
 *
 * ## 这测的是 2026-10-25 那个 400 的根因
 *
 *   桌面版的 `inferenceModels` 清单里，**旧版本写进去的模型 id 没有 provider
 *   前缀**（`claude-fable-5`），**新版本有**（`mm/claude-fable-5`）。
 *   合并层认「同一条」原本只看 key 的**字面相等** ⇒ 认不出 ⇒ 旧的被当
 *   「用户自己加的条目」**原样留着** ⇒ 清单里**新旧两套并存**（实测 8 条）。
 *   ⇒ 桌面版里用户能选到**裸档位**那条 ⇒ 它原样发给统一网关
 *   ⇒ **400「模型名没有 provider 前缀」**（用户实拍报错）。
 *
 * ## 测什么
 *
 * ★ ① **别名口径**：裸档位与带前缀的**同档位**认作同一条 ⇒ 旧的被**替换**掉，
 *   用户的显示名（`labelOverride`）留着 ⇒ 清单里不会两套并存。
 * ★ ② **前缀不同就不是同一条**：`sn/claude-fable-5` 与 `mm/claude-fable-5`
 *   档位部分一样，但**是两家的不同模型** ⇒ 不能认成一条。
 * ★ ③ **重复项只出一份**：用户清单里同时有旧写法与新写法 ⇒ 输出**一条**。
 * ★ ④ **用户自己加的条目照旧留着**（别名口径不该把「不是同档位」的条目吃掉）。
 * ★ ⑤ **不用别名的声明行为一字不变**（合并层是共享的 ⇒ 不能拖累别的客户端）。
 * ★ ⑥ 反向对照：把别名口径改坏 ⇒ ①③ 必须红。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeValue } from "../src/server/clients/merge-policy.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MERGE_SRC = fs.readFileSync(path.join(REPO, "src", "server", "clients", "merge-policy.mjs"), "utf8");

/** 我们的清单：带前缀的 4 条（桌面版接线写的就是这个形状）。 */
const OURS = [
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-fable-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-sonnet-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-opus-5" },
  { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-haiku-4-5" },
];

/** 桌面版的 spec：数组、按 name 认人、labelOverride 归用户、别名口径按档位。 */
const SPEC = { mode: "array", key: "name", theirs: ["labelOverride"], aliasOf: "tier" };

const names = (arr) => arr.map((x) => x.name);

describe("① 别名口径：同档位的旧写法被替换掉", () => {
  test("①a 旧的裸档位条目不再与新写法并存", () => {
    /* 用户清单：4 条裸的（092 留下的）+ 4 条带前缀的（104 写的）。 */
    const have = [
      { labelOverride: "我改过的显示名", name: "claude-fable-5", supports1m: true },
      { labelOverride: "MiniMax-M3.1-Flash", name: "claude-sonnet-5" },
      { labelOverride: "MiniMax-M3.1-Flash", name: "claude-opus-5" },
      { labelOverride: "MiniMax-M3.1-Flash", name: "claude-haiku-4-5" },
      { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-fable-5" },
      { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-sonnet-5" },
      { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-opus-5" },
      { labelOverride: "MiniMax-M3.1-Flash", name: "mm/claude-haiku-4-5" },
    ];
    const { value } = mergeValue(have, OURS, SPEC);
    const bare = value.filter((m) => !String(m.name).includes("/"));
    assert.equal(bare.length, 0, `★ 裸档位还在：${names(bare).join(", ")}`);
    assert.deepEqual(names(value).sort(), names(OURS).sort(),
      "★ 清单应当只剩我们那 4 条（带前缀），不两套并存");
  });

  test("①b 用户的显示名留着（别名认出的那条要合并，不是整条换掉）", () => {
    const have = [{ labelOverride: "我改过的显示名", name: "claude-fable-5" }];
    const { value } = mergeValue(have, OURS, SPEC);
    const hit = value.find((m) => m.name === "mm/claude-fable-5");
    assert.ok(hit, "应当有 mm/claude-fable-5 那一条");
    assert.equal(hit.labelOverride, "我改过的显示名", "★ 用户改过的显示名被抹了");
  });
});

describe("② 前缀不同就不是同一条", () => {
  test("②a sn/ 那条与 mm/ 那条不是同一条（档位部分一样）", () => {
    const have = [
      { labelOverride: "SN 的", name: "sn/claude-fable-5" },
      { labelOverride: "MM 的", name: "mm/claude-fable-5" },
    ];
    const { value } = mergeValue(have, OURS, SPEC);
    const sn = value.find((m) => m.name === "sn/claude-fable-5");
    assert.ok(sn, "★ sn/ 那条被当成 mm/ 那条吃掉了（两家的不同模型！）");
    assert.equal(sn.labelOverride, "SN 的", "★ sn/ 那条的显示名被改了");
  });
});

describe("③ 重复项只出一份", () => {
  test("③a 旧写法 + 新写法同时在 ⇒ 输出一条", () => {
    const have = [
      { labelOverride: "A", name: "claude-fable-5" },
      { labelOverride: "B", name: "mm/claude-fable-5" },
    ];
    const { value } = mergeValue(have, OURS, SPEC);
    const fable = value.filter((m) => String(m.name).endsWith("claude-fable-5"));
    assert.equal(fable.length, 1, `★ 同一档位出现了 ${fable.length} 次：${JSON.stringify(fable)}`);
  });
});

describe("④ 用户自己加的条目照旧留着", () => {
  test("④a 不是同档位的自定义条目不被吃掉", () => {
    const have = [
      { labelOverride: "我自己加的", name: "my-own-model" },
      { labelOverride: "MiniMax-M3.1-Flash", name: "claude-fable-5" },
    ];
    const { value } = mergeValue(have, OURS, SPEC);
    const mine = value.find((m) => m.name === "my-own-model");
    assert.ok(mine, "★ 用户自己加的条目被吃掉了");
    assert.equal(mine.labelOverride, "我自己加的");
  });
});

describe("⑤ 不用别名的声明行为一字不变", () => {
  test("⑤a 没有 aliasOf ⇒ 认人只按 key 字面相等（别的客户端不受影响）", () => {
    const have = [
      { labelOverride: "A", name: "claude-fable-5" },
      { labelOverride: "B", name: "mm/claude-fable-5" },
    ];
    const { value } = mergeValue(have, OURS, { mode: "array", key: "name", theirs: ["labelOverride"] });
    /* 不开别名时的**原样行为**：裸那条认不出 ⇒ 原样留着；带前缀那条合并掉；
       我们其余 3 条追加 ⇒ 共 5 条。**这就是 2026-10-25 那个 400 的现场形状**
       （裸档位留在清单里 ⇒ 桌面版能选到它 ⇒ 发给网关 ⇒ 400）。 */
    assert.equal(value.length, 5, "★ 没开别名的声明行为变了（别的客户端会受影响）");
    assert.ok(value.some((m) => m.name === "claude-fable-5"),
      "★ 不开别名时裸那条应当原样留着（那正是要修的形状）");
  });
});

describe("⑥ 反向对照：改坏别名口径 ⇒ ①③ 必须红", () => {
  test("⑥a 把别名分支去掉 ⇒ 旧写法会留下来（判据变回恒真）", async () => {
    const broken = MERGE_SRC.replace(
      "    if (idx < 0 && s.aliasOf) {",
      "    if (false && s.aliasOf) {   // SABOTAGE：别名口径关掉",
    );
    assert.notEqual(broken, MERGE_SRC, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bai-alias-broken-"));
    try {
      fs.writeFileSync(path.join(dir, "merge-policy.mjs"), broken, "utf8");
      fs.copyFileSync(path.join(REPO, "src", "server", "clients", "merge-policy.mjs"), path.join(dir, "orig.mjs"));
      const mod = await import(`file:///${path.join(dir, "merge-policy.mjs").replace(/\\/g, "/")}?v=${Date.now()}`);
      const have = [{ labelOverride: "A", name: "claude-fable-5" }];
      const { value } = mod.mergeValue(have, OURS, SPEC);
      const bare = value.filter((m) => !String(m.name).includes("/"));
      assert.ok(bare.length > 0,
        "★ 改坏之后裸档位仍然被替换掉了 ⇒ ① 的判据是恒真的，测了个寂寞");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
