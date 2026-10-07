# Roadmap

This roadmap follows the supplied Remote Agent Console campaign. “In progress” means code is being built in isolated task worktrees; nothing is marked complete until integrated and verified.

| Milestone | Scope | Status |
| --- | --- | --- |
| 0 | Monorepo foundation and verification gate | Complete |
| 1 | Deterministic fake ACP vertical slice | In progress — live-host browser E2E pending |
| 2 | Command Code ACP integration and observed compatibility | In progress — wrapper and initialize/session smoke done; prompt/permission compatibility pending |
| 3 | OpenCode ACP integration and observed compatibility | In progress — wrapper and initialize/session smoke done; prompt/permission compatibility pending |
| 4 | SQLite persistence, replay, idempotency, and host restart behavior | Not started |
| 5 | Pairing, device credentials, rate limits, and Tailscale Serve setup | Not started |
| 6 | Mobile PWA UX and real-device Windows/Android workflow | Not started |
| MVP gate | Twenty-step real-device acceptance evidence | Not started |
| Post-MVP | Reliability, polish, attachments, notifications, and multi-machine support | Deferred |

The fake slice proves our protocol and UI boundaries. It does not establish compatibility with Command Code or OpenCode and does not satisfy the real-device MVP gate.
