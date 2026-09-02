/**
 * Smoke test against a real Asyntai server, not a stub.
 *
 * The unit tests prove the bridge behaves correctly against invented replies.
 * They cannot prove it agrees with the actual server about metadata shapes,
 * status codes or header names, which is the thing most likely to be wrong.
 *
 * This makes read-only requests only. It registers nothing and writes nothing,
 * on the server or on disk, so it is safe to point at a local dev instance.
 *
 *   node tests/live.mjs http://127.0.0.1:8100/mcp
 */

import { discover } from '../src/oauth.js';
import { forward } from '../src/index.js';

const serverUrl = process.argv[2] || 'https://asyntai.com/mcp';
const results = [];

const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

// 1. Does the real metadata parse, and name the routes the bridge needs?
let meta;
try {
  meta = await discover(serverUrl);
  check('discovery reads the real metadata', true);
  check('authorization_endpoint is present', Boolean(meta.authorization_endpoint),
    meta.authorization_endpoint);
  check('token_endpoint is present', Boolean(meta.token_endpoint), meta.token_endpoint);
  check('dynamic registration is offered', Boolean(meta.registration_endpoint),
    meta.registration_endpoint || 'missing');
  check('PKCE S256 is advertised',
    (meta.code_challenge_methods_supported || []).includes('S256'),
    JSON.stringify(meta.code_challenge_methods_supported));
} catch (error) {
  check('discovery reads the real metadata', false, error.message);
}

// 2. Does an unauthenticated call come back as a 401 the retry can recognise?
//    If the server answered 200 with an error body, the retry would never fire.
try {
  const { status } = await forward(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { serverUrl, token: 'definitely-not-a-token' });
  check('a bad token gives HTTP 401', status === 401, `got ${status}`);
} catch (error) {
  check('a bad token gives HTTP 401', false, error.message);
}

// 3. The resource metadata document the bridge reads first.
try {
  const response = await fetch(`${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`);
  const body = await response.json();
  check('resource metadata lists an authorization server',
    Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0,
    JSON.stringify(body.authorization_servers));
} catch (error) {
  check('resource metadata lists an authorization server', false, error.message);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed} of ${results.length} checks passed against ${serverUrl}`);
process.exitCode = passed === results.length ? 0 : 1;
