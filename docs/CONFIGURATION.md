# Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `CDP_CHAT_DRIVER_MODULE` | Yes | Absolute or working-directory-relative ESM module exporting `createCdpChatDriver()` or a default factory. |
| `CDP_CHAT_MEDIA_ROOT` | No | Private root for fixture attachment downloads. Defaults to `./cdp-chat-media`. |

## Example

```bash
export CDP_CHAT_DRIVER_MODULE=/opt/chatgpt-driver.mjs
export CDP_CHAT_MEDIA_ROOT=/srv/private/chatgpt-media
chatgpt-cdp-mcp
```

The driver module loads in the server process. Keep it local and protect any
browser-specific configuration with normal operating-system permissions.
