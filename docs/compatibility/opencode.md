# OpenCode compatibility

## Discovery

On 2026-10-07, local discovery found `/home/linuxuser/.npm-global/bin/opencode`. Running `opencode --version` returned `opencode v2.0.24`. The adapter's discovery probe runs the configured executable with `--version`, without a shell, and reports the parsed version when available.

## Adapter path

The runtime wrapper starts `opencode acp` with `shell: false`. It passes the allowlisted project directory as the child process working directory, and the shared ACP client sends that same absolute path in `session/new`. Runtime events, permissions, and cancellation use the existing stable ACP v1 adapter.

OpenCode's current ACP documentation describes `opencode acp` as an ACP v1 subprocess using newline-delimited JSON-RPC over stdin/stdout. It also documents the ACP session `cwd` as an absolute directory and describes permissions and cancellation. See the [OpenCode ACP protocol reference](https://opencode.ai/v2/docs/cli/acp/) and [OpenCode CLI reference](https://docs.opencode.ai/docs/cli/).

## Compatibility status

**Discovery confirmed; live runtime compatibility not yet verified.** The installed executable was version-checked, but `opencode acp` was not launched for an initialize/session/prompt workflow in this environment. The adapter's automated tests use a fake executable that forwards to the deterministic ACP test agent; they verify process arguments, project cwd, stdio transport, and normalized text events. They do not establish OpenCode's live runtime behavior, authentication, model availability, or permission semantics on this machine.

The discovery summary advertises only capabilities available through this generic adapter path: session creation, cancellation, and permission requests. Session resume/list, model selection, modes, commands, images, and files remain unexposed by the current runtime-neutral session interface even where OpenCode ACP itself supports related protocol features.
