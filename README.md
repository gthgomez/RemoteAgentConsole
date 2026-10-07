# Remote Agent Console

A local-first control plane for coding-agent sessions. The host runs agents on your computer; the mobile-first PWA controls them through the host API.

## Requirements

- Node.js 22 through 24
- pnpm 12.4.1 (the pinned package manager version)

## Development

```sh
pnpm install
pnpm dev
```

## Quality checks

```sh
pnpm verify
pnpm build
```

`pnpm verify` checks workspace configuration, formatting and lint rules, then runs package type checks and tests. `pnpm build` builds each workspace package that defines a build script.

## Architecture

See [docs/CAMPAIGN.md](docs/CAMPAIGN.md) for the active milestone, scope, and architectural invariants. The web client talks to the local host API; ACP protocol details stay in the host-side ACP client.
