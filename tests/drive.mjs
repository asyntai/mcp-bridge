/**
 * Drive the bridge end to end against a real server, as a client would.
 *
 * Spawns the CLI, speaks JSON-RPC to it over stdio, and prints what comes
 * back. The first run against a server opens the browser for the one-time
 * sign-in, so this waits generously for the first reply.
 *
 *   node tests/drive.mjs https://asyntai.com/mcp
 *
 * Read-only by design. The one tool called is list_websites.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverUrl = process.argv[2] || 'https://asyntai.com/mcp';

const child = spawn(process.execPath, [join(here, '..', 'src', 'cli.js'), serverUrl], {
  stdio: ['pipe', 'pipe', 'inherit'],   // stderr straight through: that is where the sign-in URL is printed
});

const replies = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && replies.has(message.id)) {
      replies.get(message.id)(message);
    }
  }
});

let nextId = 1;
function call(method, params, timeoutMs = 30_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method}: no reply in ${timeoutMs / 1000}s`)), timeoutMs);
    replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

try {
  // The first request triggers sign-in on a fresh machine. Three minutes is
  // enough for a person to find the tab and click Approve.
  const init = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'asyntai-bridge-drive', version: '1.0.0' },
  }, 180_000);
  check('initialize', !!init.result, init.result?.protocolVersion || JSON.stringify(init.error));
  check('server names itself', init.result?.serverInfo?.name != null, init.result?.serverInfo?.name);

  notify('notifications/initialized', {});

  const tools = await call('tools/list', {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  check('tools/list', names.length > 0, `${names.length} tools`);
  check('every tool carries annotations',
    (tools.result?.tools || []).every((t) => t.annotations && 'readOnlyHint' in t.annotations));
  for (const expected of ['list_websites', 'list_plans', 'search_asyntai_docs', 'get_asyntai_doc']) {
    check(`tool present: ${expected}`, names.includes(expected));
  }

  const sites = await call('tools/call', { name: 'list_websites', arguments: {} });
  const payload = sites.result?.structuredContent;
  check('list_websites answers', !!payload && !sites.result?.isError,
    payload ? `${payload.websites?.length} website(s)` : JSON.stringify(sites.result?.content?.[0]?.text).slice(0, 120));
  if (payload?.websites) {
    for (const w of payload.websites) console.log(`      id=${w.id}  ${w.domain}`);
  }

  const docs = await call('tools/call', { name: 'search_asyntai_docs', arguments: { query: 'widget pinning', limit: 2 } });
  const hit = docs.result?.structuredContent?.results?.[0];
  check('search_asyntai_docs reads templates on the server', !!hit, hit?.url);
} catch (error) {
  check('run', false, error.message);
} finally {
  child.stdin.end();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed} of ${results.length} checks passed against ${serverUrl}`);
  process.exitCode = passed === results.length ? 0 : 1;
}
