# Remote Agent Console

## Mission

Build a local-first control plane for coding-agent sessions. The host runs agents on the user's machine; the mobile-first PWA controls them through the host API.

## Invariants

- Read `docs/STATUS.md`, the active section of `docs/CAMPAIGN.md`, and relevant ADRs before editing.
- Keep UI and domain code runtime-neutral. ACP protocol types stay in `packages/acp-client`.
- Use stable ACP v1. Start processes with `shell: false`; never make a remote shell endpoint.
- Projects are host-allowlisted. Remote requests use project IDs, never arbitrary paths.
- Runtime permission choices and capabilities are authoritative.
- Persist events before broadcast; support reconnect/replay; never automatically replay a prompt.
- Bind to loopback by default. Tailscale Serve is the intended private transport; never enable Funnel by default.
- Keep MVP scope aligned with `docs/CAMPAIGN.md` and the supplied architecture brief.

## Commands

- `pnpm dev` — local development.
- `pnpm verify` — formatting, lint, types, and tests.
- `pnpm build` — production build.

Update `docs/STATUS.md` with working behavior, failures, and next steps at handoff.
