using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace Rac.WindowsPolicy.Helper;

/// <summary>
/// Win32-owner/DACL verification by SID. Unix modes and copied ACL text are
/// irrelevant here. The policy leaf and its immediate directory must be
/// protected and owner-only; directories above them must not be replaceable or
/// permission-reassignable by an untrusted principal.
/// </summary>
internal static class WindowsSecurity
{
    private const uint DangerMask =
        NativeMethods.Delete
        | NativeMethods.FileDeleteChild
        | NativeMethods.WriteDac
        | NativeMethods.WriteOwner
        | NativeMethods.AccessSystemSecurity
        | NativeMethods.MaximumAllowed
        | NativeMethods.GenericAll
        | NativeMethods.GenericWrite;

    private static readonly HashSet<string> TrustedSids = new(StringComparer.OrdinalIgnoreCase)
    {
        "S-1-5-18", // NT AUTHORITY\SYSTEM
        "S-1-5-32-544", // BUILTIN\Administrators
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", // NT SERVICE\TrustedInstaller
    };

    private static readonly Lazy<string> CurrentUserSid = new(ReadCurrentUserSid);

    internal static string VerifyOwnerOnly(SafeFileHandle handle, string scope)
    {
        using var security = ReadSecurity(handle, scope);
        var ownerSid = SidToString(security.OwnerSid);
        if (ownerSid is null
            || !string.Equals(ownerSid, CurrentUserSid.Value, StringComparison.OrdinalIgnoreCase))
        {
            throw Denied($"{scope}-owner-mismatch");
        }

        if ((security.Control & NativeMethods.SeDaclPresent) == 0 || security.Dacl == IntPtr.Zero)
        {
            throw Denied($"{scope}-dacl-missing");
        }

        if ((security.Control & NativeMethods.SeDaclProtected) == 0)
        {
            throw Denied($"{scope}-dacl-unprotected");
        }

        var effectiveOwnerAllow = false;
        foreach (var ace in ReadAces(security.Dacl, $"{scope}-dacl-unsupported"))
        {
            if (ace.Type != NativeMethods.AccessAllowedAceType)
            {
                throw Denied($"{scope}-dacl-unsupported");
            }

            var sid = SidToString(ace.Sid);
            if (sid is null
                || !string.Equals(sid, CurrentUserSid.Value, StringComparison.OrdinalIgnoreCase))
            {
                throw Denied($"{scope}-dacl-unexpected-trustee");
            }

            if ((ace.Flags & NativeMethods.InheritOnlyAce) == 0)
            {
                effectiveOwnerAllow = true;
            }
        }

        if (!effectiveOwnerAllow)
        {
            throw Denied($"{scope}-dacl-unsupported");
        }

        return Fingerprint(security, scope);
    }

    internal static void VerifyAncestor(SafeFileHandle handle)
    {
        using var security = ReadSecurity(handle, "parent");
        var ownerSid = SidToString(security.OwnerSid);
        if (ownerSid is null || !IsTrusted(ownerSid))
        {
            throw Denied("parent-owner-untrusted");
        }

        if ((security.Control & NativeMethods.SeDaclPresent) == 0 || security.Dacl == IntPtr.Zero)
        {
            throw Denied("parent-dacl-unsafe");
        }

        foreach (var ace in ReadAces(security.Dacl, "parent-dacl-unsupported"))
        {
            if (ace.Type == NativeMethods.AccessDeniedAceType)
            {
                // A deny ACE cannot grant replacement or ACL control.
                continue;
            }

            if (ace.Type is NativeMethods.SystemMandatoryLabelAceType
                or NativeMethods.SystemResourceAttributeAceType
                or NativeMethods.SystemScopedPolicyIdAceType
                or NativeMethods.SystemAccessFilterAceType)
            {
                continue;
            }

            if (ace.Type != NativeMethods.AccessAllowedAceType)
            {
                // Object/callback ACEs complicate SID/mask interpretation. Fail
                // closed rather than guessing at a grant.
                throw Denied("parent-dacl-unsupported");
            }

            if ((ace.Flags & NativeMethods.InheritOnlyAce) != 0)
            {
                // This ACE does not apply to the ancestor object itself. The
                // child that would inherit it is inspected separately.
                continue;
            }

            var sid = SidToString(ace.Sid);
            if (sid is null)
            {
                throw Denied("parent-dacl-unsupported");
            }

            if (IsTrusted(sid))
            {
                continue;
            }

            if ((ace.Mask & DangerMask) != 0)
            {
                throw Denied("parent-dacl-unsafe");
            }
        }
    }

    private static bool IsTrusted(string sid) =>
        string.Equals(sid, CurrentUserSid.Value, StringComparison.OrdinalIgnoreCase)
        || TrustedSids.Contains(sid);

