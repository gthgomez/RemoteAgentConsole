#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// Classification of one stdio operation. The values distinguish what the kernel reported
/// from what the caller's deadline did, and never imply a provider or agent turn result.
/// </summary>
public enum StdioIoStatus
{
    /// <summary>The native operation completed and its byte count was observed.</summary>
    Completed = 0,

    /// <summary>A write was submitted and is still owned by the channel; completion was not observed within the caller bound.</summary>
    Submitted = 1,

    /// <summary>A read observed end-of-stream, or a write failed because the child end was closed.</summary>
    EndOfStream = 2,

    /// <summary><c>CancelIoEx</c> settled the exact overlapped operation with <c>ERROR_OPERATION_ABORTED</c>.</summary>
    Canceled = 3,

    /// <summary>The caller's bounded wait expired. The native operation is unchanged and still owned by the channel.</summary>
    TimedOut = 4,

    /// <summary>A send was refused because one bounded in-flight write already exists; nothing was queued.</summary>
    Backpressure = 5,

    /// <summary>The operation was refused because stop had already begun; no native effect was issued.</summary>
    Rejected = 6,

    /// <summary>The native operation failed with the recorded Win32 error.</summary>
    Faulted = 7,

    /// <summary>Cancellation was requested but the operation did not settle within the bound; its buffers are retained.</summary>
    UnknownPending = 8,

    /// <summary>No native operation was in flight for the direction at the recorded transition.</summary>
    NotInFlight = 9,
}

/// <summary>
/// Honest delivery evidence for a write. A post-submission cancellation or fault cannot
/// rule out a partial delivery, so it is <see cref="Unknown"/>, not a false claim of
/// delivery or non-delivery. Only an observed positive byte count is
/// <see cref="Delivered"/>, and only a pre-submission refusal or a zero-byte successful
/// request is <see cref="None"/>.
/// </summary>
public enum StdioDelivery
{
    /// <summary>The operation was refused before submission or transferred zero bytes successfully.</summary>
    None = 0,

    /// <summary>A completion observed a positive transferred byte count.</summary>
    Delivered = 1,

    /// <summary>A submitted operation was cancelled, faulted or is still in flight, so partial delivery cannot be ruled out.</summary>
    Unknown = 2,
}

/// <summary>Evidence for one send attempt.</summary>
/// <param name="Status">The classified outcome.</param>
/// <param name="BytesRequested">Payload size for this call.</param>
/// <param name="BytesTransferred">Completion byte count when one was observed; otherwise 0.</param>
/// <param name="Win32Error">The native error, or 0.</param>
/// <param name="StopObservedBeforeSubmit">True when stop was already visible, so no native write was issued.</param>
/// <param name="Delivery">Honest delivery evidence; <see cref="StdioDelivery.Unknown"/> for a cancelled, faulted or in-flight write.</param>
/// <param name="OperationRetained">True when an in-flight operation remains owned by the channel.</param>
public readonly record struct StdioSendResult(
    StdioIoStatus Status,
    int BytesRequested,
    int BytesTransferred,
    int Win32Error,
    bool StopObservedBeforeSubmit,
    StdioDelivery Delivery,
    bool OperationRetained);

/// <summary>Evidence for one bounded read attempt.</summary>
/// <param name="Status">The classified outcome.</param>
/// <param name="BytesRead">Bytes copied to the caller, or 0.</param>
/// <param name="Win32Error">The native error, or 0.</param>
/// <param name="OperationRetained">True when a timed-out native read is still owned by the channel.</param>
public readonly record struct StdioReadResult(
    StdioIoStatus Status,
    int BytesRead,
    int Win32Error,
    bool OperationRetained);

