# Host API

`createHostApp` accepts allowlisted projects and a `RuntimeSupervisorPort`. The port is the adapter seam for Task 4: `runtimes()` returns runtime-neutral capability summaries, `createSession()` receives an already allowlisted project ID and its local path, and the returned session port implements prompt, cancel, permission response, and normalized event delivery. ACP types and transport belong behind that adapter, not in this package.

The development entry point listens on `127.0.0.1` only and composes the fake ACP runtime through `packages/acp-client`. Set `RAC_PROJECTS_JSON` to a JSON array of local allowlist records before starting it, for example:

```json
[{"id":"demo","displayName":"Demo project","path":"/home/me/project"}]
```

The configured paths must be absolute. API clients select these records by ID; the host never accepts a path from an API request or returns a path in a response. ACP processes launch with `shell: false`. The in-memory session/event/idempotency store is intentionally ephemeral for this vertical slice.
