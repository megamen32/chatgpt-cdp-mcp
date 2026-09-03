# Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `CDP_CHAT_DRIVER` | One driver selector | `browserclaw` for the bundled BrowserClaw adapter; `module` (or unset) for a custom module. |
| `CDP_CHAT_DRIVER_MODULE` | For `module` | Absolute or working-directory-relative ESM module exporting `createCdpChatDriver()` or a default factory. |
| `CDP_CHAT_MEDIA_ROOT` | No | Private root for fixture attachment downloads. Defaults to `./cdp-chat-media`. |
| `CDP_CHAT_BROWSERCLAW_MCP_URL` | No | BrowserClaw Streamable HTTP endpoint. Defaults to `http://127.0.0.1:9010/mcp`. |
| `CDP_CHAT_BROWSERCLAW_MCP_TOKEN` | No | Bearer token for a protected BrowserClaw endpoint. |
| `CDP_CHAT_BROWSERCLAW_PAGE` | No | Existing ChatGPT BrowserClaw page id to own. Required only when multiple ChatGPT tabs are open. |
| `CDP_CHAT_BROWSERCLAW_TIMEOUT_MS` | No | Per-operation BrowserClaw deadline from 1,000 to 3,600,000 ms. Defaults to 600,000. |

## Bundled BrowserClaw driver

```bash
export CDP_CHAT_DRIVER=browserclaw
export CDP_CHAT_BROWSERCLAW_MCP_URL=http://127.0.0.1:9010/mcp
export CDP_CHAT_MEDIA_ROOT=/srv/private/chatgpt-media
chatgpt-cdp-mcp
```

At startup it reuses the single ChatGPT tab accessible to its BrowserClaw MCP
session. With no accessible tab — including when visible ChatGPT pages belong
to another BrowserClaw session — it opens exactly one `https://chatgpt.com/`
tab, then keeps that page for the MCP process. It never opens a tab per tool
call. If several accessible ChatGPT tabs exist, choose one explicitly:

```bash
export CDP_CHAT_BROWSERCLAW_PAGE=42
```

The bundled adapter exposes `new_chat`, `send_message`, `download_media`,
`research`, `search`, and `draw`. Its `draw` download is a current-page PNG
screenshot after the generated image settles, not the original image asset.

## Custom module driver

```bash
export CDP_CHAT_DRIVER=module
export CDP_CHAT_DRIVER_MODULE=/opt/chatgpt-driver.mjs
chatgpt-cdp-mcp
```

The custom module loads in the server process. Keep it local and protect any
browser-specific configuration with normal operating-system permissions.

## Bundled token driver (read-only, no browser)

```bash
export CDP_CHAT_DRIVER=token
export CHATGPT_TOKEN_SESSION_TOKEN=__Secure-next-auth.session-token value
# or: CHATGPT_TOKEN_SESSION_FILE=/path/to/session.json ({"session_token": "..."})
export CHATGPT_TOKEN_FETCH_COMMAND="python3 examples/token_bridge.py"
export CHATGPT_TOKEN_SNAPSHOT_DEPTH=10
export CHATGPT_TOKEN_DETAIL_DELAY_MS=1200
chatgpt-cdp-mcp
```

The token driver exchanges the long-lived `__Secure-next-auth.session-token`
cookie for a short-lived `accessToken` at `/api/auth/session` and reads
`backend-api/conversations` and `/backend-api/conversation/{id}` directly —
no browser. It declares only `list_chats`, `search_chat`, and `export_chat`;
page actions (`new_chat`, `send_message`, `edit_message`, `download_media`,
`research`, `draw`) require a CDP driver.

chatgpt.com sits behind Cloudflare, which rejects non-browser TLS
fingerprints: plain Node `fetch` usually gets 403. Use
`CHATGPT_TOKEN_FETCH_COMMAND` with the bundled `examples/token_bridge.py`
(`pip install curl_cffi`) or any curl-impersonate bridge. Cookies returned by
the server are kept in a jar and replayed on subsequent requests.

`CHATGPT_TOKEN_SNAPSHOT_DEPTH` (default 10) bounds how many newest chats get
their full message tree in one snapshot; `CHATGPT_TOKEN_DETAIL_DELAY_MS`
(default 1200) spaces those detail requests out — the conversation endpoint
answers with an empty mapping under rapid polling.
