#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;

namespace RemoteAgentConsole.WindowsLaunch.Tests;

internal sealed record TestReceipt(
    string Name,
    string Status,
    double DurationMs,
    IReadOnlyList<string> Failures,
    IReadOnlyDictionary<string, string> Evidence);

/// <summary>
/// Conformance runner for the Windows launch-ownership slice. It compiles no fixture
/// itself; the qualification script supplies the synthetic process-tree executable,
/// the synthetic environment probe and an owned scratch directory.
/// </summary>
internal static class TestRunner
{
    private const string SuiteName = "windows-launch-ownership";

    internal static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
        }
        catch (System.IO.IOException)
        {
            // A redirected or legacy console may refuse the change; evidence still lands in the receipt.
        }

        if (args.Length > 0 && string.Equals(args[0], "--supervise", StringComparison.Ordinal))
        {
            return SupervisorHost.Run(args);
        }

        Options options;
        try
        {
            options = ParseArguments(args);
        }
        catch (ArgumentException error)
        {
            Console.Error.WriteLine($"USAGE {error.Message}");
            return 2;
        }

        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("REFUSED The Windows launch ownership suite requires Windows.");
            return 2;
        }

        if (!Environment.Is64BitProcess)
        {
            Console.Error.WriteLine("REFUSED The Windows launch ownership suite requires a 64-bit process.");
            return 2;
        }

        if (!File.Exists(options.FixturePath))
        {
            Console.Error.WriteLine($"REFUSED The synthetic fixture was not found: {options.FixturePath}");
            return 2;
        }

        if (!File.Exists(options.ProbePath))
        {
            Console.Error.WriteLine($"REFUSED The synthetic environment probe was not found: {options.ProbePath}");
            return 2;
        }

        if (!File.Exists(options.StdioProbePath))
        {
            Console.Error.WriteLine($"REFUSED The synthetic stdio probe was not found: {options.StdioProbePath}");
            return 2;
        }

        var suiteRoot = Path.Combine(
            options.ScratchDirectory,
            $"witness suite {DateTime.UtcNow:yyyyMMdd-HHmmss} ünïcode 树");
        Directory.CreateDirectory(suiteRoot);

        var fixture = new FixtureControl(options.FixturePath);
        var context = new ScenarioContext(fixture, suiteRoot, options.ProbePath, options.StdioProbePath);
        var results = new List<TestReceipt>();
        string status = "PASS";

        try
        {
            Run(results, "contract-validation", checks => WindowsLaunchScenarios.ContractValidation(context, checks));

            PeerSession? peer = null;
            try
            {
                peer = PeerSession.Start(fixture, Path.Combine(suiteRoot, "peer witness träd 树"));
                Console.WriteLine($"PEER started pid={peer.Identity.ProcessId} image={peer.Identity.ExecutablePath}");
            }
            catch (Exception error)
            {
                results.Add(new TestReceipt(
                    "peer-start",
                    "FAIL",
                    0,
                    new[] { $"{error.GetType().Name}: {error.Message}" },
                    new Dictionary<string, string>()));
                Console.WriteLine("FAIL peer-start");
            }

            if (peer is null)
            {
                foreach (var name in new[] { "normal-stop", "root-crash", "dispose-kill-on-close", "supervisor-death" })
                {
                    results.Add(new TestReceipt(
                        name,
                        "FAIL",
                        0,
                        new[] { "The unrelated same-image peer did not start." },
                        new Dictionary<string, string>()));
                }
            }
            else
            {
                using (peer)
                {
                    Run(results, "normal-stop", checks => WindowsLaunchScenarios.NormalStop(context, peer, checks));
                    Run(results, "root-crash", checks => WindowsLaunchScenarios.RootCrash(context, peer, checks));
                    Run(results, "dispose-kill-on-close", checks => WindowsLaunchScenarios.DisposalKillsOwnedTree(context, peer, checks));
                    Run(results, "supervisor-death", checks => WindowsLaunchScenarios.SupervisorDeath(context, peer, checks));
                }
            }

            Run(results, "creation-time-assignment-failure", checks => WindowsLaunchScenarios.CreationTimeAssignmentFailure(context, checks));
            Run(results, "resume-count-guard", checks => WindowsLaunchScenarios.ResumeCountGuard(context, checks));
            Run(results, "environment-policy", checks => WindowsLaunchScenarios.EnvironmentPolicyCheck(context, checks));
            Run(results, "stdio-pipes", checks => WindowsLaunchScenarios.StdioPipesCheck(context, checks));
            Run(results, "stdio-handle-list-failure", checks => WindowsLaunchScenarios.StdioHandleListFailure(context, checks));
            Run(results, "cancelable-stdio-exchange", checks => WindowsLaunchScenarios.CancelableStdioExchange(context, checks));
            Run(results, "cancelable-stdio-read-blocked", checks => WindowsLaunchScenarios.CancelableStdioReadBlocked(context, checks));
            Run(results, "cancelable-stdio-write-backpressure", checks => WindowsLaunchScenarios.CancelableStdioWriteBackpressure(context, checks));
            Run(results, "cancelable-stdio-broken-pipe", checks => WindowsLaunchScenarios.CancelableStdioBrokenPipe(context, checks));
            Run(results, "cancelable-stdio-read-cancel", checks => WindowsLaunchScenarios.CancelableStdioReadCancel(context, checks));
            Run(results, "cancelable-stdio-races", checks => WindowsLaunchScenarios.CancelableStdioRaces(context, checks));
            Run(results, "cancelable-stdio-lifecycle", checks => WindowsLaunchScenarios.CancelableStdioLifecycle(context, checks));
            Run(results, "cancelable-stdio-teardown-gated", checks => WindowsLaunchScenarios.CancelableStdioTeardownGated(context, checks));
            Run(results, "cancelable-stdio-second-pump-fault", checks => WindowsLaunchScenarios.CancelableStdioSecondPumpFault(context, checks));
            Run(results, "cancelable-stdio-unknown-pending", checks => WindowsLaunchScenarios.CancelableStdioUnknownPending(context, checks));
            Run(results, "no-start", checks => WindowsLaunchScenarios.NoStart(context, checks));
        }
        catch (Exception error)
        {
            status = "ERROR";
            results.Add(new TestReceipt(
                "runner",
                "FAIL",
                0,
                new[] { $"{error.GetType().Name}: {error.Message}" },
                new Dictionary<string, string>()));
        }

        var failed = results.Where(result => !string.Equals(result.Status, "PASS", StringComparison.Ordinal)).ToArray();
        if (failed.Length > 0 && status == "PASS")
        {
            status = "FAIL";
        }

        WriteReceipt(options.ReceiptPath, status, fixture, options.ProbePath, options.StdioProbePath, suiteRoot, results);

        Console.WriteLine();
        Console.WriteLine($"SUITE {SuiteName} {status} ({results.Count - failed.Length}/{results.Count} passed)");
        Console.WriteLine($"WITNESS_ROOT {suiteRoot}");
        Console.WriteLine($"RECEIPT {options.ReceiptPath}");
        return status == "PASS" ? 0 : 1;
    }

    private static void Run(List<TestReceipt> results, string name, Action<Checks> scenario)
    {
        var checks = new Checks();
        var stopwatch = Stopwatch.StartNew();
        string? error = null;
        try
        {
            scenario(checks);
        }
        catch (Exception exception)
        {
            error = $"{exception.GetType().Name}: {exception.Message}";
        }

        stopwatch.Stop();
        var failures = checks.Failures.ToList();
        if (error is not null)
        {
            failures.Add(error);
        }

        var passed = failures.Count == 0;
        results.Add(new TestReceipt(
            name,
            passed ? "PASS" : "FAIL",
            Math.Round(stopwatch.Elapsed.TotalMilliseconds, 1),
            failures,
            checks.Evidence));
        Console.WriteLine(
            $"{(passed ? "PASS" : "FAIL")} {name} ({stopwatch.Elapsed.TotalMilliseconds:0} ms)"
            + (passed ? string.Empty : $" :: {string.Join(" | ", failures)}"));
    }

    private static void WriteReceipt(
        string receiptPath,
        string status,
        FixtureControl fixture,
        string probePath,
        string stdioProbePath,
        string suiteRoot,
        IReadOnlyList<TestReceipt> results)
    {
        var receipt = new
        {
            schemaVersion = 2,
            suite = SuiteName,
            status,
            generatedUtc = DateTimeOffset.UtcNow,
            scope = new
            {
                artifact = "managed class library (DLL) plus a console conformance runner and synthetic probes",
                productReachable = false,
                installedProduct = false,
                hostOrCodexBinding = false,
                note = "Not referenced by apps/host or packages; no scheduler, service, installer, registry value or network listener is created. No maintained Codex app-server is installed or bound.",
            },
            contract = new
            {
                executable = "owner-supplied absolute .exe path, passed as lpApplicationName",
                arguments = "owner-supplied fixed argv serialized with Windows quoting rules",
                environment = "required frozen Unicode block from the caller's explicit policy; no ambient environment read or merge",
                stdio = "optional typed stdin/stdout/stderr pipes (default none); when opted in, exactly three explicit child handles are inherited through PROC_THREAD_ATTRIBUTE_HANDLE_LIST; parent ends are non-inheritable; stderr is a distinct pipe and is never merged",
                creation = "STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_JOB_LIST (+ PROC_THREAD_ATTRIBUTE_HANDLE_LIST only for pipe custody), CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_DETACHED_PROCESS; no shell, no breakaway, no inherit-all fallback",
                containment = "creation-time private Job Object, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway, IsProcessInJob verified before resume; no post-create assignment or unsandboxed fallback",
                resume = "ResumeThread accepts only a previous suspension count of exactly 1; observed 0 is reported as possibly externally resumed/runnable, positive counts >1 as still suspended, and injected values are marked simulated, never observed",
            },
            stdioCustody = new
            {
                defaultMode = "None (no standard handles, bInheritHandles=false)",
                optInMode = "Pipes (stdin/stdout/stderr)",
                inheritance = "bInheritHandles=true only with PROC_THREAD_ATTRIBUTE_HANDLE_LIST containing exactly the three child ends; child ends inheritable for the create call and closed immediately afterwards; parent ends never inheritable",
                merging = "stdout and stderr are separate pipes; no merge or duplication",
                launchConstraint = "Pipe-enabled launches serialize inside the owner process; arbitrary concurrent spawns must not run in the dedicated launcher because the three child ends are inheritable during the bounded create window",
                shutdown = "Graceful shutdown is close/dispose stdin (EOF), bounded wait/settlement, then dispose OwnedProcess/streams. Dispose alone is forced cleanup via job close/kill-on-close.",
                sentinelEvidence = "The unrelated-handle sentinel check is behavioral and numeric-handle based; a handle-value collision can cause a false failure only, never a false pass.",
                cancelableMode = new
                {
                    mode = "ChildStdioMode.CancelablePipes (opt-in; None and Pipes are unchanged)",
                    transport = "three private local named-pipe pairs; the parent end is FILE_FLAG_OVERLAPPED, the child end is a synchronous inheritable client handle passed through PROC_THREAD_ATTRIBUTE_HANDLE_LIST",
                    endpointBoundary = "fresh unpredictable GUID name, FILE_FLAG_FIRST_PIPE_INSTANCE, protected DACL granting only the current process user, exactly one instance, PIPE_REJECT_REMOTE_CLIENTS, and the parent opens the sole client handle before the child is created, so no other local or remote client can connect",
                    peerVerification = "before handoff the controlled process verifies the pair with GetNamedPipeInfo (server/client end roles) and cross-checks GetNamedPipeClientProcessId/GetNamedPipeServerProcessId from both server and client handle views; every observed process ID must be the current controlled process, so a GUID or DACL alone is never accepted as peer proof",
                    connect = "the parent opens the only client end first, so ConnectNamedPipe observes ERROR_PIPE_CONNECTED without submitting I/O; if the OS still reports a pending connect, the exact operation is cancelled, harvested, or retained with no free, and the launch fails closed",
                    completion = "each native ReadFile/WriteFile result is harvested with GetOverlappedResult on the exact OVERLAPPED; cancellation calls CancelIoEx with that same pointer and the completion event remains authoritative",
                    backpressure = "at most one bounded operation per direction; a second send returns Backpressure instead of queueing, and the pipe buffer is 4 KiB so a larger write to a non-reading child stays pending",
                    stopGate = "a stop flag is checked under the same lock that submits I/O, so no later send or read issues a native operation; a rejected send records StopObservedBeforeSubmit",
                    writeOwnership = "every write has a stable operation identity, one authoritative observer and one stored completion result protected by the submit/harvest gate; a concurrent observer is refused before any wait or effect, and a forced dispose linearizes its close with the same teardown lock as the bounded stop",
                    lifecycle = "the facade admits public calls, refuses new calls after disposal starts, force-stops the channels, and waits a bounded interval before releasing shared wait handles; a still-admitted caller finalizes them on exit, so no admitted wait observes a disposed handle",
                    unsettled = "a caller deadline never cancels or frees a running operation; a cancel that does not settle within the bound is classified UnknownPending and its buffers/event are retained for process lifetime. Process-wide retention has an admission cap; at the cap, new cancelable launches are refused until the launcher process is recycled",
                    partialWrites = "a cancelled, faulted, or still-pending write reports StdioDelivery.Unknown because a partial delivery cannot be ruled out; only an observed positive byte count reports Delivered",
                },
            },
            cleanupSemantics = new
            {
                confirmed = "ProcessExitConfirmed/RootExitConfirmed require a bounded WaitForSingleObject on the exact handle; JobEmptyConfirmed requires kernel job accounting to reach zero.",
                accessDenied = "TerminateProcessAccessDeniedSuggested and TerminateJobObjectAccessDeniedSuggested are recorded separately and never promote a confirmed flag.",
                handles = "LaunchCleanup.Complete additionally requires both exact handles to be closed.",
            },
            host = new
            {
                osDescription = RuntimeInformation.OSDescription,
                osVersion = Environment.OSVersion.Version.ToString(),
                architecture = RuntimeInformation.ProcessArchitecture.ToString(),
                is64BitProcess = Environment.Is64BitProcess,
                framework = RuntimeInformation.FrameworkDescription,
                runtimeVersion = Environment.Version.ToString(),
                processorCount = Environment.ProcessorCount,
                availableMemoryBytes = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes,
            },
            fixture = new
            {
                path = fixture.ExecutablePath,
                probePath,
                stdioProbePath,
                witnessRoot = suiteRoot,
                peer = "same synthetic image, launched outside the owner's containment boundary",
            },
            tests = results,
            limitations = new[]
            {
                "The component is a native library/framework artifact; it is not installed, packaged or reachable from the host or relay. No maintained Codex app-server or daemon is installed or bound.",
                "Pipe custody is library-only and synchronous. It is not wired to the host, Codex app-server, relay or any remote command surface; ACL hardening and reparse-point checks remain later slices.",
                "Pipe-enabled launches create three inheritable child ends for the bounded create window. The owner process must be a dedicated launcher; other arbitrary spawns must not run concurrently, and the implementation serializes pipe-enabled launches but cannot stop unrelated code from calling inherit-all spawn APIs.",
                "CancelablePipes is library-only and not bound to a host, Codex app-server, relay or remote command surface. It observes native Windows I/O completion; it does not infer or report a provider/agent turn outcome.",
                "The anonymous-pipe Pipes mode remains synchronous. The overlapped cancelable mode uses private local named pipes; it creates no listener, socket or network endpoint, rejects remote clients and binds only the single client handle the parent opens.",
                "The UnknownPending classification is exercised with an injected cancel-boundary failure, not a real CancelIoEx failure. A real timeout and a real pending write are exercised without injection.",
                "Creation-time job assignment requires Windows 10 1607 or later; this host is Windows 11 26200 x64. If the attribute API is unavailable, launch fails before process creation with Unsupported=true and no fallback. A real host rejection is not exercised; the suite injects the boundary failure.",
                "Only the creation-time attribute failure, explicit stdio handle-list failure and unsafe resume count are fault-injected; containment verification shares the rollback path but is not separately injected. The resume test injects count 2 and checks record semantics; observed 0, observed >1 and ResumeThread-error branches are not independently executed.",
                "The synthetic fixtures are same-user; cross-user and AppContainer containment are not covered.",
                "Console hosts allocated by owned children are contained and killed with the job; a child that deliberately attaches to an unrelated console is out of scope.",
                "The library accepts any absolute .exe and environment policy from its caller by design; production must enforce the project and launch-profile allowlist outside this component.",
            },
        };

        var options = new JsonSerializerOptions { WriteIndented = true };
        File.WriteAllText(receiptPath, JsonSerializer.Serialize(receipt, options));
    }

    private static Options ParseArguments(string[] args)
    {
        string? fixture = null;
        string? scratch = null;
        string? receipt = null;
        string? probe = null;
        string? stdioProbe = null;
        for (var index = 0; index < args.Length; index++)
        {
            var name = args[index];
            if (name is not ("--fixture" or "--scratch" or "--receipt" or "--probe" or "--stdio-probe"))
            {
                throw new ArgumentException($"Unknown option '{name}'. Expected --fixture, --scratch, --receipt, --probe, --stdio-probe.");
            }

            if (index + 1 >= args.Length)
            {
                throw new ArgumentException($"Option '{name}' needs a value.");
            }

            var value = Path.GetFullPath(args[++index]);
            switch (name)
            {
                case "--fixture":
                    fixture = value;
                    break;
                case "--scratch":
                    scratch = value;
                    break;
                case "--receipt":
                    receipt = value;
                    break;
                case "--probe":
                    probe = value;
                    break;
                case "--stdio-probe":
                    stdioProbe = value;
                    break;
            }
        }

        if (fixture is null || scratch is null || receipt is null || probe is null || stdioProbe is null)
        {
            throw new ArgumentException("--fixture, --scratch, --receipt, --probe and --stdio-probe are all required.");
        }

        Directory.CreateDirectory(scratch);
        var receiptDirectory = Path.GetDirectoryName(receipt);
        if (!string.IsNullOrEmpty(receiptDirectory))
        {
            Directory.CreateDirectory(receiptDirectory);
        }

        return new Options(fixture, scratch, receipt, probe, stdioProbe);
    }

    private sealed record Options(string FixturePath, string ScratchDirectory, string ReceiptPath, string ProbePath, string StdioProbePath);
}

