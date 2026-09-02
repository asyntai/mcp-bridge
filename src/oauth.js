/**
 * OAuth 2.1 sign-in for the Asyntai MCP bridge.
 *
 * The whole point of the hosted connector is that nobody pastes an API key
 * anywhere, so this runs the same authorization-code flow with PKCE that
 * Claude and ChatGPT run, just from a local process. Nothing here invents its
 * own endpoints: they are read from the server's published metadata, so if the
 * server moves a route the bridge follows it.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Loopback ports the bridge is willing to listen on.
 *
 * The authorization server matches redirect_uri exactly, so every port the
 * bridge might use has to be registered up front. Registering the whole short
 * list once means a busy port later is just the next one along, rather than a
 * re-registration the user has to approve again.
 */
export const PORTS = [33418, 33419, 33420, 33421, 33422];

const STORE_DIR = join(homedir(), '.asyntai');
const STORE_FILE = join(STORE_DIR, 'mcp-credentials.json');

/** Refresh this long before expiry, so a slow call cannot straddle it. */
const REFRESH_MARGIN_MS = 60_000;

export const redirectUri = (port) => `http://127.0.0.1:${port}/callback`;

// -- storage ---------------------------------------------------------------

export async function loadStore(path = STORE_FILE) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveStore(store, path = STORE_FILE) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  // writeFile only applies mode when it creates the file, so an existing file
  // keeps whatever permissions it had. This holds refresh tokens.
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows does not model POSIX permissions. Not fatal.
  }
}

// -- PKCE ------------------------------------------------------------------

const base64url = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function makePkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

// -- discovery -------------------------------------------------------------

/**
 * Find the authorization server for an MCP endpoint.
 *
 * RFC 9728 first: the resource itself names its authorization servers. Falling
 * back to the well-known path on the same origin keeps this working against a
 * server that has not published resource metadata.
 */
export async function discover(serverUrl, fetchImpl = fetch) {
  const origin = new URL(serverUrl).origin;

  let issuer = origin;
  try {
    const response = await fetchImpl(`${origin}/.well-known/oauth-protected-resource`);
    if (response.ok) {
      const body = await response.json();
      if (Array.isArray(body.authorization_servers) && body.authorization_servers[0]) {
        issuer = body.authorization_servers[0];
      }
    }
  } catch {
    // Falls through to the same-origin guess below.
  }

  const response = await fetchImpl(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  if (!response.ok) {
    throw new Error(`Could not read the authorization server metadata (HTTP ${response.status}).`);
  }
  const meta = await response.json();
  for (const field of ['authorization_endpoint', 'token_endpoint']) {
    if (!meta[field]) throw new Error(`Authorization server metadata is missing ${field}.`);
  }
  return meta;
}

// -- registration ----------------------------------------------------------

export async function register(meta, fetchImpl = fetch) {
  if (!meta.registration_endpoint) {
    throw new Error('This server does not offer dynamic client registration.');
  }
  const response = await fetchImpl(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Asyntai MCP bridge',
      // Every port up front: see PORTS above for why.
      redirect_uris: PORTS.map(redirectUri),
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!response.ok) {
    throw new Error(`Client registration failed (HTTP ${response.status}): ${await response.text()}`);
  }
  return response.json();
}

// -- the browser round trip ------------------------------------------------

function openBrowser(url) {
  const command =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(command[0], command[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Headless machines exist. The URL is printed either way.
  }
}

/**
 * Bind the first free loopback port and wait there for the redirect.
 *
 * The port has to be known before the authorization URL is built, because it
 * is part of redirect_uri, so binding resolves first and the code arrives
 * later. Returning both separately keeps that order explicit instead of
 * racing two callbacks.
 *
 * `state` is checked here rather than trusted: this listener accepts a
 * connection from anything running on the machine.
 */
async function listenForCode(state) {
  for (const port of PORTS) {
    let server;
    try {
      server = await new Promise((resolve, reject) => {
        const candidate = createServer();
        candidate.once('error', reject);
        candidate.listen(port, '127.0.0.1', () => resolve(candidate));
      });
    } catch (error) {
      if (error.code === 'EADDRINUSE') continue;
      throw error;
    }

    const code = new Promise((resolve, reject) => {
      server.on('request', (request, response) => {
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== '/callback') {
          response.writeHead(404).end();
          return;
        }

        const finish = (ok, text) => {
          response.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(`<!doctype html><meta charset="utf-8"><title>Asyntai</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.6">
<h1 style="font-size:1.25rem">${ok ? 'Connected' : 'Not connected'}</h1>
<p>${text}</p></body>`);
          server.close();
        };

        const error = url.searchParams.get('error');
        const returned = url.searchParams.get('state');
        const authCode = url.searchParams.get('code');

        if (error) {
          finish(false, `The server refused the request: ${error}`);
          reject(new Error(`Authorization failed: ${error}`));
        } else if (returned !== state) {
          finish(false, 'That request did not match this sign-in. Nothing was connected.');
          reject(new Error('State mismatch on the OAuth callback.'));
        } else if (!authCode) {
          finish(false, 'No authorization code came back.');
          reject(new Error('No authorization code in the callback.'));
        } else {
          finish(true, 'You can close this tab and go back to your assistant.');
          resolve(authCode);
        }
      });
    });

    return { port, code };
  }

  throw new Error(`No free port among ${PORTS.join(', ')}. Close whatever is using them.`);
}

export async function authorize(meta, clientId, log) {
  const { verifier, challenge } = makePkce();
  const state = base64url(randomBytes(16));
  const { port, code } = await listenForCode(state);

  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri(port));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', 'asyntai:read asyntai:write');
  url.searchParams.set('state', state);

  log(`Open this page to connect your Asyntai account:
  ${url}`);
  openBrowser(url.toString());

  return { code: await code, verifier, redirect: redirectUri(port) };
}

// -- tokens ----------------------------------------------------------------

export async function exchange(meta, body, fetchImpl = fetch) {
  const response = await fetchImpl(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token request failed (HTTP ${response.status}): ${text}`);
  }
  const token = JSON.parse(text);
  if (!token.access_token) throw new Error('The token response carried no access_token.');
  // Store an absolute moment: a duration is meaningless after the file is
  // written and read back an hour later.
  token.expires_at = Date.now() + (Number(token.expires_in) || 3600) * 1000;
  return token;
}

export const isExpired = (token, now = Date.now()) =>
  !token?.expires_at || now >= token.expires_at - REFRESH_MARGIN_MS;

export { STORE_FILE };
