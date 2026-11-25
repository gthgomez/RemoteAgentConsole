namespace Rac.WindowsPolicy.Helper;

internal sealed record PolicySnapshot(
    int SchemaVersion,
    string Status,
    string Path,
    string DirectoryPath,
    string BytesBase64,
    int ByteLength,
    string Sha256,
    VolumeSnapshot Volume,
    FileSnapshot File,
    DirectorySnapshot Directory,
    IdentitySnapshot Identities,
    ProtectionSnapshot Protection);

internal sealed record VolumeSnapshot(
    string Guid,
    string SerialNumberHex);

internal sealed record FileSnapshot(
    string IdHex,
    long Size,
    uint NumberOfLinks,
    string? LastWriteTimeUtc,
    string? ChangeTimeUtc);

internal sealed record DirectorySnapshot(
    string Path,
    string IdHex);

internal sealed record IdentitySnapshot(
    string Volume,
    string File,
    string Directory);

internal sealed record ProtectionSnapshot(
    bool OwnerSidVerified,
    bool DaclProtected,
    bool DaclOwnerOnly,
    bool ParentChainSafe,
    string FileFingerprint,
    string DirectoryFingerprint);

internal sealed record ErrorSnapshot(
    int SchemaVersion,
    string Status,
    string Code);
