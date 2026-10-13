/** Keep native OpenCode tools behind approval and hand matching calls to Claude Code. */
const jobs = new Map();
const toolsOf = (tools) => (Array.isArray(tools) ? tools : []).map(t => ({
  name: t?.name || t?.function?.name,
  schema: t?.input_schema || t?.function?.parameters || t?.schema || { type: 'object' },
})).filter(t => typeof t.name === 'string');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Validate the simple object schemas used by Claude's native tools. Complex schemas
// are left to StructuredOutput instead of guessing arguments during handoff.
function matches(value, schema = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.$ref || schema.if || schema.not || schema.patternProperties) return false;
  if (has(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (schema.enum && !schema.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) return false;
  if (schema.anyOf && !schema.anyOf.some(s => matches(value, s))) return false;
  if (schema.oneOf && schema.oneOf.filter(s => matches(value, s)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(s => matches(value, s))) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(type) && !(types.includes('integer') && Number.isInteger(value))) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return false;
    if (schema.maxLength != null && value.length > schema.maxLength) return false;
    if (schema.pattern) { try { if (!new RegExp(schema.pattern).test(value)) return false; } catch { return false; } }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum)) return false;
  }
  if (Array.isArray(value)) {
    if ((schema.minItems != null && value.length < schema.minItems) || (schema.maxItems != null && value.length > schema.maxItems)) return false;
    if (schema.items && !value.every(v => matches(v, schema.items))) return false;
  } else if (value && typeof value === 'object') {
    if ((schema.required || []).some(k => !has(value, k))) return false;
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k] && !matches(v, schema.properties[k])) return false;
      if (schema.additionalProperties === false && !schema.properties?.[k]) return false;
    }
  }
  return true;
}

export function externalCallFor(part, permission, tools, toolChoice) {
  if (!part || part.type !== 'tool' || !permission?.tool?.callID || part.callID !== permission.tool.callID) return null;
  if (toolChoice?.type === 'none') return null;
  const input = part.state?.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const definitions = {
    read: ['Read', { filePath: 'file_path', offset: 'offset', limit: 'limit' }],
    bash: ['Bash', { command: 'command', timeout: 'timeout', description: 'description' }],
    edit: ['Edit', { filePath: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' }],
    write: ['Write', { filePath: 'file_path', content: 'content' }],
    glob: ['Glob', { pattern: 'pattern', path: 'path' }],
    grep: ['Grep', { pattern: 'pattern', path: 'path', include: 'glob' }],
  };
  const definition = definitions[part.tool];
  if (!definition) return null;
  const [name, fields] = definition;
  if (toolChoice?.type === 'tool' && toolChoice.name !== name) return null;
  const candidates = toolsOf(tools).filter(t => t.name === name);
  if (candidates.length !== 1) return null;
  const args = {};
  for (const [from, to] of Object.entries(fields)) if (has(input, from)) args[to] = input[from];
  if (!Object.keys(args).length || !matches(args, candidates[0].schema)) return null;
  return { name, arguments: args };
}

async function guardedPost({ base, sessionId, payload, tools, toolChoice, fetchImpl = fetch,
  timeoutMs = 180000, pollMs = 250, log = () => {} }) {
  const route = `${base}/session/${encodeURIComponent(sessionId)}`;
  const work = new AbortController();
  const watch = new AbortController();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([work.signal, timeout]);
  const watchSignal = AbortSignal.any([signal, watch.signal]);
  const request = async (url, method, body, s = signal) => {
    const r = await fetchImpl(url, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: s });
    if (r.ok) return { status: r.status, json: await r.json(), rawText: '' };
    return { status: r.status, json: null, rawText: await r.text().catch(() => '') };
  };
  const cleanupSignal = () => AbortSignal.timeout(5000);
  const abortSession = () => request(route + '/abort', 'POST', undefined, cleanupSignal()).catch(() => {});
  const pause = () => new Promise(resolve => {
    if (watchSignal.aborted) return resolve();
    const done = () => { clearTimeout(timer); watchSignal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, pollMs);
    watchSignal.addEventListener('abort', done, { once: true });
  });
  const replied = new Set();
  let handoff = false;
  const monitor = async () => {
    while (!watchSignal.aborted) {
      try {
        const pending = await request(base + '/permission', 'GET', undefined,
          AbortSignal.any([watchSignal, AbortSignal.timeout(5000)]));
        for (const permission of Array.isArray(pending.json) ? pending.json : []) {
          if (permission.sessionID !== sessionId || !permission.id || replied.has(permission.id)) continue;
          const history = await request(route + '/message?limit=3', 'GET', undefined,
            AbortSignal.any([watchSignal, AbortSignal.timeout(5000)]));
          const rows = Array.isArray(history.json) ? history.json : [];
          const part = rows.flatMap(m => Array.isArray(m.parts) ? m.parts : [])
            .find(p => p?.type === 'tool' && p.callID === permission.tool?.callID);
          const call = externalCallFor(part, permission, tools, toolChoice);
          const message = call ? 'This native action will be executed by Claude Code. Do not execute it here.'
            : 'Native actions are not executed here. Use StructuredOutput to return a call using the external tool definitions and exact arguments, or explain why it cannot be performed.';
          const reply = await request(`${base}/permission/${encodeURIComponent(permission.id)}/reply`, 'POST',
            { reply: 'reject', message }, AbortSignal.any([watchSignal, AbortSignal.timeout(5000)]));
          if (reply.status < 200 || reply.status >= 300) continue;
          replied.add(permission.id);
          if (call) {
            handoff = true;
            await abortSession();
            log(`OpenCode 工具交接：${call.name}（由 Claude Code 执行）`);
            return { status: 200, rawText: '', json: {
              structured: { content: '', calls: [call] }, info: { finish: 'tool-calls' },
            } };
          }
        }
      } catch { /* Poll failure never grants approval; the main request retains its deadline. */ }
      await pause();
    }
    return new Promise(() => {});
  };
  // Attach both continuations before starting permission polling; a handoff can abort
  // the pending HTTP request without leaving an unhandled rejection behind.
  const response = request(route + '/message', 'POST', payload);
  try {
    return await Promise.race([response, monitor()]);
  } catch (e) {
    await abortSession();
    throw e;
  } finally {
    watch.abort();
    if (handoff) work.abort();
  }
}

export async function postMessageWithToolGuard(options) {
  // Permission records belong to a session, not an HTTP request. Serialize turns
  // for a shared session so one turn cannot reject or abort another turn's tool.
  const key = `${options.base}|${options.sessionId}`;
  const previous = jobs.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => guardedPost(options));
  jobs.set(key, task);
  try { return await task; }
  finally { if (jobs.get(key) === task) jobs.delete(key); }
}
