// 发布来源保护：只读 Git；由调用方注入执行器，测试不构建、不联网、不发布。
"use strict";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function assertCleanSource(readGit, expectedHead) {
  const head = String(readGit(["rev-parse", "HEAD"])).trim();
  if (!SHA.test(head)) throw new Error("发布来源检查失败：无法确认本地 HEAD。");
  if (expectedHead && head !== expectedHead) {
    throw new Error("发布已中止：构建期间本地 HEAD 已改变，请重新构建后发布。");
  }
  const dirty = String(readGit(["status", "--porcelain", "--untracked-files=all"])).trim();
  if (dirty) {
    throw new Error("发布已中止：工作区含未提交内容（也可能是发布脚本同步了 config.defaults.json）。请检查差异，提交并推送后重试。\n" + dirty);
  }
  return head;
}

function assertRemoteSource(readGit, { repository, head, tag }) {
  if (!SHA.test(head)) throw new Error("发布来源检查失败：目标提交无效。");
  const mainRef = "refs/heads/main";
  const tagRef = "refs/tags/" + tag;
  const refs = new Map();
  const output = String(readGit(["ls-remote", repository, mainRef, tagRef, tagRef + "^{}"])).trim();
  for (const line of output ? output.split(/\r?\n/) : []) {
    const match = line.match(/^([a-f0-9]{40}|[a-f0-9]{64})\s+(\S+)$/i);
    if (!match || refs.has(match[2])) throw new Error("发布来源检查失败：远端引用响应无效。");
    refs.set(match[2], match[1]);
  }
  if (refs.get(mainRef) !== head) {
    throw new Error("发布已中止：GitHub main 与本地 HEAD 不一致。请先推送本次提交，再重试发布。");
  }
  // --target 只决定新 tag；已有 tag 时 gh 不会改它，必须先核验（含 annotated tag）。
  const tagHead = refs.get(tagRef + "^{}") || refs.get(tagRef);
  if (tagHead && tagHead !== head) {
    throw new Error(`发布已中止：远端 ${tag} 指向其他提交，请检查版本号和 tag，不能发布错配的源码。`);
  }
}

module.exports = { assertCleanSource, assertRemoteSource };
