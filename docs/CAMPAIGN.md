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

## Active scope: secure host and real-runtime MVP

The repository foundation and deterministic fake ACP vertical slice are complete. The fake agent exercises the host API and PWA:

```text
fake ACP child process -> host ACP client -> normalized events -> REST/SSE -> React PWA
```

Production static serving, pairing, durable storage, authenticated REST/SSE, and the installable PWA are implemented. The remaining MVP work is verifying Command Code and OpenCode prompt/permission behavior, hardening resource bounds, and completing an actual Windows plus Android acceptance run through private Tailscale Serve. Host-restart runtime reattachment also remains open for reliability.

## Deferred scope

Hosted relay, cloud execution, generic remote shell, native mobile apps, push notifications, and extra runtime adapters remain deferred until the real-device MVP gate passes.

## Development gate

`pnpm verify` is the canonical local gate for formatting, lint, type checking, and unit/contract tests. Run the production build and browser E2E for changes to the vertical slice.
