# Host API

`createHostApp` accepts allowlisted projects and a `RuntimeSupervisorPort`. The supervisor exposes the fake runtime plus Command Code and OpenCode when their CLIs are available. Runtime adapters receive an already allowlisted project ID and local path; ACP events, permissions, and cancellation are mapped through the shared host session port.

The development entry point listens on `127.0.0.1` only. Set `RAC_PROJECTS_JSON` to a JSON array of local allowlist records before starting it, for example:

```json
[{"id":"demo","displayName":"Demo project","path":"/home/me/project"}]
```

The configured paths must be absolute. API clients select these records by ID; the host never accepts a path from an API request or returns a path in a response. ACP processes launch with `shell: false`.

The host stores projects, session summaries, turns, normalized events, idempotency results, pending permissions, pairing records, and device records in SQLite. The default database path is `%LOCALAPPDATA%\\.remote-agent-console\\host.sqlite` on Windows and `~/.remote-agent-console/host.sqlite` elsewhere. Set `RAC_HOST_DATABASE_PATH` to choose another local file. Runtime child processes are not restored after a host restart: active turns are marked failed, idle sessions become disconnected, and prompts are never replayed automatically. Device credentials are stored only as SHA-256 hashes. Pairing and API authentication are enabled for both normal development and production; the server prints a one-time pairing code at startup.

Run `pnpm dev` for the authenticated development host and Vite PWA. Run `pnpm --filter @remote-agent-console/host dev:test` only for unauthenticated browser E2E tests. For a single production service, run `pnpm build` followed by `pnpm --filter @remote-agent-console/host start`; the host serves the PWA from `apps/web/dist` and the API on the same loopback origin. Set `RAC_WEB_DIST_PATH` only when the built assets are stored elsewhere.

The host probes `command-code --version` and `opencode --version` without a
shell. Override executable selection with `RAC_COMMAND_CODE_EXECUTABLE` or
`RAC_OPENCODE_EXECUTABLE`; each value is used as the exact executable path.
Runtime catalog discovery does not send prompts.
