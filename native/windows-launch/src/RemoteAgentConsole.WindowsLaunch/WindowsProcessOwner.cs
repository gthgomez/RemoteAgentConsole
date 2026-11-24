#nullable enable

using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// Launch entry point for the owner-only Windows executable contract.
/// </summary>
/// <remarks>
/// <para>
/// The sequence is fixed: create a private Job Object and verify kill-on-close, build a
/// creation-time <c>PROC_THREAD_ATTRIBUTE_JOB_LIST</c> attribute list, create the process
/// suspended with an explicit absolute application path, Unicode arguments and a frozen
/// environment, confirm exact job membership, and only then resume the primary thread.
/// The process is assigned to the job by the kernel at creation; there is no post-create
/// assignment and no unsandboxed fallback.
/// </para>
/// <para>
/// There is no shell, no path or environment expansion, no ambient environment read, no
/// inherited handles, no breakaway flag, no PID lookup, no image-name matching, no
/// network listener and no installation step.
/// </para>
/// </remarks>
public static class WindowsProcessOwner
{
    internal const uint FailureExitCode = 0x5A5A;

    /// <summary>
    /// Creates and owns the contract's process tree inside a private kill-on-close
    /// Job Object.
    /// </summary>
    /// <param name="contract">The owner-qualified executable/argv/environment contract.</param>
    /// <param name="settlementTimeout">Default bound used by later stop/settle calls.</param>
    /// <param name="stdio">Optional explicit stdin/stdout/stderr pipe custody; default is no stdio.</param>
    /// <returns>The resumed, contained owner.</returns>
    /// <exception cref="LaunchContractException">The contract was rejected before any native call.</exception>
    /// <exception cref="LaunchFailureException">A stage failed; see <see cref="LaunchFailureException.Cleanup"/> and <see cref="LaunchFailureException.Unsupported"/>.</exception>
    public static OwnedProcess Launch(
        LaunchContract contract,
        TimeSpan? settlementTimeout = null,
        ChildStdioMode stdio = ChildStdioMode.None)
    {
        ArgumentNullException.ThrowIfNull(contract);
        if (stdio is not (ChildStdioMode.None or ChildStdioMode.Pipes))
        {
            throw new ArgumentOutOfRangeException(nameof(stdio), stdio, "Unsupported child stdio mode.");
        }

        var bounded = OwnedProcess.NormalizeTimeout(
            settlementTimeout,
            nameof(settlementTimeout),
            TimeSpan.FromSeconds(5));

        SafeJobHandle? job = null;
        SafeProcessHandle? process = null;
        SafeThreadHandle? thread = null;
        StdioPipes? pipes = null;
        ChildStandardStreams? streams = null;
        var inheritanceWindow = stdio == ChildStdioMode.Pipes ? StdioPipes.InheritanceWindow : null;
        if (inheritanceWindow is not null)
        {
            Monitor.Enter(inheritanceWindow);
        }

        try
        {
            job = JobObject.CreateKillOnClose();
            if (stdio == ChildStdioMode.Pipes)
            {
                pipes = StdioPipes.Create();
                streams = pipes.CreateParentStreams();
            }

            using var attributes = JobListAttributes.Create(job, pipes?.ChildHandles);

            var startup = new NativeMethods.StartupInfoEx
            {
                StartupInfo = new NativeMethods.StartupInfo
                {
                    Size = (uint)Marshal.SizeOf<NativeMethods.StartupInfoEx>(),
                },
                AttributeList = attributes.Pointer,
            };

            if (pipes is not null)
            {
                startup.StartupInfo.Flags = NativeMethods.StartfUseStdHandles;
                startup.StartupInfo.StandardInput = pipes.ChildHandles[0];
                startup.StartupInfo.StandardOutput = pipes.ChildHandles[1];
                startup.StartupInfo.StandardError = pipes.ChildHandles[2];
            }

            var commandLine = IntPtr.Zero;
            var environment = IntPtr.Zero;
            try
            {
                commandLine = Marshal.StringToHGlobalUni(contract.CommandLine);
                environment = UnicodeEnvironment.Allocate(contract.EnvironmentBlock);

                var created = NativeMethods.CreateProcessW(
                    contract.ExecutablePath,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    inheritHandles: pipes is not null,
                    NativeMethods.CreateSuspended
                        | NativeMethods.CreateUnicodeEnvironment
                        | NativeMethods.CreateDetachedProcess
                        | NativeMethods.ExtendedStartupInfoPresent,
                    environment,
                    contract.WorkingDirectory,
                    ref startup,
                    out var information);

                if (!created)
                {
                    throw new LaunchFailureException(
                        LaunchStage.CreateProcess,
                        Marshal.GetLastWin32Error(),
                        "CreateProcessW failed with creation-time job assignment and explicit handle custody; no process was created and no fallback launch was attempted.");
                }

                pipes?.CloseChildEnds();
                process = new SafeProcessHandle(information.Process);
                thread = new SafeThreadHandle(information.Thread);

                var inJob = false;
                if (!NativeMethods.IsProcessInJob(process, job, out inJob))
                {
                    throw Rollback(
                        LaunchStage.VerifyContainment,
                        Marshal.GetLastWin32Error(),
                        "IsProcessInJob failed before the process was resumed.",
                        process,
                        thread,
                        job);
                }

                if (!inJob)
                {
                    throw Rollback(
                        LaunchStage.VerifyContainment,
                        0,
                        "The process was not a member of the kill-on-close Job Object, so it was never resumed.",
                        process,
                        thread,
                        job);
                }

                var injectedSuspendCount = LaunchDiagnostics.ResumeThreadResult;
                if (injectedSuspendCount is uint injectedCount && injectedCount != 1)
                {
                    var injectedObservation = new ResumeSuspensionObservation(
                        injectedCount,
                        Injected: true,
                        ObservedByResumeThread: false);
                    throw Rollback(
                        LaunchStage.ResumePrimaryThread,
                        0,
                        $"Injected previous suspension count {injectedCount}; no real ResumeThread call was made and the "
                            + "actual suspension state was not observed. The process was rolled back without resuming it in this run.",
                        process,
                        thread,
                        job,
                        injectedObservation);
                }

                var previousSuspendCount = NativeMethods.ResumeThread(thread);
                if (previousSuspendCount == uint.MaxValue)
                {
                    var failedObservation = new ResumeSuspensionObservation(
                        previousSuspendCount,
                        Injected: false,
                        ObservedByResumeThread: true);
                    throw Rollback(
                        LaunchStage.ResumePrimaryThread,
                        Marshal.GetLastWin32Error(),
                        "ResumeThread failed after containment was verified; the suspension state is unknown.",
                        process,
                        thread,
                        job,
                        failedObservation);
                }

                if (previousSuspendCount == 0)
                {
                    var zeroObservation = new ResumeSuspensionObservation(
                        previousSuspendCount,
                        Injected: false,
                        ObservedByResumeThread: true);
                    throw Rollback(
                        LaunchStage.ResumePrimaryThread,
                        0,
                        "ResumeThread observed a previous suspension count of 0; the process may already have been "
                            + "externally resumed or runnable, so it was rolled back without claiming it had never run.",
                        process,
                        thread,
                        job,
                        zeroObservation);
                }

                if (previousSuspendCount > 1)
                {
                    var positiveObservation = new ResumeSuspensionObservation(
                        previousSuspendCount,
                        Injected: false,
                        ObservedByResumeThread: true);
                    throw Rollback(
                        LaunchStage.ResumePrimaryThread,
                        0,
                        $"ResumeThread observed a previous suspension count of {previousSuspendCount} and decremented it "
                            + "once; the process remained suspended and was rolled back.",
                        process,
                        thread,
                        job,
                        positiveObservation);
                }

                thread.Dispose();
                thread = null;

                var owned = new OwnedProcess(process, job, unchecked((int)information.ProcessId), bounded, streams);
                pipes?.Dispose();
                pipes = null;
                streams = null;
                process = null;
                job = null;
                return owned;
            }
            finally
            {
                if (environment != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(environment);
                }

                if (commandLine != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(commandLine);
                }
            }
        }
        finally
        {
            streams?.Dispose();
            pipes?.Dispose();
            thread?.Dispose();
            process?.Dispose();
            job?.Dispose();
            if (inheritanceWindow is not null)
            {
                Monitor.Exit(inheritanceWindow);
            }
        }
    }

