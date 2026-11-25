# Remote Agent Console

A local-first control plane for coding-agent sessions. The host runs agents on your computer; the mobile-first PWA controls them through the host API.

The next release uses a [pinned Happier composition](docs/decisions/maintained-controller.md) for the relay, daemon and phone interface. The commands below describe the legacy host and its development fixtures. See [the composition lock](distribution/composition-lock.json) for the selected source and upstream archives.

## Requirements

- Node.js 22 through 24
- pnpm 12.4.1 (the pinned package manager version)

## Development

Install dependencies first:

```sh
pnpm install
```

The host uses a deterministic fake ACP runtime by default and also detects Command Code and OpenCode when installed. It only starts sessions in explicitly allowlisted folders. Set `RAC_PROJECTS_JSON` before starting the services:

PowerShell:

```powershell
$env:RAC_PROJECTS_JSON = '[{"id":"demo","displayName":"Demo project","path":"C:\\code\\Demo"}]'
pnpm dev
```

Bash:

```sh
RAC_PROJECTS_JSON='[{"id":"demo","displayName":"Demo project","path":"/home/me/code/Demo"}]' pnpm dev
```

`pnpm dev` starts the authenticated host and Vite PWA. The host listens on `127.0.0.1:4318`; Vite serves the PWA and proxies `/api` to it. The host prints a one-time pairing code at startup; enter it in the PWA to pair the browser. Paired credentials stay in IndexedDB, and project paths stay on the host.

For browser E2E only, use `pnpm --filter @remote-agent-console/host dev:test` to start the isolated unauthenticated test host. Do not expose that test host to a network.

The production host serves the built PWA from the same loopback service after `pnpm build`; start it with `pnpm --filter @remote-agent-console/host start`. See [the host guide](apps/host/README.md) and [private Tailscale Serve runbook](docs/runbooks/tailscale-serve.md) for configuration and phone access.

## Run the built app from one host service

Build the PWA before starting the production host. The host serves `apps/web/dist` and its API from the same loopback origin:

```sh
pnpm build
RAC_PROJECTS_JSON='[{"id":"demo","displayName":"Demo project","path":"/home/me/code/Demo"}]' pnpm --filter @remote-agent-console/host start
```

On PowerShell:

```powershell
pnpm build
$env:RAC_PROJECTS_JSON = '[{"id":"demo","displayName":"Demo project","path":"C:\\code\\Demo"}]'
pnpm --filter @remote-agent-console/host start
```

Open `http://127.0.0.1:4318/` and pair the device with the one-time code printed by the host. API endpoints still require a paired device credential. `RAC_WEB_DIST_PATH` can point to a different built asset directory when needed; the default is `apps/web/dist` in this monorepo.

## Quality checks

```sh
pnpm verify
pnpm build
```

`pnpm verify` checks workspace configuration, formatting and lint rules, then runs package type checks and tests. `pnpm build` builds each workspace package that defines a build script.

## Architecture

See [docs/CAMPAIGN.md](docs/CAMPAIGN.md) for the active milestone, scope, and architectural invariants. The web client talks to the local host API; ACP protocol details stay in the host-side ACP client.

## Archive legacy history

Use Node 24 and a self-contained SQLite backup from a stopped or checkpointed legacy host. Choose an output directory accessible only to the local owner.

```sh
node tools/export-rac-history.mjs --source-copy backup.sqlite --output history.jsonl
```

The archive records the backup SHA-256 and counts for projects, sessions, chronological turns and events, and historical permission decisions. Device credentials, pairing state, pending permission rows and operation keys are excluded. Keep the archive as a local record during migration.
