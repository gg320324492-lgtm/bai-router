/**
 * 保留用户手改过的值（src/server/clients/merge-policy.mjs + base.mjs 的合并层）
 *
 * ## 测什么
 *
 *   ★ ① **逐值比对**：用户改过的字段保留；「机器该管的」（地址/key）照写
 *   ★ ② **弱保留**：我们压根没写的键（用户自己加的）留着
 *   ★ ③ **数组合并**：认出我们那一条、**就地**合并；用户的条目原样留着、位置不变
 *   ★ ④ **还原语义一个字没改**（硬红线）：断开后文件与接线前**逐字相同**
 *   ★ ⑤ **合并层坏掉时，revert 仍还原到用户改过的那个值**（不是还原到我们的值）
 *   ★ ⑥ 读不懂就不写（合并层不许把它变成「当空配置覆盖掉」）
 *   ★ ⑦ ZCode 的真实声明：新旧两份形状各跑一遍
 *   ★ ⑧ **反向对照**：改坏合并判据 ⇒ ① 的判据必须红
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的用户 home**。
 * 🔴 全文没有一个真实令牌/API key（夹具里的凭据形态串是明显假的占位串）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyClient, revertClient, clientStatus,
} from "../src/server/clients/base.mjs";
import { mergeValue, sameValue } from "../src/server/clients/merge-policy.mjs";
import { zcodeClient } from "../src/server/clients/zcode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-keep-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `k${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const CTX = {
  home: "",
  baseUrl: "http://127.0.0.1:15799",
  apiKey: "test-placeholder-key",
  models: [{ id: "sn/claude-opus-5", label: "Claude Opus 5" }],
  providerId: "bai",
  providerName: "B.AI",
};

const cfgPath = (home) => path.join(home, "app", "cfg.json");
function writeCfg(home, text) {
  fs.mkdirSync(path.dirname(cfgPath(home)), { recursive: true });
  fs.writeFileSync(cfgPath(home), text, "utf8");
}

/** 一个假客户端：往 `<home>/cfg.json` 的 `providers.bai` 写一块，带合并声明。 */
function fakeClient(home, opts = {}) {
  return {
    id: opts.id || "fake",
    name: "假客户端",
    protocol: "chat",
    files: () => [
      {
        path: cfgPath(home),
        format: "json",
        writes: () => [
          {
            path: "providers.bai",
            value: {
              name: "B.AI",
              enabled: true,
              baseUrl: CTX.baseUrl,
              apiKey: CTX.apiKey,
              options: { apiKey: CTX.apiKey, baseURL: CTX.baseUrl },
              models: { "sn/claude-opus-5": { name: "Claude Opus 5" } },
            },
            merge: opts.merge || { theirs: ["name", "enabled"] },
          },
        ],
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "providers.bai");
          return !!(r && r.ok && r.found);
        },
      },
    ],
  };
}

/* ====================================================================== *
 * ① 逐值比对
 * ====================================================================== */
