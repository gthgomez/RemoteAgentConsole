#nullable enable

using System;
using System.Runtime.InteropServices;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// Builds a <c>PROC_THREAD_ATTRIBUTE_JOB_LIST</c> attribute list so the process is
/// assigned to the private Job Object at creation time, before it can run. If the
/// attribute API is unavailable or rejects the job list, creation fails before any
/// process exists; there is no post-create assignment or unsandboxed fallback.
/// </summary>
internal sealed class JobListAttributes : IDisposable
{
    private IntPtr _list;
    private IntPtr _jobHandleBuffer;
    private bool _initialized;

    private JobListAttributes(IntPtr list, IntPtr jobHandleBuffer)
    {
        _list = list;
        _jobHandleBuffer = jobHandleBuffer;
        _initialized = true;
    }

    internal IntPtr Pointer => _list;

    internal static JobListAttributes Create(SafeJobHandle job)
    {
        if (job.IsInvalid || job.IsClosed)
        {
            throw Failure(0, unsupported: false, "The private Job Object handle is not usable for creation-time assignment.");
        }

        if (LaunchDiagnostics.CreateJobListFailure is int injectedError)
        {
            throw Failure(
                injectedError,
                unsupported: true,
                "Creation-time job assignment was rejected by the injected fault seam; nothing was launched.");
        }

        var size = IntPtr.Zero;
        if (!NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != NativeMethods.ErrorInsufficientBuffer)
            {
                throw Failure(
                    error,
                    IsUnsupportedError(error),
                    "InitializeProcThreadAttributeList could not size the creation-time job list; nothing was launched.");
            }
        }

        if (size == IntPtr.Zero)
        {
            throw Failure(0, unsupported: true, "InitializeProcThreadAttributeList returned a zero attribute-list size; nothing was launched.");
        }

        var list = Marshal.AllocHGlobal(size);
        try
        {
            if (!NativeMethods.InitializeProcThreadAttributeList(list, 1, 0, ref size))
            {
                var error = Marshal.GetLastWin32Error();
                throw Failure(
                    error,
                    IsUnsupportedError(error),
                    "InitializeProcThreadAttributeList failed; nothing was launched.");
            }
        }
        catch
        {
            Marshal.FreeHGlobal(list);
            throw;
        }

        var jobBuffer = IntPtr.Zero;
        try
        {
            jobBuffer = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobBuffer, 0, job.DangerousGetHandle());

            if (!NativeMethods.UpdateProcThreadAttribute(
                    list,
                    0,
                    NativeMethods.ProcThreadAttributeJobList,
                    jobBuffer,
                    (IntPtr)IntPtr.Size,
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                var error = Marshal.GetLastWin32Error();
                throw Failure(
                    error,
                    IsUnsupportedError(error),
                    "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST) failed; nothing was launched.");
            }

            return new JobListAttributes(list, jobBuffer);
        }
        catch
        {
            NativeMethods.DeleteProcThreadAttributeList(list);
            if (jobBuffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(jobBuffer);
            }

            Marshal.FreeHGlobal(list);
            throw;
        }
    }

    private static bool IsUnsupportedError(int error) =>
        error is NativeMethods.ErrorNotSupported or NativeMethods.ErrorInvalidParameter or NativeMethods.ErrorCallNotImplemented;

    private static LaunchFailureException Failure(int error, bool unsupported, string message)
    {
        return new LaunchFailureException(
            LaunchStage.CreateJobAssignment,
            error,
            $"{message} No process was created and no unsandboxed fallback was attempted.",
            cleanup: null,
            unsupported: unsupported);
    }

    public void Dispose()
    {
        if (_initialized)
        {
            NativeMethods.DeleteProcThreadAttributeList(_list);
            _initialized = false;
        }

        if (_jobHandleBuffer != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_jobHandleBuffer);
            _jobHandleBuffer = IntPtr.Zero;
        }

        if (_list != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_list);
            _list = IntPtr.Zero;
        }
    }
}

/// <summary>Allocates the exact frozen Unicode environment block for CreateProcessW.</summary>
internal static class UnicodeEnvironment
{
    internal static IntPtr Allocate(string block)
    {
        // The contract block already ends with a double NUL; the extra zero word is
        // defensive and never read by the environment parser.
        var bytes = checked((block.Length + 1) * sizeof(char));
        var pointer = Marshal.AllocHGlobal(bytes);
        try
        {
            for (var index = 0; index < block.Length; index++)
            {
                Marshal.WriteInt16(pointer, index * sizeof(char), unchecked((short)block[index]));
            }

            Marshal.WriteInt16(pointer, block.Length * sizeof(char), 0);
            return pointer;
        }
        catch
        {
            Marshal.FreeHGlobal(pointer);
            throw;
        }
    }
}
