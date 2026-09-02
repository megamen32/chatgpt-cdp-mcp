# Architecture

```text
MCP client
  │ stdio
  ▼
ChatGPT CDP MCP
  ├─ tool schemas and limits
  ├─ opaque-reference map
  ├─ disposable-fixture boundary
  └─ page-lease validation
       │
       ▼
your CdpChatDriver
       │
       ▼
one authenticated browser page
```

The package intentionally has two layers:

1. **Public MCP core** — portable, testable TypeScript that owns tool inputs,
   opacity, bounded exports, media confinement, and write idempotency.
2. **Local driver** — your browser bridge. It owns browser authentication,
   concrete accessibility/DOM/CDP actions, and acquiring one page.

Keeping them separate lets users select their browser technology without
shipping account state in an npm package or Git repository.

The server invokes `identity()` before and after every operation. A changed
origin, account, page, or lease invalidates the action. This protects opaque
refs from being accidentally replayed against a different browser page.

The bundled BrowserClaw driver is one such local driver. On startup it reuses
the only ChatGPT tab accessible to its BrowserClaw session; when none is
accessible, it creates exactly one. It stores that page id in the process and
never calls `tabs:new` for an individual MCP tool invocation.
