# Windows launch ownership (first slice)

Owner-only process ownership for the Remote Agent Console / Happier Windows
composition. This is a **native library component plus a conformance runner and
synthetic environment/stdin-stdout-stderr probes**, not an installed product. Nothing in
`apps/` or `packages/` references it, and no maintained Codex app-server is installed or
bound, so it is not production reachable yet.

## What it does

`WindowsProcessOwner.Launch` takes an owner-supplied, already-qualified contract:

- one absolute `.exe` path, passed as `lpApplicationName` (never resolved through
  `PATH`, never extension-appended, never parsed from a command string);
- one fixed argument vector, serialized with the standard Windows quoting rules;
- one absolute working directory;
- one **required, frozen environment policy**. The library never reads, merges or
  expands the parent environment; the child receives exactly the supplied block.

The launch sequence is fixed and ordered:

1. create a private Job Object and set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`;
2. query the job back and refuse to continue unless kill-on-close is set and both
   breakaway flags are clear;
3. build a `STARTUPINFOEX` attribute list containing
   `PROC_THREAD_ATTRIBUTE_JOB_LIST` for that job; when stdio pipes are opted in, also
   add `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` with exactly the three child pipe handles;
4. `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
   CREATE_UNICODE_ENVIRONMENT | CREATE_DETACHED_PROCESS`, the explicit Unicode
   environment block, and no shell or breakaway. `bInheritHandles` is false for the
   default no-stdio path and true only with the explicit handle list for pipes;
5. verify membership with `IsProcessInJob` while the process is still suspended;
6. resume only when `ResumeThread` reports an observed previous suspension count of
   exactly 1. Observed 0 is reported as possibly externally resumed/runnable, positive
   counts above 1 as still suspended after one decrement, and injected values are marked
   simulated rather than observed;
7. return `OwnedProcess`, which holds only the exact process and job handles.

The process is assigned to the job by the kernel at creation time. There is **no
post-create `AssignProcessToJobObject`** and no unsandboxed fallback. If the attribute
API is unavailable or rejects the job list, launch fails before any process exists with
`LaunchFailureException.Unsupported = true` and `Stage = CreateJobAssignment`. The
qualification suite's `creation-time-assignment-failure` case injects that failure at
the attribute boundary; it does **not** prove that a real host rejects the OS attribute,
which remains an OS-dependent path the lead must run on the target host.

Optional stdio custody is a typed library API: `ChildStdioMode.Pipes` creates one
anonymous stdin/stdout/stderr pipe set, and `ChildStdioMode.CancelablePipes` creates one
private named-pipe set with overlapped parent ends. In both modes the child ends are
inheritable only for the bounded create window, parent ends are never inheritable, and
stdout/stderr remain distinct. Stdio-enabled launches serialize inside the owner process;
the component must run in a dedicated owner launcher, and unrelated inherit-all spawns
must not run concurrently. There is no inherit-all fallback.

Graceful pipe shutdown is: close/dispose the parent `StandardInput` to deliver EOF, wait
for the child to exit and the job to settle, then dispose `OwnedProcess` (and its
streams). Calling `OwnedProcess.Dispose` alone is forced cleanup: it closes the job and
applies kill-on-close rather than requesting a graceful shutdown.

### Cancelable overlapped stdio (opt-in)

`ChildStdioMode.CancelablePipes` adds a second, opt-in custody mode. `None` and `Pipes`
keep their existing behavior; nothing about the default launch changes.

Mechanism:

- Three private local **named-pipe pairs**. The parent end is opened with
  `FILE_FLAG_OVERLAPPED`; the child end is a normal **synchronous**, inheritable client
  handle passed through the same explicit `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. The child
  performs ordinary blocking pipe I/O. The mode is qualified for **64-bit Windows only**
  and fails closed before creation otherwise.
