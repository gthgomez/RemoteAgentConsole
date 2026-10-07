# Host API

`createHostApp` accepts allowlisted projects and a `RuntimeSupervisorPort`. The port is the adapter seam for Task 4: `runtimes()` returns runtime-neutral capability summaries, `createSession()` receives an already allowlisted project ID and its local path, and the returned session port implements prompt, cancel, permission response, and normalized event delivery. ACP types and transport belong behind that adapter, not in this package.

The default development entry point listens on `127.0.0.1` only. It has an empty project/runtime catalog until a local supervisor is wired in. The in-memory store is intentionally ephemeral for this vertical slice.
