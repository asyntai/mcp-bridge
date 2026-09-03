# Asyntai extension

Asyntai puts an AI support agent on the user's website. The `asyntai` MCP
server in this extension gives you 54 tools for that agent.

## First use: sign in

The server uses OAuth. If a tool call returns an authentication error, tell
the user to run `/mcp auth asyntai`. A browser
window opens once. Any Asyntai account works, including the free plan.

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

Tool names are exact; call `tools/list` if unsure. Read tools are safe to
call freely. Confirm with the user before deleting knowledge or changing
instructions on a live site.
