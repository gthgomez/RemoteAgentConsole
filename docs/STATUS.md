# Status

## Current milestone

Milestones 0 and 1 are complete. The deterministic fake ACP agent works through the host REST/SSE API and mobile PWA, including permissions, cancellation, process failure, reconnect, reload, and continued prompting. Milestones 2 and 3 are in progress: runtime wrappers exist, and both installed CLIs passed ACP initialize/session creation without a prompt; full compatibility remains to be verified.

## Latest known-green commit

`7b9cc40` — `docs: update fake slice status and runtime smoke results`

The integrated code passed `pnpm verify`, `pnpm --filter @remote-agent-console/web test:e2e` (7 tests), and `pnpm build` immediately before this documentation commit.

## What works today

- Strict TypeScript/pnpm monorepo with workspace verification, build, and development commands.
- Stable ACP v1 stdio client and deterministic fake ACP child.
- Host REST API with an explicit project allowlist, loopback-only binding, per-session event sequencing, SSE replay, and idempotent mutations.
- Permission choices are the runtime's exact ACP options; duplicate permission events, stale pending permissions, and cross-session permission ID collisions are covered.
- Runtime process failure clears active turns and reports a visible failure.
- Mobile-first installable PWA with session creation/activity, tool cards, permission controls, cancellation, and reconnect/reload behavior.
- Live-host Playwright E2E covers streaming, tool activity, permission response/cancel, completion, reload, another prompt, and runtime crash.
- Command Code and OpenCode wrappers use the shared ACP client; both local binaries initialized ACP and created a session without sending a model prompt. Observed results are in `docs/compatibility/`.

## What does not work yet

- The host's default server composes the fake runtime only; Command Code and OpenCode are not yet selectable through the host.
- Live Command Code/OpenCode prompt streaming, permission, cancellation, and session continuation are unverified.
- No SQLite persistence or host-restart recovery; host session state is in memory.
- No pairing/authentication, device revocation, rate limits, or Tailscale Serve setup.
- Production host does not yet serve the compiled PWA assets.
- No real Windows laptop + Android phone acceptance run.

## Active branch

`feat/fake-acp-vertical-slice`

## Known blockers

- Real Windows laptop and Android phone are unavailable in this environment. Windows-specific discovery has unit coverage, but native executable behavior and real-device networking still need verification on the target devices.

## Next three tasks

1. Register Command Code and OpenCode adapters in the host supervisor; verify real prompts, streaming, permissions, cancellation, and continuation.
2. Add SQLite persistence, event replay across host restarts, and durable idempotency.
3. Implement device pairing/authentication and Tailscale Serve setup, then run the Android/Windows acceptance flow.

## Last real-device test

Not run. Browser E2E uses the integrated fake ACP runtime on Linux.

## Runtime compatibility

- Command Code 1.75.1: live ACP initialize/session creation confirmed; live prompt/permission behavior pending.
- OpenCode 2.0.24: live ACP initialize/session creation confirmed; live prompt/permission behavior pending.
