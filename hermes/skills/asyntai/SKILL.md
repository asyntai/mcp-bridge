---
name: asyntai
description: Use when the user wants to manage their Asyntai AI support agent - its knowledge base, instructions, conversations, leads, live chats or plan - or asks how their website chatbot is doing.
---

# Asyntai

Asyntai puts an AI support agent on the user's website. The `asyntai` MCP
server in this plugin gives you 73 tools for that agent. Hermes names them
`mcp__asyntai__<tool>`.

## First use: sign in

The first tool call opens a browser window once so the user can approve
access to their Asyntai account. Any account works, including the free plan.
Tell the user this before the first call. If no browser can open (a server,
a cron job), the call fails after the timeout: ask the user to run Hermes once
on a machine with a browser, or to run `npx @asyntai/mcp` there and sign in.

To sign out, the user runs `npx @asyntai/mcp logout`.

## Start every task the same way

1. Call `list_websites`. Most accounts have one site; some have several.
2. If there are several, ask which one before any write. Write tools take a
   `website_id` and refuse to guess.
3. Read before you change: `get_ai_instructions` before editing
   instructions, `list_knowledge` before adding or removing knowledge.

## Common jobs

- **Teach the agent something**: `add_knowledge_text` for a fact, `add_knowledge_url` for a page.
- **Change how it answers**: `get_ai_instructions`, then `update_ai_instructions`.
- **See what visitors ask**: `list_conversations`, `get_conversation`, `list_knowledge_gaps`.
- **Leads**: `list_leads`.
- **Answer a visitor yourself**: `list_active_sessions`, `take_over_conversation`, `send_agent_reply`, `release_conversation`.
- **Plan and limits**: `get_account`, `list_plans`.
- **How does Asyntai work**: `search_asyntai_docs`, then `get_asyntai_doc`.

Tool names are exact. Read tools are safe to call freely. The plugin marks the
server untrusted, so Hermes asks the user before every write tool runs. Still
confirm with the user before deleting knowledge or changing instructions on a
live site, and never send a reply to a visitor the user did not approve.
