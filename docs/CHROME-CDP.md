# Chrome CDP driver

`CDP_CHAT_DRIVER=chrome-cdp` connects the MCP server straight to a Chrome the
user already runs. It needs no BrowserClaw, no launchd/launchctl unit, no OS
automation and no Accessibility scripting: the only channel is the browser
DevTools WebSocket.

```bash
export CDP_CHAT_DRIVER=chrome-cdp
export CDP_CHAT_CHROME_PROFILE_DIR="$HOME/Library/Application Support/Google/Chrome"
export CDP_CHAT_MEDIA_ROOT=/srv/private/chatgpt-media
chatgpt-cdp-mcp
```

The driver owns **one** ChatGPT page in that Chrome. It reads the sidebar and
the rendered conversation of that page, and it types into the composer of a
chat it created itself.

## Two connection routes

### 1. The toggle route (a real profile)

Chrome 136 and newer **ignore** `--remote-debugging-port` and
`--remote-debugging-pipe` for the default `--user-data-dir`. A real profile is
reachable only through the toggle at `chrome://inspect/#remote-debugging`:
*Allow remote debugging for this browser instance*. The toggle must already be
on when Chrome starts.

On that route Chrome serves **only the browser WebSocket**. The HTTP discovery
endpoints are gone:

```text
GET http://127.0.0.1:<port>/json/version  ->  404
GET http://127.0.0.1:<port>/json/list     ->  404
```

So the driver must not build discovery on `/json/*`. Instead it reads the
endpoint from the file Chrome writes for that start:

```text
<user-data-dir>/DevToolsActivePort
  9222
  /devtools/browser/b6025fd3-8972-4a79-af1a-85fc42beb027
```

The first line is the port, the second is the browser target path. The file
exists only for a Chrome start that already had the toggle on, so it is the
ownership proof of the first kind.

The driver then connects to the browser target:

```text
ws://127.0.0.1:9222/devtools/browser/b6025fd3-8972-4a79-af1a-85fc42beb027
```

and works over that one socket:

| Step | CDP command |
| --- | --- |
| list targets | `Target.getTargets` |
| attach to the page | `Target.attachToTarget` with `flatten: true` |
| read the page | `Runtime.evaluate` in the page session |
| type | `Input.insertText` |
| submit | `Input.dispatchKeyEvent` / the page-native send control |

### 2. The flag route (a separate profile)

Chrome started with `--remote-debugging-port` **and a non-default**
`--user-data-dir` still answers `/json/*`. The driver uses the same browser
WebSocket; the endpoint can be given directly:

```bash
export CDP_CHAT_CHROME_BROWSER_WS_URL=ws://127.0.0.1:9222/devtools/browser/<uuid>
```

## Why the ownership proof uses the file, the argv and the socket inode

`/json/*` answers 404 on the toggle route, so the port cannot be asked who
owns it. The driver therefore proves ownership from three independent facts
before it opens the browser WebSocket:

1. **The file.** `<user-data-dir>/DevToolsActivePort` supplies the port and the
   browser target path. Chrome writes it only for a start that already had the
   toggle on.
2. **The argv profile.** The process that listens on that port must be Chrome,
   and when it carries `--user-data-dir=` that value must be the expected
   profile. A different profile on the same port is refused. On Linux the argv
   comes from `/proc/<pid>/cmdline`; on macOS `ps` only reports a reconstructed
   command line, so the value is matched inside the raw command line, which
   keeps a profile path with spaces intact.
3. **The socket owner.** The listening socket is resolved to its owning
   process: by socket inode through `/proc/net/tcp` and `/proc/<pid>/fd` on
   Linux, by `lsof` on macOS. The port therefore cannot be silently taken over
   by another process that merely inherited it.

A mismatch is refused with a concrete reason instead of a generic connection
error, for example:

```text
Chrome access unavailable: the listening Chrome owns profile /somewhere/else
instead of /Users/user/Library/Application Support/Google/Chrome (pid 25426
owns the DevTools port 9222).
```

## Refusals

Every refusal names its cause:

