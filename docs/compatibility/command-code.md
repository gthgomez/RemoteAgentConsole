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

This confirms local installation, version, ACP command availability, and
authentication status. No real ACP initialization or prompt was run during
this check, so it does not establish end-to-end compatibility with this local
version. Command Code requires an account login or API key before authenticated
use; see the [official quickstart](https://commandcode.ai/docs/quickstart).
