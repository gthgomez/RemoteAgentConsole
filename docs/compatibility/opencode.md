# OpenCode compatibility

## Discovery

On 2026-10-07, local discovery found `/home/linuxuser/.npm-global/bin/opencode`. Running `opencode --version` returned `opencode v2.0.24`. The adapter's discovery probe runs the configured executable with `--version`, without a shell, and reports the parsed version when available.

## Adapter path

The runtime wrapper starts `opencode acp` with `shell: false`. It passes the allowlisted project directory as the child process working directory, and the shared ACP client sends that same absolute path in `session/new`. Runtime events, permissions, and cancellation use the existing stable ACP v1 adapter.

OpenCode's current ACP documentation describes `opencode acp` as an ACP v1 subprocess using newline-delimited JSON-RPC over stdin/stdout. It also documents the ACP session `cwd` as an absolute directory and describes permissions and cancellation. See the [OpenCode ACP protocol reference](https://opencode.ai/v2/docs/cli/acp/) and [OpenCode CLI reference](https://docs.opencode.ai/docs/cli/).

## Compatibility status

**Live ACP initialize and session creation confirmed; prompt behavior not verified.** On 2026-10-07, the adapter launched the installed `opencode v2.0.24` executable with `opencode acp`, initialized ACP, and completed `session/new` with cwd `/home/linuxuser/RemoteAgentConsole/.worktrees/opencode-adapter`. The session and connection returned the same `RuntimeCapabilities`:

```json
{
  "sessions": { "create": true, "resume": true, "list": true },
  "interaction": { "cancel": true, "permissions": true, "questions": false },
  "models": { "selectable": false, "effort": false },
  "modes": false,
  "plans": false,
  "commands": false,
  "images": true,
  "files": false
}
```

The smoke test closed the session immediately and sent no prompt, so it did not invoke a model or establish authentication, model availability, prompt streaming, or live permission behavior. The automated tests still use a fake executable forwarding to the deterministic ACP test agent; they verify process arguments, project cwd, stdio transport, and normalized text events.

The discovery summary intentionally advertises only capabilities currently exposed through the generic adapter path: session creation, cancellation, and permission requests. Live ACP additionally reported resume/list and image support; the current runtime-neutral session interface does not expose those features. Model selection, modes, commands, and files were not reported in this live capability response.
