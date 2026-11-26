#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace RemoteAgentConsole.WindowsLaunch.Tests;

internal sealed record SupervisorEvidence(
    int SchemaVersion,
    int SupervisorProcessId,
    long SupervisorStartTimeUtcTicks,
    int RootProcessId,
    uint JobLimitFlags,
    string[] EnvironmentKeys,
    string CreatedUtc);

internal sealed class ScenarioContext
{
    internal ScenarioContext(FixtureControl fixture, string suiteWitnessRoot, string probePath, string stdioProbePath)
    {
        Fixture = fixture;
        SuiteWitnessRoot = suiteWitnessRoot;
        ProbePath = probePath;
        StdioProbePath = stdioProbePath;
        PolicyTempDirectory = Path.Combine(suiteWitnessRoot, "policy temp");
        Directory.CreateDirectory(PolicyTempDirectory);
    }

    internal FixtureControl Fixture { get; }

    internal string SuiteWitnessRoot { get; }

    internal string ProbePath { get; }

    internal string StdioProbePath { get; }

    internal string PolicyTempDirectory { get; }

    internal string FreshWitnessDirectory(string name)
    {
        var directory = Path.Combine(SuiteWitnessRoot, name);
        if (Directory.Exists(directory))
        {
            throw new InvalidOperationException($"Scenario witness directory already exists: {directory}");
        }

        Directory.CreateDirectory(directory);
        return directory;
    }
}

internal static class WindowsLaunchScenarios
{
    private static readonly TimeSpan StartupBound = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan SettlementBound = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan DisposalDeathBound = TimeSpan.FromSeconds(10);
    private static readonly IReadOnlyDictionary<string, string> EmptyEnvironment =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    internal static void ContractValidation(ScenarioContext context, Checks checks)
    {
        _ = context;

        checks.Equal(0, (int)LaunchStage.Contract, "contract stage remains 0");
        checks.Equal(1, (int)LaunchStage.CreateJob, "create-job stage remains 1");
        checks.Equal(2, (int)LaunchStage.ConfigureJob, "configure-job stage remains 2");
        checks.Equal(3, (int)LaunchStage.CreateJobAssignment, "job-assignment stage remains 3");
        checks.Equal(4, (int)LaunchStage.CreateProcess, "create-process stage remains 4");
        checks.Equal(5, (int)LaunchStage.VerifyContainment, "verify-containment stage remains 5");
        checks.Equal(6, (int)LaunchStage.ResumePrimaryThread, "resume-thread stage remains 6");
        checks.Equal(7, (int)LaunchStage.CreateStdio, "stdio stage is appended as 7");
        checks.Equal(8, (int)LaunchStage.CreateHandleList, "handle-list stage is appended as 8");

        ExpectContractRejection(checks, "relative executable", () =>
            LaunchContract.Create("agent.exe", @"C:\Windows", Array.Empty<string>(), EmptyEnvironment));

        ExpectContractRejection(checks, "non-exe executable", () =>
            LaunchContract.Create(@"C:\Windows\System32\cmd.com", @"C:\Windows", Array.Empty<string>(), EmptyEnvironment));

        ExpectContractRejection(checks, "relative working directory", () =>
            LaunchContract.Create(@"C:\Windows\System32\cmd.exe", "Windows", Array.Empty<string>(), EmptyEnvironment));

        ExpectContractRejection(checks, "NUL in argument", () =>
            LaunchContract.Create(@"C:\Windows\System32\cmd.exe", @"C:\Windows", new[] { "a\0b" }, EmptyEnvironment));

        ExpectContractRejection(checks, "quote in executable path", () =>
            LaunchContract.Create("C:\\dir\\bad\"name.exe", @"C:\Windows", Array.Empty<string>(), EmptyEnvironment));

        var tooMany = Enumerable.Range(0, LaunchContract.MaximumArgumentCount + 1).Select(index => index.ToString()).ToArray();
        ExpectContractRejection(checks, "argument count bound", () =>
            LaunchContract.Create(@"C:\Windows\System32\cmd.exe", @"C:\Windows", tooMany, EmptyEnvironment));

        var oversized = new[] { new string('a', 20_000), new string('b', 20_000) };
        ExpectContractRejection(checks, "command line bound", () =>
            LaunchContract.Create(@"C:\Windows\System32\cmd.exe", @"C:\Windows", oversized, EmptyEnvironment));

        ExpectContractRejection(checks, "null environment policy", () =>
            LaunchContract.Create(@"C:\Windows\System32\cmd.exe", @"C:\Windows", Array.Empty<string>(), null!));

        var duplicateEnvironment = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["RAC_DUPLICATE"] = "one",
            ["rac_duplicate"] = "two",
        };
        ExpectContractRejection(checks, "case-insensitive duplicate environment key", () =>
            LaunchContract.Create(@"C:\Windows\System32\cmd.exe", @"C:\Windows", Array.Empty<string>(), duplicateEnvironment));

        ExpectContractRejection(checks, "empty environment key", () =>
            LaunchContract.Create(
                @"C:\Windows\System32\cmd.exe",
                @"C:\Windows",
                Array.Empty<string>(),
                new Dictionary<string, string> { [""] = "value" }));

        ExpectContractRejection(checks, "equals sign in environment key", () =>
            LaunchContract.Create(
                @"C:\Windows\System32\cmd.exe",
                @"C:\Windows",
                Array.Empty<string>(),
                new Dictionary<string, string> { ["BAD=KEY"] = "value" }));

        ExpectContractRejection(checks, "NUL in environment value", () =>
            LaunchContract.Create(
                @"C:\Windows\System32\cmd.exe",
                @"C:\Windows",
                Array.Empty<string>(),
                new Dictionary<string, string> { ["GOOD_KEY"] = "a\0b" }));

        ExpectContractRejection(checks, "environment block bound", () =>
            LaunchContract.Create(
                @"C:\Windows\System32\cmd.exe",
                @"C:\Windows",
                Array.Empty<string>(),
                new Dictionary<string, string>
                {
                    ["RAC_LARGE"] = new string('x', LaunchContract.MaximumEnvironmentBlockLength),
                }));

        var valid = LaunchContract.Create(
            @"C:\Program Files\Ünïcode Tool\agent tree.exe",
            @"C:\Program Files\Ünïcode Tool",
            new[] { "--project", @"C:\work\spaced project", "plain" },
            new Dictionary<string, string>
            {
                ["SystemRoot"] = @"C:\Windows",
                [EnvironmentPolicy.MarkerName] = EnvironmentPolicy.MarkerValue,
            });

        checks.Equal(
            "\"C:\\Program Files\\Ünïcode Tool\\agent tree.exe\" --project \"C:\\work\\spaced project\" plain",
            valid.CommandLine,
            "valid contract builds a quoted command line in argument order");
        checks.Equal(
            EnvironmentPolicy.MarkerValue,
            valid.Environment[EnvironmentPolicy.MarkerName],
            "valid contract freezes the supplied environment policy");
        checks.True(
            !valid.Environment.ContainsKey("PATH"),
            "valid contract does not add ambient PATH to the explicit environment");

        var builder = new System.Text.StringBuilder();
        CommandLineBuilder.AppendQuoted(builder, @"a b\");
        checks.Equal("\"a b\\\\\"", builder.ToString(), "trailing backslash is doubled before the closing quote");

        builder.Clear();
        CommandLineBuilder.AppendQuoted(builder, "say\"hi");
        checks.Equal("\"say\\\"hi\"", builder.ToString(), "embedded quote is escaped");

        builder.Clear();
        CommandLineBuilder.AppendQuoted(builder, string.Empty);
        checks.Equal("\"\"", builder.ToString(), "empty argument is quoted");

        builder.Clear();
        CommandLineBuilder.AppendQuoted(builder, @"C:\plain\path");
        checks.Equal(@"C:\plain\path", builder.ToString(), "plain path is not quoted");

        // Cleanup helper used by OwnedProcess.Dispose and the launcher's custody finally:
        // every step must be attempted even when an earlier stream cleanup throws.
        var order = new List<string>();
        try
        {
            ResourceCleanup.DisposeAll(
                new RecordingDisposable(order, "first", throwOnDispose: true),
                new RecordingDisposable(order, "second", throwOnDispose: false));
            checks.True(false, "the first cleanup failure should be surfaced after all steps run");
        }
        catch (InvalidOperationException)
        {
        }

        checks.Equal("first,second", string.Join(",", order), "all custody cleanup steps run after a throw");
    }

    private sealed class RecordingDisposable : IDisposable
    {
        private readonly List<string> _order;
        private readonly string _name;
        private readonly bool _throw;

        internal RecordingDisposable(List<string> order, string name, bool throwOnDispose)
        {
            _order = order;
            _name = name;
            _throw = throwOnDispose;
        }

        public void Dispose()
        {
            _order.Add(_name);
            if (_throw)
            {
                throw new InvalidOperationException("injected cleanup fault");
            }
        }
    }