/// <summary>Evidence for the idempotent input-close (EOF) transition.</summary>
/// <param name="Settled">True when no write remained unsettled, so the write handle could be closed safely.</param>
/// <param name="EofDelivered">True when the parent write handle was closed, which is what delivers EOF to the child.</param>
/// <param name="PendingWriteStatus">Outcome of the write that was in flight when close began, or <see cref="StdioIoStatus.NotInFlight"/>.</param>
/// <param name="PendingWriteError">The pending write's native error, or 0.</param>
/// <param name="PendingWriteDelivery">Honest delivery evidence for the pending write.</param>
/// <param name="LastWriteStatus">The most recent observed write outcome, even when another observer harvested it before close.</param>
/// <param name="LastWriteError">The last observed write's native error, or 0.</param>
/// <param name="LastWriteDelivery">Honest delivery evidence for the last observed write.</param>
/// <param name="Elapsed">Wall-clock duration of the close attempt.</param>
public readonly record struct StdioEofResult(
    bool Settled,
    bool EofDelivered,
    StdioIoStatus PendingWriteStatus,
    int PendingWriteError,
    StdioDelivery PendingWriteDelivery,
    StdioIoStatus LastWriteStatus,
    int LastWriteError,
    StdioDelivery LastWriteDelivery,
    TimeSpan Elapsed);

/// <summary>Aggregate, finite evidence for a full cancelable-stdio shutdown.</summary>
/// <param name="InputPendingStatus">Outcome of the write in flight when stop began, or <see cref="StdioIoStatus.NotInFlight"/>.</param>
/// <param name="InputPendingError">That write's native error, or 0.</param>
/// <param name="InputLastWriteStatus">The most recent observed write outcome, even if another observer harvested it before close.</param>
/// <param name="InputLastWriteError">The last observed write's native error, or 0.</param>
/// <param name="InputLastWriteDelivery">Honest delivery evidence for the last observed write.</param>
/// <param name="InputEofDelivered">True when the parent write handle was closed and EOF was delivered.</param>
/// <param name="ReadStopSignaledBeforeInputClose">True when both read pumps were signalled to stop before input settlement.</param>
/// <param name="OutputPendingStatus">Outcome of the read in flight on stdout when stop began.</param>
/// <param name="OutputPendingError">That read's native error, or 0.</param>
/// <param name="OutputPendingBytes">Native bytes the pending stdout read completed with before stop, if any.</param>
/// <param name="OutputTerminal">The final stdout classification (EOF, fault, cancellation, or unknown).</param>
/// <param name="OutputPumpExited">True when the stdout pump thread was observed to exit within the bound.</param>
/// <param name="OutputHandleClosed">True when the parent stdout handle was closed after the pump settled.</param>
/// <param name="ErrorPendingStatus">Outcome of the read in flight on stderr when stop began.</param>
/// <param name="ErrorPendingError">That read's native error, or 0.</param>
/// <param name="ErrorPendingBytes">Native bytes the pending stderr read completed with before stop, if any.</param>
/// <param name="ErrorTerminal">The final stderr classification.</param>
/// <param name="ErrorPumpExited">True when the stderr pump thread was observed to exit within the bound.</param>
/// <param name="ErrorHandleClosed">True when the parent stderr handle was closed after the pump settled.</param>
/// <param name="StopGateClosed">The stop gate flag was set. This is gate state only; post-stop rejection and zero native submissions are asserted by the fixture, not inferred from this flag.</param>
/// <param name="SubmittedReads">Native reads issued across stdout and stderr.</param>
/// <param name="CompletedReads">Native reads that completed with data, including a completion raced by cancellation.</param>
/// <param name="CanceledReads">Native reads settled by <c>CancelIoEx</c>.</param>
/// <param name="ReadBytes">Native bytes read by completed reads, whether or not a caller copied them before stop.</param>
/// <param name="SubmittedWrites">Native writes issued on stdin.</param>
/// <param name="CompletedWrites">Native writes that completed successfully.</param>
/// <param name="CanceledWrites">Native writes settled by <c>CancelIoEx</c>.</param>
/// <param name="WriteBytes">Bytes accepted by completed writes.</param>
/// <param name="RetainedOperationsProcessWide">Process-wide count of operations abandoned to lifetime retention after an unsettled cancel.</param>
/// <param name="Complete">True when EOF was delivered, both pumps exited, both read handles closed, the gate was observed, and no direction is <see cref="StdioIoStatus.UnknownPending"/>.</param>
/// <param name="Elapsed">Wall-clock duration of the shutdown.</param>
public sealed record StdioShutdownReceipt(
    StdioIoStatus InputPendingStatus,
    int InputPendingError,
    StdioIoStatus InputLastWriteStatus,
    int InputLastWriteError,
    StdioDelivery InputLastWriteDelivery,
    bool InputEofDelivered,
    bool ReadStopSignaledBeforeInputClose,
    StdioIoStatus OutputPendingStatus,
    int OutputPendingError,
    long OutputPendingBytes,
    StdioIoStatus OutputTerminal,
    bool OutputPumpExited,
    bool OutputHandleClosed,
    StdioIoStatus ErrorPendingStatus,
    int ErrorPendingError,
    long ErrorPendingBytes,
    StdioIoStatus ErrorTerminal,
    bool ErrorPumpExited,
    bool ErrorHandleClosed,
    bool StopGateClosed,
    long SubmittedReads,
    long CompletedReads,
    long CanceledReads,
    long ReadBytes,
    long SubmittedWrites,
    long CompletedWrites,
    long CanceledWrites,
    long WriteBytes,
    long RetainedOperationsProcessWide,
    bool Complete,
    TimeSpan Elapsed);