/// <summary>
/// Separate supervisor process used to prove that supervisor death closes the only
/// Job Object handle and settles the contained tree. It is a qualification helper, not
/// a second ownership implementation or controller.
/// </summary>
internal static class SupervisorHost
{
    internal static int Run(string[] args)
    {
        if (args.Length != 5
            || !string.Equals(args[0], "--supervise", StringComparison.Ordinal))
        {
            Console.Error.WriteLine("SUPERVISOR_USAGE --supervise <fixture.exe> <witness-dir> <evidence.json> <policy-temp-dir>");
            return 2;
        }

        try
        {
            var fixture = Path.GetFullPath(args[1]);
            var witness = Path.GetFullPath(args[2]);
            var evidencePath = Path.GetFullPath(args[3]);
            var policyTemp = Path.GetFullPath(args[4]);

            var contract = LaunchContract.Create(
                fixture,
                Path.GetDirectoryName(fixture) ?? throw new InvalidOperationException("Fixture directory is unavailable."),
                new[] { "tree-root", "--witness-dir", witness },
                EnvironmentPolicy.Minimal(policyTemp));

            using var owned = WindowsProcessOwner.Launch(contract, TimeSpan.FromSeconds(10));
            using var self = Process.GetCurrentProcess();
            var payload = new
            {
                schemaVersion = 1,
                supervisorProcessId = self.Id,
                supervisorStartTimeUtcTicks = self.StartTime.ToUniversalTime().Ticks,
                rootProcessId = owned.ProcessId,
                jobLimitFlags = owned.JobLimitFlags,
                environmentKeys = contract.Environment.Keys.OrderBy(key => key, StringComparer.OrdinalIgnoreCase).ToArray(),
                createdUtc = DateTimeOffset.UtcNow,
            };

            var temporary = $"{evidencePath}.{Guid.NewGuid():N}.tmp";
            Directory.CreateDirectory(Path.GetDirectoryName(evidencePath)!);
            File.WriteAllText(
                temporary,
                JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporary, evidencePath, overwrite: true);

            // Hold the only Job Object handle. The parent kills this exact process; the
            // OS then closes the job handle and kill-on-close settles the owned tree.
            Thread.Sleep(TimeSpan.FromSeconds(60));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"SUPERVISOR_ERROR {error.GetType().Name}: {error.Message}");
            return 2;
        }
    }
}