- Endpoint custody: a fresh unpredictable GUID name, `FILE_FLAG_FIRST_PIPE_INSTANCE`, a
  protected DACL that grants only the current process user (`D:P(A;;GA;;;<sid>)`), exactly
  one instance, `PIPE_REJECT_REMOTE_CLIENTS`, and the parent opens the **only** client
  handle itself before the child exists. Before handoff the controlled process verifies
  `GetNamedPipeInfo` server/client end roles on both handles and requires
  `GetNamedPipeClientProcessId` and `GetNamedPipeServerProcessId` to report the current
  process from both the server and client handle views; a GUID, DACL or role string alone
  is not accepted as peer proof. No other local
  or remote client can attach, and there is no reconnectable public endpoint. Any failure
  closes everything and fails the launch; there is no anonymous-pipe or inherit-all
  fallback.
- Because the only client is already open, `ConnectNamedPipe` observes
  `ERROR_PIPE_CONNECTED` without submitting I/O. If the OS still reports a pending
  connect, the exact operation is cancelled, harvested, or retained (never freed) and the
  launch fails closed. The sentinel probe makes an unrelated file handle inheritable and
  resolves the child's handle path (`GetFinalPathNameByHandleW`), so an inherited sentinel
  is detected by object identity rather than a colliding numeric handle; DACL and
  remote-client rejection are construction properties, not runtime observations.
- Each direction has **at most one bounded operation in flight** plus a 4 KiB pipe
  buffer. A second send reports `Backpressure` and is not queued. Every write has a stable
  operation identity, one authoritative observer and one stored completion result; a
  concurrent observer is refused before any wait or effect.
- Completion is observed natively with `GetOverlappedResult` on the exact `OVERLAPPED`;
  cancellation calls `CancelIoEx` with that same pointer and the completion event remains
  authoritative. A cancel that races a completion is harvested with its real byte count;
  a zero-byte successful pipe read is EOF, never a `Completed/0` result, and data read
  before a stop is retained as already-read data.
- Stop is a **gate before effect**: the stop flag, the read submit and the write submit
  share their channel gates, so no later send or read issues a native operation. The
  receipt's `StopGateClosed` is gate state only; the fixture separately asserts rejection
  and no new native submission.
- A caller timeout never cancels, closes or frees a running operation. A cancel that does
  not settle within the bound is classified `UnknownPending`, and its unmanaged buffer,
  `OVERLAPPED` and event are retained for process lifetime rather than freed while the
  kernel may still write into them.
- Every submitted operation is freed only after a **positively observed** completion.
  `PendingOverlappedIo` records submission and completion separately; handle closure,
  `ERROR_IO_INCOMPLETE`, `ERROR_INVALID_HANDLE` and an unobserved cancellation all retain
  the allocation. Closing a handle is never used as proof of completion.
- Cancelable stdio is a **single-owner process mode**. One lease is acquired atomically
  before any pipe exists; a retained operation keeps that lease until process recycle, so
  a second owner cannot multiply the retained set. The owner has at most three channel
  operations; `MaximumRetained = 8` is a defensive process bound, not a claim of a hard
  per-launch cap. `InheritanceWindow` still serializes only the create window; the owner
  lease is what excludes active owners.
- Delivery is tri-state. A cancelled, faulted or still-pending write reports
  `StdioDelivery.Unknown` because partial delivery cannot be ruled out; only an observed
  positive byte count reports `Delivered`, and only a pre-submission refusal or a
  zero-byte successful request reports `None`.

Typed evidence: `StdioSendResult`, `StdioReadResult`, `StdioEofResult`,
`StdioShutdownReceipt` and `StdioStreamCounters` distinguish native read/write completion,
end-of-stream/broken pipe, cancellation, caller timeout, backpressure, rejection, fault
and unknown/in-flight. They never infer a provider or agent turn outcome.

`CancelableChildStdio.CloseInput` is idempotent: it stops new sends, settles or cancels the
in-flight write, then closes the parent write handle to deliver EOF.
`CancelableChildStdio.Shutdown` is idempotent and concurrency-safe: it signals both read
stops first (so pending reads are cancelled promptly and independently of input
settlement), then executes a finite teardown and shares one receipt with concurrent
callers. A shutdown whose budget expires before an operation settles returns
`Complete = false` with `UnknownPending` rather than fabricating settlement.
`StdioEofResult`/`StdioShutdownReceipt` report both the pending write and the **last
observed write** status/error/delivery, so a concurrent observer that harvested a
cancelled or partial write before `CloseInput` cannot turn its history into
`NotInFlight`/`None`. The pending fields describe the operation in flight when close
began; the last-write fields describe previously observed history. Neither attests
delivery beyond the explicit `StdioDelivery` value.

