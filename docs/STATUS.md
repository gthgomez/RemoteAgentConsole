# Status

## Current milestone

Milestones 0 and 1 are complete. The deterministic fake ACP agent works through the host REST/SSE API and mobile PWA, including permissions, cancellation, process failure, reconnect, reload, and continued prompting. SQLite persists sessions, event replay, idempotency, and device auth state across host restarts. Device pairing and authenticated REST/SSE work in the PWA. Milestones 2 and 3 remain in progress: Command Code and OpenCode create sessions through the host, but real prompt/permission compatibility remains to be verified.

## Latest known-green commit

`dd3682b` — `fix(client): recover expired SSE event cursors`

`pnpm verify`, `pnpm build`, `pnpm --filter @remote-agent-console/web test:e2e` (10 tests), and `pnpm --filter @remote-agent-console/web test:pwa` passed on the integrated tree. All 44 host tests passed, including production static serving, SSE capacity/recovery, persistence retention, and authentication.

## What works today

- Strict TypeScript/pnpm monorepo with workspace verification, build, and development commands.
- Stable ACP v1 stdio client and deterministic fake ACP child.
- Host REST API with an explicit project allowlist, loopback-only binding, per-session event sequencing, SSE replay, and idempotent mutations.
- SQLite-backed host state persists projects, sessions, turns, normalized events, permissions, idempotency responses, pairing codes, and device credential hashes. Persisted event sequences continue after restart; active turns become failed and idle sessions disconnected because runtime process resumption is not implemented yet.
- `SQLiteHostStore` implements the device `AuthStore` boundary with atomic one-time pairing and device creation, hash-only credential persistence, last-seen updates, revocation, and expired-code cleanup.
- Normal host startup enables paired-device auth, prints a one-time code, protects APIs, and rate-limits pairing attempts, auth failures, and mutations. The PWA keeps credentials in IndexedDB and uses authenticated REST plus fetch-based SSE with `Last-Event-ID` replay.
- SSE streams are capped at 64 globally and 4 per device by default. SQLite retains up to 10,000 events per session, protecting active turns and pending permissions; expired cursors get an HTTP 410 with a recovery sequence that the client uses to replay retained history. Idempotency keys are retained for seven days by default. Configure with `RAC_EVENT_HISTORY_LIMIT` and `RAC_IDEMPOTENCY_RETENTION_MS`.
- Permission choices are the runtime's exact ACP options; duplicate permission events, stale pending permissions, and cross-session permission ID collisions are covered.
- Runtime process failure clears active turns and reports a sanitized visible failure.
- Mobile-first installable PWA with app-shell offline caching, device pairing, authenticated session creation/activity, tool cards, permission controls, cancellation, and reconnect/reload behavior.
- Playwright E2E covers pair/reload/invalid-code flows, authenticated SSE replay, session streaming, tool activity, permission response/cancel, completion, another prompt, reconnect, and runtime crash.
- Production host serves the built PWA app shell and static assets from `apps/web/dist` alongside the API, with SPA route fallback from one loopback service. API routes remain authenticated.
- Normal `pnpm dev` uses pairing and API authentication and prints a one-time pairing code. The unauthenticated `dev:test` entry point is reserved for Playwright E2E.
- The host runtime supervisor exposes the fake runtime plus Command Code and OpenCode. Both local binaries initialized ACP and created a session through the host without sending a model prompt. Observed results are in `docs/compatibility/`.

## What does not work yet

- Live Command Code/OpenCode prompt streaming, permission, cancellation, and session continuation are unverified.
- No runtime session reattachment/resume after host restart; persisted sessions are visible but disconnected, and prompts are never replayed.
- Production PWA serving requires `pnpm build` first; development still uses Vite and its API proxy.
- No real Windows laptop + Android phone acceptance run.

## Active branch

`feat/fake-acp-vertical-slice`

## Known blockers

- Real Windows laptop and Android phone are unavailable in this environment. Windows-specific discovery has unit coverage, but native executable behavior and real-device networking still need verification on the target devices.

## Next three tasks

1. Verify real Command Code/OpenCode prompts, permissions, cancellation, and continuation.
2. Implement host-restart runtime reattachment where supported and test runtime upgrade/recovery behavior.
3. Run private Tailscale access on the Windows laptop and Android phone and record acceptance evidence.

## Last real-device test

Not run. Browser E2E uses the integrated fake ACP runtime on Linux; `docs/runbooks/tailscale-serve.md` documents the private real-device check.

## Runtime compatibility

- Command Code 1.75.1: live ACP initialize/session creation confirmed; live prompt/permission behavior pending.
- OpenCode 2.0.24: live ACP initialize/session creation confirmed; live prompt/permission behavior pending.