| Reason | Meaning |
| --- | --- |
| `chrome_cdp_active_port_missing` | No `DevToolsActivePort` in the profile: the toggle was off, or the profile is wrong. |
| `chrome_cdp_active_port_invalid` | The file does not hold a port and a `/devtools/browser/<uuid>` path. |
| `chrome_cdp_socket_owner_missing` | Nothing listens on the recorded port. |
| `chrome_cdp_socket_owner_mismatch` | The listening process is not the expected Chrome profile. |
| `chrome_cdp_ws_failed` / `chrome_cdp_ws_timeout` | The browser WebSocket did not open. |
| `chrome_cdp_no_chatgpt_page` | No open `chatgpt.com` page in this Chrome. |
| `chrome_cdp_ambiguous_chatgpt_page` | Several ChatGPT pages are open; set `CDP_CHAT_CHROME_TARGET_ID`. |
| `chrome_cdp_target_not_found` | The requested target id is not open. |
| `chrome_cdp_composer_missing` | The ChatGPT composer was not found on the owned page. |
| `chrome_cdp_submit_failed` | The composer accepted the text but the page did not submit it. |
| `chrome_cdp_lease_lost` | The recorded endpoint changed: Chrome was restarted or the toggle was turned off. |

The driver starts without Chrome: the MCP server comes up and `tools/list`
works, and every operation then refuses with the concrete reason above.

## What the driver reads

The current ChatGPT page has no `[data-message-author-role]` markup and no
`article` elements any more, and the conversation list endpoint answers
`total: 0` for this account. The driver therefore reads the DOM of the owned
page only:

- **Chats** — `a[href^="/c/"]` in the sidebar, with the title from
  `aria-label`.
- **Messages** — `[data-chatgpt-search-unit-key]` units; the role comes from
  `h4[data-conversation-role]`, the message id from
  `[data-chatgpt-selection-message-id]`, and the text from the message body.
- **Composer** — the visible `div[contenteditable="true"]`. ChatGPT keeps a
  hidden stale editor in front of the live one, so the focused element wins and
  the last visible one is the fallback.

Two consequences worth knowing:

- `updatedAt` is derived from the sidebar order, because the current sidebar
  exposes no per-chat timestamp. The order is the page's own recency order, so
  the timestamps are monotonic and correctly ordered, but they are not wall
  clock values of the individual chats.
- `export_chat` returns the messages of the chat that is open on the page. A
  chat that is only listed in the sidebar exports without messages.

## How a message is sent

1. The composer is focused and any text the page restored into it is removed.
   ChatGPT restores its own composer draft after a reload, and a stale draft
   must never ride along with the message.
2. The text is inserted with `Input.insertText`, with an in-page
   `execCommand('insertText')` fallback.
3. The page-native send control is clicked; the Enter key stays as the
   fallback.
4. The send is verified: the message has to appear in the page. ChatGPT can
   overwrite the composer between the insertion and the submit, so the driver
   repeats the send up to three times before it gives up.

`new_chat` is equally strict. The page-native *New chat* control only rewrites
the URL and leaves the previous conversation rendered, so the driver checks
that the conversation really is empty and loads a real empty conversation
otherwise. A message can therefore never land in a conversation the driver did
not create.

## Capabilities

The driver declares only what it can execute:

| Operation | Supported |
| --- | --- |
| `new_chat` | yes |
| `list_chats` | yes |
| `search_chat` | yes — titles plus the messages of the open chat |
| `export_chat` | yes — the open chat and the disposable fixture chat |
| `send_message` | yes |
| `edit_message` | no |
| `download_media` | no — the code path exists (the images of a conversation are fetched through the page), but it is not verified against a real image conversation yet |
| `research`, `search`, `draw` | no — this ChatGPT build exposes image generation as its own section and not as a composer control, so no page-native mode control is driven yet |

The MCP contract itself does not change: the ten operations, the opaque refs
and the `send_message` shape stay exactly as documented in
[the tool reference](TOOLS.md).

## Configuration

| Variable | Meaning |
| --- | --- |
| `CDP_CHAT_CHROME_PROFILE_DIR` | Chrome user-data-dir that owns the DevTools port. Defaults to the platform profile (`~/Library/Application Support/Google/Chrome` on macOS, `~/.config/google-chrome` on Linux). |
| `CDP_CHAT_CHROME_BROWSER_WS_URL` | Explicit browser WebSocket URL, bypassing `DevToolsActivePort` discovery. |
| `CDP_CHAT_CHROME_TARGET_ID` | Page target id to own when several ChatGPT pages are open. |
| `CDP_CHAT_CHROME_TIMEOUT_MS` | Per-operation deadline in ms (1,000 … 3,600,000). Defaults to 120,000. |

## Notes

- The driver performs no OS automation. If Chrome asks the user to confirm a
  remote-debugging connection, the operator answers it; the driver never
  clicks through an operating-system dialog.
- The driver owns the page it attaches to: `new_chat` and `send_message` can
  navigate that tab. Use a dedicated ChatGPT tab if the one you work in
  matters.