describe("① 逐值比对：用户改过的赢，机器该管的照写", () => {
  test("①a 用户改过的名字留着；地址与 key 照写我们的", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({
      providers: {
        bai: {
          name: "我自己起的名字",
          enabled: false,
          baseUrl: "http://旧网关:1234",
          apiKey: "旧key",
          options: { apiKey: "旧key", baseURL: "http://旧网关:1234" },
        },
      },
    }));
    const r = applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.equal(j.providers.bai.name, "我自己起的名字", "★ 用户改过的名字被改回去了");
    assert.equal(j.providers.bai.enabled, false, "★ 用户关掉的 provider 被重新打开了");
    assert.equal(j.providers.bai.baseUrl, CTX.baseUrl, "地址是机器该管的 ⇒ 必须换成我们的");
    assert.equal(j.providers.bai.apiKey, CTX.apiKey, "key 是机器该管的 ⇒ 必须换成我们的");
    assert.equal(j.providers.bai.options.baseURL, CTX.baseUrl, "嵌套里的地址也一样");
    assert.equal(j.providers.bai.options.apiKey, CTX.apiKey, "嵌套里的 key 也一样");
  });

  test("①b 值一样 ⇒ 不动它（那句「保留了你手改的」也不该出现）", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({ providers: { bai: { name: "B.AI", enabled: true } } }));
    const r = applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.kept || [], [], "★ 一样的值不该被报成「保留了你手改」");
  });

  test("①c detail 里**说了一句**（不静默）", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({ providers: { bai: { name: "我改的" } } }));
    const r = applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    assert.match(String(r.detail || ""), /保留了你手改/, "★ 用户改的东西被保留却一个字没说");
    assert.equal((r.kept || []).length, 1);
    /* ⚠ 2026-10-23：路径前面带上了**文件名**（`base.mjs` 里的改动）——
     *   多文件的客户端里同一个点分路径会出现好几次（Cline 的 providers.json 与
     *   models.json 都写 `providers.openai-compatible`）⇒ 不带文件名分不清是哪一份。 */
    assert.equal(r.kept[0].path, "cfg.json:providers.bai.name", "要说清是哪个字段（连哪个文件）");
    assert.equal(r.kept[0].theirs, "我改的");
    assert.equal(r.kept[0].ours, "B.AI");
  });

  test("①d 「一个 write 一个字段」的声明也能标出「这个字段归用户」", () => {
    /* 「用户在客户端里把某个 provider 关掉了」是这个仓库最常见的缺口 ——
       而很多客户端的声明是**一个 write 只写一个字段**
       （`providers.bai.enabled` = true）⇒ 标量没法用子路径表达归属
       ⇒ 用**根模式**（theirs: [""]）。 */
    const home = tmpDir();
    writeCfg(home, JSON.stringify({ providers: { bai: { enabled: false, base_url: "http://旧网关" } } }));
    const def = {
      id: "fieldish", name: "逐字段的", protocol: "chat",
      files: () => [{
        path: cfgPath(home),
        format: "json",
        writes: () => [
          { path: "providers.bai.enabled", value: true, merge: { theirs: [""] } },
          { path: "providers.bai.base_url", value: CTX.baseUrl },
        ],
        wired: () => false,
      }],
    };
    const r = applyClient(def, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.equal(j.providers.bai.enabled, false, "★ 用户关掉的 provider 被重新打开了");
    assert.equal(j.providers.bai.base_url, CTX.baseUrl, "没标归属的字段照写我们的");
  });
});

/* ====================================================================== *
 * ② 弱保留：我们没写的键
 * ====================================================================== */
describe("② 我们压根没写的键 ⇒ 保留用户的", () => {
  test("②a 用户自己加的键（logo 等）留着", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({
      providers: { bai: { name: "B.AI", logo: "https://例子/图.png", visibility: "hidden" } },
    }));
    applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.equal(j.providers.bai.logo, "https://例子/图.png", "★ 用户自己加的键被抹掉了");
    assert.equal(j.providers.bai.visibility, "hidden");
  });

  test("②b 我们没写的模型 id ⇒ 用户的模型留着", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({
      providers: { bai: { models: { "别的/模型": { name: "我自己的模型" } } } },
    }));
    applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.ok(j.providers.bai.models["别的/模型"], "★ 用户自己加的模型被抹掉了");
    assert.ok(j.providers.bai.models["sn/claude-opus-5"], "我们的模型没写进去");
  });
});

/* ====================================================================== *
 * ③ 数组合并
 * ====================================================================== */
