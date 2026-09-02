/**
 * The bridge moves other people's bytes, so the tests are about the seams:
 * where a message is split, where a reply is absent, and where a token dies.
 * A stub fetch stands in for the server, because none of this needs a network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  createLineReader, forward, getAccessToken, rpcError, run,
} from '../src/index.js';
import { isExpired, makePkce, redirectUri, PORTS } from '../src/oauth.js';

const json = (body, status = 200) => ({
  status,
  ok: status < 400,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const empty = (status) => ({
  status, ok: status < 400, text: async () => '', json: async () => null,
});

// -- framing ---------------------------------------------------------------

test('a message split across chunks is still delivered once', () => {
  const seen = [];
  const read = createLineReader((line) => seen.push(line));
  read('{"jsonrpc":"2.0",');
  read('"id":1,"method":"ping"}\n');
  assert.deepEqual(seen, ['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
});

test('several messages in one chunk are delivered in order', () => {
  const seen = [];
  const read = createLineReader((line) => seen.push(line));
  read('{"id":1}\n{"id":2}\n{"id":3}\n');
  assert.deepEqual(seen, ['{"id":1}', '{"id":2}', '{"id":3}']);
});

test('blank lines are not delivered as messages', () => {
  const seen = [];
  const read = createLineReader((line) => seen.push(line));
  read('\n\n{"id":1}\n\n');
  assert.deepEqual(seen, ['{"id":1}']);
});

test('a partial trailing message is held, not delivered', () => {
  const seen = [];
  const read = createLineReader((line) => seen.push(line));
  read('{"id":1}\n{"id":2');
  assert.deepEqual(seen, ['{"id":1}']);
});

// -- forwarding ------------------------------------------------------------

test('a reply is returned with its status', async () => {
  const result = await forward({ id: 1, method: 'ping' }, {
    serverUrl: 'https://example/mcp', token: 't',
    fetchImpl: async () => json({ jsonrpc: '2.0', id: 1, result: {} }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.reply.id, 1);
});

test('a notification answered with 202 produces no reply', async () => {
  // Writing anything here would put a stray line on stdout and desynchronise
  // the client, which is the whole reason this case is separate.
  const result = await forward({ method: 'notifications/initialized' }, {
    serverUrl: 'https://example/mcp', token: 't',
    fetchImpl: async () => empty(202),
  });
  assert.equal(result.reply, null);
});

test('the bearer token is attached', async () => {
  let seen;
  await forward({ id: 1 }, {
    serverUrl: 'https://example/mcp', token: 'abc123',
    fetchImpl: async (_url, init) => { seen = init.headers; return json({}); },
  });
  assert.equal(seen.Authorization, 'Bearer abc123');
});

test('the negotiated protocol version is sent once it is known', async () => {
  let seen;
  await forward({ id: 2 }, {
    serverUrl: 'https://example/mcp', token: 't', protocolVersion: '2025-06-18',
    fetchImpl: async (_url, init) => { seen = init.headers; return json({}); },
  });
  assert.equal(seen['MCP-Protocol-Version'], '2025-06-18');
});

test('a non-JSON body is reported, not passed through', async () => {
  await assert.rejects(
    () => forward({ id: 1 }, {
      serverUrl: 'https://example/mcp', token: 't',
      fetchImpl: async () => ({ status: 502, ok: false, text: async () => '<html>oops' }),
    }),
    /HTTP 502/);
});

// -- tokens ----------------------------------------------------------------

const META = {
  authorization_endpoint: 'https://example/auth',
  token_endpoint: 'https://example/token',
  registration_endpoint: 'https://example/register',
};

test('a valid cached token is reused without any network call', async () => {
  const token = await getAccessToken('https://example/mcp', {
    load: async () => ({
      'https://example/mcp': { meta: META, clientId: 'c', token: { access_token: 'live', expires_at: Date.now() + 3_600_000 } },
    }),
    save: async () => {},
    fetchImpl: () => { throw new Error('should not reach the network'); },
  });
  assert.equal(token, 'live');
});

test('force ignores a cached token that the server has revoked', async () => {
  // The clock says the token is fine; the 401 says otherwise. Without force
  // the retry would hand back the same dead token for ever.
  let refreshed = false;
  const token = await getAccessToken('https://example/mcp', {
    force: true,
    load: async () => ({
      'https://example/mcp': {
        meta: META, clientId: 'c',
        token: { access_token: 'revoked', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
      },
    }),
    save: async () => {},
    fetchImpl: async () => {
      refreshed = true;
      return json({ access_token: 'fresh', expires_in: 3600 });
    },
  });
  assert.ok(refreshed);
  assert.equal(token, 'fresh');
});

test('an expired token is refreshed rather than re-authorised', async () => {
  let body;
  const token = await getAccessToken('https://example/mcp', {
    load: async () => ({
      'https://example/mcp': {
        meta: META, clientId: 'c',
        token: { access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1000 },
      },
    }),
    save: async () => {},
    fetchImpl: async (_url, init) => {
      body = init.body;
      return json({ access_token: 'fresh', expires_in: 3600 });
    },
  });
  assert.equal(token, 'fresh');
  assert.match(body, /grant_type=refresh_token/);
});

test('the refreshed token is saved, not just returned', async () => {
  let saved;
  await getAccessToken('https://example/mcp', {
    load: async () => ({
      'https://example/mcp': {
        meta: META, clientId: 'c',
        token: { access_token: 'old', refresh_token: 'r', expires_at: 0 },
      },
    }),
    save: async (store) => { saved = store; },
    fetchImpl: async () => json({ access_token: 'fresh', expires_in: 3600 }),
  });
  assert.equal(saved['https://example/mcp'].token.access_token, 'fresh');
  // The client id must survive a refresh, or the next sign-in registers again.
  assert.equal(saved['https://example/mcp'].clientId, 'c');
});

test('expiry is judged with a margin, so a slow call cannot straddle it', () => {
  const now = 1_000_000;
  assert.equal(isExpired({ expires_at: now + 120_000 }, now), false);
  assert.equal(isExpired({ expires_at: now + 30_000 }, now), true);
  assert.equal(isExpired({}, now), true);
  assert.equal(isExpired(null, now), true);
});

// -- PKCE and redirects ----------------------------------------------------

test('the PKCE challenge is base64url with no padding', () => {
  const { verifier, challenge } = makePkce();
  for (const value of [verifier, challenge]) {
    assert.match(value, /^[A-Za-z0-9_-]+$/);
    assert.ok(!value.includes('='));
  }
  assert.notEqual(verifier, challenge);
});

test('two sign-ins do not share a verifier', () => {
  assert.notEqual(makePkce().verifier, makePkce().verifier);
});

test('every redirect URI is loopback, which is what the server accepts', () => {
  for (const port of PORTS) {
    assert.match(redirectUri(port), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  }
  assert.equal(new Set(PORTS).size, PORTS.length);
});

// -- the loop --------------------------------------------------------------

/**
 * Run the loop against a stub server, with an in-memory credential store.
 *
 * The store is injected so no test ever reads or writes the real file in the
 * home directory. A cached, valid token is seeded so the loop starts without
 * trying to open a browser.
 */