Public calls are admitted at entry; a call after disposal starts is refused before any
effect. `Dispose` signals channel stop without disposing shared wait handles, then waits a
bounded interval for admitted callers. Channels and facade events are disposed only after
the admitted count reaches zero, by exactly one finalizer (disposal or the last exiting
caller); no signaler can race event closure. The channel's read `Dispose` never closes the
handle while the pump is alive; the pump owns the handle and closes it on exit after
harvesting or retaining the pending operation. A gated qualification seam pauses a read
pump after a possible submit so this teardown window is exercised deterministically (it is
a test delay, not a simulated cancellation failure). `Dispose` is forced cleanup and
retains anything it cannot settle safely; a forced-close receipt never claims EOF or
settlement. It may return while a deferred pump still owns a handle and the owner lease,
and it attests no channel, root or job settlement. Cleanup steps are attempted
unconditionally so an earlier stream failure cannot skip exact job/process closure or the
inheritance-window release; a cleanup exception is never treated as evidence of exit.

`OwnedProcess.KillAndSettle` terminates the exact root handle, terminates the job,
and waits within a bound for job accounting to reach zero. `Dispose` closes the job, so
kill-on-close terminates anything still owned. No code path looks up a process by ID or
image name, enumerates processes, or signals a process outside the job.

`OwnedProcess.Dispose` and the launcher's custody `finally` attempt every cleanup step
even when an earlier stream cleanup throws: exact job/process handle closure and the
inheritance-window release are not skipped. A cleanup exception is never treated as
evidence of exit, and cancelable `Dispose` may still return with a deferred pump handle
and the owner lease held.

## Contract boundaries

| Surface | This slice |
| --- | --- |
| Executable | owner-qualified absolute `.exe` only |
| Arguments | owner-qualified fixed argv only |
| Environment | required explicit frozen block; no ambient read, merge or expansion |
| Stdio | optional typed stdin/stdout/stderr custody; default none; `Pipes` keeps synchronous anonymous pipes; opt-in `CancelablePipes` adds overlapped parent ends over private local named pipes with explicit `HANDLE_LIST`, non-inheritable parent ends, distinct stderr; library-only with no host/Codex binding |
| Console | no console/window is allocated for the root |
| Containment | creation-time private job, kill-on-close, no breakaway |
| Resume | observed previous suspension count must be exactly 1; observed 0 is unknown/externally runnable, injected values are simulated |
| Network | none; no listener, client, socket or RPC surface |
| Persistence | none; no registry, service, task or installer writes |
| Cleanup | exact handles only; bounded waits; confirmed exit separated from AccessDenied suggestions |
| Fallback | none; unsupported creation-time assignment fails closed |

Child processes created by the qualified executable inherit job membership. If a
child allocates a console, its console host is also contained and terminated with the
job; the peer fixture verifies that an unrelated same-image process outside the job is
neither a member nor affected.

The caller owns the environment policy. The library does not inject credentials and
cannot detect them; the policy must contain only approved values (for example
`SystemRoot` and a private temporary directory) and must omit live credentials. The
conformance probe proves that an ambient sentinel, `PATH` and `USERPROFILE` are not
propagated.

## Layout

```text
native/windows-launch/
  Directory.Build.props
  src/RemoteAgentConsole.WindowsLaunch/                    # net8.0-windows class library
  tests/RemoteAgentConsole.WindowsLaunch.Tests/            # console conformance runner
  tests/RemoteAgentConsole.WindowsLaunch.EnvironmentProbe/ # synthetic child env probe
  tests/RemoteAgentConsole.WindowsLaunch.StdioProbe/        # synthetic pipe/stdio probe
```

The runner drives the existing synthetic tree at
`qualification/windows/process-tree-fixture.cs`; it does not add another controller or
a second ownership implementation.

