# Remote Agent Console

A local-first control plane for coding-agent sessions. The host runs agents on your computer; the mobile-first PWA controls them through the host API.

## Requirements

- Node.js 22 through 24
- pnpm 12.4.1 (the pinned package manager version)

## Development

Install dependencies first:

```sh
pnpm install
```

The current development host uses a deterministic fake ACP runtime. It only starts sessions in explicitly allowlisted folders. Set `RAC_PROJECTS_JSON` before starting the services:

PowerShell:

```powershell
$env:RAC_PROJECTS_JSON = '[{"id":"demo","displayName":"Demo project","path":"C:\\code\\Demo"}]'
pnpm dev
```

Bash:

```sh
RAC_PROJECTS_JSON='[{"id":"demo","displayName":"Demo project","path":"/home/me/code/Demo"}]' pnpm dev
```

The host listens on `127.0.0.1:4318`; Vite serves the PWA and proxies `/api` to the host. The project path stays on the host and is never returned by the API.

Normal `pnpm dev` uses the SQLite-backed device pairing and API authentication just like production, and prints a one-time pairing code at host startup. Enter that code in the PWA to pair the browser. `pnpm --filter @remote-agent-console/host dev:test` disables pairing only for the Playwright E2E host; do not use it for normal development or remote access.

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
