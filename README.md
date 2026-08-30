# ChatGPT CDP MCP

[Русский](docs/README.ru.md) · [Quick start](docs/QUICKSTART.md) · [Driver guide](docs/DRIVER.md) · [Tool reference](docs/TOOLS.md)

![A single chat page connected to MCP tools](docs/assets/hero.png)

> Turn one authenticated ChatGPT browser page into a bounded MCP server — with a driver you control and a single-page lease you can verify.

ChatGPT CDP MCP gives an MCP client a clean, typed tool surface for a browser page you already own. Bring any CDP-capable adapter (Chrome DevTools Protocol, Playwright, BrowserClaw, or your own), point the server at it, and keep the browser integration separate from the MCP contract.

- Seven MCP operations: create, list, search, export, send, edit, and download.
- One owned browser page per MCP process; every operation rechecks its lease.
- Existing chats are discoverable; consequential operations are restricted to one disposable fixture created by the server.
- Opaque refs keep browser-native IDs out of MCP responses.
- A bundled mock driver lets you verify the complete MCP wiring before connecting a real account.

## Install

```bash
npm install --global git+https://github.com/megamen32/chatgpt-cdp-mcp.git
```

Requires Node.js 20+ and a local driver module. The command installs the server; a driver is the unavoidable connection to your already authenticated browser.

## Start in minutes

Try the safe local demo first — it does not open a browser or contact ChatGPT:

```bash
git clone https://github.com/megamen32/chatgpt-cdp-mcp.git && cd chatgpt-cdp-mcp && npm ci && CDP_CHAT_DRIVER_MODULE=./examples/mock-driver.mjs npm start
```

Then configure your MCP client:

```json
{
  "mcpServers": {
    "chatgpt": {
      "command": "chatgpt-cdp-mcp",
      "env": {
        "CDP_CHAT_DRIVER_MODULE": "/absolute/path/to/your-chatgpt-driver.mjs",
        "CDP_CHAT_MEDIA_ROOT": "/absolute/path/to/private-media"
      }
    }
  }
}
```

Build the real driver from the compact [driver contract](docs/DRIVER.md). The server intentionally does not ship a browser login flow, profile, cookie, or hosted endpoint.

## What it exposes

| Tool | Purpose |
| --- | --- |
| `new_chat` | Creates one disposable fixture chat without submitting a prompt. |
| `list_chats` | Lists visible chats by `unread`, `working`, or `recent`. |
| `search_chat` | Searches visible titles and message text from one fresh snapshot. |
| `export_chat` | Exports a page-visible chat as bounded JSON or Markdown. |
| `send_message` | Sends once to a page-visible chat after explicit confirmation. |
| `edit_message` | Edits a fixture message with an optimistic guard. |
| `download_media` | Saves an allowlisted fixture attachment under a confined directory. |

Read the full [tool reference](docs/TOOLS.md) for inputs, limits, and expected results.

## Why retain a fixture boundary?

The most expensive browser failures happen when an automation targets the wrong conversation. Page identity checks, opaque references, exact confirmations, and one-shot idempotency keys protect export/send to an existing visible chat. `new_chat` remains available for isolated integration tests; editing and media download stay fixture-bound.

## Project layout

```text
MCP client
   │ stdio
   ▼
ChatGPT CDP MCP
   │ CdpChatDriver
   ▼
one browser page you own
```

The public package owns the tool contract, opaque references, bounds, and fixture lifecycle. Your adapter owns browser automation and authentication. See [architecture](docs/ARCHITECTURE.md).

## Development

```bash
npm ci
npm test
```

The test suite uses an in-memory browser page; no ChatGPT account, browser profile, or network access is required.

## Important notes

- Use only a browser page and account you are authorized to control, and comply with the applicable terms of service.
- This is an independent open-source project; it is not affiliated with or endorsed by OpenAI.
- The server never includes a browser profile, cookie, token, or account data in the repository.

## Learn more

- [Quick start](docs/QUICKSTART.md)
- [Writing a real CDP driver](docs/DRIVER.md)
- [Tool reference](docs/TOOLS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Security model](docs/SECURITY.md)
- [Contributing](CONTRIBUTING.md)

MIT © 2026 megamen32