## Qualification

```powershell
$commit = git -C . rev-parse HEAD
pwsh qualification/windows/launch-ownership-fixture.ps1 -ExpectedCommit $commit -ScratchRoot "$env:TEMP\rac-windows-launch"
```

`-ExpectedCommit` is required and must be the full 40-hex commit being bound. The caller
chooses the scratch root; the default is a portable directory under the current user's
temporary path, not a machine-specific repository path. `-AllowOtherCommit` permits a
diagnostic mismatch but cannot produce an attested `PASS`. The script records the initial
`HEAD` tree and initial hashes for the existing scoped inputs (`native/windows-launch`,
this script, and the process-tree fixture); before declaring `PASS` it re-reads the commit,
tree and scoped hashes and fails if any changed. Dirty scoped inputs (modified or
untracked files under those paths) are recorded truthfully in `receipt.json` along with
their hashes; the derived `witnessClass` is `clean-publication` only for an attested run
with no dirty scoped inputs, `stable-dirty-source` for an attested run with bound dirty
inputs, and un-attested otherwise. No broader worktree sweep is performed.

The script:

- verifies the exact base commit and the Windows x64 / .NET 8+ host;
- scans the production sources with a **token-presence only** scan for forbidden
  process-control, ambient-environment, inherit-all and network patterns, and requires
  both explicit `JOB_LIST` and `HANDLE_LIST` plus explicit pipe
  inheritable/non-inheritable setup. Presence is not a semantic proof; the behavioral
  stdio tests provide runtime evidence;
- builds the synthetic fixture and the library/runner/probes with one MSBuild job at a
  time into a unique scratch directory (no repository `bin`/`obj`; no `PackageReference`
  items exist, so no external package is declared. `dotnet build` may still run an
  implicit restore for framework and reference packs from the installed SDK);
- runs the conformance suite in Unicode paths containing spaces;
- writes `receipt.json` (hashes, environment, per-test evidence, limitations) next to
  the build artifacts.

Scratch output is created under the caller-supplied scratch root, for example
`$env:TEMP\rac-windows-launch\<run-id>`.

## Conformance coverage

- contract rejection: relative paths, non-`.exe` images, relative working directory,
  NUL arguments, quote-in-path, argument-count and command-line bounds;
- environment rejection: null policy, case-insensitive duplicate keys, empty keys,
  `=`/NUL characters, and the environment-block bound;
- Windows quoting rules for spaces, quotes, empty arguments and trailing backslashes;
- job limits: kill-on-close present, breakaway absent;
- creation-time job membership for the root and both owned descendants;
- normal stop: synthetic root stops on its own request, exact child tree settles,
  job accounting reaches zero;
- root crash: the exact root handle is terminated, owned child and grandchild die,
  the job settles, the root's own cleanup did not run;
- dispose: closing the job alone kills the owned tree through kill-on-close;
- **supervisor death**: a separate supervisor process creates the contained tree; the
  parent kills only the exact supervisor handle and verifies the owned descendants
  settle while the same-image peer survives;
- **creation-time fault injection**: `Unsupported = true` before any process exists,
  with an empty witness directory. This is an injected attribute-boundary failure, not
  a demonstrated real host rejection;
- **resume guard**: the launcher test injects an unsafe previous suspension count,
  asserts the injected/observed record flags and record-level semantics, and rolls back
  without running child code. The observed-0, observed-positive and `ResumeThread`-error
  branches are implemented and typed but are not independently executed by this suite;
- **environment policy**: the synthetic probe sees exactly the explicit policy, with
  no ambient sentinel, `PATH` or `USERPROFILE` propagation;
- **stdio pipes**: with `ChildStdioMode.Pipes`, a harmless synthetic child performs a
  bounded fixed ASCII PING/PONG exchange, emits a distinct stderr marker, shuts down via
  `BYE`, and separately via stdin EOF. It also reports absence of an unrelated
  inheritable sentinel handle as **behavioral evidence**; the numeric-handle check can
  only false-fail on a handle-value collision, never false-pass an inherited sentinel.
  The default no-stdio launch exposes no streams. An injected explicit handle-list
  failure fails closed before any child code runs;
