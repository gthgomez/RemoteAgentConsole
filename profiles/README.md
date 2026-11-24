# Production profiles

The selected controller is Happier at the exact source commit recorded in
`distribution/composition-lock.json`. **The production allowlist is empty until
the corresponding native path and all dependent qualification criteria pass.**

| Profile | Maintained/native path | Current state |
| --- | --- | --- |
| Command Code | Happier maintained ACP backend | Disabled pending adapter, policy and end-to-end qualification |
| OpenCode | Happier native V2 backend | Disabled pending native contract, policy and end-to-end qualification |
| Codex | Happier app-server backend | Disabled pending native contract, policy and end-to-end qualification |
| Babel | Scoped Babel native gateway with a thin Happier ACP bridge | Disabled pending gateway implementation and qualification |

The fixture fake is available only in isolated tests. Each enabled profile
requires a fixed launch definition, project-scoped operations, and current
qualification evidence.

The restricted relay configuration requires `HAPPIER_RAC_PUBLIC_ORIGIN` with
one exact HTTPS origin, for example `https://relay.example.invalid`. The relay
listens on `127.0.0.1`. HTTP and Socket.IO use the same Host and Origin rules
for the configured origin and the native client on the loopback address.
The private Tailscale Serve path still requires validation on Windows.

The earlier RAC host, PWA, fake runtime, and custom remote-control path remain
available for legacy source review and migration tests.

The pinned Windows Happier CLI and server archives in the composition lock are
upstream reference artifacts for compatibility comparison. The server archive
embeds its web UI. The standalone UI archive identifies its separate source
commit in the composition lock.

`node distribution/build-composition.mjs verify --artifact-dir <verified-cache>` verifies these inputs.
`stage` creates an independent, disposable full-history checkout and applies
the declared ordered patch series. Both commands label their output as scaffold
evidence. Production packaging stays disabled until the integrated candidate
is qualified.

`build-reference` is an explicit opt-in for source-only upstream component
builds. It installs the frozen lockfile inside the new disposable checkout,
then builds the maintained CLI, stack launcher, and web export and runs the
server typecheck. Pass `--yarn-bin` and `--bun-bin` when using pinned tool
executables outside `PATH`.