describe("③ 数组合并：认出我们那一条、就地合并、其余原样", () => {
  const listClient = (home) => ({
    id: "listy",
    name: "清单客户端",
    protocol: "chat",
    files: () => [{
      path: cfgPath(home),
      format: "json",
      writes: () => [{
        path: "rules",
        value: { providerId: "bai", name: "B.AI", enabled: true, url: CTX.baseUrl },
        merge: { mode: "array", key: "providerId", theirs: ["name", "enabled"] },
      }],
      wired: () => false,
    }],
  });

  test("③a 我们那一条**留在原位**，用户改的字段留着，用户的别的条目原样", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({
      rules: [
        { providerId: "别人的", name: "别人的 provider", url: "https://别人的" },
        { providerId: "bai", name: "我改过的名字", enabled: false, url: "http://旧网关" },
        { providerId: "另一个人的", name: "又一个" },
      ],
    }));
    const r = applyClient(listClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.equal(j.rules.length, 3, "不该多出/少掉条目");
    assert.equal(j.rules[0].providerId, "别人的", "★ 我们把清单重排了 —— 用户的顺序不该动");
    assert.equal(j.rules[1].providerId, "bai");
    assert.equal(j.rules[1].name, "我改过的名字", "★ 用户改的名字被改回去了");
    assert.equal(j.rules[1].enabled, false, "★ 用户关掉的被重新打开");
    assert.equal(j.rules[1].url, CTX.baseUrl, "地址是机器该管的 ⇒ 换成我们的");
    assert.equal(j.rules[2].providerId, "另一个人的");
  });

  test("③b 清单里压根没有我们那一条 ⇒ 追加到末尾", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({ rules: [{ providerId: "别人的", name: "别人的" }] }));
    const r = applyClient(listClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.equal(j.rules.length, 2);
    assert.equal(j.rules[1].providerId, "bai");
    assert.equal(j.rules[0].providerId, "别人的");
  });

  test("③c 值完全一样 ⇒ 那个数组一个字都不动", () => {
    const home = tmpDir();
    const before = JSON.stringify({
      rules: [{ providerId: "bai", name: "B.AI", enabled: true, url: CTX.baseUrl }],
    });
    writeCfg(home, before);
    applyClient(listClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(fs.readFileSync(cfgPath(home), "utf8"), before,
      "★ 合并后没变却把文件重写了一遍（用户手写的排版被换掉了）");
  });
});

/* ====================================================================== *
 * ④ 还原语义一个字没改（硬红线）
 * ====================================================================== */
describe("④ 断开：还原判据没被合并层破坏", () => {
  test("④a 用户改过的值**原样写回**（不是还原到我们的值）", () => {
    const home = tmpDir();
    const before = JSON.stringify({
      theme: "dark",
      providers: {
        bai: { name: "我自己起的名字", enabled: false, logo: "x", baseUrl: "http://旧网关" },
        other: { keep: [1, 2, 3] },
      },
      other: { nested: { deep: true } },
    });
    writeCfg(home, before);
    const def = fakeClient(home);
    const a = applyClient(def, { ...CTX, home }, { dataDir: home });
    assert.equal(a.ok, true, a.detail);
    const r = revertClient(def, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    assert.equal(fs.readFileSync(cfgPath(home), "utf8"), before,
      "★ 断开后与原来不逐字相同");
  });

  test("④b 原来没有那块 ⇒ 断开后那块被删掉，用户的手改也没了（那是对的）", () => {
    const home = tmpDir();
    writeCfg(home, JSON.stringify({ theme: "dark" }));
    const def = fakeClient(home);
    applyClient(def, { ...CTX, home }, { dataDir: home });
    revertClient(def, { dataDir: home });
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.equal(j.providers, undefined, "★ 我们新增的那块断开后应该没了");
    assert.equal(j.theme, "dark");
  });

  test("④c 没有备份 ⇒ 如实说不碰文件", () => {
    const home = tmpDir();
    const before = '{"theme":"dark"}';
    writeCfg(home, before);
    const r = revertClient(fakeClient(home), { dataDir: home });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(cfgPath(home), "utf8"), before);
  });
});

/* ====================================================================== *
 * ⑤ 合并层坏掉时，revert 仍还原到用户改过的那个值
 * ====================================================================== */
