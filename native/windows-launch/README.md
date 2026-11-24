# Windows launch ownership (first slice)

Owner-only process ownership for the Remote Agent Console / Happier Windows
composition. This is a **native library component plus a conformance runner and a
synthetic environment probe**, not an installed product. Nothing in `apps/` or
`packages/` references it, so it is not production reachable yet.

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
   `PROC_THREAD_ATTRIBUTE_JOB_LIST` for that job;
4. `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
   CREATE_UNICODE_ENVIRONMENT | CREATE_DETACHED_PROCESS`, the explicit Unicode
   environment block, `bInheritHandles = false`, no shell and no breakaway;
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

`OwnedProcess.KillAndSettle` terminates the exact root handle, terminates the job,
and waits within a bound for job accounting to reach zero. `Dispose` closes the job, so
kill-on-close terminates anything still owned. No code path looks up a process by ID or
image name, enumerates processes, or signals a process outside the job.

## Contract boundaries

| Surface | This slice |
| --- | --- |
| Executable | owner-qualified absolute `.exe` only |
| Arguments | owner-qualified fixed argv only |
| Environment | required explicit frozen block; no ambient read, merge or expansion |
| Stdio | not redirected; no stdio API or host wiring is exposed, so there is no reachable agent runtime path in this slice |
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
their hashes; a clean published commit produces a clean binding. No broader worktree
sweep is performed.

The script:

- verifies the exact base commit and the Windows x64 / .NET 8+ host;
- scans the production sources for forbidden process-control, ambient-environment and
  network patterns, and for any post-create job assignment;
- builds the synthetic fixture and the library/runner/probe with one MSBuild job at a
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
- Stdio pipes, ACL hardening, reparse-point checks, code signing, upgrade/rollback and
  host integration are later slices. No stdio API or host wiring is exposed, so this
  slice has no reachable agent launch path.
- Only the creation-time attribute failure and the unsafe resume count are
  fault-injected. The resume test injects count `2` and checks the injected/observed
  flags plus record-level semantics; observed `0`, observed positive counts and a real
  `ResumeThread` failure are not independently executed. Injected resume values are
  labelled simulated and never treated as an OS observation. Containment verification
  shares the same rollback routine but is not separately injected.
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
3. Add stdio pipe ownership and a reviewed per-profile environment policy before real
   agent use.
4. Define the per-user install directory and ACLs, versioned ABI, and upgrade/rollback
   behavior.
5. Keep scheduler/service/global changes out of scope; registration remains a manual,
   owner-authorized step.