/// <summary>Monotonic counters for the cancelable stdio channels.</summary>
/// <param name="WritesSubmitted">Native writes issued on stdin.</param>
/// <param name="WritesCompleted">Native writes completed successfully.</param>
/// <param name="WritesCanceled">Native writes settled by cancellation.</param>
/// <param name="WriteBytes">Bytes accepted by completed writes.</param>
/// <param name="ReadsSubmitted">Native reads issued on stdout and stderr.</param>
/// <param name="ReadsCompleted">Native reads that completed with data.</param>
/// <param name="ReadsCanceled">Native reads settled by cancellation.</param>
/// <param name="ReadBytes">Native bytes read by completed reads.</param>
/// <param name="RetainedOperationsProcessWide">Process-wide count of operations abandoned to lifetime retention.</param>
public readonly record struct StdioStreamCounters(
    long WritesSubmitted,
    long WritesCompleted,
    long WritesCanceled,
    long WriteBytes,
    long ReadsSubmitted,
    long ReadsCompleted,
    long ReadsCanceled,
    long ReadBytes,
    long RetainedOperationsProcessWide);

/// <summary>
/// Parent-side custody of a child's stdin/stdout/stderr over private local named pipes.
/// The parent ends are overlapped and cancelable; the child ends are ordinary synchronous
/// inherited pipe handles. Each direction has at most one bounded operation in flight, so
/// in-flight memory and backpressure are bounded. Stop is a gate before effect, every
/// cancellation is observed through the exact <c>OVERLAPPED</c> completion, and a bounded
/// caller wait never frees or closes an operation that is still running.
/// </summary>
/// <remarks>
/// The facade admits public calls at entry and refuses new calls after disposal starts.
/// Disposal signals channel stop without disposing shared wait handles, then waits within
/// a bound for admitted calls to leave. Channel and facade handles are disposed only after
/// the admitted count reaches zero, by exactly one finalizer (disposal or the last exiting
/// caller). No admitted wait observes a disposed handle and no signaler can race event
/// closure. A cancellation operation that cannot settle is retained, never freed.
/// </remarks>
public sealed class CancelableChildStdio : IDisposable
{
    private static readonly TimeSpan MaximumBound = TimeSpan.FromSeconds(60);
    private const int ForcedDrainMilliseconds = 5000;

    private readonly OverlappedWriteChannel _input;
    private readonly OverlappedReadChannel _output;
    private readonly OverlappedReadChannel _error;
    private readonly ManualResetEvent _shutdownCompleted = new(false);
    private readonly ManualResetEvent _eofCompleted = new(false);
    private readonly object _resultGate = new();
    private readonly object _lifecycleGate = new();
    private readonly DeferredLeaseRelease _leaseRelease;
    private StdioShutdownReceipt? _receipt;
    private StdioEofResult? _eofResult;
    private int _shutdownOwner;
    private int _eofOwner;
    private int _activeCalls;
    private bool _disposeRequested;
    private bool _disposeTimedOut;
    private bool _finalized;
    private int _disposeStarted;

    internal CancelableChildStdio(
        OverlappedWriteChannel input,
        OverlappedReadChannel output,
        OverlappedReadChannel error,
        DeferredLeaseRelease leaseRelease)
    {
        _input = input;
        _output = output;
        _error = error;
        _leaseRelease = leaseRelease;
    }