    internal static void NormalStop(ScenarioContext context, PeerSession peer, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("normal-stop träd 树");
        checks.EmptyDirectory(witness, "tree-root witness directory starts empty");

        OwnedProcess? owned = null;
        try
        {
            owned = LaunchRoot(context, witness, checks);
            var root = WaitForRoot(witness, owned, checks);
            checks.True(owned.StandardStreams is null, "no-stdio default exposes no parent pipe custody");

            checks.True(
                (owned.JobLimitFlags & NativeMethods.JobObjectLimitKillOnJobClose) != 0,
                "job object holds kill-on-close");
            const uint breakaway = NativeMethods.JobObjectLimitBreakawayOk | NativeMethods.JobObjectLimitSilentBreakawayOk;
            checks.True((owned.JobLimitFlags & breakaway) == 0, "job object holds no breakaway option");

            checks.Equal(context.Fixture.ExecutablePath, root.ExecutablePath, "Unicode executable path is passed through exactly");

            peer.AssertHealthy(checks, "before release");

            FixtureControl.RequestStop(witness, "release-tree");
            checks.True(
                FixtureControl.WaitForFile(Path.Combine(witness, "owned-tree.json"), StartupBound),
                "owned tree published after release");
            checks.Equal(root.ProcessId, owned!.ProcessId, "root identity matches the owner's process ID");

            var child = FixtureControl.ReadIdentity(witness, "owned-child");
            var grandchild = FixtureControl.ReadIdentity(witness, "owned-grandchild");
            checks.True(
                FixtureControl.WaitUntil(() => JobContains(owned, root.ProcessId, child.ProcessId, grandchild.ProcessId), StartupBound),
                "kernel job membership contains the root and both owned descendants");
            checks.True(owned.ActiveProcessCount >= 3, "job accounting observes at least the three fixture processes");
            checks.True(
                !JobContains(owned, peer.Identity.ProcessId),
                "unrelated same-image peer is not a member of the owned job");
            checks.True(FixtureControl.IsExactIdentityAlive(child), "owned child is alive before stop");
            checks.True(FixtureControl.IsExactIdentityAlive(grandchild), "owned grandchild is alive before stop");

            peer.AssertHealthy(checks, "while owned tree runs");

            FixtureControl.RequestStop(witness, "stop-tree");
            checks.True(owned.WaitForExit(SettlementBound), "synthetic root exits on its own stop request");
            checks.Equal(0, owned.ExitCode, "normal stop exit code");

            var shutdown = FixtureControl.ReadShutdown(witness);
            checks.True(shutdown.ChildTreeSettled, "fixture observed its exact child tree settle");
            checks.Equal("shutdown-requested", shutdown.Result, "fixture reports shutdown-requested");
            checks.True(owned.TrySettle(TimeSpan.FromSeconds(10)), "job accounting reaches zero after normal stop");

            checks.True(FixtureControl.WaitForDeath(child, DisposalDeathBound), "owned child is gone after normal stop");
            checks.True(FixtureControl.WaitForDeath(grandchild, DisposalDeathBound), "owned grandchild is gone after normal stop");

            owned.Dispose();
            checks.True(owned.ProcessHandleClosed, "process handle is closed after dispose");
            checks.True(owned.JobHandleClosed, "job handle is closed after dispose");

            peer.AssertHealthy(checks, "after normal stop");
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void RootCrash(ScenarioContext context, PeerSession peer, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("root-crash träd 树");
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchRoot(context, witness, checks);
            WaitForRoot(witness, owned, checks);
            FixtureControl.RequestStop(witness, "release-tree");
            checks.True(
                FixtureControl.WaitForFile(Path.Combine(witness, "owned-tree.json"), StartupBound),
                "owned tree published before crash");
            checks.True(
                FixtureControl.WaitUntil(
                    () => JobContains(
                        owned,
                        FixtureControl.ReadIdentity(witness, "owned-root").ProcessId,
                        FixtureControl.ReadIdentity(witness, "owned-child").ProcessId,
                        FixtureControl.ReadIdentity(witness, "owned-grandchild").ProcessId),
                    StartupBound),
                "kernel job membership contains all three fixture processes before crash");

            var child = FixtureControl.ReadIdentity(witness, "owned-child");
            var grandchild = FixtureControl.ReadIdentity(witness, "owned-grandchild");
            peer.AssertHealthy(checks, "before root crash");

            var settlement = owned.KillAndSettle(SettlementBound);
            checks.True(settlement.TerminateProcessSucceeded, "crash path terminates the exact root handle");
            checks.True(
                !settlement.TerminateProcessAccessDeniedSuggested,
                "crash path does not rely on an AccessDenied suggestion");
            checks.True(settlement.RootExitConfirmed, "crash path confirms root exit by handle wait");
            checks.True(settlement.JobTerminateSucceeded, "crash path terminates the owned job");
            checks.True(
                !settlement.JobTerminateAccessDeniedSuggested,
                "crash path does not rely on a job AccessDenied suggestion");
            checks.True(settlement.JobEmptyConfirmed, "crash path confirms job accounting reached zero");
            checks.True(
                settlement.ExitCode == 0x5A5A,
                $"crash exit code is the owner's bounded kill code (observed {settlement.ExitCode})");
            checks.True(!File.Exists(Path.Combine(witness, "shutdown.json")), "crashed root did not run its shutdown cleanup");

            checks.True(FixtureControl.WaitForDeath(child, DisposalDeathBound), "owned child dies with the crashed root");
            checks.True(FixtureControl.WaitForDeath(grandchild, DisposalDeathBound), "owned grandchild dies with the crashed root");

            owned.Dispose();
            checks.True(owned.ProcessHandleClosed, "crash cleanup closes the process handle");
            checks.True(owned.JobHandleClosed, "crash cleanup closes the job handle");

            peer.AssertHealthy(checks, "after root crash");
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void DisposalKillsOwnedTree(ScenarioContext context, PeerSession peer, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("dispose-kill-on-close 树");
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchRoot(context, witness, checks);
            var root = WaitForRoot(witness, owned, checks);
            FixtureControl.RequestStop(witness, "release-tree");
            checks.True(
                FixtureControl.WaitForFile(Path.Combine(witness, "owned-tree.json"), StartupBound),
                "owned tree published before dispose");
            checks.True(
                FixtureControl.WaitUntil(
                    () => JobContains(
                        owned,
                        FixtureControl.ReadIdentity(witness, "owned-root").ProcessId,
                        FixtureControl.ReadIdentity(witness, "owned-child").ProcessId,
                        FixtureControl.ReadIdentity(witness, "owned-grandchild").ProcessId),
                    StartupBound),
                "kernel job membership contains all three fixture processes before dispose");

            var child = FixtureControl.ReadIdentity(witness, "owned-child");
            var grandchild = FixtureControl.ReadIdentity(witness, "owned-grandchild");
            peer.AssertHealthy(checks, "before dispose");

            owned.Dispose();
            checks.True(owned.ProcessHandleClosed, "dispose closes the process handle");
            checks.True(owned.JobHandleClosed, "dispose closes the kill-on-close job handle");

            checks.True(FixtureControl.WaitForDeath(root, DisposalDeathBound), "dispose terminates the root via kill-on-close");
            checks.True(FixtureControl.WaitForDeath(child, DisposalDeathBound), "dispose terminates the owned child via kill-on-close");
            checks.True(FixtureControl.WaitForDeath(grandchild, DisposalDeathBound), "dispose terminates the owned grandchild via kill-on-close");

            peer.AssertHealthy(checks, "after dispose");
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void SupervisorDeath(ScenarioContext context, PeerSession peer, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("supervisor-death träd 树");
        var evidencePath = Path.Combine(
            context.SuiteWitnessRoot,
            $"supervisor evidence {DateTime.UtcNow:yyyyMMdd-HHmmss-fffffff} 树.json");

        Process? supervisor = null;
        Task<string>? stdout = null;
        Task<string>? stderr = null;
        try
        {
            var startInfo = SelfProcess.CreateStartInfo();
            startInfo.ArgumentList.Add("--supervise");
            startInfo.ArgumentList.Add(context.Fixture.ExecutablePath);
            startInfo.ArgumentList.Add(witness);
            startInfo.ArgumentList.Add(evidencePath);
            startInfo.ArgumentList.Add(context.PolicyTempDirectory);

            supervisor = Process.Start(startInfo)
                ?? throw new InvalidOperationException("The supervisor test runner did not start.");
            stdout = supervisor.StandardOutput.ReadToEndAsync();
            stderr = supervisor.StandardError.ReadToEndAsync();

            checks.True(
                FixtureControl.WaitForFile(evidencePath, StartupBound),
                $"separate supervisor published launch evidence{Diagnostics(stdout, stderr)}");
            if (!File.Exists(evidencePath))
            {
                return;
            }

            var evidence = FixtureControl.ReadJson<SupervisorEvidence>(evidencePath);
            checks.Equal(supervisor.Id, evidence.SupervisorProcessId, "supervisor evidence identifies the exact supervisor");
            checks.Equal(
                supervisor.StartTime.ToUniversalTime().Ticks,
                evidence.SupervisorStartTimeUtcTicks,
                "supervisor start ticks match the exact supervisor handle");
            checks.True(
                (evidence.JobLimitFlags & NativeMethods.JobObjectLimitKillOnJobClose) != 0,
                "supervisor's job holds kill-on-close");
            const uint breakaway = NativeMethods.JobObjectLimitBreakawayOk | NativeMethods.JobObjectLimitSilentBreakawayOk;
            checks.True((evidence.JobLimitFlags & breakaway) == 0, "supervisor's job holds no breakaway option");
            checks.True(evidence.EnvironmentKeys.Length > 0, "supervisor recorded the explicit environment keys");

            checks.True(
                FixtureControl.WaitForFile(Path.Combine(witness, "owned-root.json"), StartupBound),
                "supervised root published its identity");
            var root = FixtureControl.ReadIdentity(witness, "owned-root");
            checks.Equal(evidence.RootProcessId, root.ProcessId, "supervisor evidence matches the contained root");

            peer.AssertHealthy(checks, "before supervised tree release");

            FixtureControl.RequestStop(witness, "release-tree");
            checks.True(
                FixtureControl.WaitForFile(Path.Combine(witness, "owned-tree.json"), StartupBound),
                "supervised owned tree published");
            var child = FixtureControl.ReadIdentity(witness, "owned-child");
            var grandchild = FixtureControl.ReadIdentity(witness, "owned-grandchild");
            checks.True(FixtureControl.IsExactIdentityAlive(root), "supervised root is alive");
            checks.True(FixtureControl.IsExactIdentityAlive(child), "supervised child is alive");
            checks.True(FixtureControl.IsExactIdentityAlive(grandchild), "supervised grandchild is alive");
            peer.AssertHealthy(checks, "while supervised tree runs");

            // The parent kills only the exact supervisor handle. It never looks up or
            // terminates the root or descendants; their settlement proves containment.
            checks.True(!supervisor.HasExited, "supervisor is still running before the crash injection");
            var terminated = TerminateProcessExact(supervisor.Handle, 0xBEEF);
            checks.True(
                terminated,
                $"parent terminated the exact supervisor handle (Win32 error {Marshal.GetLastWin32Error()})");
            checks.True(supervisor.WaitForExit(5_000), "supervisor exit observed after exact-handle termination");
            checks.True(supervisor.HasExited, "supervisor is gone");
            checks.True(
                supervisor.ExitCode == 0xBEEF,
                $"supervisor exit code records the parent's kill code (observed {supervisor.ExitCode})");

            checks.True(FixtureControl.WaitForDeath(root, DisposalDeathBound), "supervised root settles after supervisor death");
            checks.True(FixtureControl.WaitForDeath(child, DisposalDeathBound), "supervised child settles after supervisor death");
            checks.True(FixtureControl.WaitForDeath(grandchild, DisposalDeathBound), "supervised grandchild settles after supervisor death");
            checks.True(
                !File.Exists(Path.Combine(witness, "shutdown.json")),
                "supervised root did not run its own cleanup; job closure settled it");

            peer.AssertHealthy(checks, "after supervisor death");
        }
        finally
        {
            if (supervisor is not null)
            {
                if (!supervisor.HasExited)
                {
                    _ = TerminateProcessExact(supervisor.Handle, 0xBEEF);
                    if (!supervisor.WaitForExit(5_000))
                    {
                        supervisor.Kill();
                        supervisor.WaitForExit(5_000);
                    }
                }

                supervisor.Dispose();
            }
        }
    }

    internal static void CreationTimeAssignmentFailure(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("creation-time-assignment träd 树");
        var previous = LaunchDiagnostics.CreateJobListFailure;
        try
        {
            // Fault injection at the creation-time attribute-list boundary: no process
            // exists, so no child code can run and no unsandboxed fallback is available.
            LaunchDiagnostics.CreateJobListFailure = NativeMethods.ErrorInvalidParameter;

            LaunchFailureException? failure = null;
            try
            {
                using var owned = WindowsProcessOwner.Launch(
                    context.Fixture.RootContract(witness, EnvironmentPolicy.Minimal(context.PolicyTempDirectory)),
                    SettlementBound);
            }
            catch (LaunchFailureException error)
            {
                failure = error;
            }

            checks.True(failure is not null, "creation-time assignment failure is reported");
            if (failure is null)
            {
                return;
            }

            checks.Equal(LaunchStage.CreateJobAssignment, failure.Stage, "creation-time assignment failure stage");
            checks.Equal(NativeMethods.ErrorInvalidParameter, failure.Win32Error, "creation-time assignment failure carries the Win32 error");
            checks.True(failure.Unsupported, "creation-time assignment failure is explicitly unsupported");
            checks.True(failure.Cleanup is null, "no rollback evidence exists because no process was created");

            Thread.Sleep(750);
            checks.EmptyDirectory(witness, "creation-time assignment failure never ran child code");
        }
        finally
        {
            LaunchDiagnostics.CreateJobListFailure = previous;
        }
    }

    internal static void ResumeCountGuard(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("resume-count-guard träd 树");
        var previous = LaunchDiagnostics.ResumeThreadResult;
        try
        {
            // Simulate an unsafe previous suspension count. The launcher must not call
            // ResumeThread with this value; it rolls the suspended process back exactly.
            LaunchDiagnostics.ResumeThreadResult = 2;

            LaunchFailureException? failure = null;
            try
            {
                using var owned = WindowsProcessOwner.Launch(
                    context.Fixture.RootContract(witness, EnvironmentPolicy.Minimal(context.PolicyTempDirectory)),
                    SettlementBound);
            }
            catch (LaunchFailureException error)
            {
                failure = error;
            }

            checks.True(failure is not null, "unsafe suspension count is rejected");
            if (failure is null)
            {
                return;
            }

            checks.Equal(LaunchStage.ResumePrimaryThread, failure.Stage, "unsafe suspension count failure stage");
            checks.Equal(0, failure.Win32Error, "unsafe suspension count is not a Win32 failure");

            var observation = failure.ResumeObservation;
            checks.True(observation is not null, "unsafe suspension count reports resume observation evidence");
            if (observation is not null)
            {
                checks.True(observation.Injected, "the unsafe count is marked as injected, not observed");
                checks.True(!observation.ObservedByResumeThread, "injected count was not observed by ResumeThread");
                checks.Equal(2u, observation.PreviousSuspendCount, "injected count value");
                checks.True(observation.SuspensionStateUnknown, "injected count leaves the actual state unknown");
                checks.True(!observation.ConfirmedStillSuspended, "injected count never claims confirmed suspension");
                checks.True(!observation.PossiblyExternallyResumed, "injected count is not an external-resume observation");
            }

            checks.True(
                failure.Message.Contains("Injected", StringComparison.Ordinal),
                "failure message identifies the injected value");

            var observedZero = new ResumeSuspensionObservation(0, Injected: false, ObservedByResumeThread: true);
            checks.True(observedZero.PossiblyExternallyResumed, "observed count 0 is possibly externally resumed");
            checks.True(!observedZero.ConfirmedStillSuspended, "observed count 0 is not claimed as still suspended");
            checks.True(!observedZero.SuspensionStateUnknown, "observed count 0 is a known observation");
            var observedPositive = new ResumeSuspensionObservation(2, Injected: false, ObservedByResumeThread: true);
            checks.True(observedPositive.ConfirmedStillSuspended, "observed positive count remains suspended after one decrement");

            var cleanup = failure.Cleanup;
            checks.True(cleanup is not null, "unsafe suspension count reports rollback evidence");
            if (cleanup is null)
            {
                return;
            }

            checks.True(cleanup.ProcessCreated, "rollback saw the suspended process");
            checks.True(cleanup.TerminateProcessSucceeded, "rollback terminated the suspended process handle");
            checks.True(!cleanup.TerminateProcessAccessDeniedSuggested, "rollback did not rely on AccessDenied");
            checks.True(cleanup.ProcessExitConfirmed, "rollback confirmed process exit");
            checks.True(cleanup.ProcessHandleClosed, "rollback closed the process handle");
            checks.True(cleanup.JobHandleClosed, "rollback closed the job handle");
            checks.True(cleanup.Complete, "rollback evidence is complete");
            checks.True(cleanup.ExitCode == 0x5A5A, $"rollback exit code (observed {cleanup.ExitCode})");

            Thread.Sleep(750);
            checks.EmptyDirectory(witness, "the injected-count process was rolled back before child code ran");
        }
        finally
        {
            LaunchDiagnostics.ResumeThreadResult = previous;
        }
    }

    internal static void EnvironmentPolicyCheck(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("environment-policy träd 树");
        var output = Path.Combine(witness, "probe environment.json");
        const string sentinelName = "RAC_AMBIENT_SENTINEL";
        var sentinelValue = Guid.NewGuid().ToString("N");
        var policy = new Dictionary<string, string>(EnvironmentPolicy.Minimal(context.PolicyTempDirectory), StringComparer.OrdinalIgnoreCase)
        {
            ["RAC_POLICY_VALUE"] = "explicit-only",
        };

        OwnedProcess? owned = null;
        Environment.SetEnvironmentVariable(sentinelName, sentinelValue);
        try
        {
            checks.True(File.Exists(context.ProbePath), $"environment probe exists: {context.ProbePath}");
            if (!File.Exists(context.ProbePath))
            {
                return;
            }

            var contract = LaunchContract.Create(
                context.ProbePath,
                Path.GetDirectoryName(context.ProbePath)!,
                new[] { "--out", output },
                policy);

            owned = WindowsProcessOwner.Launch(contract, SettlementBound);
            checks.True(owned.WaitForExit(SettlementBound), "environment probe exits");
            checks.Equal(0, owned.ExitCode, "environment probe exit code");
            checks.True(owned.TrySettle(TimeSpan.FromSeconds(10)), "environment probe leaves an empty job");
            checks.True(File.Exists(output), "environment probe wrote its environment");

            var seen = JsonSerializer.Deserialize<Dictionary<string, string>>(
                    File.ReadAllText(output),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = false })
                ?? throw new InvalidOperationException("Environment probe output was empty.");

            checks.Equal(
                "explicit-only",
                seen.TryGetValue("RAC_POLICY_VALUE", out var marker) ? marker : null,
                "explicit policy value reaches the child");
            checks.Equal(
                EnvironmentPolicy.MarkerValue,
                seen.TryGetValue(EnvironmentPolicy.MarkerName, out var policyMarker) ? policyMarker : null,
                "policy marker reaches the child");
            checks.True(!seen.ContainsKey(sentinelName), "ambient sentinel does not propagate to the child");
            checks.True(!seen.ContainsKey("PATH"), "ambient PATH does not propagate to the child");
            checks.True(!seen.ContainsKey("USERPROFILE"), "ambient user profile does not propagate to the child");

            var expectedKeys = policy.Keys.OrderBy(key => key, StringComparer.OrdinalIgnoreCase).ToArray();
            var actualKeys = seen.Keys.OrderBy(key => key, StringComparer.OrdinalIgnoreCase).ToArray();
            checks.True(
                expectedKeys.SequenceEqual(actualKeys, StringComparer.OrdinalIgnoreCase),
                $"child environment equals the explicit policy (expected: {string.Join(",", expectedKeys)}; observed: {string.Join(",", actualKeys)})");
        }
        finally
        {
            Environment.SetEnvironmentVariable(sentinelName, null);
            ForceCleanup(owned);
        }
    }

    internal static void StdioPipesCheck(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("stdio-pipes träd 树");
        var sentinel = CreateInheritableSentinel();
        try
        {
            if (sentinel == IntPtr.Zero)
            {
                checks.True(false, $"could not create the inheritable sentinel event (Win32 error {Marshal.GetLastWin32Error()})");
                return;
            }

            RunPipedExchange(context, witness, sentinel, eofMode: false, checks, "request-response");
            RunPipedExchange(context, witness, sentinel, eofMode: true, checks, "eof");
        }
        finally
        {
            if (sentinel != IntPtr.Zero)
            {
                _ = CloseHandle(sentinel);
            }
        }
    }

    private static void RunPipedExchange(
        ScenarioContext context,
        string witness,
        IntPtr sentinel,
        bool eofMode,
        Checks checks,
        string label)
    {
        var sentinelOutput = Path.Combine(witness, $"sentinel-{label}.txt");
        var arguments = new[]
        {
            "--sentinel-out",
            sentinelOutput,
            "--sentinel-handle",
            sentinel.ToInt64().ToString(CultureInfo.InvariantCulture),
        };

        OwnedProcess? owned = null;
        try
        {
            var contract = LaunchContract.Create(
                context.StdioProbePath,
                Path.GetDirectoryName(context.StdioProbePath)!,
                arguments,
                EnvironmentPolicy.Minimal(context.PolicyTempDirectory));

            owned = WindowsProcessOwner.Launch(contract, SettlementBound, ChildStdioMode.Pipes);
            checks.True(owned.StandardStreams is not null, $"{label}: pipe custody is exposed when opted in");
            var streams = owned.StandardStreams
                ?? throw new InvalidOperationException("Pipe custody was requested but no streams were returned.");
            checks.True(IsNonInheritable(streams.StandardInput), $"{label}: parent stdin end is non-inheritable");
            checks.True(IsNonInheritable(streams.StandardOutput), $"{label}: parent stdout end is non-inheritable");
            checks.True(IsNonInheritable(streams.StandardError), $"{label}: parent stderr end is non-inheritable");

            using var standardInput = new StreamWriter(streams.StandardInput, Encoding.ASCII)
            {
                AutoFlush = true,
                NewLine = "\n",
            };
            using var standardOutput = new StreamReader(streams.StandardOutput, Encoding.ASCII);
            using var standardError = new StreamReader(streams.StandardError, Encoding.ASCII);

            checks.True(
                FixtureControl.WaitUntil(
                    () => File.Exists(sentinelOutput) && ReadTextIfAvailable(sentinelOutput) == "absent",
                    StartupBound),
                $"{label}: unrelated inheritable sentinel handle was not inherited");
            if (File.Exists(sentinelOutput))
            {
                checks.Equal("absent", ReadTextIfAvailable(sentinelOutput), $"{label}: sentinel evidence");
            }

            standardInput.WriteLine("PING");
            var pong = ReadLineBounded(standardOutput, $"{label}: stdout");
            var errorLine = ReadLineBounded(standardError, $"{label}: stderr");
            checks.Equal("PONG", pong, $"{label}: fixed ASCII response");
            checks.Equal("STDERR-MARKER", errorLine, $"{label}: distinct stderr line");
            checks.True(!string.Equals(pong, errorLine, StringComparison.Ordinal), $"{label}: stdout and stderr are distinct");

            if (eofMode)
            {
                standardInput.Dispose();
                checks.Equal("EOF", ReadLineBounded(standardOutput, $"{label}: EOF response"), $"{label}: stdin EOF is observed");
            }
            else
            {
                standardInput.WriteLine("BYE");
                checks.Equal("BYE-OK", ReadLineBounded(standardOutput, $"{label}: shutdown response"), $"{label}: fixed shutdown response");
            }

            checks.True(owned.WaitForExit(SettlementBound), $"{label}: child exits without hanging");
            checks.True(owned.ExitCode == 0, $"{label}: child exit code");
            checks.True(owned.TrySettle(TimeSpan.FromSeconds(10)), $"{label}: child job settles after pipe shutdown");
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    private static string ReadLineBounded(StreamReader reader, string label)
    {
        var task = Task.Run(() => reader.ReadLine());
        if (!task.Wait(StartupBound))
        {
            throw new TimeoutException($"{label} did not produce a bounded line within {StartupBound.TotalSeconds:0} seconds.");
        }

        return task.Result ?? throw new EndOfStreamException($"{label} closed before a line was received.");
    }

    private static string? ReadTextIfAvailable(string path)
    {
        try
        {
            return File.ReadAllText(path).Trim();
        }
        catch (IOException)
        {
            return null;
        }
    }

    private static bool IsNonInheritable(Stream stream)
    {
        return stream is FileStream fileStream
            && GetHandleInformation(fileStream.SafeFileHandle.DangerousGetHandle(), out var flags)
            && (flags & 1) == 0;
    }

    private static IntPtr CreateInheritableSentinel()
    {
        var attributes = new NativeSecurityAttributes
        {
            Length = Marshal.SizeOf<NativeSecurityAttributes>(),
            InheritHandle = 1,
        };
        return CreateEventW(ref attributes, manualReset: false, initialState: false, name: null);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        internal int InheritHandle;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateEventW(
        ref NativeSecurityAttributes attributes,
        [MarshalAs(UnmanagedType.Bool)] bool manualReset,
        [MarshalAs(UnmanagedType.Bool)] bool initialState,
        string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    internal static void StdioHandleListFailure(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("stdio-handle-list-failure träd 树");
        var previous = LaunchDiagnostics.CreateHandleListFailure;
        try
        {
            LaunchDiagnostics.CreateHandleListFailure = NativeMethods.ErrorInvalidParameter;
            var contract = LaunchContract.Create(
                context.StdioProbePath,
                Path.GetDirectoryName(context.StdioProbePath)!,
                Array.Empty<string>(),
                EnvironmentPolicy.Minimal(context.PolicyTempDirectory));

            LaunchFailureException? failure = null;
            try
            {
                using var owned = WindowsProcessOwner.Launch(
                    contract,
                    SettlementBound,
                    ChildStdioMode.Pipes);
            }
            catch (LaunchFailureException error)
            {
                failure = error;
            }

            checks.True(failure is not null, "explicit handle-list failure is reported");
            if (failure is null)
            {
                return;
            }

            checks.Equal(LaunchStage.CreateHandleList, failure.Stage, "explicit handle-list failure stage");
            checks.Equal(NativeMethods.ErrorInvalidParameter, failure.Win32Error, "explicit handle-list failure error");
            checks.True(!failure.Unsupported, "explicit handle-list failure is not the unsupported OS-attribute result");
            checks.True(failure.Cleanup is null, "explicit handle-list failure creates no process or rollback evidence");

            Thread.Sleep(500);
            checks.EmptyDirectory(witness, "explicit handle-list failure never ran child code");
        }
        finally
        {
            LaunchDiagnostics.CreateHandleListFailure = previous;
        }
    }
    internal static void CancelableStdioExchange(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("cancelable-stdio-exchange 树");
        var sentinelOutput = Path.Combine(witness, "sentinel-cancelable.txt");
        var sentinelFile = Path.Combine(witness, "sentinel-control.txt");
        File.WriteAllText(sentinelFile, "sentinel-control");
        using var sentinelStream = new FileStream(
            sentinelFile,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete);
        var sentinelHandle = sentinelStream.SafeFileHandle.DangerousGetHandle();
        OwnedProcess? owned = null;
        try
        {
            checks.True(
                SetHandleInformation(sentinelHandle, 1, 1),
                "the unrelated sentinel file handle was made inheritable");

            owned = LaunchCancelableStdioProbe(
                context,
                checks,
                "--mode",
                "echo",
                "--sentinel-out",
                sentinelOutput,
                "--sentinel-handle",
                sentinelHandle.ToInt64().ToString(CultureInfo.InvariantCulture),
                "--sentinel-path",
                sentinelFile);
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "cancelable pipe custody is exposed when opted in");
            checks.True(owned.StandardStreams is null, "legacy synchronous custody is not exposed in cancelable mode");
            if (streams is null)
            {
                return;
            }

            checks.True(AreParentHandlesNonInheritable(streams), "all parent-side named-pipe handles are non-inheritable");
            checks.True(
                FixtureControl.WaitUntil(
                    () => File.Exists(sentinelOutput) && ReadTextIfAvailable(sentinelOutput) == "absent",
                    StartupBound),
                "cancelable mode inherits only the explicit child handles, not an unrelated inheritable sentinel");
            if (File.Exists(sentinelOutput))
            {
                checks.Equal("absent", ReadTextIfAvailable(sentinelOutput), "cancelable sentinel evidence");
            }

            var ping = streams.Send(Encoding.ASCII.GetBytes("PING\n"), StartupBound);
            checks.Equal(StdioIoStatus.Completed, ping.Status, "stdin PING completes natively");
            checks.Equal(5, ping.BytesTransferred, "stdin PING reports the observed byte count");
            checks.Equal(StdioDelivery.Delivered, ping.Delivery, "a completed write with bytes reports delivered");

            checks.Equal("PONG", ReadCancelableLine(streams, error: false, StartupBound, checks), "stdout receives the fixed PONG line");
            checks.Equal("STDERR-MARKER", ReadCancelableLine(streams, error: true, StartupBound, checks), "stderr is a distinct pipe with its own line");

            var eof = streams.CloseInput(SettlementBound);
            checks.True(eof.Settled, "input close settles before EOF");
            checks.True(eof.EofDelivered, "input close closes the parent write handle (EOF)");
            checks.Equal(StdioIoStatus.NotInFlight, eof.PendingWriteStatus, "no write was in flight at input close");
            checks.Equal(StdioIoStatus.Completed, eof.LastWriteStatus, "input close preserves the already-harvested write history");
            checks.Equal(StdioDelivery.Delivered, eof.LastWriteDelivery, "input close preserves the delivered history instead of reporting None");
            checks.Equal("EOF", ReadCancelableLine(streams, error: false, StartupBound, checks), "child observes stdin EOF");

            var beforeReject = streams.Counters;
            var rejected = streams.Send(Encoding.ASCII.GetBytes("PING\n"), TimeSpan.FromSeconds(1));
            checks.Equal(StdioIoStatus.Rejected, rejected.Status, "a send after closure is rejected");
            checks.True(rejected.StopObservedBeforeSubmit, "the rejected send observed stop before any native effect");
            checks.Equal(beforeReject.WritesSubmitted, streams.Counters.WritesSubmitted, "the rejected send issued no native write");
            var rejectedRead = streams.ReadOutput(new byte[16], TimeSpan.FromSeconds(1));
            checks.True(
                rejectedRead.Status is StdioIoStatus.Rejected or StdioIoStatus.EndOfStream,
                $"a read after stop is refused or returns its already-observed terminal state (observed {rejectedRead.Status})");
            checks.True(
                rejectedRead.Status != StdioIoStatus.TimedOut,
                "a read after stop never waits for new child data");

            checks.True(owned.WaitForExit(SettlementBound), "child exits after EOF");
            checks.Equal(0, owned.ExitCode, "child exit code");
            checks.True(owned.TrySettle(TimeSpan.FromSeconds(10)), "job accounting reaches zero after the cancelable exchange");

            // Concurrent shutdown callers must share one finite settlement, not run two
            // teardowns or destroy a still-running operation.
            var firstTask = Task.Run(() => streams.Shutdown(SettlementBound));
            var secondTask = Task.Run(() => streams.Shutdown(SettlementBound));
            Task.WaitAll(new[] { firstTask, secondTask }, StartupBound);
            var first = firstTask.Result;
            var second = secondTask.Result;
            checks.True(first.Complete, $"concurrent shutdown is complete ({Describe(first)})");
            checks.True(second.Complete, "the concurrent caller receives a complete receipt");
            checks.Equal(first.InputEofDelivered, second.InputEofDelivered, "concurrent callers agree on EOF delivery");
            checks.Equal(first.OutputTerminal, second.OutputTerminal, "concurrent callers agree on the stdout terminal state");

            var third = streams.Shutdown(SettlementBound);
            checks.True(third.Complete, "a later repeated shutdown returns the same complete receipt");
            checks.True(third.StopGateClosed, "shutdown reports the stop gate was closed");
            checks.True(third.OutputPumpExited && third.ErrorPumpExited, "both read pumps exited");
            checks.True(third.OutputHandleClosed && third.ErrorHandleClosed, "both parent read handles were closed");
            checks.True(third.SubmittedWrites >= 1 && third.CompletedWrites >= 1, "receipt counts the native stdin write");
            checks.True(third.SubmittedReads >= 1 && third.CompletedReads >= 1, "receipt counts native stdout/stderr reads");
            checks.Equal(0L, third.RetainedOperationsProcessWide, "no operation was retained in the clean exchange");
            NoteReceipt(checks, "exchange", third);
            NoteHandles(checks, "exchange", streams);

            streams.Dispose();
            streams.Dispose();
            checks.True(true, "dispose is idempotent");
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void CancelableStdioReadBlocked(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("cancelable-stdio-read-blocked 树");
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchCancelableStdioProbe(context, checks, "--mode", "silent", "--silent-ms", "2500", "--marker", "LATE");
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "cancelable read custody is exposed");
            if (streams is null)
            {
                return;
            }

            var stdoutTimeout = streams.ReadOutput(new byte[64], TimeSpan.FromMilliseconds(900));
            checks.Equal(StdioIoStatus.TimedOut, stdoutTimeout.Status, "stdout read times out while the child is alive");
            checks.True(stdoutTimeout.OperationRetained, "the timed-out native read is retained, not destroyed");
            checks.True(!owned.HasExited, "the child is alive at the stdout timeout");

            var stderrTimeout = streams.ReadError(new byte[64], TimeSpan.FromMilliseconds(900));
            checks.Equal(StdioIoStatus.TimedOut, stderrTimeout.Status, "stderr read times out independently while the child is alive");
            checks.True(stderrTimeout.OperationRetained, "the timed-out stderr read is retained");
            checks.True(!owned.HasExited, "the child is alive at the stderr timeout");

            checks.Equal("LATE", ReadCancelableLine(streams, error: false, TimeSpan.FromSeconds(10), checks), "the retained native read completes when the child later writes");
            checks.True(owned.WaitForExit(SettlementBound), "the silent child exits after writing its marker");
            checks.Equal(0, owned.ExitCode, "silent child exit code");
            checks.True(owned.TrySettle(TimeSpan.FromSeconds(10)), "job accounting reaches zero after the silent child exits");

            var receipt = streams.Shutdown(SettlementBound);
            checks.True(receipt.Complete, $"shutdown is complete after a timed-out read ({Describe(receipt)})");
            checks.Equal(StdioIoStatus.EndOfStream, receipt.OutputTerminal, "stdout terminal state is EOF after the child exits");
            checks.Equal(0L, receipt.RetainedOperationsProcessWide, "a timeout alone retained no operation after clean settlement");
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void CancelableStdioWriteBackpressure(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("cancelable-stdio-write-backpressure 树");
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchCancelableStdioProbe(context, checks, "--mode", "no-read", "--stay-ms", "5000");
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "cancelable write custody is exposed");
            if (streams is null)
            {
                return;
            }

            checks.Equal("READY", ReadCancelableLine(streams, error: false, StartupBound, checks), "the non-reading child announces liveness");
            checks.True(!owned.HasExited, "the non-reading child is alive before the pending write");

            var payload = new byte[8192];
            Array.Fill(payload, (byte)'X');
            var pending = streams.Send(payload, TimeSpan.FromMilliseconds(1500));
            checks.Equal(StdioIoStatus.Submitted, pending.Status, "a send larger than the pipe buffer stays pending with a non-reading child");
            checks.True(pending.OperationRetained, "the pending write remains owned by the channel");
            checks.Equal(StdioDelivery.Unknown, pending.Delivery, "the in-flight write reports unknown delivery, not false non-delivery");
            checks.True(!owned.HasExited, "the child is still alive while the native write is pending");

            var beforeBackpressure = streams.Counters;
            var second = streams.Send(payload, TimeSpan.FromMilliseconds(500));
            checks.Equal(StdioIoStatus.Backpressure, second.Status, "a second send is refused instead of queued");
            checks.Equal(beforeBackpressure.WritesSubmitted, streams.Counters.WritesSubmitted, "backpressure issued no native write");

            var close = streams.CloseInput(TimeSpan.FromSeconds(4));
            checks.Equal(StdioIoStatus.Canceled, close.PendingWriteStatus, "the pending write is settled by CancelIoEx");
            checks.True(close.EofDelivered, "EOF is delivered after the pending write settles");
            checks.Equal(StdioDelivery.Unknown, close.PendingWriteDelivery, "the cancelled in-flight write reports unknown delivery");
            checks.Equal(StdioIoStatus.Canceled, close.LastWriteStatus, "the last write history remains the cancelled operation");
            checks.Equal(StdioDelivery.Unknown, close.LastWriteDelivery, "the cancelled write history is not reported as None");
            checks.True(!owned.HasExited, "the child is still alive when the write is cancelled (cancel, not kill)");
            checks.Note("backpressure.pending", pending.Status.ToString());
            checks.Note("backpressure.pendingDelivery", pending.Delivery.ToString());
            checks.Note("backpressure.close", close.PendingWriteStatus.ToString());
            checks.Note("backpressure.pendingCloseDelivery", close.PendingWriteDelivery.ToString());
            checks.Note("backpressure.lastWrite", $"{close.LastWriteStatus}/{close.LastWriteDelivery}");
            checks.Note("backpressure.rootAliveAfterCancel", (!owned.HasExited).ToString());

            checks.True(owned.WaitForExit(SettlementBound), "the child exits on its own bounded schedule");
            checks.Equal(0, owned.ExitCode, "non-reading child exit code");
            checks.True(owned.TrySettle(TimeSpan.FromSeconds(10)), "job accounting reaches zero after the backpressure child exits");

            var receipt = streams.Shutdown(SettlementBound);
            checks.True(receipt.Complete, $"shutdown is complete after a cancelled write ({Describe(receipt)})");
            checks.Equal(StdioIoStatus.Canceled, receipt.InputPendingStatus, "the receipt records the cancelled pending write");
            checks.True(receipt.CanceledWrites >= 1, "the receipt counts the cancelled native write");
            NoteReceipt(checks, "backpressure", receipt);
            NoteHandles(checks, "backpressure", streams);
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void CancelableStdioBrokenPipe(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("cancelable-stdio-broken-pipe 树");
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchCancelableStdioProbe(context, checks, "--mode", "no-read", "--stay-ms", "0");
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "cancelable broken-pipe custody is exposed");
            if (streams is null)
            {
                return;
            }

            checks.Equal("READY", ReadCancelableLine(streams, error: false, StartupBound, checks), "the short-lived child announced liveness");
            checks.True(owned.WaitForExit(SettlementBound), "the short-lived child exits");
            checks.Equal(0, owned.ExitCode, "short-lived child exit code");
            checks.True(owned.TrySettle(TimeSpan.FromSeconds(10)), "job accounting reaches zero before the broken-pipe send");

            var send = streams.Send(Encoding.ASCII.GetBytes("PING\n"), TimeSpan.FromSeconds(2));
            checks.True(
                send.Status is StdioIoStatus.Faulted or StdioIoStatus.EndOfStream,
                $"a send after child exit reports a closed pipe (observed {send.Status})");
            checks.True(
                send.Win32Error is NativeMethods.ErrorBrokenPipe or NativeMethods.ErrorNoData or NativeMethods.ErrorPipeNotConnected,
                $"the closed-pipe send carries a pipe error (observed {send.Win32Error})");

            var read = streams.ReadOutput(new byte[16], TimeSpan.FromSeconds(2));
            checks.Equal(StdioIoStatus.EndOfStream, read.Status, "stdout reports EOF after the child exits");

            var eof = streams.CloseInput(TimeSpan.FromSeconds(2));
            checks.True(eof.EofDelivered, "input close still delivers EOF after the child exited");

            var receipt = streams.Shutdown(SettlementBound);
            checks.True(receipt.Complete, $"shutdown is complete after a broken pipe ({Describe(receipt)})");
            checks.Equal(StdioIoStatus.EndOfStream, receipt.OutputTerminal, "the receipt records the stdout EOF classification");
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void CancelableStdioLifecycle(ScenarioContext context, Checks checks)
    {
        // Phase A: an admitted read is stopped by Dispose; neither side observes a
        // disposed wait handle and the exact owner still closes.
        var witness = context.FreshWitnessDirectory("cancelable-stdio-lifecycle 树");
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchCancelableStdioProbe(context, checks, "--mode", "silent", "--silent-ms", "4000", "--marker", "LATE");
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "lifecycle phase A exposes cancelable custody");
            if (streams is null)
            {
                return;
            }

            var readTask = Task.Run(() => streams.ReadOutput(new byte[8], TimeSpan.FromSeconds(5)));
            checks.True(
                FixtureControl.WaitUntil(() => streams.ActiveCallCount >= 1, TimeSpan.FromSeconds(2)),
                "the read is admitted before dispose");
            var disposeTask = Task.Run(() => owned.Dispose());
            checks.True(readTask.Wait(TimeSpan.FromSeconds(6)), "the admitted read returns after dispose signals stop");
            checks.True(disposeTask.Wait(TimeSpan.FromSeconds(6)), "dispose completes after the admitted read leaves");
            var readResult = readTask.Result;
            checks.True(
                readResult.Status is StdioIoStatus.Rejected or StdioIoStatus.Canceled or StdioIoStatus.EndOfStream or StdioIoStatus.TimedOut,
                $"the admitted read returns a truthful status (observed {readResult.Status})");
            checks.Equal(0, streams.ActiveCallCount, "no admitted call remains after lifecycle phase A");
            checks.True(owned.ProcessHandleClosed, "lifecycle phase A closes the process handle");
            checks.True(owned.JobHandleClosed, "lifecycle phase A closes the job handle");
            checks.Note("lifecycle.read", readResult.Status.ToString());
        }
        finally
        {
            ForceCleanup(owned);
        }

        // Phase B: an admitted Shutdown is inside its write-cancel path when Dispose runs.
        // Dispose must signal stop and wait, not close facade events the shutdown still uses.
        owned = null;
        try
        {
            owned = LaunchCancelableStdioProbe(context, checks, "--mode", "no-read", "--stay-ms", "4000");
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "lifecycle phase B exposes cancelable custody");
            if (streams is null)
            {
                return;
            }

            checks.Equal("READY", ReadCancelableLine(streams, error: false, StartupBound, checks), "lifecycle phase B child announced liveness");
            var payload = new byte[8192];
            Array.Fill(payload, (byte)'L');
            var pending = streams.Send(payload, TimeSpan.FromMilliseconds(1000));
            checks.Equal(StdioIoStatus.Submitted, pending.Status, "lifecycle phase B write is pending");

            var shutdownTask = Task.Run(() => streams.Shutdown(SettlementBound));
            checks.True(
                FixtureControl.WaitUntil(() => streams.ActiveCallCount >= 1, TimeSpan.FromSeconds(2)),
                "shutdown is admitted before dispose");
            var disposeTask = Task.Run(() => owned.Dispose());
            checks.True(shutdownTask.Wait(TimeSpan.FromSeconds(7)), "the admitted shutdown completes without a disposed-event failure");
            checks.True(disposeTask.Wait(TimeSpan.FromSeconds(7)), "dispose completes after shutdown leaves");
            var receipt = shutdownTask.Result;
            checks.True(receipt.StopGateClosed, "lifecycle phase B reports the stop gate closed");
            checks.True(!receipt.Complete || receipt.InputEofDelivered, "a complete receipt never omits EOF delivery");
            checks.Equal(0, streams.ActiveCallCount, "no admitted call remains after lifecycle phase B");
            checks.True(owned.ProcessHandleClosed, "lifecycle phase B closes the process handle");
            checks.True(owned.JobHandleClosed, "lifecycle phase B closes the job handle");
            checks.Note("lifecycle.shutdown", Describe(receipt));
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void CancelableStdioTeardownGated(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("cancelable-stdio-teardown-gated 树");
        var paused = new ManualResetEventSlim(false);
        var resume = new ManualResetEventSlim(false);
        var previousPaused = LaunchDiagnostics.ReadPumpPaused;
        var previousResume = LaunchDiagnostics.ReadPumpResume;
        LaunchDiagnostics.ReadPumpPaused = paused;
        LaunchDiagnostics.ReadPumpResume = resume;
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchCancelableStdioProbe(context, checks, "--mode", "silent", "--silent-ms", "4000", "--marker", "LATE");
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "gated teardown exposes cancelable custody");
            if (streams is null)
            {
                return;
            }

            checks.True(
                paused.Wait(TimeSpan.FromSeconds(5)),
                "the read pump reached the gated window after a possible native submit (explicit test seam)");

            // Clear the seam so resumed pumps do not pause again.
            LaunchDiagnostics.ReadPumpPaused = null;

            var disposeTask = Task.Run(() => owned.Dispose());
            checks.True(disposeTask.Wait(TimeSpan.FromSeconds(10)), "dispose returns while the gated pump is paused");
            checks.True(
                !streams.ParentHandles[1].IsClosed,
                "the timed-out joiner did not close the stdout handle the paused pump still owns");

            resume.Set();
            checks.True(
                FixtureControl.WaitUntil(
                    () => streams.ParentHandles[1].IsClosed && streams.ParentHandles[2].IsClosed,
                    TimeSpan.FromSeconds(10)),
                "the pump closes its deferred read handles after the gated window is released");
            checks.True(owned.ProcessHandleClosed, "gated teardown closes the process handle");
            checks.True(owned.JobHandleClosed, "gated teardown closes the job handle");
            checks.True(
                AbandonedOverlappedIo.RetainedCount <= AbandonedOverlappedIo.MaximumRetained,
                "gated teardown stays within the defensive retained bound");
            checks.Note("gated.paused", "true");
            checks.Note("gated.retained", AbandonedOverlappedIo.RetainedCount.ToString(CultureInfo.InvariantCulture));
            NoteHandles(checks, "gated", streams);
        }
        finally
        {
            LaunchDiagnostics.ReadPumpPaused = previousPaused;
            LaunchDiagnostics.ReadPumpResume = previousResume;
            resume.Set();
            ForceCleanup(owned);
        }
    }

    internal static void CancelableStdioSecondPumpFault(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("cancelable-stdio-second-pump 树");
        var paused = new ManualResetEventSlim(false);
        var resume = new ManualResetEventSlim(false);
        var previousPaused = LaunchDiagnostics.ReadPumpPaused;
        var previousResume = LaunchDiagnostics.ReadPumpResume;
        var previousFail = LaunchDiagnostics.FailSecondReadPumpStart;
        LaunchDiagnostics.ReadPumpPaused = paused;
        LaunchDiagnostics.ReadPumpResume = resume;
        LaunchDiagnostics.FailSecondReadPumpStart = true;

        PeerSession? peer = null;
        OwnedProcess? recovered = null;
        try
        {
            peer = PeerSession.Start(context.Fixture, Path.Combine(witness, "peer träd 树"));
            peer.AssertHealthy(checks, "before injected pump start failure");

            var negativeWitness = Path.Combine(witness, "failed-child-start.txt");
            var contract = LaunchContract.Create(
                context.StdioProbePath,
                Path.GetDirectoryName(context.StdioProbePath)!,
                new[] { "--mode", "silent", "--silent-ms", "4000", "--marker", "LATE", "--started-witness", negativeWitness },
                EnvironmentPolicy.Minimal(context.PolicyTempDirectory));

            LaunchFailureException? failure = null;
            try
            {
                using var owned = WindowsProcessOwner.Launch(contract, SettlementBound, ChildStdioMode.CancelablePipes);
            }
            catch (LaunchFailureException error)
            {
                failure = error;
            }

            checks.True(failure is not null, "the injected second-pump start failure is reported");
            if (failure is null)
            {
                return;
            }

            checks.Equal(LaunchStage.CreateStdio, failure.Stage, "injected pump start failure stage");
            var cleanup = failure.Cleanup;
            checks.True(cleanup is not null, "the suspended root was rolled back with cleanup evidence");
            if (cleanup is not null)
            {
                checks.True(cleanup.ProcessCreated, "rollback saw the suspended root");
                checks.True(cleanup.ProcessExitConfirmed, "rollback confirmed exact root exit");
                checks.True(cleanup.ProcessHandleClosed && cleanup.JobHandleClosed, "rollback closed exact handles");
                checks.True(cleanup.Complete, "rollback evidence is complete");
            }

            checks.True(paused.IsSet, "the first pump reached the gated window before the start fault");
            checks.True(CancelableOwnerLease.Held, "the first pump's owner lease is held after the start fault");

            LaunchFailureException? refused = null;
            try
            {
                using var second = WindowsProcessOwner.Launch(contract, SettlementBound, ChildStdioMode.CancelablePipes);
            }
            catch (LaunchFailureException error)
            {
                refused = error;
            }

            checks.True(refused is not null, "a second cancelable owner is refused while the first pump holds custody");
            if (refused is not null)
            {
                checks.Equal(LaunchStage.CreateStdio, refused.Stage, "second-owner refusal stage");
                checks.True(refused.Cleanup is null, "the refused second owner created no process");
            }

            peer.AssertHealthy(checks, "after injected pump start failure");
            checks.True(!File.Exists(negativeWitness), "the rolled-back child did not reach the Main entry witness");

            LaunchDiagnostics.FailSecondReadPumpStart = false;
            LaunchDiagnostics.ReadPumpPaused = null;
            resume.Set();
            checks.True(
                FixtureControl.WaitUntil(() => !CancelableOwnerLease.Held, TimeSpan.FromSeconds(10)),
                "the deferred pump releases the owner lease after cleanup");
            checks.True(
                FixtureControl.WaitUntil(() => AbandonedOverlappedIo.RetainedCount == 0, TimeSpan.FromSeconds(10)),
                "the gated pump completed without retaining a live OVERLAPPED");
            peer.AssertHealthy(checks, "after deferred pump cleanup");

            var positiveWitness = Path.Combine(witness, "recovered-child-start.txt");
            recovered = LaunchCancelableStdioProbe(context, checks, "--mode", "no-read", "--stay-ms", "0", "--started-witness", positiveWitness);
            var recoveredStreams = recovered.CancelableStreams;
            checks.True(recoveredStreams is not null, "the fresh owner exposes cancelable custody");
            if (recoveredStreams is not null)
            {
                checks.Equal("READY", ReadCancelableLine(recoveredStreams, error: false, StartupBound, checks), "a fresh owner starts after cleanup");
                checks.True(File.Exists(positiveWitness) && File.ReadAllText(positiveWitness) == "entered-main",
                    "the same Main entry witness fires in the positive control");
                checks.True(recovered.WaitForExit(SettlementBound), "the fresh owner child exits");
                checks.True(recovered.TrySettle(TimeSpan.FromSeconds(10)), "the fresh owner job settles");
            }

            recovered.Dispose();
            checks.True(recovered.ProcessHandleClosed && recovered.JobHandleClosed, "the fresh owner closes exact handles");
            recovered = null;
            peer.AssertHealthy(checks, "after fresh owner cleanup");

            checks.Note("second-pump.failureStage", failure.Stage.ToString());
            checks.Note("second-pump.cleanupComplete", (cleanup?.Complete ?? false).ToString());
            checks.Note("second-pump.secondOwnerRefused", (refused is not null).ToString());
            checks.Note("second-pump.retained", AbandonedOverlappedIo.RetainedCount.ToString(CultureInfo.InvariantCulture));
        }
        finally
        {
            LaunchDiagnostics.ReadPumpPaused = previousPaused;
            LaunchDiagnostics.ReadPumpResume = previousResume;
            LaunchDiagnostics.FailSecondReadPumpStart = previousFail;
            resume.Set();
            ForceCleanup(recovered);
            peer?.Dispose();
        }
    }

    internal static void CancelableStdioUnknownPending(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("cancelable-stdio-unknown-pending 树");
        var previous = LaunchDiagnostics.CancelIoExFailure;
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchCancelableStdioProbe(context, checks, "--mode", "no-read", "--stay-ms", "6000");
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "cancelable unknown-pending custody is exposed");
            if (streams is null)
            {
                return;
            }

            checks.Equal("READY", ReadCancelableLine(streams, error: false, StartupBound, checks), "the non-reading child announced liveness");
            var payload = new byte[8192];
            Array.Fill(payload, (byte)'Y');
            var pending = streams.Send(payload, TimeSpan.FromMilliseconds(1000));
            checks.Equal(StdioIoStatus.Submitted, pending.Status, "the write is pending before the injected cancel failure");

            // Inject a cancel-boundary failure. This is not a claim that a real CancelIoEx
            // call failed; it exercises the unknown/in-flight classification path.
            LaunchDiagnostics.CancelIoExFailure = NativeMethods.ErrorAccessDenied;

            var close = streams.CloseInput(TimeSpan.FromSeconds(3));
            checks.Equal(StdioIoStatus.UnknownPending, close.PendingWriteStatus, "the injected cancel failure is classified as unknown/in-flight");
            checks.True(!close.Settled, "an unsettled write is not reported as settled");
            checks.True(!close.EofDelivered, "the parent write handle stays open while the operation is unsettled");
            checks.Equal(StdioDelivery.Unknown, close.PendingWriteDelivery, "the unsettled write reports unknown delivery");
            checks.Equal(StdioIoStatus.UnknownPending, close.LastWriteStatus, "the last write history remains the unsettled operation");
            checks.Equal(StdioDelivery.Unknown, close.LastWriteDelivery, "the unsettled history is not reported as None");

            var receipt = streams.Shutdown(TimeSpan.FromSeconds(3));
            checks.True(!receipt.Complete, "an unsettled cancel cannot produce a complete receipt");
            checks.Equal(StdioIoStatus.UnknownPending, receipt.InputPendingStatus, "the receipt records the unsettled write");
            checks.Equal(StdioIoStatus.UnknownPending, receipt.InputLastWriteStatus, "the receipt preserves the unsettled last-write history");
            checks.Equal(StdioDelivery.Unknown, receipt.InputLastWriteDelivery, "the unsettled history is not reported as None");
            checks.True(receipt.RetainedOperationsProcessWide >= 1, "the unsettled operation is retained rather than freed");
            checks.True(receipt.OutputPumpExited && receipt.ErrorPumpExited, "the read pumps still settle independently");
            checks.True(!owned.HasExited, "no kill occurred during the unknown/in-flight classification");
            checks.Note("unknown.close", $"{close.PendingWriteStatus}/{close.PendingWriteError}/settled={close.Settled}/eof={close.EofDelivered}");
            checks.Note("unknown.lastWrite", $"{close.LastWriteStatus}/{close.LastWriteDelivery}");
            NoteReceipt(checks, "unknown", receipt);
            NoteHandles(checks, "unknown", streams);

            LaunchDiagnostics.CancelIoExFailure = previous;

            var settlement = owned.KillAndSettle(SettlementBound);
            checks.True(settlement.RootExitConfirmed, "exact root exit is confirmed after the forced stop");
            checks.True(settlement.JobEmptyConfirmed, "job accounting reaches zero after the forced stop");
            checks.True(owned.HasExited, "the synthetic child is gone after the exact job stop");

            owned.Dispose();
            checks.True(owned.ProcessHandleClosed, "forced dispose closes the process handle");
            checks.True(owned.JobHandleClosed, "forced dispose closes the job handle");
            checks.True(
                CancelableOwnerLease.Held,
                "a retained operation pins the single-owner lease until process recycle");
            checks.True(
                AbandonedOverlappedIo.RetainedCount <= AbandonedOverlappedIo.MaximumRetained,
                "the single-owner retained set stays within the defensive process bound");
        }
        finally
        {
            LaunchDiagnostics.CancelIoExFailure = previous;
            ForceCleanup(owned);
        }
    }

    internal static void CancelableStdioReadCancel(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("cancelable-stdio-read-cancel 树");
        OwnedProcess? owned = null;
        try
        {
            owned = LaunchCancelableStdioProbe(context, checks, "--mode", "silent", "--silent-ms", "5000", "--marker", "NEVER");
            var streams = owned.CancelableStreams;
            checks.True(streams is not null, "cancelable read-cancel custody is exposed");
            if (streams is null)
            {
                return;
            }

            checks.Note("read-cancel.rootExitedBefore", owned.HasExited.ToString());
            checks.Note("read-cancel.jobActiveBefore", owned.ActiveProcessCount.ToString(CultureInfo.InvariantCulture));

            var stdoutPending = streams.ReadOutput(new byte[32], TimeSpan.FromMilliseconds(700));
            checks.Equal(StdioIoStatus.TimedOut, stdoutPending.Status, "stdout native read is pending before cancellation");
            checks.True(stdoutPending.OperationRetained, "the pending stdout read remains owned");

            var stderrPending = streams.ReadError(new byte[32], TimeSpan.FromMilliseconds(700));
            checks.Equal(StdioIoStatus.TimedOut, stderrPending.Status, "stderr native read is pending before cancellation");
            checks.True(stderrPending.OperationRetained, "the pending stderr read remains owned");

            checks.True(!owned.HasExited, "the exact synthetic child is alive while both reads are pending");
            checks.True(owned.ActiveProcessCount >= 1, "the owned job still contains the synthetic child before cancellation");
            var countersBeforeStop = streams.Counters;

            // Shutdown requests read cancellation before it spends time on input EOF. The
            // child is deliberately silent and never reads stdin, so the only way the
            // pending reads settle is the exact CancelIoEx path.
            var receipt = streams.Shutdown(SettlementBound);
            checks.True(receipt.ReadStopSignaledBeforeInputClose, "read stop is signalled before input close");
            checks.Equal(StdioIoStatus.Canceled, receipt.OutputPendingStatus, "stdout pending read is settled by CancelIoEx");
            checks.Equal(StdioIoStatus.Canceled, receipt.ErrorPendingStatus, "stderr pending read is settled by CancelIoEx");
            checks.Equal(NativeMethods.ErrorOperationAborted, receipt.OutputPendingError, "stdout reports ERROR_OPERATION_ABORTED");
            checks.Equal(NativeMethods.ErrorOperationAborted, receipt.ErrorPendingError, "stderr reports ERROR_OPERATION_ABORTED");
            checks.True(receipt.CanceledReads >= 2, "both native reads are counted as cancelled");
            checks.True(receipt.OutputPumpExited && receipt.ErrorPumpExited, "both read pumps exited after cancellation");
            checks.True(receipt.OutputHandleClosed && receipt.ErrorHandleClosed, "both parent read handles were closed");
            checks.Equal(StdioIoStatus.NotInFlight, receipt.InputPendingStatus, "no stdin write was in flight");
            checks.Equal(StdioIoStatus.NotInFlight, receipt.InputLastWriteStatus, "no write exists in the read-cancel history");
            checks.Equal(StdioDelivery.None, receipt.InputLastWriteDelivery, "no write means no delivery uncertainty");
            checks.True(receipt.InputEofDelivered, "input EOF was still delivered");
            checks.Equal(0L, receipt.OutputPendingBytes, "a cancelled stdout read has no completed bytes");
            checks.Equal(0L, receipt.ErrorPendingBytes, "a cancelled stderr read has no completed bytes");
            checks.True(receipt.Complete, $"read cancellation settles the channel ({Describe(receipt)})");

            checks.True(!owned.HasExited, "the synthetic child is alive after read cancellation (cancel, not kill)");
            checks.True(owned.ActiveProcessCount >= 1, "the owned job still contains the synthetic child after read cancellation");

            var countersAfterStop = streams.Counters;
            var postStopRead = streams.ReadOutput(new byte[8], TimeSpan.FromMilliseconds(500));
            checks.True(
                postStopRead.Status is StdioIoStatus.Rejected or StdioIoStatus.Canceled or StdioIoStatus.EndOfStream,
                $"a read after read-stop is refused or terminal (observed {postStopRead.Status})");
            checks.Equal(countersAfterStop.ReadsSubmitted, streams.Counters.ReadsSubmitted, "the post-stop read issues no new native read");

            var postStopSend = streams.Send(Encoding.ASCII.GetBytes("PING\n"), TimeSpan.FromMilliseconds(500));
            checks.Equal(StdioIoStatus.Rejected, postStopSend.Status, "a send after read-stop is rejected");
            checks.Equal(countersAfterStop.WritesSubmitted, streams.Counters.WritesSubmitted, "the post-stop send issues no native write");

            checks.True(owned.WaitForExit(SettlementBound), "the synthetic child exits on its own bounded schedule");
            checks.Equal(0, owned.ExitCode, "silent child exit code");
            checks.True(owned.TrySettle(TimeSpan.FromSeconds(10)), "job accounting reaches zero after the child exits");
            checks.Equal(0u, owned.ActiveProcessCount, "the owned job is empty after settlement");
            checks.Note("read-cancel.rootExitedAfter", owned.HasExited.ToString());
            checks.Note("read-cancel.jobActiveAfter", owned.ActiveProcessCount.ToString(CultureInfo.InvariantCulture));
            NoteReceipt(checks, "read-cancel", receipt);
            NoteHandles(checks, "read-cancel", streams);

            owned.Dispose();
            checks.True(owned.ProcessHandleClosed, "read-cancel dispose closes the process handle");
            checks.True(owned.JobHandleClosed, "read-cancel dispose closes the job handle");
        }
        finally
        {
            ForceCleanup(owned);
        }
    }

    internal static void CancelableStdioRaces(ScenarioContext context, Checks checks)
    {
        const int iterations = 3;
        var payload = new byte[8192];
        Array.Fill(payload, (byte)'Z');

        for (var iteration = 0; iteration < iterations; iteration++)
        {
            var witness = context.FreshWitnessDirectory($"cancelable-stdio-races {iteration} 树");
            OwnedProcess? owned = null;
            try
            {
                owned = LaunchCancelableStdioProbe(context, checks, "--mode", "no-read", "--stay-ms", "4000");
                var streams = owned.CancelableStreams;
                checks.True(streams is not null, $"iteration {iteration}: cancelable race custody is exposed");
                if (streams is null)
                {
                    return;
                }

                checks.Equal("READY", ReadCancelableLine(streams, error: false, StartupBound, checks), $"iteration {iteration}: child announced liveness");

                var pending = streams.Send(payload, TimeSpan.FromMilliseconds(1000));
                checks.Equal(StdioIoStatus.Submitted, pending.Status, $"iteration {iteration}: write is pending");

                var firstWaiter = Task.Run(() => streams.WaitForSendCompletion(TimeSpan.FromSeconds(2)));
                var secondWaiter = Task.Run(() => streams.WaitForSendCompletion(TimeSpan.FromSeconds(1)));
                var concurrentSend = streams.Send(payload, TimeSpan.FromMilliseconds(300));
                checks.True(
                    concurrentSend.Status is StdioIoStatus.Backpressure or StdioIoStatus.Rejected,
                    $"iteration {iteration}: concurrent send is backpressure or rejected (observed {concurrentSend.Status})");

                var close = streams.CloseInput(TimeSpan.FromSeconds(3));
                checks.True(
                    close.PendingWriteStatus is StdioIoStatus.Canceled or StdioIoStatus.Completed or StdioIoStatus.NotInFlight or StdioIoStatus.UnknownPending,
                    $"iteration {iteration}: close reports a settled or explicit-unknown write (observed {close.PendingWriteStatus})");

                Task.WaitAll(new[] { firstWaiter, secondWaiter }, TimeSpan.FromSeconds(5));
                var first = firstWaiter.Result;
                var second = secondWaiter.Result;
                checks.True(
                    first.Status is StdioIoStatus.Completed or StdioIoStatus.Canceled or StdioIoStatus.UnknownPending or StdioIoStatus.Submitted or StdioIoStatus.EndOfStream or StdioIoStatus.Faulted,
                    $"iteration {iteration}: first waiter returns a truthful operation status (observed {first.Status})");
                checks.True(
                    second.Status is StdioIoStatus.Completed or StdioIoStatus.Canceled or StdioIoStatus.UnknownPending or StdioIoStatus.Submitted or StdioIoStatus.EndOfStream or StdioIoStatus.Faulted,
                    $"iteration {iteration}: second waiter returns a truthful operation status (observed {second.Status})");
                checks.True(!owned.HasExited, $"iteration {iteration}: child is alive after the concurrent close/cancel");
                checks.Note($"races.{iteration}.send", pending.Status.ToString());
                checks.Note($"races.{iteration}.concurrentSend", concurrentSend.Status.ToString());
                checks.Note($"races.{iteration}.firstWaiter", first.Status.ToString());
                checks.Note($"races.{iteration}.secondWaiter", second.Status.ToString());
                checks.Note($"races.{iteration}.close", close.PendingWriteStatus.ToString());
                checks.Note($"races.{iteration}.retained", streams.Counters.RetainedOperationsProcessWide.ToString(CultureInfo.InvariantCulture));

                var settlement = owned.KillAndSettle(TimeSpan.FromSeconds(5));
                checks.True(settlement.RootExitConfirmed, $"iteration {iteration}: exact root exit is confirmed");
                checks.True(settlement.JobEmptyConfirmed, $"iteration {iteration}: job accounting reaches zero");
                owned.Dispose();
                checks.True(owned.ProcessHandleClosed, $"iteration {iteration}: process handle is closed");
                checks.True(owned.JobHandleClosed, $"iteration {iteration}: job handle is closed");
            }
            finally
            {
                ForceCleanup(owned);
            }
        }

        // Dispose while a write observer is genuinely admitted and waiting. The observer
        // must return a truthful status instead of observing a disposed event or an
        // ambiguous handle; the owner must still close exact handles.
        OwnedProcess? disposeOwned = null;
        try
        {
            disposeOwned = LaunchCancelableStdioProbe(context, checks, "--mode", "no-read", "--stay-ms", "4000");
            var streams = disposeOwned.CancelableStreams;
            checks.True(streams is not null, "dispose race custody is exposed");
            if (streams is null)
            {
                return;
            }

            checks.Equal("READY", ReadCancelableLine(streams, error: false, StartupBound, checks), "dispose race child announced liveness");
            var pending = streams.Send(payload, TimeSpan.FromMilliseconds(1000));
            checks.Equal(StdioIoStatus.Submitted, pending.Status, "dispose race write is pending");

            var waiter = Task.Run(() => streams.WaitForSendCompletion(TimeSpan.FromSeconds(5)));
            var admitted = FixtureControl.WaitUntil(
                () => streams.ActiveCallCount >= 1,
                TimeSpan.FromSeconds(2));
            checks.True(admitted, "the write observer is admitted before dispose");

            disposeOwned.Dispose();
            checks.True(disposeOwned.ProcessHandleClosed, "dispose race closes the process handle");
            checks.True(disposeOwned.JobHandleClosed, "dispose race closes the job handle");

            checks.True(waiter.Wait(TimeSpan.FromSeconds(6)), "the admitted write observer returns after dispose");
            var observed = waiter.Result;
            checks.True(
                observed.Status is StdioIoStatus.Completed or StdioIoStatus.Canceled or StdioIoStatus.UnknownPending or StdioIoStatus.Submitted or StdioIoStatus.EndOfStream or StdioIoStatus.Faulted,
                $"the admitted observer reports a truthful operation status (observed {observed.Status})");
            checks.Note("dispose-race.waiter", observed.Status.ToString());
            checks.Note("dispose-race.delivery", observed.Delivery.ToString());
            checks.Note("dispose-race.retained", streams.Counters.RetainedOperationsProcessWide.ToString(CultureInfo.InvariantCulture));
        }
        finally
        {
            ForceCleanup(disposeOwned);
        }
    }

    private static void NoteReceipt(Checks checks, string prefix, StdioShutdownReceipt receipt)
    {
        checks.Note(prefix + ".complete", receipt.Complete.ToString());
        checks.Note(prefix + ".input", $"{receipt.InputPendingStatus}/{receipt.InputPendingError}/last={receipt.InputLastWriteStatus}/{receipt.InputLastWriteError}/lastDelivery={receipt.InputLastWriteDelivery}/eof={receipt.InputEofDelivered}");
        checks.Note(prefix + ".readStopBeforeInputClose", receipt.ReadStopSignaledBeforeInputClose.ToString());
        checks.Note(prefix + ".output", $"{receipt.OutputPendingStatus}/{receipt.OutputPendingError}/{receipt.OutputPendingBytes}/{receipt.OutputTerminal}/pump={receipt.OutputPumpExited}/closed={receipt.OutputHandleClosed}");
        checks.Note(prefix + ".error", $"{receipt.ErrorPendingStatus}/{receipt.ErrorPendingError}/{receipt.ErrorPendingBytes}/{receipt.ErrorTerminal}/pump={receipt.ErrorPumpExited}/closed={receipt.ErrorHandleClosed}");
        checks.Note(prefix + ".counters", $"r={receipt.SubmittedReads}/{receipt.CompletedReads}/{receipt.CanceledReads}/{receipt.ReadBytes};w={receipt.SubmittedWrites}/{receipt.CompletedWrites}/{receipt.CanceledWrites}/{receipt.WriteBytes}");
        checks.Note(prefix + ".retained", receipt.RetainedOperationsProcessWide.ToString(CultureInfo.InvariantCulture));
    }

    private static void NoteHandles(Checks checks, string prefix, CancelableChildStdio streams)
    {
        var index = 0;
        foreach (var handle in streams.ParentHandles)
        {
            checks.Note($"{prefix}.parent{index}.closed", handle.IsClosed.ToString());
            index++;
        }
    }

    private static OwnedProcess LaunchCancelableStdioProbe(ScenarioContext context, Checks checks, params string[] arguments)
    {
        var contract = LaunchContract.Create(
            context.StdioProbePath,
            Path.GetDirectoryName(context.StdioProbePath)!,
            arguments,
            EnvironmentPolicy.Minimal(context.PolicyTempDirectory));

        try
        {
            var owned = WindowsProcessOwner.Launch(contract, SettlementBound, ChildStdioMode.CancelablePipes);
            checks.True(owned.ProcessId > 0, "cancelable stdio launch reports a process ID");
            return owned;
        }
        catch (LaunchFailureException error)
        {
            checks.True(false, $"cancelable stdio launch failed at {error.Stage} with Win32 error {error.Win32Error}: {error.Message}");
            throw;
        }
    }

    private static string ReadCancelableLine(CancelableChildStdio streams, bool error, TimeSpan bound, Checks checks)
    {
        var builder = new StringBuilder();
        var buffer = new byte[256];
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < bound)
        {
            var remaining = bound - stopwatch.Elapsed;
            var read = error
                ? streams.ReadError(buffer, remaining)
                : streams.ReadOutput(buffer, remaining);

            if (read.Status == StdioIoStatus.Completed)
            {
                for (var index = 0; index < read.BytesRead; index++)
                {
                    if (buffer[index] == (byte)'\n')
                    {
                        return builder.ToString();
                    }

                    builder.Append((char)buffer[index]);
                }

                if (builder.Length > 256)
                {
                    checks.True(false, "bounded line read exceeded its maximum length");
                    return builder.ToString();
                }

                continue;
            }

            if (read.Status == StdioIoStatus.TimedOut)
            {
                checks.True(false, $"bounded line read timed out ({(error ? "stderr" : "stdout")}, observed {builder})");
                return builder.ToString();
            }

            checks.True(false, $"bounded line read ended with {read.Status} and Win32 error {read.Win32Error}");
            return builder.ToString();
        }

        checks.True(false, "bounded line read exceeded its time bound");
        return builder.ToString();
    }

    private static bool AreParentHandlesNonInheritable(CancelableChildStdio streams)
    {
        foreach (var handle in streams.ParentHandles)
        {
            if (handle.IsInvalid || handle.IsClosed)
            {
                return false;
            }

            if (!GetHandleInformation(handle.DangerousGetHandle(), out var flags) || (flags & 1) != 0)
            {
                return false;
            }
        }

        return true;
    }

    private static string Describe(StdioShutdownReceipt receipt) =>
        $"complete={receipt.Complete}, eof={receipt.InputEofDelivered}, "
        + $"outputs={receipt.OutputTerminal}/{receipt.OutputPumpExited}/{receipt.OutputHandleClosed}, "
        + $"errors={receipt.ErrorTerminal}/{receipt.ErrorPumpExited}/{receipt.ErrorHandleClosed}, "
        + $"retained={receipt.RetainedOperationsProcessWide}, elapsed={receipt.Elapsed.TotalMilliseconds:0} ms";

    internal static void NoStart(ScenarioContext context, Checks checks)
    {
        var witness = context.FreshWitnessDirectory("no-start träd 树");
        var environment = EnvironmentPolicy.Minimal(context.PolicyTempDirectory);
        var missingExecutable = Path.Combine(context.Fixture.ExecutableDirectory, "missing image 树.exe");
        var contract = LaunchContract.Create(missingExecutable, context.Fixture.ExecutableDirectory, Array.Empty<string>(), environment);

        LaunchFailureException? failure = null;
        try
        {
            using var owned = WindowsProcessOwner.Launch(contract, SettlementBound);
        }
        catch (LaunchFailureException error)
        {
            failure = error;
        }

        checks.True(failure is not null, "missing executable is reported as LaunchFailureException");
        if (failure is not null)
        {
            checks.Equal(LaunchStage.CreateProcess, failure.Stage, "missing executable fails at CreateProcess");
            checks.Equal(2, failure.Win32Error, "missing executable reports ERROR_FILE_NOT_FOUND");
            checks.True(failure.Cleanup is null, "no rollback evidence exists when no process was created");
        }

        checks.EmptyDirectory(witness, "no-start wrote nothing into the witness directory");

        var missingWorkingDirectory = Path.Combine(context.SuiteWitnessRoot, "missing working directory 树");
        var badDirectoryContract = LaunchContract.Create(
            context.Fixture.ExecutablePath,
            missingWorkingDirectory,
            Array.Empty<string>(),
            environment);
        LaunchFailureException? directoryFailure = null;
        try
        {
            using var owned = WindowsProcessOwner.Launch(badDirectoryContract, SettlementBound);
        }
        catch (LaunchFailureException error)
        {
            directoryFailure = error;
        }

        checks.True(directoryFailure is not null, "missing working directory is reported as LaunchFailureException");
        checks.True(directoryFailure?.Stage == LaunchStage.CreateProcess, "missing working directory fails at CreateProcess");
        checks.True(
            directoryFailure?.Win32Error == 267,
            $"missing working directory reports ERROR_DIRECTORY (observed {directoryFailure?.Win32Error})");
    }

    private static bool JobContains(OwnedProcess owned, params int[] processIds)
    {
        var members = owned.JobProcessIds;
        return processIds.All(id => members.Contains(unchecked((uint)id)));
    }

    private static OwnedProcess LaunchRoot(ScenarioContext context, string witness, Checks checks)
    {
        try
        {
            var owned = WindowsProcessOwner.Launch(
                context.Fixture.RootContract(witness, EnvironmentPolicy.Minimal(context.PolicyTempDirectory)),
                SettlementBound);
            checks.True(owned.ProcessId > 0, "launch reports a process ID as evidence");
            return owned;
        }
        catch (LaunchFailureException error)
        {
            checks.True(false, $"launch failed at {error.Stage} with Win32 error {error.Win32Error}: {error.Message}");
            throw;
        }
    }

    private static FixtureIdentity WaitForRoot(string witness, OwnedProcess owned, Checks checks)
    {
        checks.True(
            FixtureControl.WaitForFile(Path.Combine(witness, "owned-root.json"), StartupBound),
            "root published its identity");
        var root = FixtureControl.ReadIdentity(witness, "owned-root");
        checks.Equal(owned.ProcessId, root.ProcessId, "published root identity matches the owned process ID");
        return root;
    }

    private static void ForceCleanup(OwnedProcess? owned)
    {
        if (owned is null)
        {
            return;
        }

        try
        {
            if (!owned.ProcessHandleClosed)
            {
                if (!owned.HasExited)
                {
                    owned.KillAndSettle(TimeSpan.FromSeconds(5));
                }

                owned.Dispose();
            }
        }
        catch (ObjectDisposedException)
        {
        }
        catch (LaunchFailureException)
        {
        }
    }

    private static void ExpectContractRejection(Checks checks, string name, Func<LaunchContract> action)
    {
        try
        {
            _ = action();
            checks.True(false, $"{name} was accepted but should have been rejected");
        }
        catch (LaunchContractException)
        {
        }
    }

    private static string Diagnostics(Task<string>? stdout, Task<string>? stderr)
    {
        var output = stdout is { IsCompleted: true } ? stdout.Result.Trim() : string.Empty;
        var error = stderr is { IsCompleted: true } ? stderr.Result.Trim() : string.Empty;
        var detail = string.Join("; ", new[] { output, error }.Where(value => value.Length > 0));
        return detail.Length == 0 ? string.Empty : $" [supervisor output: {detail}]";
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    private static bool TerminateProcessExact(IntPtr process, uint exitCode) => TerminateProcess(process, exitCode);
}

internal sealed class PeerSession : IDisposable
{
    private const string Instance = "unrelated-same-role";

    private readonly Process _process;
    private readonly Task<string> _stdout;
    private readonly Task<string> _stderr;
    private readonly string _witnessDirectory;
    private readonly string _imagePath;

    private PeerSession(
        Process process,
        string witnessDirectory,
        string imagePath,
        FixtureIdentity identity,
        Task<string> stdout,
        Task<string> stderr)
    {
        _process = process;
        _witnessDirectory = witnessDirectory;
        _imagePath = imagePath;
        Identity = identity;
        _stdout = stdout;
        _stderr = stderr;
    }

    internal FixtureIdentity Identity { get; }

    internal int FinalHeartbeatSequence { get; private set; } = -1;

    internal static PeerSession Start(FixtureControl fixture, string witnessDirectory)
    {
        var process = fixture.StartDetachedPeer(witnessDirectory, out var stdout, out var stderr);
        try
        {
            if (!FixtureControl.WaitForFile(Path.Combine(witnessDirectory, Instance + ".json"), TimeSpan.FromSeconds(10)))
            {
                throw new InvalidOperationException("The synthetic peer did not publish its identity.");
            }

            var identity = FixtureControl.ReadIdentity(witnessDirectory, Instance);
            if (!FixtureControl.WaitForFile(Path.Combine(witnessDirectory, Instance + ".heartbeat.json"), TimeSpan.FromSeconds(10)))
            {
                throw new InvalidOperationException("The synthetic peer did not publish a heartbeat.");
            }

            return new PeerSession(process, witnessDirectory, fixture.ExecutablePath, identity, stdout, stderr);
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    internal void AssertHealthy(Checks checks, string phase)
    {
        // Observation only: exact handle state plus the fixture's PID + start ticks.
        // Heartbeat files are deliberately not read while the peer is writing them.
        checks.True(!_process.HasExited, $"{phase}: test-owned peer process has not exited{Diagnostics()}");
        checks.True(
            FixtureControl.IsExactIdentityAlive(Identity),
            $"{phase}: unrelated same-image peer keeps its exact identity{Diagnostics()}");
        checks.Equal(Identity.ProcessId, _process.Id, $"{phase}: peer process handle matches the published identity");
        checks.Equal("worker", Identity.Role, $"{phase}: peer keeps the unrelated worker role");
        checks.Equal(Instance, Identity.Instance, $"{phase}: peer keeps the unrelated instance name");
        checks.Equal(_imagePath, Identity.ExecutablePath, $"{phase}: peer runs the same image as the owned tree");
    }

    public void Dispose()
    {
        try
        {
            FixtureControl.RequestStop(_witnessDirectory, Instance + ".stop");
            if (!_process.WaitForExit(5_000))
            {
                // The peer is a test-owned helper process, not an outside process or shared service.
                _process.Kill();
                _process.WaitForExit(5_000);
            }

            try
            {
                FinalHeartbeatSequence = FixtureControl.ReadHeartbeat(_witnessDirectory, Instance).Sequence;
            }
            catch (Exception)
            {
                FinalHeartbeatSequence = -1;
            }

            Console.WriteLine(
                $"PEER stopped pid={Identity.ProcessId} final-heartbeat={FinalHeartbeatSequence}{Diagnostics()}");
        }
        finally
        {
            _process.Dispose();
        }
    }

    private string Diagnostics()
    {
        var error = _stderr.IsCompleted ? _stderr.Result.Trim() : string.Empty;
        var output = _stdout.IsCompleted ? _stdout.Result.Trim() : string.Empty;
        var detail = string.Join(
            "; ",
            new[] { error, output }.Where(value => value.Length > 0));
        return detail.Length == 0 ? string.Empty : $" [peer output: {detail}]";
    }
}
