# Remote Agent Console Campaign

This repository implements the architecture brief supplied by the product owner on 2026-10-07. The full brief is the source of truth in the conversation; this file records the active campaign and its invariants.

## Mission

Control coding-agent sessions running on the user's own computer from an installable, mobile-first PWA. Source code and agent processes stay local. The phone is a control surface, not a terminal or IDE.

## Architecture invariants

- The web client calls our host API; it never talks to a runtime or ACP directly.
- Use stable ACP v1 where it provides the required behavior. Keep ACP types inside `packages/acp-client`.
- Keep the host domain model runtime-neutral and expose runtime capabilities as data.
- The host launches processes without a shell and never accepts arbitrary project paths from remote clients.
- Runtime permission semantics remain authoritative. Never synthesize permission options or silently enable a bypass mode.
- Persist runtime events before broadcasting them. Use REST for commands and replayable SSE for host events.
- Enforce one active turn per session and idempotency for mutation requests.
- Bind to loopback by default. No generic remote shell, cloud relay, or Tailscale Funnel in the MVP.
- Do not resend a prompt automatically after process failure or reconnect.

## Active scope: foundation and fake ACP vertical slice

The first deliverable establishes the pnpm/TypeScript monorepo and a deterministic end-to-end slice:

```text
fake ACP child process -> host ACP client -> normalized events -> REST/SSE -> React PWA
```

The fake agent must stream text, emit a tool activity update, request a permission with runtime-provided options, continue after a response, complete, and cancel. The browser must create a session, submit a prompt, follow events, respond to permission, see completion, and return to the same session after reload. No real Command Code/OpenCode integration is in this milestone.

## Deferred scope

Real runtime adapters, SQLite durability, device pairing, Tailscale setup, full mobile polish, and real-device acceptance follow the milestones in the original architecture brief. They are not implied complete by the fake slice.

## Development gate

`pnpm verify` is the canonical local gate for formatting, lint, type checking, and unit/contract tests. Run the production build and browser E2E for changes to the vertical slice.