    private static LaunchFailureException Rollback(
        LaunchStage stage,
        int win32Error,
        string message,
        SafeProcessHandle process,
        SafeThreadHandle thread,
        SafeJobHandle job,
        ResumeSuspensionObservation? resumeObservation = null)
    {
        var processCreated = !process.IsInvalid && !process.IsClosed;
        var terminateProcessSucceeded = false;
        var terminateProcessAccessDenied = false;
        var processExitConfirmed = false;
        var jobTerminateSucceeded = false;
        var jobTerminateAccessDenied = false;
        int? exitCode = null;

        if (processCreated)
        {
            terminateProcessSucceeded = NativeMethods.TerminateProcess(process, FailureExitCode);
            if (!terminateProcessSucceeded)
            {
                terminateProcessAccessDenied = Marshal.GetLastWin32Error() == NativeMethods.ErrorAccessDenied;
            }

            processExitConfirmed = NativeMethods.WaitForSingleObject(process, 5_000) == NativeMethods.WaitObject0;
        }

        if (!job.IsInvalid && !job.IsClosed)
        {
            jobTerminateSucceeded = NativeMethods.TerminateJobObject(job, FailureExitCode);
            if (!jobTerminateSucceeded)
            {
                jobTerminateAccessDenied = Marshal.GetLastWin32Error() == NativeMethods.ErrorAccessDenied;
            }
        }

        if (processCreated && !processExitConfirmed)
        {
            // Job termination (or its imminent kill-on-close) may be the only mechanism
            // that stopped the process; observe that exit before closing the handle.
            processExitConfirmed = NativeMethods.WaitForSingleObject(process, 2_000) == NativeMethods.WaitObject0;
        }

        job.Dispose();

        if (processCreated && !processExitConfirmed)
        {
            // Closing the job applies kill-on-close; observe the exact process handle one
            // last time before giving up on the handle.
            processExitConfirmed = NativeMethods.WaitForSingleObject(process, 2_000) == NativeMethods.WaitObject0;
        }

        if (processExitConfirmed && NativeMethods.GetExitCodeProcess(process, out var code))
        {
            exitCode = unchecked((int)code);
        }

        thread.Dispose();
        process.Dispose();

        var cleanup = new LaunchCleanup(
            processCreated,
            terminateProcessSucceeded,
            terminateProcessAccessDenied,
            processExitConfirmed,
            jobTerminateSucceeded,
            jobTerminateAccessDenied,
            process.IsClosed,
            job.IsClosed,
            exitCode,
            Complete: !processCreated
                || (processExitConfirmed && process.IsClosed && job.IsClosed));

        return new LaunchFailureException(
            stage,
            win32Error,
            $"{message} Exact-handle rollback: exit confirmed={processExitConfirmed}, "
                + $"TerminateProcess succeeded={terminateProcessSucceeded} "
                + $"(AccessDenied suggestion={terminateProcessAccessDenied}), "
                + $"handles closed={cleanup.ProcessHandleClosed && cleanup.JobHandleClosed}.",
            cleanup,
            unsupported: false,
            resumeObservation: resumeObservation);
    }
}

/// <summary>
/// Assembly-internal fault injection used only by the qualification suite. It is not
/// part of the public API and is never set by production code.
/// </summary>
internal static class LaunchDiagnostics
{
    /// <summary>Simulates a creation-time attribute-list failure before any process exists.</summary>
    internal static int? CreateJobListFailure { get; set; }

    /// <summary>Simulates an explicit stdio handle-list failure before CreateProcess.</summary>
    internal static int? CreateHandleListFailure { get; set; }

    /// <summary>
    /// Simulates an unsafe previous suspension count. The real ResumeThread call is not
    /// made for a non-1 value, so the process stays suspended and is rolled back; the
    /// value is marked as injected, not observed.
    /// </summary>
    internal static uint? ResumeThreadResult { get; set; }
}
