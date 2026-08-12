# Security model

This package narrows the blast radius of a browser integration; it does not
make browser automation risk-free.

## What the core enforces

- A browser identity contains origin, account, page, and lease coordinates.
- Every operation checks that identity before and after it acts.
- Driver IDs are never returned as MCP IDs.
- Existing conversations can be listed and searched but cannot be exported,
  messaged, edited, or used to download media.
- Those consequential operations require the one new fixture chat created by
  `new_chat`.
- Writes require a literal confirmation plus one-shot idempotency keys.
- Exports and downloads have deliberately small default limits.
- Download paths, MIME types, and file modes are constrained.

## What the driver must protect

- Browser credentials, cookies, profiles, and remote-debugging endpoints.
- Accurate page identity and a stable single-page lease.
- Fresh selector/a11y state before an action.
- Explicit handling of account or tab changes.

## Operational guidance

Run the server locally. Keep driver modules and media roots private. Use a
disposable fixture for development. Review driver changes like any code that
can control a signed-in browser.

This project is not an authorization bypass and does not grant access to a
ChatGPT account.
