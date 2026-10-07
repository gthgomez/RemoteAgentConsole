# Status

## Current milestone

Milestones 0 and 1 are complete. The deterministic fake ACP agent works through the host REST/SSE API and mobile PWA, including permissions, cancellation, process failure, reconnect, reload, and continued prompting. SQLite persists sessions, event replay, idempotency, and device auth state across host restarts. Device pairing and authenticated REST/SSE work in the PWA. Milestones 2 and 3 remain in progress: Command Code and OpenCode create sessions through the host, but real prompt/permission compatibility remains to be verified.

## Latest known-green commit

`3e2dbcb` — `feat(host): serve production PWA assets`

`pnpm verify`, `pnpm build`, and `pnpm --filter @remote-agent-console/web test:e2e` all passed after integration. The 35 host tests include production static serving and authentication; the static test also passed a default `apps/web/dist` process smoke test.

## What works today

- Strict TypeScript/pnpm monorepo with workspace verification, build, and development commands.
- Stable ACP v1 stdio client and deterministic fake ACP child.
- Host REST API with an explicit project allowlist, loopback-only binding, per-session event sequencing, SSE replay, and idempotent mutations.
- SQLite-backed host state persists projects, sessions, turns, normalized events, permissions, idempotency responses, pairing codes, and device credential hashes. Persisted event sequences continue after restart; active turns become failed and idle sessions disconnected because runtime process resumption is not implemented yet.
- `SQLiteHostStore` implements the device `AuthStore` boundary with atomic one-time pairing and device creation, hash-only credential persistence, last-seen updates, revocation, and expired-code cleanup.
- Normal host startup enables paired-device auth, prints a one-time code, protects APIs, and rate-limits pairing attempts, auth failures, and mutations. The PWA keeps credentials in IndexedDB and uses authenticated REST plus fetch-based SSE with `Last-Event-ID` replay.
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
- Authenticated SSE connection caps and SQLite data retention limits are being added after an independent review identified resource exhaustion risks.

## Active branch

`feat/fake-acp-vertical-slice`

## Known blockers

- Real Windows laptop and Android phone are unavailable in this environment. Windows-specific discovery has unit coverage, but native executable behavior and real-device networking still need verification on the target devices.

## Next three tasks

1. Finish and verify SSE connection and SQLite storage limits.
2. Verify real Command Code/OpenCode prompts, permissions, cancellation, and continuation; implement host-restart reattachment where supported.
3. Run private Tailscale access on the Windows laptop and Android phone and record acceptance evidence.

## Last real-device test

Not run. Browser E2E uses the integrated fake ACP runtime on Linux; `docs/runbooks/tailscale-serve.md` documents the private real-device check.

## Runtime compatibility

- Command Code 1.75.1: live ACP initialize/session creation confirmed; live prompt/permission behavior pending.
- OpenCode 2.0.24: live ACP initialize/session creation confirmed; live prompt/permission behavior pending.
