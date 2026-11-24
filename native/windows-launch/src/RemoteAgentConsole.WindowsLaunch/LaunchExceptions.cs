#nullable enable

using System;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>The stage at which a launch failed.</summary>
public enum LaunchStage
{
    /// <summary>The supplied contract was rejected before any native resource existed.</summary>
    Contract = 0,

    /// <summary>The private Job Object could not be created.</summary>
    CreateJob = 1,

    /// <summary>Kill-on-close could not be configured or verified on the Job Object.</summary>
    ConfigureJob = 2,

    /// <summary>The creation-time job-assignment attribute list could not be built; nothing was launched.</summary>
    CreateJobAssignment = 3,

    /// <summary><c>CreateProcessW</c> failed; no process was created.</summary>
    CreateProcess = 4,

    /// <summary>The suspended process could not be confirmed as a Job Object member.</summary>
    VerifyContainment = 5,

    /// <summary>The primary thread could not be resumed safely after containment was verified.</summary>
    ResumePrimaryThread = 6,
}

/// <summary>
/// Evidence produced by the exact-handle rollback that runs after a partial launch
/// failure. Confirmed termination is distinct from an <c>AccessDenied</c> suggestion.
/// </summary>
/// <param name="ProcessCreated">A suspended process handle existed and was rolled back.</param>
/// <param name="TerminateProcessSucceeded"><c>TerminateProcess</c> succeeded on the exact handle.</param>
/// <param name="TerminateProcessAccessDeniedSuggested"><c>TerminateProcess</c> failed with <c>ERROR_ACCESS_DENIED</c>; this is only a suggestion.</param>
/// <param name="ProcessExitConfirmed">A bounded wait on the exact handle confirmed exit.</param>
/// <param name="JobTerminateSucceeded"><c>TerminateJobObject</c> succeeded.</param>
/// <param name="JobTerminateAccessDeniedSuggested"><c>TerminateJobObject</c> returned <c>ERROR_ACCESS_DENIED</c>; this is only a suggestion.</param>
/// <param name="ProcessHandleClosed">The exact process handle was closed.</param>
/// <param name="JobHandleClosed">The Job Object handle was closed (kill-on-close applied).</param>
/// <param name="ExitCode">The observed exit code, only when exit was confirmed and readable.</param>
/// <param name="Complete">Exit was confirmed and both exact handles were closed.</param>
public sealed record LaunchCleanup(
    bool ProcessCreated,
    bool TerminateProcessSucceeded,
    bool TerminateProcessAccessDeniedSuggested,
    bool ProcessExitConfirmed,
    bool JobTerminateSucceeded,
    bool JobTerminateAccessDeniedSuggested,
    bool ProcessHandleClosed,
    bool JobHandleClosed,
    int? ExitCode,
    bool Complete);

/// <summary>
/// How the primary thread's suspension state was determined at the resume guard.
/// </summary>
/// <param name="PreviousSuspendCount">The value used for the guard.</param>
/// <param name="Injected">True for an assembly-internal fault injection; no real ResumeThread call was made.</param>
/// <param name="ObservedByResumeThread">True when the value came from an actual ResumeThread call.</param>
public sealed record ResumeSuspensionObservation(
    uint PreviousSuspendCount,
    bool Injected,
    bool ObservedByResumeThread)
{
    /// <summary>
    /// The process was observed with a positive count greater than one and was decremented
    /// once by ResumeThread, so it remained suspended. Injected values are never confirmed.
    /// </summary>
    public bool ConfirmedStillSuspended =>
        ObservedByResumeThread
        && PreviousSuspendCount > 1
        && PreviousSuspendCount != uint.MaxValue;

    /// <summary>
    /// ResumeThread observed a previous count of zero: the process may already have been
    /// externally resumed or runnable, so no "never resumed" claim is made.
    /// </summary>
    public bool PossiblyExternallyResumed =>
        ObservedByResumeThread && PreviousSuspendCount == 0;

    /// <summary>
    /// The real state is unknown: an injected value was used, or ResumeThread failed.
    /// </summary>
    public bool SuspensionStateUnknown =>
        Injected || PreviousSuspendCount == uint.MaxValue;
}

/// <summary>
/// Raised when a launch fails after contract validation. The failure identifies its
/// stage, the Win32 error when one exists, and the handle-based rollback evidence.
/// </summary>
public sealed class LaunchFailureException : Exception
{
    /// <summary>Creates the exception.</summary>
    public LaunchFailureException(
        LaunchStage stage,
        int win32Error,
        string message,
        LaunchCleanup? cleanup = null,
        bool unsupported = false,
        ResumeSuspensionObservation? resumeObservation = null)
        : base(message)
    {
        Stage = stage;
        Win32Error = win32Error;
        Cleanup = cleanup;
        Unsupported = unsupported;
        ResumeObservation = resumeObservation;
    }

    /// <summary>The stage that failed.</summary>
    public LaunchStage Stage { get; }

    /// <summary>The Win32 error code, or 0 when the failure was raised from verified state.</summary>
    public int Win32Error { get; }

    /// <summary>Rollback evidence, or null when no native process resource was created.</summary>
    public LaunchCleanup? Cleanup { get; }

    /// <summary>
    /// True when the creation-time job-assignment API is unavailable or rejected the
    /// attribute. Nothing was launched and no unsandboxed fallback was attempted.
    /// </summary>
    public bool Unsupported { get; }

    /// <summary>
    /// The resume-guard evidence, when the failure occurred at or after the suspension
    /// check. It distinguishes an injected value from an actual ResumeThread observation.
    /// </summary>
    public ResumeSuspensionObservation? ResumeObservation { get; }
}

/// <summary>Result of an explicit, bounded stop of an owned process tree.</summary>
/// <param name="RootExitConfirmed">A bounded wait on the exact root handle confirmed exit.</param>
/// <param name="JobEmptyConfirmed">Job accounting reached zero active processes within the bound.</param>
/// <param name="ExitCode">The root exit code, only when exit was confirmed and readable.</param>
/// <param name="TerminateProcessSucceeded"><c>TerminateProcess</c> succeeded on the exact root handle.</param>
/// <param name="TerminateProcessAccessDeniedSuggested"><c>TerminateProcess</c> returned <c>ERROR_ACCESS_DENIED</c>; only a suggestion.</param>
/// <param name="JobTerminateSucceeded"><c>TerminateJobObject</c> succeeded.</param>
/// <param name="JobTerminateAccessDeniedSuggested"><c>TerminateJobObject</c> returned <c>ERROR_ACCESS_DENIED</c>; only a suggestion.</param>
/// <param name="Elapsed">Wall-clock duration of the stop and settlement.</param>
public sealed record KillSettlement(
    bool RootExitConfirmed,
    bool JobEmptyConfirmed,
    int? ExitCode,
    bool TerminateProcessSucceeded,
    bool TerminateProcessAccessDeniedSuggested,
    bool JobTerminateSucceeded,
    bool JobTerminateAccessDeniedSuggested,
    TimeSpan Elapsed);
