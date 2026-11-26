# Codex-only Windows integration checkpoint

This is an inactive diagnostic. It starts the **installed** native Codex
app-server through the Windows job/pipe owner and calls it through Happier's
maintained client, not a second JSON-RPC client or remote controller. It never
starts the relay or opens a listener. The diagnostic uses a new empty Codex home
and a new disposable Git repository. It does not use the user's login or start
a model turn. An unsigned diagnostic package is not the product installer.

## Candidate and launch paths

Apply `0009`, `0010` and `0011` in order to the five-patch Happier tree
`c62fcb80464a0b7161efb4c09bdcbd8d9506bea4` in disposable source. The active
series, profile allowlist, locks and upstream source pin are unchanged.

| Pinned Happier path | Diagnostic disposition |
| --- | --- |
| `appServer/runtime.ts` `ensureClient` and its `params.createClient` seam | Preserve the existing generation/correlation owner. The diagnostic invokes the maintained client directly. No installed `runCodex` or `runtime.ts` integration is claimed. |
| `appServer/nativeFork.ts`, `appServer/bootstrapCodexTuiHome.ts`, `appServer/client/withCodexAppServerClient.ts` | The default factory refuses restricted use without an owner. A supplied native-fork factory would need separately proven custody for that operation. |
| Direct-session transcript and list, session/control helpers, daemon proxy transport | Route through the same client or `withCodexAppServerClient`; unowned `stdio`, daemon proxy and Unix WebSocket are refused at the factory. |
| `appServer/createCodexSharedAppServer.ts` | Shared daemon startup resolves via `resolveCodexCliInvocation`; that resolver refuses restricted invocations before resolution or startup. No shared app-server is required or allowed by this diagnostic. |
| Version probe in `utils/withCodexNativeStartupLock.ts` | The default path reaches it only after invocation resolution. The native version execution is Linux-only with `CODEX_SQLITE_HOME`; the Windows owner path never calls it. |
| `executionRuns/probeCodexAppServerExecutionRunAvailability.ts`, `executionRuns/executionRunBackendFactory.ts` | The `app-server --help` probe directly uses `spawnSync`, so it has its own refusal. The surrounding factory also refuses before an unavailable probe can select ACP or MCP instead. |
| TUI, provider attach, ACP/MCP capability probes and other non-app-server Codex paths | Not part of this diagnostic. Some use separate provider executors. Revalidate their reachability under the installed admission policy; the app-server checks are not a general executable lockdown. |

The launch handoff uses fixed `app-server --listen stdio://` arguments with
nonessential native plugins disabled. The helper owns newline framing and a
bounded enqueue-to-write deadline. The maintained client still owns RPC IDs,
handler correlation, `AbortError`, per-method response deadlines and deliberate
open-ended provider waits. A request that expires or aborts before the owner
write is refused at queue admission. Once submitted, an error is not proof of
non-delivery. This diagnostic never replays a request.

Child stderr is discarded in the native helper; only fixed status letters and
bounded counters return to the diagnostic parent on a separate control stream.
The root, job and native I/O results are recorded separately from provider
outcomes. A forced carrier kill or missing settlement record is not proof of
native settlement.

The diagnostic reuses the Windows policy reader's fixed-volume,
handle-relative path walk and retains the project and executable directory
chains for the native job's lifetime. It hashes an open, non-reparse image.
The witness checks that a disposable project can be renamed before and after
ownership, but not while it is serving. This is not an enrolled policy, a proof
of custody over every file below the root, or a qualified Windows loader.

## Run locally without a listener

On Windows x64, build the owner into a disposable artifacts directory with the
local .NET SDK:

```powershell
dotnet build native/windows-launch/src/RemoteAgentConsole.CodexDiagnosticOwner/RemoteAgentConsole.CodexDiagnosticOwner.csproj `
  -c Release --artifacts-path <absolute-owned-build-output> -m:1
```

Run `run-diagnostic.mjs` with Node `24.22.1` and these absolute arguments in
order: trusted Git executable, Happier Git directory, five-patch object store,
verified Zod ESM entry point, built diagnostic owner executable, installed Codex
executable, and a trusted disposable scratch parent. The witness reconstructs
the selected dependency fragment from exact Git objects. Out-of-lane imports
are fail-on-use stubs; this is **not** a whole Happier dependency/build test.
Output is a redacted JSON receipt with no prompts, credentials or session IDs.

The native helper currently admits only Codex Windows x64 `0.172.0`,
SHA-256 `3f42b12274b353ecb3ec555e6c8d0a43f6c6cb29c3a546179bc12dee4855deb6`.
This is a new identity, not inherited qualification from `0.171.0`. The
earlier fixture and baseline for `0.171.0` have not been modified.

The diagnostic MSIX draft is built by
[`New-CodexDiagnosticPackage.ps1`](../../distribution/windows/New-CodexDiagnosticPackage.ps1)
against that build with Windows SDK MakeAppx. It records every file's digest
and checks the unpacked bytes. This draft has no stub product, relay,
credentials or deployable profile and is not signed or installed. It still
uses the host .NET runtime. Do not install it, widen Windows trust, or point
Tailscale Serve at the diagnostic.

## Gate to authenticated and remote operation

The product must first bind the `runtime.ts` factory to the protected Windows
launcher and retained enrolled-root identity, without the diagnostic inputs.
Do not substitute the unsigned helper, environment flags, or a caller-supplied
root/argv for that boundary. The authenticated diagnostic must use the existing
owner-approved Codex login without copying credential files, exposing account
data or accepting arbitrary user config/launcher inputs as remote authority.

Production still needs owner-only IPC and startup/restore with the existing
`0006` grant lifecycle, an effect-time fence for typed approvals and uploads,
and an exact reviewed Codex-only installer from the pinned relay, web and CLI.
The separate inactive `0012` draft disables the known server-routed machine
transfer lane and prompt-asset transfer registration in restricted mode.
`transfer-admission.test.mjs` tests those two call sites against exact staged
source (`RAC_TRANSFER_WITNESS_HAPPIER_ROOT`); it does not cover all upload
surfaces or prove effect-time fencing for any enabled transfer.
Live prompts, approvals, continuation and cancellation are separate tests;
none is inferred from an idle thread. The installed S25 Ultra Chrome PWA
cellular journey is the final acceptance gate. All profiles remain disabled.