describe("⑤ 合并层坏掉 ⇒ revert 仍要还原到**用户改过的那个值**", () => {
  /* ⚠ 这一条是设计稿 §2.2(c) 点名的那个坑：
   *   「改坏『保留』的判定后，revert 仍要还原到用户改过的那个值（不是还原到我们的值）」。
   *   它证明的是：**备份取的是写盘前的现值**，不是我们算出来的值 ——
   *   所以合并层怎么坏都影响不到还原。 */
  test("⑤a 把合并层改坏（用户的赢 → 我们的赢）⇒ 还原仍是用户改过的值", async () => {
    const dir = path.join(TMPROOT, "broken-merge");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "merge-policy.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      "    if (sameValue(have, ours)) return ours;\n"
        + "    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "    return have;",
      "    if (sameValue(have, ours)) return ours;\n"
        + "    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "    return ours;   // SABOTAGE：用户的赢被改成我们的赢",
    );
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "merge-policy.mjs"), broken, "utf8");
    fs.copyFileSync(
      path.join(REPO, "src", "server", "clients", "base.mjs"),
      path.join(dir, "base.mjs"),
    );
    fs.copyFileSync(
      path.join(REPO, "src", "server", "edit-json.mjs"),
      path.join(TMPROOT, "edit-json.mjs"),
    );
    const mod = await import(pathToFileURL(path.join(dir, "base.mjs")).href + `?v=${Date.now()}`);

    const home = tmpDir();
    const before = JSON.stringify({ providers: { bai: { name: "我自己起的名字" } } });
    writeCfg(home, before);
    const def = fakeClient(home);
    const a = mod.applyClient(def, { ...CTX, home }, { dataDir: home });
    assert.equal(a.ok, true, a.detail);
    /* 坏掉的合并层：用户改的名字被我们的值盖掉了。 */
    const mid = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.equal(mid.providers.bai.name, "B.AI", "★ 合并层没被改坏 —— 这条对照的前提不成立");
    /* ⚠ 关键：还原后必须是**用户改过的那个值**，不是我们的值。 */
    const r = mod.revertClient(def, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const back = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.equal(back.providers.bai.name, "我自己起的名字",
      "★ 还原到了我们的值，而不是用户改过的那个值 —— 备份取错了原值");
  });
});

/* ====================================================================== *
 * ⑥ 读不懂就不写
 * ====================================================================== */
describe("⑥ 读不懂的配置 ⇒ 中止，用户文件一个字节都没被改", () => {
  test("⑥a 文件在但 JSON 坏了 ⇒ 报错、不写", () => {
    const home = tmpDir();
    const broken = '{ this is not json ';
    writeCfg(home, broken);
    const r = applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, false, "坏文件不该被接线");
    assert.match(String(r.detail || ""), /读不懂|读不了/);
    assert.equal(fs.readFileSync(cfgPath(home), "utf8"), broken, "★ 用户的坏文件被改写了");
  });

  test("⑥b 失败时**不留下备份**", () => {
    const home = tmpDir();
    writeCfg(home, "{ broken");
    applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    const bf = path.join(home, "client-backups", "fake.json");
    assert.equal(fs.existsSync(bf), false, "★ 失败的接线留下了备份");
  });
});

/* ====================================================================== *
 * ⑦ ZCode 的真实声明
 * ====================================================================== */
