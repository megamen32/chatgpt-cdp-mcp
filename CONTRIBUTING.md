# Contributing

Thanks for improving ChatGPT CDP MCP.

## Local loop

```bash
npm ci
npm test
```

Keep browser implementations behind `CdpChatDriver`. Tests must use a fake page or mock driver; do not add account profiles, cookies, captured chats, or browser leases to the repository.

## Pull requests

1. Keep a change narrowly scoped to the MCP contract, adapter seam, or documentation.
2. Add a regression test for behavior changes.
3. Run `npm test`.
4. Describe the user-visible change and the driver assumptions.

Do not claim a browser capability in documentation unless a concrete driver and test prove it.