- **cancelable overlapped stdio** (opt-in `CancelablePipes`): a PING/PONG exchange, a
  distinct stderr line, graceful EOF, an absent unrelated inheritable sentinel, a
  verified exact peer/role pair, and exact job settlement; native stdout **and** stderr
  reads observed as pending (`TimedOut`, operation retained) while the child is still
  alive; a dedicated cancellation case where both exact pending reads return
  `ERROR_OPERATION_ABORTED` (`Canceled`, 995) before the silent child exits, with no new
  post-stop native submission; a real stdin write larger than the pipe buffer observed as
  `Submitted` against a non-reading child, a second send refused as `Backpressure`, then
  the pending write cancelled (`Canceled`, `StdioDelivery.Unknown`) while the child is still
  alive; broken pipe after child exit; concurrent/idempotent `Shutdown` returning one
  complete receipt; repeated send/stop/reap/dispose race witnesses; admitted read and
  `Shutdown` versus `Dispose` lifecycle witnesses; a deterministic gated read-pump
  teardown witness; and an injected cancel-boundary failure classified `UnknownPending`
  with the buffer retained and no fabricated settlement (the gated pause and injected
  cancel are labelled as test seams, not evidence of a real cancellation failure);
- no start: missing executable and missing working directory produce staged failures
  with no process created;
- unrelated same-image peer: outside the job, not a member, heartbeat continues
  through every owned-tree stop;
- Unicode/spaces: executable path, working directory and witness paths.

## Limitations

- Windows x64, .NET 8 runtime. This is a DLL/framework artifact; there is no MSI,
  MSIX, service, scheduled task or per-machine installation.
- Creation-time job assignment requires Windows 10 1607 or later. It is qualified on
  Windows 10.0.26200 x64; if the OS rejects or lacks the attribute API, launch fails
  before process creation and no fallback is attempted. A real host rejection of the
  attribute API is **not** exercised; only the injected boundary failure is.
- `Pipes` custody is synchronous and library-only; `CancelablePipes` adds overlapped,
  cancelable parent channels over private local named pipes, but both remain library-only.
  Neither is wired to the host, maintained Codex app-server, daemon, relay or any remote
  command surface. Reparse-point checks, code signing, upgrade/rollback and host/Codex
  binding remain later slices, so this slice still has no production agent launch path.
- `CancelablePipes` is qualified for 64-bit Windows only and refuses the mode before any
  process creation on a 32-bit host, with `Unsupported = true`. `PendingOverlappedIo`
  still zeroes the exact runtime structure size in 4-byte units, so no 20-byte x86 layout
  is overrun by the shared code.
- `CancelablePipes` observes native Windows I/O completion and settlement; it does not
  infer or report a provider/agent turn outcome. The unknown/in-flight classification is
  exercised only through an injected cancel-boundary failure; a real `CancelIoEx` failure
  is not staged. A real timeout, a real pending read/write, real read cancellation with
  `ERROR_OPERATION_ABORTED`, and a real broken pipe are exercised without injection.
- The named-pipe DACL is an explicit protected ACE for the current process user, and the
  parent owns the sole client handle. Every launch verifies the exact end roles and
  current process IDs, but a deliberately mismatched-peer rejection is not staged, and
  DACL/remote-client exclusion is a construction property rather than a runtime
  observation. Cross-user attacks and a compromised same-user process remain out of scope.
- Delivery is tri-state. `StdioDelivery.Unknown` for a cancelled/faulted/in-flight write
  is honest uncertainty, not evidence that data arrived; `Delivered` requires an observed
  positive byte count. A read that completed with data during a stop keeps those bytes
  available to a drain call and reports the stop as the terminal state; a zero-byte
  successful pipe read is reported as EOF.
- Cancelable shutdown is finite and idempotent, but a caller budget that expires before a
  cancel settles returns `Complete = false` and retains the operation. Repeated
  `Shutdown` calls after that return the same incomplete classification. A forced
  `Dispose` closes the write handle only after the operation is harvested or retained by
  the stateful `PendingOverlappedIo`; it never claims EOF or settled state for an
  unobserved forced closure.
