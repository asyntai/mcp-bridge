/**
 * One reversible write on a named test website, plus two guards that write
 * nothing. Reuses the sign-in the bridge already cached, so no browser.
 *
 *   node tests/drive_write.mjs https://asyntai.com/mcp 2082
 *
 * Everything this adds, it deletes again before exiting.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverUrl = process.argv[2] || 'https://asyntai.com/mcp';
const websiteId = Number(process.argv[3]);
if (!websiteId) { console.error('pass the website id of the TEST site'); process.exit(2); }

const child = spawn(process.execPath, [join(here, '..', 'src', 'cli.js'), serverUrl], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const replies = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && replies.has(m.id)) replies.get(m.id)(m);
  }
});
let nextId = 1;
const call = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => reject(new Error(`${method}: no reply in ${timeoutMs / 1000}s`)), timeoutMs);
  replies.set(id, (m) => { clearTimeout(t); resolve(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const tool = async (name, args) => {
  const r = await call('tools/call', { name, arguments: args });
  return { error: r.result?.isError ? r.result.content?.[0]?.text : null, data: r.result?.structuredContent };
};

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

let createdId = null;
try {
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'drive-write', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  // Guard 1: a write with no website named, on an account with several sites,
  // must be refused rather than land on whichever site sorts first.
  const blind = await tool('update_ai_instructions', { instructions: 'should never land' });
  check('write without website_id is refused on a multi-site account',
    !!blind.error && /website_id/.test(blind.error), (blind.error || '').slice(0, 90));

  // Guard 2: plan gates report themselves, read-only.
  const feats = await tool('get_website_features', { website_id: websiteId });
  const locked = feats.data ? Object.entries(feats.data.features).filter(([, v]) => !v.available_on_your_plan).map(([k]) => k) : [];
  check('get_website_features answers for the test site', !!feats.data, feats.data ? `plan=${feats.data.plan}, ${locked.length} locked` : feats.error);

  const acct = await tool('get_account', {});
  check('get_account reports limits', !!acct.data && 'websites_limit' in acct.data,
    acct.data ? `plan=${acct.data.plan} msgs=${acct.data.messages_used_this_month}/${acct.data.messages_limit} sites=${acct.data.websites}/${acct.data.websites_limit}` : acct.error);

  // The reversible write.
  const marker = 'MCP write test ' + new Date().toISOString();
  const added = await tool('add_knowledge_text', {
    website_id: websiteId, title: marker,
    content: 'Temporary entry created by the MCP bridge end-to-end test. It is deleted by the same test moments later. ' +
             'If you can read this in the dashboard, the test was interrupted and this entry can be removed.',
  });
  createdId = added.data?.id ?? added.data?.entry?.id ?? null;
  check('add_knowledge_text on the test site', !!added.data && !added.error, added.error || `id=${createdId} website=${added.data?.website}`);
  check('the write names the website it landed on', added.data?.website === 'yourwebsite.com', String(added.data?.website));

  const listed = await tool('list_knowledge', { website_id: websiteId, limit: 50 });
  const found = (listed.data?.entries || []).find((e) => e.title === marker);
  check('the entry is visible afterwards', !!found, found ? `id=${found.id}` : listed.error || 'not in list');
  if (!createdId && found) createdId = found.id;
} catch (e) {
  check('run', false, e.message);
} finally {
  if (createdId) {
    const gone = await tool('delete_knowledge_entry', { entry_id: createdId }).catch((e) => ({ error: e.message }));
    check('cleanup: entry deleted again', !gone.error, gone.error || '');
    const after = await tool('list_knowledge', { website_id: websiteId, limit: 50 }).catch(() => ({}));
    check('cleanup: entry no longer listed', !(after.data?.entries || []).some((e) => e.id === createdId));
  }
  child.stdin.end();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed} of ${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}
