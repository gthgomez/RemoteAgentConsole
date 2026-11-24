using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace Rac.WindowsPolicy.Helper;

internal static class PolicyFileReader
{
    private const int SchemaVersion = 1;

    internal static PolicySnapshot Read(string input)
    {
        var policyPath = PolicyPath.Parse(input);
        if (policyPath.Components.Length == 1)
        {
            // A policy directly in a drive root cannot have a private,
            // owner-only immediate directory.
            throw Denied("parent-drive-root");
        }

        var handles = new List<SafeFileHandle>();
        try
        {
            var root = HandleQueries.OpenDriveRoot(policyPath.DriveRoot);
            handles.Add(root);

            var rootAttributes = HandleQueries.GetAttributeTag(root, "volume-root-open-failed");
            if ((rootAttributes.FileAttributes & NativeMethods.FileAttributeReparsePoint) != 0
                || rootAttributes.ReparseTag != 0)
            {
                throw Denied("volume-root-reparse");
            }

            if ((rootAttributes.FileAttributes & NativeMethods.FileAttributeDirectory) == 0)
            {
                throw Denied("volume-root-not-directory");
            }

            var rootStandard = HandleQueries.GetStandardInfo(root, "volume-root-open-failed");
            if (rootStandard.Directory == 0 || rootStandard.DeletePending != 0)
            {
                throw Denied("volume-root-open-failed");
            }

            var rootFinalPath = HandleQueries.GetFinalDosPath(root, "volume-root-identity-unavailable");
            RequireExactCanonicalPath(rootFinalPath, policyPath.DriveRoot, "volume-root-identity-mismatch");

            var rootIdentity = HandleQueries.GetIdentity(root, "volume-root-identity-unavailable");
            var rootVolumeGuid = HandleQueries.GetVolumeGuidPath(root, "volume-identity-unavailable");
            WindowsSecurity.VerifyAncestor(root);

            var current = root;
            string? targetDirectoryFingerprint = null;
            for (var index = 0; index < policyPath.Components.Length - 1; index++)
            {
                var directory = HandleQueries.OpenDirectoryComponent(current, policyPath.Components[index]);
                handles.Add(directory);

                var attributes = HandleQueries.GetAttributeTag(directory, "component-open-failed");
                if ((attributes.FileAttributes & NativeMethods.FileAttributeReparsePoint) != 0
                    || attributes.ReparseTag != 0)
                {
                    throw Denied("component-reparse");
                }

                if ((attributes.FileAttributes & NativeMethods.FileAttributeDirectory) == 0
                    || (attributes.FileAttributes & NativeMethods.FileAttributeDevice) != 0)
                {
                    throw Denied("component-not-directory");
                }

                if ((attributes.FileAttributes & (NativeMethods.FileAttributeOffline
                        | NativeMethods.FileAttributeRecallOnOpen
                        | NativeMethods.FileAttributeRecallOnDataAccess)) != 0)
                {
                    throw Denied("component-offline");
                }

                var standard = HandleQueries.GetStandardInfo(directory, "component-open-failed");
                if (standard.Directory == 0 || standard.DeletePending != 0)
                {
                    throw Denied("component-open-failed");
                }

                var identity = HandleQueries.GetIdentity(directory, "component-identity-unavailable");
                if (identity.VolumeSerialNumber != rootIdentity.VolumeSerialNumber)
                {
                    throw Denied("component-volume-mismatch");
                }

                var isTargetDirectory = index == policyPath.Components.Length - 2;
                if (isTargetDirectory)
                {
                    targetDirectoryFingerprint = WindowsSecurity.VerifyOwnerOnly(directory, "directory");
                }
                else
                {
                    WindowsSecurity.VerifyAncestor(directory);
                }

                current = directory;
            }

            var directoryFinalPath = HandleQueries.GetFinalDosPath(current, "directory-identity-unavailable");
            RequireExactCanonicalPath(directoryFinalPath, policyPath.DirectoryPath, "input-ambiguous");

            var directoryIdentity = HandleQueries.GetIdentity(current, "directory-identity-unavailable");
            if (directoryIdentity.VolumeSerialNumber != rootIdentity.VolumeSerialNumber)
            {
                throw Denied("directory-volume-mismatch");
            }

            var leaf = HandleQueries.OpenLeafComponent(current, policyPath.Components[^1]);
            handles.Add(leaf);

            var leafAttributes = HandleQueries.GetAttributeTag(leaf, "file-open-failed");
            if ((leafAttributes.FileAttributes & NativeMethods.FileAttributeReparsePoint) != 0
                || leafAttributes.ReparseTag != 0)
            {
                throw Denied("file-reparse");
            }

            if ((leafAttributes.FileAttributes & (NativeMethods.FileAttributeDirectory | NativeMethods.FileAttributeDevice)) != 0)
            {
                throw Denied("file-not-regular");
            }

            if ((leafAttributes.FileAttributes & (NativeMethods.FileAttributeOffline
                    | NativeMethods.FileAttributeRecallOnOpen
                    | NativeMethods.FileAttributeRecallOnDataAccess)) != 0)
            {
                throw Denied("file-offline");
            }

            var leafStandard = HandleQueries.GetStandardInfo(leaf, "file-open-failed");
            if (leafStandard.Directory != 0)
            {
                throw Denied("file-not-regular");
            }

            if (leafStandard.DeletePending != 0)
            {
                throw Denied("file-delete-pending");
            }

            if (leafStandard.NumberOfLinks != 1)
            {
                throw Denied("file-hardlinked");
            }

            if (leafStandard.EndOfFile <= 0)
            {
                throw Denied("file-empty");
            }

            if (leafStandard.EndOfFile > NativeMethods.MaxPolicyBytes)
            {
                throw Denied("file-oversize");
            }

            var leafIdentity = HandleQueries.GetIdentity(leaf, "file-identity-unavailable");
            if (leafIdentity.VolumeSerialNumber != rootIdentity.VolumeSerialNumber)
            {
                throw Denied("file-volume-mismatch");
            }

            var fileFingerprint = WindowsSecurity.VerifyOwnerOnly(leaf, "file");

            var basicBefore = HandleQueries.GetBasicInfo(leaf, "file-open-failed");
            var bytes = HandleQueries.ReadBounded(leaf, leafStandard.EndOfFile);
            var basicAfter = HandleQueries.GetBasicInfo(leaf, "file-changed");
            var standardAfter = HandleQueries.GetStandardInfo(leaf, "file-changed");
            var identityAfter = HandleQueries.GetIdentity(leaf, "file-changed");

            if (basicAfter.CreationTime != basicBefore.CreationTime
                || basicAfter.LastWriteTime != basicBefore.LastWriteTime
                || basicAfter.ChangeTime != basicBefore.ChangeTime
                || basicAfter.FileAttributes != basicBefore.FileAttributes
                || standardAfter.EndOfFile != leafStandard.EndOfFile
                || standardAfter.NumberOfLinks != leafStandard.NumberOfLinks
                || standardAfter.DeletePending != 0
                || standardAfter.Directory != 0
                || identityAfter != leafIdentity)
            {
                throw Denied("file-changed");
            }

            // File sharing blocks new data-write/delete handles, but it does not
            // by itself fence WRITE_DAC. Re-read and compare owner/DACL evidence
            // before the handles are released.
            var fileFingerprintAfter = WindowsSecurity.VerifyOwnerOnly(leaf, "file");
            var directoryFingerprintAfter = WindowsSecurity.VerifyOwnerOnly(current, "directory");
            if (targetDirectoryFingerprint is null
                || !string.Equals(targetDirectoryFingerprint, directoryFingerprintAfter, StringComparison.Ordinal))
            {
                throw Denied("directory-security-changed");
            }

            if (!string.Equals(fileFingerprint, fileFingerprintAfter, StringComparison.Ordinal))
            {
                throw Denied("file-security-changed");
            }

            var leafFinalPath = HandleQueries.GetFinalDosPath(leaf, "file-path-unavailable");
            RequireExactCanonicalPath(leafFinalPath, policyPath.NormalizedPath, "input-ambiguous");

            var leafVolumeGuid = HandleQueries.GetVolumeGuidPath(leaf, "volume-identity-unavailable");
            if (!string.Equals(leafVolumeGuid, rootVolumeGuid, StringComparison.OrdinalIgnoreCase))
            {
                throw Denied("volume-identity-mismatch");
            }

            var fileIdentity = ComposeIdentity(rootVolumeGuid, leafIdentity.FileIdHex);
            var directoryCompositeIdentity = ComposeIdentity(rootVolumeGuid, directoryIdentity.FileIdHex);

            return new PolicySnapshot(
                SchemaVersion: SchemaVersion,
                Status: "ok",
                Path: leafFinalPath,
                DirectoryPath: directoryFinalPath,
                BytesBase64: Convert.ToBase64String(bytes),
                ByteLength: bytes.Length,
                Sha256: Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                Volume: new VolumeSnapshot(
                    Guid: rootVolumeGuid,
                    SerialNumberHex: rootIdentity.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture)),
                File: new FileSnapshot(
                    IdHex: leafIdentity.FileIdHex,
                    Size: leafStandard.EndOfFile,
                    NumberOfLinks: leafStandard.NumberOfLinks,
                    LastWriteTimeUtc: HandleQueries.FileTimeToUtc(basicBefore.LastWriteTime),
                    ChangeTimeUtc: HandleQueries.FileTimeToUtc(basicBefore.ChangeTime)),
                Directory: new DirectorySnapshot(
                    Path: directoryFinalPath,
                    IdHex: directoryIdentity.FileIdHex),
                Identities: new IdentitySnapshot(
                    Volume: rootVolumeGuid,
                    File: fileIdentity,
                    Directory: directoryCompositeIdentity),
                Protection: new ProtectionSnapshot(
                    OwnerSidVerified: true,
                    DaclProtected: true,
                    DaclOwnerOnly: true,
                    ParentChainSafe: true,
                    FileFingerprint: fileFingerprintAfter,
                    DirectoryFingerprint: directoryFingerprintAfter));
        }
        finally
        {
            for (var index = handles.Count - 1; index >= 0; index--)
            {
                handles[index].Dispose();
            }
        }
    }

    private static string ComposeIdentity(string volumeGuid, string fileIdHex) =>
        $"{volumeGuid}#{fileIdHex}";

    private static void RequireExactCanonicalPath(string actual, string expected, string mismatchCode)
    {
        // Compare the drive letter case-insensitively, but require exact
        // component spelling. OrdinalIgnoreCase on the whole path would accept
        // a case-only alias in a directory that permits case-sensitive siblings.
        var normalizedActual = NormalizeDriveLetter(actual);
        var normalizedExpected = NormalizeDriveLetter(expected);
        if (string.Equals(normalizedActual, normalizedExpected, StringComparison.Ordinal))
        {
            return;
        }

        if (string.Equals(normalizedActual, normalizedExpected, StringComparison.OrdinalIgnoreCase))
        {
            throw Denied("input-case-mismatch");
        }

        throw Denied(mismatchCode);
    }

    private static string NormalizeDriveLetter(string path) =>
        path.Length >= 2 && path[1] == ':'
            ? char.ToUpperInvariant(path[0]) + path[2..]
            : path;

    private static PolicyFailureException Denied(string code) => new(code, 3);
}
