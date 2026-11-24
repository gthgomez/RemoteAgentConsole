#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
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
    internal ScenarioContext(FixtureControl fixture, string suiteWitnessRoot, string probePath)
    {
        Fixture = fixture;
        SuiteWitnessRoot = suiteWitnessRoot;
        ProbePath = probePath;
        PolicyTempDirectory = Path.Combine(suiteWitnessRoot, "policy temp");
        Directory.CreateDirectory(PolicyTempDirectory);
    }

    internal FixtureControl Fixture { get; }

    internal string SuiteWitnessRoot { get; }

    internal string ProbePath { get; }

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
