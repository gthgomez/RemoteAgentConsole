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

## Quality checks

```sh
pnpm verify
pnpm build
```

`pnpm verify` checks workspace configuration, formatting and lint rules, then runs package type checks and tests. `pnpm build` builds each workspace package that defines a build script.

## Architecture

See [docs/CAMPAIGN.md](docs/CAMPAIGN.md) for the active milestone, scope, and architectural invariants. The web client talks to the local host API; ACP protocol details stay in the host-side ACP client.