function harness(handleMcp) {
  const store = {
    'https://example/mcp': {
      meta: META,
      clientId: 'c',
      token: { access_token: 'live', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
    },
  };

  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/mcp')) return handleMcp(url, init);
    if (String(url) === META.token_endpoint) {
      return json({ access_token: 'refreshed', expires_in: 3600 });
    }
    throw new Error(`unexpected request to ${url}`);
  };

  const input = new PassThrough();
  const written = [];
  const done = run({
    serverUrl: 'https://example/mcp',
    input,
    output: { write: (chunk) => written.push(chunk) },
    fetchImpl,
    load: async () => store,
    save: async () => {},
  });
  return { input, written, done };
}

test('replies keep the order the requests arrived in', async () => {
  // A client that pipelines must not see reply 2 before reply 1.
  const { input, written, done } = harness(async (_url, init) => {
    const message = JSON.parse(init.body);
    if (message.id === 1) await new Promise((r) => setTimeout(r, 30));
    return json({ jsonrpc: '2.0', id: message.id, result: {} });
  });

  input.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n');
  input.end();
  await done;

  assert.deepEqual(written.map((line) => JSON.parse(line).id), [1, 2]);
});

test('a notification writes nothing to stdout', async () => {
  const { input, written, done } = harness(async () => empty(202));
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.end();
  await done;
  assert.deepEqual(written, []);
});

test('a broken line gets an error, and the stream carries on', async () => {
  const { input, written, done } = harness(async (_url, init) =>
    json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: {} }));

  input.write('not json\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  input.end();
  await done;

  assert.equal(written.length, 2);
  assert.ok(JSON.parse(written[0]).error);
  assert.equal(JSON.parse(written[1]).id, 7);
});

test('a transport failure answers the request instead of hanging it', async () => {
  // Silence would leave the client waiting on an id that never comes back.
  const { input, written, done } = harness(async () => {
    throw new Error('connection reset');
  });
  input.write('{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
  input.end();
  await done;

  const reply = JSON.parse(written[0]);
  assert.equal(reply.id, 9);
  assert.match(reply.error.message, /connection reset/);
});

test('a 401 is retried once with a fresh token', async () => {
  let calls = 0;
  const { input, written, done } = harness(async () => {
    calls += 1;
    return calls === 1
      ? json({ jsonrpc: '2.0', id: 3, error: { code: -32600 } }, 401)
      : json({ jsonrpc: '2.0', id: 3, result: { ok: true } });
  });

  input.write('{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n');
  input.end();
  await done;

  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(written[0]).result, { ok: true });
});

test('rpcError uses null when there is no id to answer', () => {
  assert.equal(rpcError(undefined, 'x').id, null);
  assert.equal(rpcError(0, 'x').id, 0);
});