describe("⑦ ZCode：新旧两份形状各跑一遍", () => {
  const zctx = (home) => ({ ...CTX, home });
  const rulesFile = (home) => path.join(home, ".zcode", "v2", "provider_config.json");
  const legacyFile = (home) => path.join(home, ".zcode", "v2", "config.json");

  test("⑦a rules 那份：用户改的名字/关掉的开关留着，别人的 provider 原样", () => {
    const home = tmpDir();
    fs.mkdirSync(path.dirname(rulesFile(home)), { recursive: true });
    fs.writeFileSync(rulesFile(home), JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: "别人的", providerName: "别人的", enabled: true, config: { group: "x" } },
            {
              providerId: "bai",
              providerName: "我改过的名字",
              enabled: false,
              config: { group: "standard-personal", access: { type: "api-key", apiKey: "旧key" } },
            },
          ],
        },
      },
    }), "utf8");
    const r = applyClient(zcodeClient, zctx(home), { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = JSON.parse(fs.readFileSync(rulesFile(home), "utf8"));
    const rules = j.config.providerConfigRules.providerRules;
    assert.equal(rules.length, 2, "不该多出条目");
    assert.equal(rules[0].providerId, "别人的", "★ 用户的 provider 被抹了");
    assert.equal(rules[1].providerName, "我改过的名字", "★ 用户改的 provider 名字被改回去了");
    assert.equal(rules[1].enabled, false, "★ 用户关掉的 provider 被重新打开");
    assert.equal(rules[1].config.access.apiKey, CTX.apiKey, "key 是机器该管的 ⇒ 换成我们的");
    assert.equal(rules[1].config.api.baseUrl, CTX.baseUrl, "地址是机器该管的 ⇒ 换成我们的");
  });

  test("⑦b 旧形状那份：用户改的名字留着、关掉的开关留着、自己加的模型留着", () => {
    const home = tmpDir();
    fs.mkdirSync(path.dirname(legacyFile(home)), { recursive: true });
    fs.writeFileSync(legacyFile(home), JSON.stringify({
      provider: {
        bai: {
          name: "我改过的名字",
          enabled: false,
          kind: "anthropic",
          source: "custom",
          options: { apiKey: "旧key", baseURL: "http://旧网关" },
          models: { "sn/claude-opus-5": { name: "我改过的模型名" }, "别的/模型": { name: "我自己的" } },
        },
      },
    }), "utf8");
    const r = applyClient(zcodeClient, zctx(home), { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = JSON.parse(fs.readFileSync(legacyFile(home), "utf8"));
    assert.equal(j.provider.bai.name, "我改过的名字", "★ 用户改的名字被改回去了");
    assert.equal(j.provider.bai.enabled, false, "★ 用户关掉的被重新打开");
    assert.equal(j.provider.bai.options.baseURL, CTX.baseUrl, "地址是机器该管的");
    assert.equal(j.provider.bai.models["sn/claude-opus-5"].name, "我改过的模型名",
      "★ 用户改过的模型名被改回去了");
    assert.ok(j.provider.bai.models["别的/模型"], "★ 用户自己加的模型被抹掉了");
  });

  test("⑦c ZCode 断开后逐字还原（含用户改过的那些）", () => {
    const home = tmpDir();
    fs.mkdirSync(path.dirname(rulesFile(home)), { recursive: true });
    const before = JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [{ providerId: "bai", providerName: "我改过的名字", enabled: false }],
        },
      },
    });
    fs.writeFileSync(rulesFile(home), before, "utf8");
    const r = applyClient(zcodeClient, zctx(home), { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const back = revertClient(zcodeClient, { dataDir: home });
    assert.equal(back.ok, true, back.detail);
    assert.equal(fs.readFileSync(rulesFile(home), "utf8"), before, "★ 还原后不逐字相同");
  });

  test("⑦d 状态：接完就是「已接到 B.AI」", () => {
    const home = tmpDir();
    applyClient(zcodeClient, zctx(home), { dataDir: home });
    const st = clientStatus(zcodeClient, zctx(home), { dataDir: home });
    assert.equal(st.wired, true, `状态不对：${JSON.stringify(st)}`);
  });
});

/* ====================================================================== *
 * ⑧ 反向对照
 * ====================================================================== */