    internal void Start()
    {
        try
        {
            _output.Start();

            if (LaunchDiagnostics.ReadPumpPaused is { } paused)
            {
                // Deterministic second-pump fault window: wait until the first pump owns a
                // submitted read before injecting the second start failure.
                paused.Wait(TimeSpan.FromSeconds(5));
            }

            if (LaunchDiagnostics.FailSecondReadPumpStart)
            {
                throw new InvalidOperationException(
                    "Injected second read-pump start failure; the child was never resumed.");
            }

            _error.Start();
        }
        catch (Exception failure)
        {
            try
            {
                Dispose();
            }
            catch (Exception cleanupFailure)
            {
                failure.Data["rac.stdioCleanupFailure"] = cleanupFailure;
            }
            throw;
        }
    }

    internal IReadOnlyList<SafeFileHandle> ParentHandles => new[]
    {
        _input.Handle,
        _output.Handle,
        _error.Handle,
    };

    /// <summary>Number of admitted public calls currently inside the facade. Test evidence only.</summary>
    internal int ActiveCallCount
    {
        get
        {
            lock (_lifecycleGate)
            {
                return _activeCalls;
            }
        }
    }

    /// <summary>Current monotonic counters. Reading them never issues I/O.</summary>
    public StdioStreamCounters Counters => new(
        _input.SubmittedWrites,
        _input.CompletedWrites,
        _input.CanceledWrites,
        _input.BytesWritten,
        _output.SubmittedReads + _error.SubmittedReads,
        _output.CompletedReads + _error.CompletedReads,
        _output.CanceledReads + _error.CanceledReads,
        _output.BytesRead + _error.BytesRead,
        AbandonedOverlappedIo.RetainedCount);

    /// <summary>
    /// Sends one bounded payload on stdin. The payload is copied into the operation's own
    /// buffer, so the caller may reuse its span immediately. Returns
    /// <see cref="StdioIoStatus.Backpressure"/> when one write is already in flight, and
    /// <see cref="StdioIoStatus.Rejected"/> (with no native effect) once stop is visible.
    /// If the completion bound expires, the operation remains owned and is reported
    /// <see cref="StdioIoStatus.Submitted"/>; call <see cref="WaitForSendCompletion"/> to
    /// observe that same operation, not a later one.
    /// </summary>
    /// <param name="payload">At most 64 KiB.</param>
    /// <param name="completionBound">How long to wait for native completion; 0..60 seconds.</param>
    public StdioSendResult Send(ReadOnlySpan<byte> payload, TimeSpan completionBound)
    {
        var bounded = Normalize(completionBound, nameof(completionBound));
        if (!TryEnter())
        {
            return RejectedSend(payload.Length);
        }

        try
        {
            return _input.Send(payload, bounded);
        }
        finally
        {
            Exit();
        }
    }

    /// <summary>
    /// Waits for the outstanding write, if any, within the bound. Returns that operation's
    /// stored result, the last observed completion when no write is pending, or
    /// <see cref="StdioIoStatus.Submitted"/> when another observer currently owns the
    /// operation (refused before effect). It never harvests a different operation.
    /// </summary>
    public StdioSendResult WaitForSendCompletion(TimeSpan timeout)
    {
        var bounded = Normalize(timeout, nameof(timeout));
        if (!TryEnter())
        {
            return RejectedSend(0);
        }

        try
        {
            return _input.WaitForSendCompletion(bounded);
        }
        finally
        {
            Exit();
        }
    }

    /// <summary>Reads a bounded amount of child stdout, waiting at most <paramref name="timeout"/>.</summary>
    public StdioReadResult ReadOutput(Span<byte> destination, TimeSpan timeout)
    {
        var bounded = Normalize(timeout, nameof(timeout));
        if (!TryEnter())
        {
            return RejectedRead();
        }

        try
        {
            return _output.Read(destination, bounded);
        }
        finally
        {
            Exit();
        }
    }

    /// <summary>Reads a bounded amount of child stderr, waiting at most <paramref name="timeout"/>.</summary>
    public StdioReadResult ReadError(Span<byte> destination, TimeSpan timeout)
    {
        var bounded = Normalize(timeout, nameof(timeout));
        if (!TryEnter())
        {
            return RejectedRead();
        }

        try
        {
            return _error.Read(destination, bounded);
        }
        finally
        {
            Exit();
        }
    }

