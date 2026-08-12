# Quick start

This package speaks MCP over standard input/output. It has no browser login UI
and never opens a remote service on its own.

## 1. Verify the server locally

The mock driver uses only in-memory data:

```bash
git clone https://github.com/megamen32/chatgpt-cdp-mcp.git
cd chatgpt-cdp-mcp
npm ci
CDP_CHAT_DRIVER_MODULE=./examples/mock-driver.mjs npm start
```

The process stays running and writes MCP messages to stdout. Start it through
an MCP client or inspect it locally:

```bash
CDP_CHAT_DRIVER_MODULE=./examples/mock-driver.mjs npm run inspect
```

## 2. Add it to an MCP client

Use the built package or `npx`. With a project checkout:

```json
{
  "mcpServers": {
    "chatgpt": {
      "command": "node",
      "args": ["/absolute/path/chatgpt-cdp-mcp/dist/cdp-chat-mcp.js"],
      "env": {
        "CDP_CHAT_DRIVER_MODULE": "/absolute/path/to/your-chatgpt-driver.mjs",
        "CDP_CHAT_MEDIA_ROOT": "/absolute/path/to/private-media"
      }
    }
  }
}
```

For a global installation, set `command` to `chatgpt-cdp-mcp` and keep the two
environment values.

## 3. Implement your driver

Copy [`examples/chatgpt-cdp-driver.mjs`](../examples/chatgpt-cdp-driver.mjs),
then implement the `CdpChatDriver` contract described in [DRIVER.md](DRIVER.md).
The driver must return the same page identity throughout one action. Do not
return cookies, browser handles, or account names in that identity.

## 4. Use a disposable fixture

The recommended first tool call against a real page is:

```json
{
  "name": "new_chat",
  "arguments": {
    "confirmation": "NEW_CHAT",
    "idempotencyKey": "your-unique-key",
    "title": "MCP disposable fixture"
  }
}
```

Use the returned `chatRef` for `export_chat`, `send_message`, `edit_message`,
and `download_media`. Existing chats are intentionally not accepted by those
operations.