describe("⑧ 反向对照：改坏 ⇒ 判据必须红", () => {
  test("⑧a 把合并层改成「总是我们的赢」⇒ ①a 必须失效", async () => {
    const dir = path.join(TMPROOT, "broken-merge-2");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "merge-policy.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      "    if (sameValue(have, ours)) return ours;\n"
        + "    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "    return have;",
      "    if (sameValue(have, ours)) return ours;\n"
        + "    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "    return ours;   // SABOTAGE",
    );
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "merge-policy.mjs"), broken, "utf8");
    fs.copyFileSync(path.join(REPO, "src", "server", "clients", "base.mjs"), path.join(dir, "base.mjs"));
    fs.copyFileSync(path.join(REPO, "src", "server", "edit-json.mjs"), path.join(TMPROOT, "edit-json.mjs"));
    const mod = await import(pathToFileURL(path.join(dir, "base.mjs")).href + `?v=${Date.now()}`);

    const home = tmpDir();
    writeCfg(home, JSON.stringify({ providers: { bai: { name: "我自己起的名字", enabled: false } } }));
    mod.applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.notEqual(j.providers.bai.name, "我自己起的名字",
      "★ 改坏之后仍然保留用户的名字 —— 那 ①a 的判据是恒真的，测了个寂寞");
  });

  test("⑧b 把「备份里存原值」改成「存新值」⇒ ④a 必须失效", async () => {
    const dir = path.join(TMPROOT, "broken-base");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "base.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      "        value: e.before.existed === true ? e.before.value : null,\n      })),",
      "        value: e.value,   // SABOTAGE：备份里存的是写后的新值\n      })),",
    );
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "base.mjs"), broken, "utf8");
    fs.copyFileSync(path.join(REPO, "src", "server", "clients", "merge-policy.mjs"), path.join(dir, "merge-policy.mjs"));
    fs.copyFileSync(path.join(REPO, "src", "server", "edit-json.mjs"), path.join(TMPROOT, "edit-json.mjs"));
    const mod = await import(pathToFileURL(path.join(dir, "base.mjs")).href + `?v=${Date.now()}`);

    const home = tmpDir();
    const before = JSON.stringify({ providers: { bai: { name: "我自己起的名字" } } });
    writeCfg(home, before);
    const def = fakeClient(home);
    mod.applyClient(def, { ...CTX, home }, { dataDir: home });
    mod.revertClient(def, { dataDir: home });
    assert.notEqual(fs.readFileSync(cfgPath(home), "utf8"), before,
      "★ 改坏之后仍然还原成功 —— 那 ④a 的判据是恒真的，测了个寂寞");
  });

  test("⑧c 把合并层的「弱保留」改成「整块用我们的」⇒ ②a 必须失效", async () => {
    const dir = path.join(TMPROOT, "broken-merge-3");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "merge-policy.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      "      out[k] = hv;                    /* 我们没写 ⇒ 用户的留下 */",
      "      out[k] = undefined;             // SABOTAGE：用户没写的键被抹掉",
    );
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "merge-policy.mjs"), broken, "utf8");
    fs.copyFileSync(path.join(REPO, "src", "server", "clients", "base.mjs"), path.join(dir, "base.mjs"));
    fs.copyFileSync(path.join(REPO, "src", "server", "edit-json.mjs"), path.join(TMPROOT, "edit-json.mjs"));
    const mod = await import(pathToFileURL(path.join(dir, "base.mjs")).href + `?v=${Date.now()}`);

    const home = tmpDir();
    writeCfg(home, JSON.stringify({ providers: { bai: { logo: "https://例子/图.png" } } }));
    mod.applyClient(fakeClient(home), { ...CTX, home }, { dataDir: home });
    const j = JSON.parse(fs.readFileSync(cfgPath(home), "utf8"));
    assert.notEqual(j.providers.bai.logo, "https://例子/图.png",
      "★ 改坏之后仍然保留用户的键 —— 那 ②a 的判据是恒真的，测了个寂寞");
  });
});

/* ====================================================================== *
 * ⑨ 纯函数本身
 * ====================================================================== */
