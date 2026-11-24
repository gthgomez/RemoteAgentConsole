#nullable enable

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// Builds the creation-time attribute list for a launched process: the private Job
/// Object assignment and, when stdio pipes are opted in, the explicit inherited-handle
/// list. Both attributes are required before <c>CreateProcessW</c>. There is no
/// inherit-all fallback and no post-create assignment.
/// </summary>
internal sealed class JobListAttributes : IDisposable
{
    private IntPtr _list;
    private IntPtr _jobHandleBuffer;
    private IntPtr _handleListBuffer;
    private bool _initialized;

    private JobListAttributes(IntPtr list, IntPtr jobHandleBuffer, IntPtr handleListBuffer)
    {
        _list = list;
        _jobHandleBuffer = jobHandleBuffer;
        _handleListBuffer = handleListBuffer;
        _initialized = true;
    }

    internal IntPtr Pointer => _list;

    internal static JobListAttributes Create(SafeJobHandle job, IReadOnlyList<IntPtr>? inheritedHandles = null)
    {
        if (job.IsInvalid || job.IsClosed)
        {
            throw Failure(
                LaunchStage.CreateJobAssignment,
                0,
                unsupported: false,
                "The private Job Object handle is not usable for creation-time assignment.");
        }

        var handleCount = inheritedHandles?.Count ?? 0;
        if (inheritedHandles is not null && handleCount == 0)
        {
            throw Failure(
                LaunchStage.CreateHandleList,
                0,
                unsupported: false,
                "An empty explicit handle list is not valid for pipe custody.");
        }

        for (var index = 0; index < handleCount; index++)
        {
            if (inheritedHandles![index] == IntPtr.Zero)
            {
                throw Failure(
                    LaunchStage.CreateHandleList,
                    0,
                    unsupported: false,
                    $"The explicit handle list contains a null handle at index {index}.");
            }
        }

        if (LaunchDiagnostics.CreateJobListFailure is int injectedError)
        {
            throw Failure(
                LaunchStage.CreateJobAssignment,
                injectedError,
                unsupported: true,
                "Creation-time job assignment was rejected by the injected fault seam; nothing was launched.");
        }

        var attributeCount = handleCount > 0 ? 2 : 1;
        var size = IntPtr.Zero;
        if (!NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != NativeMethods.ErrorInsufficientBuffer)
            {
                throw Failure(
                    LaunchStage.CreateJobAssignment,
                    error,
                    IsUnsupportedError(error),
                    "InitializeProcThreadAttributeList could not size the creation-time attributes; nothing was launched.");
            }
        }

        if (size == IntPtr.Zero)
        {
            throw Failure(
                LaunchStage.CreateJobAssignment,
                0,
                unsupported: true,
                "InitializeProcThreadAttributeList returned a zero attribute-list size; nothing was launched.");
        }

        var list = Marshal.AllocHGlobal(size);
        try
        {
            if (!NativeMethods.InitializeProcThreadAttributeList(list, attributeCount, 0, ref size))
            {
                var error = Marshal.GetLastWin32Error();
                throw Failure(
                    LaunchStage.CreateJobAssignment,
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
        var handleBuffer = IntPtr.Zero;
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
                    LaunchStage.CreateJobAssignment,
                    error,
                    IsUnsupportedError(error),
                    "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST) failed; nothing was launched.");
            }

            if (handleCount > 0)
            {
                if (LaunchDiagnostics.CreateHandleListFailure is int injectedHandleError)
                {
                    throw Failure(
                        LaunchStage.CreateHandleList,
                        injectedHandleError,
                        false,
                        "The explicit stdio handle list was rejected by the injected fault seam; nothing was launched.");
                }

                handleBuffer = Marshal.AllocHGlobal(checked(IntPtr.Size * handleCount));
                for (var index = 0; index < handleCount; index++)
                {
                    Marshal.WriteIntPtr(handleBuffer, index * IntPtr.Size, inheritedHandles![index]);
                }

                if (!NativeMethods.UpdateProcThreadAttribute(
                        list,
                        0,
                        NativeMethods.ProcThreadAttributeHandleList,
                        handleBuffer,
                        (IntPtr)(IntPtr.Size * handleCount),
                        IntPtr.Zero,
                        IntPtr.Zero))
                {
                    var error = Marshal.GetLastWin32Error();
                    throw Failure(
                        LaunchStage.CreateHandleList,
                        error,
                        unsupported: false,
                        "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_HANDLE_LIST) failed; the pipe handles were not inherited and nothing was launched.");
                }
            }

            return new JobListAttributes(list, jobBuffer, handleBuffer);
        }
        catch
        {
            NativeMethods.DeleteProcThreadAttributeList(list);
            if (jobBuffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(jobBuffer);
            }

            if (handleBuffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(handleBuffer);
            }

            Marshal.FreeHGlobal(list);
            throw;
        }
    }

    private static bool IsUnsupportedError(int error) =>
        error is NativeMethods.ErrorNotSupported or NativeMethods.ErrorInvalidParameter or NativeMethods.ErrorCallNotImplemented;

    private static LaunchFailureException Failure(
        LaunchStage stage,
        int error,
        bool unsupported,
        string message)
    {
        return new LaunchFailureException(
            stage,
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

        if (_handleListBuffer != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_handleListBuffer);
            _handleListBuffer = IntPtr.Zero;
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
