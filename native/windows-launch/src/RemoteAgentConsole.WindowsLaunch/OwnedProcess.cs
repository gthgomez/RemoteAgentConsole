#nullable enable

using System;
using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Threading;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// A process created suspended, contained by a private kill-on-close Job Object and
/// then resumed. Ownership is expressed only by the exact process and job handles
/// held here; the process ID is retained as evidence and is never used for control.
/// </summary>
/// <remarks>
/// <para>
/// Disposing while the root is running closes the Job Object, so kill-on-close
/// terminates the owned tree. <see cref="KillAndSettle"/> additionally terminates the
/// exact root handle and waits, within a bound, for job accounting to reach zero.
/// </para>
/// <para>This type is not synchronized for concurrent use.</para>
/// </remarks>
public sealed class OwnedProcess : IDisposable
{
    internal static readonly TimeSpan MaximumSettlementTimeout = TimeSpan.FromSeconds(60);

    private readonly SafeProcessHandle _process;
    private readonly SafeJobHandle _job;
    private readonly TimeSpan _settlementTimeout;
    private int _disposed;

    internal OwnedProcess(
        SafeProcessHandle process,
        SafeJobHandle job,
        int processId,
        TimeSpan settlementTimeout,
        ChildStandardStreams? standardStreams,
        CancelableChildStdio? cancelableStreams = null)
    {
        _process = process;
        _job = job;
        ProcessId = processId;
        _settlementTimeout = settlementTimeout;
        StandardStreams = standardStreams;
        CancelableStreams = cancelableStreams;
    }

    /// <summary>The reported process ID. Evidence only; never used to signal or look up the process.</summary>
    public int ProcessId { get; }

    /// <summary>
    /// Parent-side stdin/stdout/stderr custody when <see cref="ChildStdioMode.Pipes"/> was
    /// opted in; null otherwise. Output and error are distinct streams.
    /// </summary>
    public ChildStandardStreams? StandardStreams { get; }

    /// <summary>
    /// Overlapped, cancelable parent-side stdin/stdout/stderr custody when
    /// <see cref="ChildStdioMode.CancelablePipes"/> was opted in; null otherwise. Call
    /// <see cref="CancelableChildStdio.CloseInput"/> to deliver EOF and
    /// <see cref="CancelableChildStdio.Shutdown"/> for a finite, idempotent teardown.
    /// </summary>
    public CancelableChildStdio? CancelableStreams { get; }

    /// <summary>True when the exact root handle has signalled exit.</summary>
    public bool HasExited
    {
        get
        {
            ThrowIfDisposed();
            return NativeMethods.WaitForSingleObject(_process, 0) == NativeMethods.WaitObject0;
        }
    }

    /// <summary>The root exit code once it has exited; otherwise null.</summary>
    public int? ExitCode
    {
        get
        {
            ThrowIfDisposed();
            if (NativeMethods.WaitForSingleObject(_process, 0) != NativeMethods.WaitObject0)
            {
                return null;
            }

            return NativeMethods.GetExitCodeProcess(_process, out var code)
                ? unchecked((int)code)
                : null;
        }
    }

    internal SafeProcessHandle ProcessHandle => _process;

    internal SafeJobHandle JobHandle => _job;

    internal bool ProcessHandleClosed => _process.IsClosed;

    internal bool JobHandleClosed => _job.IsClosed;

    internal uint ActiveProcessCount => JobObject.QueryActiveProcessCount(_job);

    internal uint[] JobProcessIds => JobObject.QueryProcessIds(_job);

    internal uint JobLimitFlags => JobObject.QueryLimitFlags(_job);

    /// <summary>
    /// Waits, within the supplied bound, for the exact root handle to signal exit.
    /// Descendants are not awaited here; use <see cref="TrySettle"/>.
    /// </summary>
    /// <exception cref="ArgumentOutOfRangeException">The timeout is negative or beyond the bound.</exception>
    public bool WaitForExit(TimeSpan timeout)
    {
        ThrowIfDisposed();
        var bounded = NormalizeTimeout(timeout, nameof(timeout), MaximumSettlementTimeout);
        return NativeMethods.WaitForSingleObject(_process, ToMilliseconds(bounded)) == NativeMethods.WaitObject0;
    }

    /// <summary>
    /// Terminates the exact root handle, terminates the Job Object to reach owned
    /// descendants, and waits within the bound for job accounting to reach zero.
    /// Handles stay open until <see cref="Dispose"/>.
    /// </summary>
    /// <param name="timeout">Total bound; defaults to the launch settlement timeout.</param>
    public KillSettlement KillAndSettle(TimeSpan? timeout = null)
    {
        ThrowIfDisposed();
        var bounded = NormalizeTimeout(timeout ?? _settlementTimeout, nameof(timeout), MaximumSettlementTimeout);
        var stopwatch = Stopwatch.StartNew();
        var terminateProcessSucceeded = false;
        var terminateProcessAccessDenied = false;

        if (NativeMethods.WaitForSingleObject(_process, 0) != NativeMethods.WaitObject0)
        {
            terminateProcessSucceeded = NativeMethods.TerminateProcess(_process, 0x5A5A);
            if (!terminateProcessSucceeded)
            {
                terminateProcessAccessDenied = Marshal.GetLastWin32Error() == NativeMethods.ErrorAccessDenied;
            }
        }

        // Signal both terminations before any bounded wait. An unreaped root can no
        // longer consume the whole budget before descendants are signalled.
        var jobTerminateSucceeded = NativeMethods.TerminateJobObject(_job, 0x5A5A);
        var jobTerminateAccessDenied = false;
        if (!jobTerminateSucceeded)
        {
            jobTerminateAccessDenied = Marshal.GetLastWin32Error() == NativeMethods.ErrorAccessDenied;
        }

        var (rootExitConfirmed, jobEmptyConfirmed) = WaitForRootAndJobEmpty(stopwatch, bounded);
        int? exitCode = rootExitConfirmed && NativeMethods.GetExitCodeProcess(_process, out var code)
            ? unchecked((int)code)
            : null;

        return new KillSettlement(
            rootExitConfirmed,
            jobEmptyConfirmed,
            exitCode,
            terminateProcessSucceeded,
            terminateProcessAccessDenied,
            jobTerminateSucceeded,
            jobTerminateAccessDenied,
            stopwatch.Elapsed);
    }