- The enforceable retained invariant is **one active cancelable owner per process**, with
  at most three channel operations from that owner. `MaximumRetained = 8` is a defensive
  process bound; `Retain` never refuses a live buffer. A retained operation keeps the
  owner lease, so new cancelable launches are refused until the process is recycled.
- A read-channel `Dispose` does not close the pipe if the pump has not exited within its
  forced join bound. The pump remains the handle owner, finishes the pending operation,
  closes the handle on exit and disposes the shared events; a timed-out joiner returns
  without touching them. The gated teardown fixture exercises this window with an explicit
  pause seam; the pause is not evidence of a real cancellation failure.
- A late admitted `CloseInput` after forced write closure has a static defensive branch
  returning a typed forced-close classification (`UnknownPending`,
  `ERROR_INVALID_HANDLE`, `Unknown` delivery) from cached state, without `CancelIoEx` or a
  disposed handle. The fixture does not execute that branch; it is not evidence that a
  forced close settled anything.
- Graceful shutdown is stdin EOF, bounded wait/settlement, then dispose. `Dispose` alone
  is forced cleanup via job close/kill-on-close, not a graceful request.
- The source scan is token-presence only, not AST or semantic proof. The stdio sentinel
  check is behavioral and numeric-handle based; a handle-value collision can cause a
  false failure only, never a false pass for an inherited sentinel.
- Attested receipts distinguish a `stable-dirty-source` witness (exact commit/tree and
  stable scoped hashes with uncommitted inputs) from a `clean-publication` witness
  (no dirty scoped inputs). The derived witness class does not alter historical
  attestation or weaken the exact-commit/hash checks.
- Public `LaunchStage` numeric values 0-6 are preserved; `CreateStdio = 7` and
  `CreateHandleList = 8` are appended. The `contract-validation` fixture asserts
  all nine values.
- Pipe-enabled launches create three inheritable child ends during the bounded create
  window. Run this component in a dedicated owner launcher; pipe-enabled launches are
  serialized, but unrelated inherit-all spawns in the same OS process are outside its
  control.
- Only the creation-time attribute failure, explicit stdio handle-list failure and
  unsafe resume count are fault-injected. The resume test injects count `2` and checks
  the injected/observed flags plus record-level semantics; observed `0`, observed
  positive counts and a real `ResumeThread` failure are not independently executed.
  Injected resume values are labelled simulated and never treated as an OS observation.
  Containment verification shares the same rollback routine but is not separately
  injected. The injected handle-list failure also does not prove a real OS rejection.
- `dotnet build` may run an implicit restore for framework/reference packs from the
  installed SDK. There are no `PackageReference` items in this slice, so no external
  package is declared.
- Attested `PASS` requires the exact expected commit, a stable `HEAD` tree, and stable
  hashes for the scoped source/script inputs recorded at start. Dirty scoped inputs are
  hashed and recorded truthfully, but they are not a clean publication state.
- Same-user synthetic fixtures only; cross-user, AppContainer and restricted-token
  containment are not covered.
- Console hosts allocated by owned children are contained and killed with the job; a
  child that deliberately attaches to an unrelated console is out of scope.
- The library accepts any absolute `.exe` and environment policy from its caller by
  design. Production must enforce the project and launch-profile allowlist outside
  this component, including which environment keys are approved.

## Packaging prerequisites (before this becomes reachable)

1. Publish the library as part of the host's native/framework payload for `win-x64`
   (framework-dependent requires .NET 8; self-contained avoids a machine prerequisite)
   and sign the resulting binaries.
2. Integrate only behind the host's allowlisted launch-profile resolver; never accept
   a remote path, argv or environment policy.
3. Bind the typed pipe custody to the host/Codex app-server and add a reviewed
   per-profile environment policy before real agent use.
4. Define the per-user install directory and ACLs, versioned ABI, and upgrade/rollback
   behavior.
5. Keep scheduler/service/global changes out of scope; registration remains a manual,
   owner-authorized step.
