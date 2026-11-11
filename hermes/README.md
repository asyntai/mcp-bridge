# Asyntai AI Support Agent for Hermes

[Asyntai](https://asyntai.com) puts an AI support agent on your website that
answers visitors from your own content. This plugin lets Hermes run that agent
for you: add knowledge, edit the agent's instructions, read conversations and
leads, reply to a live visitor yourself and check your plan.

It is an Agent Plugins v1 package: `plugin.json`, `mcp.json` and one skill. It
has no Python code.

## Install

```bash
hermes plugins install asyntai
hermes plugins enable asyntai
```

You need Node.js 18 or newer, because the MCP server runs through `npx`. You
also need an Asyntai account; the free plan works. Sign up at
https://asyntai.com/register/ if you do not have one.

## First use

Ask Hermes something like "How many leads did my website get this week?". The
first tool call opens your browser once so you can approve access. After that
it is silent.

## What it can do

The server has 73 tools, the same jobs the Asyntai dashboard does:

- Knowledge: add text, pages, images and products, start a crawl, search, list and remove sources
- Agent instructions and widget settings: read and update them
- Conversations, leads and analytics: list, read, daily reports, knowledge gaps
- Live chat: see active visitors, take over a chat, reply, hand it back
- Tickets, emails and order requests: read, draft and send replies
- Account: plan, usage, team and limits
- Asyntai documentation search

Full list: https://asyntai.com/documentation/mcp/

## Disclosure

- **Network**: every tool call goes to `https://asyntai.com/mcp`. On first
  run `npx` also downloads the bridge from the npm registry. The local
  process is `@asyntai/mcp`, pinned to version 1.0.2 on npm. Its source is in
  this repository under `src/`.
- **Stored credential**: the sign-in is OAuth 2.1 with PKCE. No API key is
  entered. The access and refresh tokens are kept in
  `~/.asyntai/mcp-credentials.json`, with owner-only permissions where the
  operating system supports them. `npx @asyntai/mcp logout` deletes them.
- **Browser**: the first tool call opens a browser and waits for a redirect on
  a loopback port (33418 to 33422). In an unattended run (cron, the messaging
  gateway) no one can approve it, so the call fails when Hermes's MCP timeout
  ends. Sign in once on a machine with a browser first.
- **Writes**: some tools change your live website agent (knowledge,
  instructions) or send a message to a visitor. The plugin marks the server
  `untrusted`, so Hermes asks you before every tool that is not read-only, and
  refuses them in unattended runs.
- **No telemetry**: the plugin collects nothing. The Asyntai server keeps the
  usual account and activity records, as described in the privacy policy:
  https://asyntai.com/privacy-policy/

## Other server

`ASYNTAI_MCP_URL` points the bridge at a different Asyntai server, for example
a self-hosted test instance. Leave it unset to use `https://asyntai.com/mcp`.

## Support

hello@asyntai.com

## License

MIT
