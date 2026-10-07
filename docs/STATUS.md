# Status

## Current milestone

Milestones 0 and 1 are complete. The deterministic fake ACP agent works through the host REST/SSE API and mobile PWA, including permissions, cancellation, process failure, reconnect, reload, and continued prompting. Milestones 2 and 3 are in progress: the host can select Command Code and OpenCode adapters, and both installed CLIs passed ACP initialize/session creation without a prompt; full prompt/permission compatibility remains to be verified.

## Latest known-green commit

`44d506d` — `chore: sync host runtime workspace links`

The integrated code passed `pnpm verify`, `pnpm --filter @remote-agent-console/web test:e2e` (7 tests), and `pnpm build`. The ACP crash E2E expectation was updated for sanitized errors and passed after that verification run.

## What works today

- Strict TypeScript/pnpm monorepo with workspace verification, build, and development commands.
- Stable ACP v1 stdio client and deterministic fake ACP child.
- Host REST API with an explicit project allowlist, loopback-only binding, per-session event sequencing, SSE replay, and idempotent mutations.
- SQLite-backed host state persists projects, sessions, turns, normalized events, permissions, idempotency responses, pairing codes, and device credential hashes. Persisted event sequences continue after restart; active turns become failed and idle sessions disconnected because runtime process resumption is not implemented yet.
- Production host routes use `SQLiteHostStore` and device authentication, with atomic one-time pairing consumption, hash-only credential persistence, last-seen updates, and revocation.
- Permission choices are the runtime's exact ACP options; duplicate permission events, stale pending permissions, and cross-session permission ID collisions are covered.
- Runtime process failure clears active turns and reports a sanitized visible failure.
- Mobile-first installable PWA with session creation/activity, tool cards, permission controls, cancellation, and reconnect/reload behavior.
- Production host serves the built PWA app shell and static assets from `apps/web/dist` alongside the API, with SPA route fallback and a single loopback service.
- Normal `pnpm dev` uses SQLite-backed pairing and API authentication and prints a one-time pairing code. The unauthenticated `dev:test` entrypoint is reserved for Playwright E2E.
- Live-host Playwright E2E covers streaming, tool activity, permission response/cancel, completion, reload, another prompt, and runtime crash.
- The host runtime supervisor exposes the fake runtime plus Command Code and OpenCode. Both local binaries initialized ACP and created a session through the host without sending a model prompt. Observed results are in `docs/compatibility/`.

## What does not work yet

- Live Command Code/OpenCode prompt streaming, permission, cancellation, and session continuation are unverified.
- No runtime session reattachment/resume after host restart; persisted sessions are visible but disconnected, and prompts are never replayed.
- Production PWA serving requires `pnpm build` first; development still uses Vite and its API proxy.
- No real Windows laptop + Android phone acceptance run.
- No real Windows laptop + Android phone acceptance run.

## Active branch

`feat/fake-acp-vertical-slice`

## Known blockers

- Real Windows laptop and Android phone are unavailable in this environment. Windows-specific discovery has unit coverage, but native executable behavior and real-device networking still need verification on the target devices.

## Next three tasks

1. Verify real Command Code/OpenCode prompts, permissions, cancellation, and continuation.
2. Implement runtime session reattachment where supported and complete host-restart continuation behavior.
3. Run production `pnpm build` + host startup through Tailscale on Windows and Android.

## Last real-device test

Not run. Browser E2E uses the integrated fake ACP runtime on Linux.

## Runtime compatibility

- Command Code 1.75.1: live ACP initialize/session creation confirmed; live prompt/permission behavior pending.
- OpenCode 2.0.24: live ACP initialize/session creation confirmed; live prompt/permission behavior pending.