    /// <summary>
    /// Waits within the bound for the root to exit and for job accounting to reach
    /// zero without issuing any termination request.
    /// </summary>
    public bool TrySettle(TimeSpan timeout)
    {
        ThrowIfDisposed();
        var bounded = NormalizeTimeout(timeout, nameof(timeout), MaximumSettlementTimeout);
        var stopwatch = Stopwatch.StartNew();
        var rootExited = NativeMethods.WaitForSingleObject(
            _process,
            ToMilliseconds(Remaining(stopwatch, bounded))) == NativeMethods.WaitObject0;
        return rootExited && WaitForJobEmpty(stopwatch, bounded);
    }

    /// <summary>
    /// Closes the Job Object (applying kill-on-close) and the exact process handle.
    /// Any still-running owned process is terminated by the kernel as a consequence;
    /// no process outside the Job Object is touched. This is forced cleanup; for a
    /// graceful pipe shutdown close <see cref="ChildStandardStreams.StandardInput"/>
    /// first, wait for exit/settlement, then dispose the owner and streams.
    /// </summary>
    /// <remarks>
    /// Stream cleanup is attempted unconditionally before the exact job and process handles
    /// are closed. Cancelable stream disposal may return with a deferred pump still owning
    /// a handle and the owner lease; this method does not attest channel, root or job
    /// settlement, and a cleanup exception is not evidence of exit.
    /// </remarks>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        // Forced cleanup order: cancel/stop parent-side I/O first, then close the job
        // (kill-on-close) and the exact process handle. Every step is attempted even when
        // an earlier stream cleanup throws; cancelable streams retain any operation that
        // cannot be cancelled safely rather than freeing in-use memory.
        ResourceCleanup.DisposeAll(CancelableStreams, StandardStreams, _job, _process);
    }

    internal static TimeSpan NormalizeTimeout(TimeSpan? timeout, string parameterName, TimeSpan defaultTimeout)
    {
        var value = timeout ?? defaultTimeout;
        if (value < TimeSpan.Zero || value > MaximumSettlementTimeout)
        {
            throw new ArgumentOutOfRangeException(
                parameterName,
                value,
                $"The settlement bound must be between zero and {MaximumSettlementTimeout.TotalSeconds:0} seconds.");
        }

        return value;
    }

    private bool WaitForJobEmpty(Stopwatch stopwatch, TimeSpan bound)
    {
        while (true)
        {
            if (JobObject.QueryActiveProcessCount(_job) == 0)
            {
                return true;
            }

            var remaining = Remaining(stopwatch, bound);
            if (remaining <= TimeSpan.Zero)
            {
                return false;
            }

            Thread.Sleep((int)Math.Min(25, Math.Ceiling(remaining.TotalMilliseconds)));
        }
    }

    private (bool RootExitConfirmed, bool JobEmptyConfirmed) WaitForRootAndJobEmpty(
        Stopwatch stopwatch,
        TimeSpan bound)
    {
        while (true)
        {
            var rootExitConfirmed = NativeMethods.WaitForSingleObject(_process, 0) == NativeMethods.WaitObject0;
            var jobEmptyConfirmed = JobObject.QueryActiveProcessCount(_job) == 0;
            if (rootExitConfirmed && jobEmptyConfirmed)
            {
                return (true, true);
            }

            var remaining = Remaining(stopwatch, bound);
            if (remaining <= TimeSpan.Zero)
            {
                return (rootExitConfirmed, jobEmptyConfirmed);
            }

            Thread.Sleep((int)Math.Min(25, Math.Ceiling(remaining.TotalMilliseconds)));
        }
    }

    private static TimeSpan Remaining(Stopwatch stopwatch, TimeSpan bound)
    {
        var remaining = bound - stopwatch.Elapsed;
        return remaining > TimeSpan.Zero ? remaining : TimeSpan.Zero;
    }

    private static uint ToMilliseconds(TimeSpan value)
    {
        if (value <= TimeSpan.Zero)
        {
            return 0;
        }

        var milliseconds = Math.Ceiling(value.TotalMilliseconds);
        return milliseconds >= uint.MaxValue ? uint.MaxValue - 1 : (uint)milliseconds;
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
    }
}

/// <summary>
/// Attempts every cleanup step even if an earlier one throws. The first failure is
/// rethrown after all steps have run; an exception is never treated as evidence that a
/// process, channel or job settled.
/// </summary>
internal static class ResourceCleanup
{
    internal static void DisposeAll(params IDisposable?[] resources)
    {
        Exception? first = null;
        foreach (var resource in resources)
        {
            try
            {
                resource?.Dispose();
            }
            catch (Exception error)
            {
                first ??= error;
            }
        }

        if (first is not null)
        {
            ExceptionDispatchInfo.Capture(first).Throw();
        }
    }
}
