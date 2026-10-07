# Host API

`createHostApp` accepts allowlisted projects and a `RuntimeSupervisorPort`. The supervisor exposes the fake runtime plus Command Code and OpenCode when their CLIs are available. Runtime adapters receive an already allowlisted project ID and local path; ACP events, permissions, and cancellation are mapped through the shared host session port.

The development entry point listens on `127.0.0.1` only. Set `RAC_PROJECTS_JSON` to a JSON array of local allowlist records before starting it, for example:

```json
[{"id":"demo","displayName":"Demo project","path":"/home/me/project"}]
```

The configured paths must be absolute. API clients select these records by ID; the host never accepts a path from an API request or returns a path in a response. ACP processes launch with `shell: false`. The in-memory session/event/idempotency store is intentionally ephemeral for this vertical slice.

The host probes `command-code --version` and `opencode --version` without a
shell. Override executable selection with `RAC_COMMAND_CODE_EXECUTABLE` or
`RAC_OPENCODE_EXECUTABLE`; each value is used as the exact executable path.
Runtime catalog discovery does not send prompts.