describe("⑨ merge-policy 的纯函数", () => {
  test("⑨a sameValue 忽略键序，但数组按顺序比", () => {
    assert.equal(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
    assert.equal(sameValue([1, 2], [2, 1]), false);
    assert.equal(sameValue({ a: 1 }, { a: "1" }), false);
    assert.equal(sameValue(null, null), true);
    assert.equal(sameValue(undefined, null), false);
  });

  test("⑨b 没给 spec ⇒ 原样返回我们的值", () => {
    const r = mergeValue({ a: 1 }, { b: 2 }, null);
    assert.deepEqual(r.value, { b: 2 });
    assert.deepEqual(r.kept, []);
  });

  test("⑨c 通配路径：`models.*.name` 命中数组元素里的 name", () => {
    const have = { models: { "a/1": { name: "用户的" } } };
    const ours = { models: { "a/1": { name: "我们的" }, "b/2": { name: "新的" } } };
    const r = mergeValue(have, ours, { theirs: ["models.*.name"] });
    assert.equal(r.value.models["a/1"].name, "用户的");
    assert.equal(r.value.models["b/2"].name, "新的");
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].path, "models.a/1.name");
  });

  test("⑨d 键名带点（模型 id 当表名）时，路径切分不会切坏它", () => {
    const have = { models: { "sn/glm-5.2": { name: "用户的" } } };
    const ours = { models: { "sn/glm-5.2": { name: "我们的" } } };
    const r = mergeValue(have, ours, { theirs: ["models.*.name"] });
    assert.equal(r.value.models["sn/glm-5.2"].name, "用户的",
      "★ 带点的键被切坏了 —— 通配路径按**键**匹配，不按点分字符串");
  });

  test("⑨e whole：整块用我们的，不做深合并", () => {
    const have = { models: { "a/1": { name: "用户的", extra: 1 } } };
    const ours = { models: { "a/1": { name: "我们的" } } };
    const r = mergeValue(have, ours, { whole: ["models"] });
    assert.deepEqual(r.value, ours);
    assert.deepEqual(r.kept, []);
  });

  test("⑨f 根模式（theirs: [\"\" ]）：标量值整体比，用户改过就赢", () => {
    const r = mergeValue(false, true, { theirs: [""] });
    assert.equal(r.value, false, "★ 用户关掉的开关不能被我们打开");
    assert.equal(r.kept.length, 1);
    const same = mergeValue(true, true, { theirs: [""] });
    assert.equal(same.value, true);
    assert.deepEqual(same.kept, [], "一样的值不该被报成「保留了你手改」");
  });

  test("⑨g 根模式对数组不适用（我们的赢 —— 否则我们写不进自己的条目）", () => {
    const r = mergeValue([{ id: "a" }], [{ id: "b" }], { theirs: [""] });
    assert.deepEqual(r.value, [{ id: "b" }]);
    assert.deepEqual(r.kept, []);
  });

  test("⑨h 「保留了你手改」清单里**不带凭据形态的长串**（它会流向面板）", () => {
    const long = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const r = mergeValue(long, "sk-zyxwvutsrqponmlkjihgfedcba654321", { theirs: [""] });
    assert.equal(r.kept.length, 1);
    assert.ok(!String(r.kept[0].theirs).includes("abcdefghij"),
      "★ 凭据形态的串被原样带出去了");
    assert.match(String(r.kept[0].theirs), /不原样带出/);
    /* ⚠ 但**写进文件的值**不受影响（脱敏只作用于清单）。 */
    assert.equal(r.value, long, "★ 脱敏把真正要写的值也改了");
  });

  test("⑨i 短字符串与数字原样带出（面板要能显示「保留了你手改的窗口 128000」）", () => {
    const r = mergeValue(128000, 200000, { theirs: [""] });
    assert.equal(r.kept[0].theirs, 128000);
    assert.equal(r.kept[0].ours, 200000);
    const n = mergeValue("我改过的名字", "B.AI", { theirs: [""] });
    assert.equal(n.kept[0].theirs, "我改过的名字");
  });
});
