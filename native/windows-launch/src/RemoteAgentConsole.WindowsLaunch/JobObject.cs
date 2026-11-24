#nullable enable

using System;
using System.Runtime.InteropServices;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// A private Job Object configured with kill-on-close and without any breakaway
/// option. It is created per launch and never shared with another owner.
/// </summary>
internal static class JobObject
{
    internal static SafeJobHandle CreateKillOnClose()
    {
        var job = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid)
        {
            throw new LaunchFailureException(
                LaunchStage.CreateJob,
                Marshal.GetLastWin32Error(),
                "CreateJobObjectW failed; no process was created.");
        }

        try
        {
            var limits = new NativeMethods.JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new NativeMethods.JobObjectBasicLimitInformation
                {
                    LimitFlags = NativeMethods.JobObjectLimitKillOnJobClose,
                },
            };

            if (!NativeMethods.SetInformationJobObject(
                    job,
                    NativeMethods.JobObjectExtendedLimitInformationClass,
                    ref limits,
                    (uint)Marshal.SizeOf<NativeMethods.JobObjectExtendedLimitInformation>()))
            {
                throw new LaunchFailureException(
                    LaunchStage.ConfigureJob,
                    Marshal.GetLastWin32Error(),
                    "SetInformationJobObject(kill-on-close) failed; no process was created.");
            }

            var observed = QueryLimitFlags(job);
            var forbidden = NativeMethods.JobObjectLimitBreakawayOk | NativeMethods.JobObjectLimitSilentBreakawayOk;
            if ((observed & NativeMethods.JobObjectLimitKillOnJobClose) == 0 || (observed & forbidden) != 0)
            {
                throw new LaunchFailureException(
                    LaunchStage.ConfigureJob,
                    0,
                    $"The Job Object did not hold the required limits (observed 0x{observed:X8}); no process was created.");
            }

            return job;
        }
        catch
        {
            job.Dispose();
            throw;
        }
    }

    internal static uint QueryLimitFlags(SafeJobHandle job)
    {
        if (!NativeMethods.QueryInformationJobObjectExtended(
                job,
                NativeMethods.JobObjectExtendedLimitInformationClass,
                out var information,
                (uint)Marshal.SizeOf<NativeMethods.JobObjectExtendedLimitInformation>(),
                out _))
        {
            throw new LaunchFailureException(
                LaunchStage.ConfigureJob,
                Marshal.GetLastWin32Error(),
                "QueryInformationJobObject(extended limits) failed.");
        }

        return information.BasicLimitInformation.LimitFlags;
    }

    internal static uint QueryActiveProcessCount(SafeJobHandle job)
    {
        if (!NativeMethods.QueryInformationJobObjectAccounting(
                job,
                NativeMethods.JobObjectBasicAccountingInformationClass,
                out var information,
                (uint)Marshal.SizeOf<NativeMethods.JobObjectBasicAccountingInformation>(),
                out _))
        {
            throw new LaunchFailureException(
                LaunchStage.ConfigureJob,
                Marshal.GetLastWin32Error(),
                "QueryInformationJobObject(accounting) failed.");
        }

        return information.ActiveProcesses;
    }

    /// <summary>
    /// Returns the kernel's current member process IDs for evidence checks. This is a
    /// read-only query; membership itself is established by handle during launch.
    /// </summary>
    internal static uint[] QueryProcessIds(SafeJobHandle job)
    {
        const int capacity = 256;
        var length = 8 + (IntPtr.Size * capacity);
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!NativeMethods.QueryInformationJobObjectProcessIdList(
                    job,
                    NativeMethods.JobObjectBasicProcessIdListClass,
                    buffer,
                    (uint)length,
                    out _))
            {
                throw new LaunchFailureException(
                    LaunchStage.ConfigureJob,
                    Marshal.GetLastWin32Error(),
                    "QueryInformationJobObject(process list) failed.");
            }

            var assigned = unchecked((uint)Marshal.ReadInt32(buffer));
            var listed = unchecked((uint)Marshal.ReadInt32(buffer, 4));
            var count = Math.Min(Math.Min(assigned, listed), capacity);
            var result = new uint[count];
            for (var index = 0; index < count; index++)
            {
                result[index] = unchecked((uint)Marshal.ReadIntPtr(buffer, 8 + (index * IntPtr.Size)).ToInt64());
            }

            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