    private sealed record SecuritySnapshot(IntPtr OwnerSid, IntPtr Dacl, ushort Control, IntPtr Descriptor) : IDisposable
    {
        public void Dispose() => NativeMethods.LocalFree(Descriptor);
    }

    private static SecuritySnapshot ReadSecurity(SafeFileHandle handle, string scope)
    {
        var result = NativeMethods.GetSecurityInfo(
            handle.DangerousGetHandle(),
            NativeMethods.SeFileObject,
            NativeMethods.OwnerSecurityInformation | NativeMethods.DaclSecurityInformation,
            out var ownerSid,
            out _,
            out var dacl,
            out _,
            out var descriptor);

        if (result != 0 || descriptor == IntPtr.Zero)
        {
            throw Denied($"{scope}-security-unavailable");
        }

        if (!NativeMethods.GetSecurityDescriptorControl(descriptor, out var control, out _))
        {
            NativeMethods.LocalFree(descriptor);
            throw Denied($"{scope}-security-unavailable");
        }

        return new SecuritySnapshot(ownerSid, dacl, control, descriptor);
    }

    private static string Fingerprint(SecuritySnapshot security, string scope)
    {
        var length = NativeMethods.GetSecurityDescriptorLength(security.Descriptor);
        if (length == 0 || length > 1024 * 1024)
        {
            throw Denied($"{scope}-security-unavailable");
        }

        var byteLength = checked((int)length);
        var bytes = new byte[byteLength];
        Marshal.Copy(security.Descriptor, bytes, 0, byteLength);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    private sealed record AceEntry(byte Type, byte Flags, uint Mask, IntPtr Sid);

    private static IEnumerable<AceEntry> ReadAces(IntPtr dacl, string failureCode)
    {
        if (!NativeMethods.GetAclInformation(
                dacl,
                out var information,
                (uint)Marshal.SizeOf<NativeMethods.AclSizeInformation>(),
                2))
        {
            throw Denied(failureCode);
        }

        for (var index = 0u; index < information.AceCount; index++)
        {
            if (!NativeMethods.GetAce(dacl, index, out var acePointer))
            {
                throw Denied(failureCode);
            }

            var header = Marshal.PtrToStructure<NativeMethods.AceHeader>(acePointer);
            if (header.AceSize < 4)
            {
                throw Denied(failureCode);
            }

            if (header.AceType is not (NativeMethods.AccessAllowedAceType or NativeMethods.AccessDeniedAceType))
            {
                // Do not guess at object/callback/system ACE layouts. The
                // caller decides whether that type is ignorable or fatal.
                yield return new AceEntry(header.AceType, header.AceFlags, 0, IntPtr.Zero);
                continue;
            }

            if (header.AceSize < 16)
            {
                throw Denied(failureCode);
            }

            var mask = unchecked((uint)Marshal.ReadInt32(acePointer, 4));
            var sid = IntPtr.Add(acePointer, 8);
            var sidLength = NativeMethods.GetLengthSid(sid);
            if (sidLength == 0 || sidLength > header.AceSize - 8)
            {
                throw Denied(failureCode);
            }

            yield return new AceEntry(header.AceType, header.AceFlags, mask, sid);
        }
    }

    private static string ReadCurrentUserSid()
    {
        if (!NativeMethods.OpenProcessToken(
                NativeMethods.GetCurrentProcess(),
                NativeMethods.TokenQuery,
                out var token))
        {
            throw Denied("token-unavailable");
        }

        try
        {
            _ = NativeMethods.GetTokenInformation(token, NativeMethods.TokenUserClass, IntPtr.Zero, 0, out var length);
            if (length == 0)
            {
                throw Denied("token-unavailable");
            }

            var buffer = Marshal.AllocHGlobal(checked((int)length));
            try
            {
                if (!NativeMethods.GetTokenInformation(token, NativeMethods.TokenUserClass, buffer, length, out _))
                {
                    throw Denied("token-unavailable");
                }

                var user = Marshal.PtrToStructure<NativeMethods.TokenUser>(buffer);
                return SidToString(user.User.Sid) ?? throw Denied("token-unavailable");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            _ = NativeMethods.CloseHandle(token);
        }
    }

    private static string? SidToString(IntPtr sid)
    {
        if (sid == IntPtr.Zero || !NativeMethods.ConvertSidToStringSid(sid, out var stringSid))
        {
            return null;
        }

        try
        {
            return Marshal.PtrToStringUni(stringSid);
        }
        finally
        {
            NativeMethods.LocalFree(stringSid);
        }
    }

    private static PolicyFailureException Denied(string code) => new(code, 3);
}
