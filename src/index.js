/**
 * The bridge: stdio in, HTTPS out.
 *
 * This is deliberately a transparent proxy. It does not know what tools exist,
 * what their arguments mean, or what the results contain: it moves JSON-RPC
 * messages between a local client and the hosted server, and attaches the
 * Authorization header. That is the whole design, and it is why adding a tool
 * to the server needs no release here.
 *
 * The one thing it does understand is the difference between a request and a
 * notification, because a notification has no reply and writing an empty line
 * to stdout would corrupt the stream for the client.
 */

import {
  authorize, discover, exchange, isExpired, loadStore, register, saveStore,
} from './oauth.js';

export const DEFAULT_SERVER = 'https://asyntai.com/mcp';

/** Diagnostics go to stderr. stdout carries the protocol and nothing else. */
export const log = (message) => process.stderr.write(`[asyntai] ${message}\n`);

/**
 * Return a valid access token, signing in or refreshing only when needed.
 *
 * Keyed by server URL so a staging endpoint and production can be connected at
 * once without one overwriting the other's tokens.
 */
export async function getAccessToken(serverUrl, deps = {}) {
  const {
    fetchImpl = fetch, now = Date.now(), force = false,
  } = deps;
  const load = deps.load || loadStore;
  const save = deps.save || saveStore;

  const store = await load();
  const entry = store[serverUrl] || {};
  const meta = entry.meta || await discover(serverUrl, fetchImpl);

  // `force` is how the 401 retry says "the cached token is dead even though
  // the clock says otherwise", which is what a revoked token looks like.
  // Without it the retry would hand back the same dead token forever.
  if (!force && entry.token && !isExpired(entry.token, now)) {
    return entry.token.access_token;
  }

  // A refresh token that still works saves the browser round trip. If the
  // server has since revoked it, fall through to a full sign-in rather than
  // failing: the person asked for a tool, not for an error about a token.
  if (entry.token?.refresh_token && entry.clientId) {
    try {
      const token = await exchange(meta, {
        grant_type: 'refresh_token',
        refresh_token: entry.token.refresh_token,
        client_id: entry.clientId,
      }, fetchImpl);
      store[serverUrl] = { ...entry, meta, token };
      await save(store);
      return token.access_token;
    } catch {
      log('The saved sign-in expired. Opening the browser to connect again.');
    }
  }

  const clientId = entry.clientId || (await register(meta, fetchImpl)).client_id;
  const { code, verifier, redirect } = await authorize(meta, clientId, log);
  const token = await exchange(meta, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    client_id: clientId,
    code_verifier: verifier,
  }, fetchImpl);

  store[serverUrl] = { meta, clientId, token };
  await save(store);
  log('Connected.');
  return token.access_token;
}

/**
 * Split a stdio byte stream into whole JSON-RPC messages.
 *
 * The transport is newline-delimited, but a chunk boundary can land anywhere,
 * including inside a multi-byte character. Holding the tail until a newline
 * arrives is the whole job.
 */
export function createLineReader(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onMessage(line);
    }
  };
}

/**
 * Forward one message and return { status, reply }.
 *
 * The HTTP status is handed back rather than swallowed because the caller has
 * to tell an expired token (401) from a tool that legitimately failed, and the
 * error body looks much the same either way.
 *
 * `reply` is null when there is nothing to write: a notification carries no id
 * and the server answers 202 with an empty body. Writing a blank line for that
 * would corrupt the stream for the client.
 */
export async function forward(message, context) {
  const { serverUrl, token, protocolVersion, fetchImpl = fetch } = context;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;

  const response = await fetchImpl(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  const status = response.status;
  if (status === 202 || status === 204) return { status, reply: null };

  const text = await response.text();
  if (!text) return { status, reply: null };

  try {
    return { status, reply: JSON.parse(text) };
  } catch {
    throw new Error(`The server replied with HTTP ${status} and a body that is not JSON.`);
  }
}

/** A JSON-RPC error shaped so the local client shows it rather than hanging. */
export const rpcError = (id, message) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code: -32603, message },
});

export async function run(options = {}) {
  const {
    serverUrl = process.env.ASYNTAI_MCP_URL || DEFAULT_SERVER,
    input = process.stdin,
    output = process.stdout,
    fetchImpl = fetch,
    // Injectable so a test never reads or writes the real credentials file in
    // the home directory. Production leaves both at their defaults.
    load, save,
  } = options;

  const auth = (extra = {}) =>
    getAccessToken(serverUrl, { fetchImpl, load, save, ...extra });

  let token = await auth();
  let protocolVersion = null;

  const write = (payload) => output.write(`${JSON.stringify(payload)}\n`);

  // Messages are handled in order. A client may pipeline several, and running
  // them concurrently would let a later reply overtake an earlier one, which
  // some clients treat as a protocol fault.
  let queue = Promise.resolve();

  const handle = (line) => {
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write(rpcError(null, 'The bridge received a line that is not valid JSON.'));
        return;
      }

      try {
        let { status, reply } = await forward(
          message, { serverUrl, token, protocolVersion, fetchImpl });

        // Exactly one retry on 401. A token can be revoked mid-session, and a
        // silent re-auth beats making somebody restart their client. Retrying
        // more than once would loop against a server that always says 401.
        if (status === 401) {
          token = await auth({ force: true });
          ({ status, reply } = await forward(
            message, { serverUrl, token, protocolVersion, fetchImpl }));
        }

        if (message.method === 'initialize' && reply?.result?.protocolVersion) {
          protocolVersion = reply.result.protocolVersion;
        }
        if (reply) write(reply);
      } catch (error) {
        if ('id' in message) write(rpcError(message.id, error.message));
        else log(`A notification could not be delivered: ${error.message}`);
      }
    });
  };

  input.setEncoding('utf8');
  input.on('data', createLineReader(handle));
  await new Promise((resolve) => input.on('end', resolve));
  await queue;
}
