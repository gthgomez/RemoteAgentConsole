# Command Code ACP compatibility

The `@remote-agent-console/runtime-command-code` package wraps the shared ACP
process adapter. It starts the selected executable as `command-code acp` (or
`cmdc.exe acp` on native Windows), with `shell: false` and the selected project
as the child working directory. Project paths come from the host's explicit
allowlist.

## Executable discovery

An explicitly configured executable path takes precedence and is used only if
it names a regular executable file. Otherwise discovery searches `PATH`. On
Windows it checks `command-code.exe` and then `cmdc.exe`. It does not run `.cmd`,
`.bat`, or PowerShell shims because those require a shell. This means an npm
installation that exposes only `command-code.cmd` is not discovered
automatically; configure a native executable path or install a native build.

The official Windows documentation says the full `command-code` name works on
all platforms and documents `cmdc` as the native Windows short name. See the
[Windows installation guide](https://commandcode.ai/docs/windows) and the
[CLI quickstart](https://commandcode.ai/docs/quickstart).

## Local evidence

Checked on 2026-10-07 in the development environment:

- `command -v command-code` resolved to
  `/home/linuxuser/.npm-global/bin/command-code`.
- `command-code --version` reported `1.75.1`.
- `command-code acp --help` succeeded and described the stdio ACP mode.
- `command-code status` reported `authenticated`.
- A live smoke through `createCommandCodeAdapter` initialized ACP, created a
  session with the repository as `cwd`, and closed it without sending a prompt.
  The adapter returned these session capabilities:

  ```json
  {
    "sessions": { "create": true, "resume": true, "list": true },
    "interaction": { "cancel": true, "permissions": true, "questions": false },
    "models": { "selectable": false, "effort": false },
    "modes": true,
    "plans": false,
    "commands": false,
    "images": true,
    "files": false
  }
  ```

This confirms local installation, version, ACP command availability, and
authentication status, as well as ACP initialization and session creation for
this local version. No prompt was sent, so model response behavior and streamed
updates remain unverified. Command Code requires an account login or API key
before authenticated use; see the
[official quickstart](https://commandcode.ai/docs/quickstart).
