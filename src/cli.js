#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Two jobs: run the bridge, or clear the saved sign-in. Everything a client
 * launches goes through the first, and the second exists because "sign me out"
 * should not mean "find and delete a file in your home directory".
 */

import { loadStore, saveStore, STORE_FILE } from './oauth.js';
import { DEFAULT_SERVER, log, run } from './index.js';

const USAGE = `Asyntai MCP bridge

  asyntai-mcp [server-url]     Run the bridge. Defaults to ${DEFAULT_SERVER}
  asyntai-mcp logout [url]     Forget the saved sign-in
  asyntai-mcp --help           Show this

Point your MCP client's command at "npx -y @asyntai/mcp". The first run opens
a browser once so you can approve access to your Asyntai account.
`;

async function logout(serverUrl) {
  const store = await loadStore();
  if (serverUrl) {
    if (!store[serverUrl]) {
      log(`Nothing saved for ${serverUrl}.`);
      return;
    }
    delete store[serverUrl];
    await saveStore(store);
    log(`Forgot the sign-in for ${serverUrl}.`);
    return;
  }
  await saveStore({});
  log(`Forgot every saved sign-in. The file is ${STORE_FILE}.`);
}

const [command, ...rest] = process.argv.slice(2);

if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(USAGE);
} else if (command === 'logout') {
  await logout(rest[0]);
} else {
  try {
    await run({ serverUrl: command || undefined });
  } catch (error) {
    // Anything reaching here happened before, or instead of, the message loop,
    // so there is no client waiting on a JSON-RPC reply to put it in.
    log(`Could not start: ${error.message}`);
    process.exitCode = 1;
  }
}