    /// <summary>
    /// Stops accepting sends, settles the in-flight write within the bound (cancelling the
    /// exact operation if it does not complete during a short grace period), and closes the
    /// parent write handle to deliver EOF. Idempotent and safe for concurrent callers.
    /// </summary>
    public StdioEofResult CloseInput(TimeSpan timeout)
    {
        var bounded = Normalize(timeout, nameof(timeout));
        if (!TryEnter())
        {
            return RejectedEof(bounded);
        }

        try
        {
            return CloseInputCore(bounded);
        }
        finally
        {
            Exit();
        }
    }

    /// <summary>
    /// Full, finite shutdown. Both read pumps are signalled to stop and their exact pending
    /// reads are cancelled before the potentially longer input-EOF settlement, so read
    /// cancellation is prompt and independent of stdin. The receipt distinguishes a pending
    /// write, a pending read, an observed EOF, an observed cancellation, a timeout, an
    /// unknown/in-flight operation, pump exit, and handle close. Idempotent and
    /// concurrency-safe; an unsettled operation is retained, never freed.
    /// </summary>
    public StdioShutdownReceipt Shutdown(TimeSpan timeout)
    {
        var bounded = Normalize(timeout, nameof(timeout));
        if (!TryEnter())
        {
            return IncompleteReceipt(bounded);
        }

        try
        {
            return ShutdownCore(bounded);
        }
        finally
        {
            Exit();
        }
    }

    /// <summary>
    /// Forced cleanup. Admission closes immediately; the channels are signalled to stop
    /// without disposing any shared wait handle. Disposal waits a bounded interval for
    /// admitted callers to leave, then exactly one finalizer disposes the channels and
    /// facade events. A still-admitted caller finalizes them on exit. Pending operations
    /// that cannot settle are retained until process exit rather than having in-use
    /// buffers freed.
    /// </summary>
    /// <remarks>
    /// Dispose may return while a deferred read pump still owns a handle and the owner
    /// lease. It does not attest channel, root or job settlement, and no exception from
    /// cleanup is evidence of exit.
    /// </remarks>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposeStarted, 1) != 0)
        {
            return;
        }

        lock (_lifecycleGate)
        {
            _disposeRequested = true;
        }

        // Wake admitted read waiters without closing or disposing anything.
        _input.RequestStop();
        _output.RequestStop();
        _error.RequestStop();

        var finalize = false;
        lock (_lifecycleGate)
        {
            var stopwatch = Stopwatch.StartNew();
            while (_activeCalls > 0)
            {
                var remaining = ForcedDrainMilliseconds - stopwatch.Elapsed.TotalMilliseconds;
                if (remaining <= 0)
                {
                    break;
                }

                Monitor.Wait(_lifecycleGate, (int)Math.Ceiling(remaining));
            }

            if (_activeCalls == 0)
            {
                finalize = true;
            }
            else
            {
                // The last admitted caller is the finalizer; it owns channels/events now.
                _disposeTimedOut = true;
            }
        }

