# @asyntai/mcp

Connect any MCP client to your [Asyntai](https://asyntai.com) account.

Asyntai puts an AI support agent on your website that answers visitors from
your own content. This package gives your assistant the same 52 tools the
Asyntai dashboard has: add knowledge, edit the agent's instructions, read
conversations and leads, and reply to a live visitor yourself.

## Do you need this?

Probably not, and that is deliberate.

Asyntai runs a hosted MCP server at `https://asyntai.com/mcp`. If your client
supports remote MCP servers, which Claude, ChatGPT, Cursor and VS Code all do,
add that URL directly and skip this package.

This is for clients that can only launch a local command. It bridges one to the
other and handles the sign-in.

## Use it

```json
{
  "mcpServers": {
    "asyntai": {
      "command": "npx",
      "args": ["-y", "@asyntai/mcp"]
    }
  }
}
```

The first run opens a browser once so you can approve access. After that it is
silent. You need an Asyntai account; the free plan works.

## Commands

```bash
npx @asyntai/mcp            # run the bridge
npx @asyntai/mcp logout     # forget the saved sign-in
npx @asyntai/mcp --help
```

## How it works

It is a transparent proxy. It reads JSON-RPC messages on stdin, posts them to
the hosted server with an `Authorization` header, and writes the replies to
stdout. It does not know what the tools are or what they return, which is why
new tools on the server work here without a new release.

Sign-in is OAuth 2.1 with PKCE, the same flow Claude and ChatGPT use. No API
key is ever entered. The endpoints are read from the server's published
metadata rather than hard-coded, so a route change on the server does not
break this package.

## Where the sign-in is kept

`~/.asyntai/mcp-credentials.json`, with owner-only permissions where the
operating system supports them. It holds an access token and a refresh token
for each server you connect to. `logout` removes them.

Revoking from the Asyntai side is at
[asyntai.com/mcp/connections](https://asyntai.com/mcp/connections/), which
kills the tokens immediately whatever is on disk.

## Options

| Variable | Meaning |
| --- | --- |
| `ASYNTAI_MCP_URL` | Point at a different server. Defaults to `https://asyntai.com/mcp`. |

Diagnostics go to stderr. stdout carries the protocol and nothing else.

## Development

```bash
npm test
```

No dependencies, and none planned. Node 18 or newer.

## Links

- [Connector documentation](https://asyntai.com/documentation/mcp/)
- [Privacy policy](https://asyntai.com/privacy-policy/)
- hello@asyntai.com

MIT.