        if (finalize)
        {
            FinalizeLifetime();
        }
    }

    private StdioEofResult CloseInputCore(TimeSpan bounded)
    {
        if (Interlocked.CompareExchange(ref _eofOwner, 1, 0) != 0)
        {
            if (_eofCompleted.WaitOne(OverlappedReadChannel.ToMilliseconds(bounded)))
            {
                lock (_resultGate)
                {
                    if (_eofResult is { } published)
                    {
                        return published;
                    }
                }
            }

            return RejectedEof(bounded);
        }

        try
        {
            var stopwatch = Stopwatch.StartNew();
            var settlement = _input.StopAndCloseEof(bounded);
            var result = new StdioEofResult(
                settlement.Settled,
                settlement.Settled && settlement.HandleClosed,
                settlement.PendingOutcome,
                settlement.PendingError,
                settlement.PendingDelivery,
                settlement.LastWriteStatus,
                settlement.LastWriteError,
                settlement.LastWriteDelivery,
                stopwatch.Elapsed);
            lock (_resultGate)
            {
                _eofResult = result;
            }

            return result;
        }
        finally
        {
            _eofCompleted.Set();
        }
    }

    private StdioShutdownReceipt ShutdownCore(TimeSpan bounded)
    {
        if (Interlocked.CompareExchange(ref _shutdownOwner, 1, 0) != 0)
        {
            if (_shutdownCompleted.WaitOne(OverlappedReadChannel.ToMilliseconds(bounded)))
            {
                lock (_resultGate)
                {
                    if (_receipt is { } published)
                    {
                        return published;
                    }
                }
            }

            return IncompleteReceipt(bounded);
        }

        var stopwatch = Stopwatch.StartNew();
        try
        {
            // Prompt, independent read stop: cancellation is requested before the input
            // write is allowed to consume the remaining budget.
            _output.RequestStop();
            _error.RequestStop();

            var eof = CloseInputCore(Remaining(stopwatch, bounded));
            var outputSettlement = _output.StopAndSettle(Remaining(stopwatch, bounded));
            var errorSettlement = _error.StopAndSettle(Remaining(stopwatch, bounded));
            var outputClosed = _output.CloseIfSettled();
            var errorClosed = _error.CloseIfSettled();

            var receipt = new StdioShutdownReceipt(
                InputPendingStatus: eof.PendingWriteStatus,
                InputPendingError: eof.PendingWriteError,
                InputLastWriteStatus: eof.LastWriteStatus,
                InputLastWriteError: eof.LastWriteError,
                InputLastWriteDelivery: eof.LastWriteDelivery,
                InputEofDelivered: eof.EofDelivered,
                ReadStopSignaledBeforeInputClose: true,
                OutputPendingStatus: outputSettlement.PendingOutcome,
                OutputPendingError: outputSettlement.PendingError,
                OutputPendingBytes: outputSettlement.PendingBytes,
                OutputTerminal: outputSettlement.Terminal,
                OutputPumpExited: outputSettlement.PumpExited,
                OutputHandleClosed: outputClosed,
                ErrorPendingStatus: errorSettlement.PendingOutcome,
                ErrorPendingError: errorSettlement.PendingError,
                ErrorPendingBytes: errorSettlement.PendingBytes,
                ErrorTerminal: errorSettlement.Terminal,
                ErrorPumpExited: errorSettlement.PumpExited,
                ErrorHandleClosed: errorClosed,
                StopGateClosed: _input.StopRequested && _output.StopRequested && _error.StopRequested,
                SubmittedReads: outputSettlement.SubmittedReads + errorSettlement.SubmittedReads,
                CompletedReads: outputSettlement.CompletedReads + errorSettlement.CompletedReads,
                CanceledReads: outputSettlement.CanceledReads + errorSettlement.CanceledReads,
                ReadBytes: outputSettlement.BytesRead + errorSettlement.BytesRead,
                SubmittedWrites: _input.SubmittedWrites,
                CompletedWrites: _input.CompletedWrites,
                CanceledWrites: _input.CanceledWrites,
                WriteBytes: _input.BytesWritten,
                RetainedOperationsProcessWide: AbandonedOverlappedIo.RetainedCount,
                Complete: eof.EofDelivered
                    && outputSettlement.PendingOutcome != StdioIoStatus.UnknownPending
                    && errorSettlement.PendingOutcome != StdioIoStatus.UnknownPending
                    && eof.PendingWriteStatus != StdioIoStatus.UnknownPending
                    && outputSettlement.PumpExited
                    && errorSettlement.PumpExited
                    && outputClosed
                    && errorClosed,
                Elapsed: stopwatch.Elapsed);

            lock (_resultGate)
            {
                _receipt = receipt;
            }

            return receipt;
        }
        finally
        {
            _shutdownCompleted.Set();
        }
    }

    private StdioShutdownReceipt IncompleteReceipt(TimeSpan elapsed)
    {
        var last = _input.LastCompletion;
        return new StdioShutdownReceipt(
            InputPendingStatus: StdioIoStatus.UnknownPending,
            InputPendingError: 0,
            InputLastWriteStatus: last?.Status ?? StdioIoStatus.NotInFlight,
            InputLastWriteError: last?.Win32Error ?? 0,
            InputLastWriteDelivery: last?.Delivery ?? StdioDelivery.None,
            InputEofDelivered: false,
            ReadStopSignaledBeforeInputClose: _output.StopRequested && _error.StopRequested,
            OutputPendingStatus: StdioIoStatus.UnknownPending,
            OutputPendingError: 0,
            OutputPendingBytes: 0,
            OutputTerminal: StdioIoStatus.UnknownPending,
            OutputPumpExited: false,
            OutputHandleClosed: false,
            ErrorPendingStatus: StdioIoStatus.UnknownPending,
            ErrorPendingError: 0,
            ErrorPendingBytes: 0,
            ErrorTerminal: StdioIoStatus.UnknownPending,
            ErrorPumpExited: false,
            ErrorHandleClosed: false,
            StopGateClosed: _input.StopRequested,
            SubmittedReads: _output.SubmittedReads + _error.SubmittedReads,
            CompletedReads: _output.CompletedReads + _error.CompletedReads,
            CanceledReads: _output.CanceledReads + _error.CanceledReads,
            ReadBytes: _output.BytesRead + _error.BytesRead,
            SubmittedWrites: _input.SubmittedWrites,
            CompletedWrites: _input.CompletedWrites,
            CanceledWrites: _input.CanceledWrites,
            WriteBytes: _input.BytesWritten,
            RetainedOperationsProcessWide: AbandonedOverlappedIo.RetainedCount,
            Complete: false,
            Elapsed: elapsed);
    }

    private static StdioSendResult RejectedSend(int length) =>
        new(
            StdioIoStatus.Rejected,
            length,
            0,
            0,
            StopObservedBeforeSubmit: true,
            Delivery: StdioDelivery.None,
            OperationRetained: false);

    private static StdioReadResult RejectedRead() =>
        new(StdioIoStatus.Rejected, 0, 0, OperationRetained: false);

    private static StdioEofResult RejectedEof(TimeSpan elapsed) =>
        new(
            Settled: false,
            EofDelivered: false,
            PendingWriteStatus: StdioIoStatus.UnknownPending,
            PendingWriteError: NativeMethods.ErrorSemTimeout,
            PendingWriteDelivery: StdioDelivery.Unknown,
            LastWriteStatus: StdioIoStatus.NotInFlight,
            LastWriteError: 0,
            LastWriteDelivery: StdioDelivery.None,
            Elapsed: elapsed);

    private bool TryEnter()
    {
        lock (_lifecycleGate)
        {
            if (_disposeRequested)
            {
                return false;
            }

            _activeCalls++;
            return true;
        }
    }

    private void Exit()
    {
        var finalize = false;
        lock (_lifecycleGate)
        {
            _activeCalls--;
            Monitor.PulseAll(_lifecycleGate);
            if (_disposeRequested && _disposeTimedOut && _activeCalls == 0)
            {
                finalize = true;
            }
        }

        if (finalize)
        {
            FinalizeLifetime();
        }
    }

    private void FinalizeLifetime()
    {
        lock (_lifecycleGate)
        {
            if (!_disposeRequested || _activeCalls != 0 || _finalized)
            {
                return;
            }

            _finalized = true;
        }

        // No admitted call remains, so channel event disposal cannot race a signaler.
        _input.Dispose();
        _output.Dispose();
        _error.Dispose();
        _shutdownCompleted.Dispose();
        _eofCompleted.Dispose();

        // The read pumps may outlive their forced join and still retain an operation on
        // the way out. The lease is released only after both pumps have exited, and only
        // if the retained count did not grow.
        _leaseRelease.FinalizeRequested();
    }

    private static TimeSpan Normalize(TimeSpan value, string parameterName)
    {
        if (value < TimeSpan.Zero || value > MaximumBound)
        {
            throw new ArgumentOutOfRangeException(
                parameterName,
                value,
                $"The bound must be between zero and {MaximumBound.TotalSeconds:0} seconds.");
        }

        return value;
    }

    private static TimeSpan Remaining(Stopwatch stopwatch, TimeSpan bound)
    {
        var remaining = bound - stopwatch.Elapsed;
        return remaining > TimeSpan.Zero ? remaining : TimeSpan.Zero;
    }
}
