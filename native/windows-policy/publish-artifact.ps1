#requires -Version 7.0

<#
.SYNOPSIS
Publish the fixed-identity Windows x64 self-contained single-file qualification
helper.

.DESCRIPTION
This is the only supported qualification artifact for the Windows policy helper.
It is self-contained and does not depend on a globally installed .NET runtime.
The SDK and runtime-framework versions are pinned; a mismatch is a hard failure.
The version/path pin identifies the toolchain only; it is not source-authenticity
attestation. Source/build-host trust and package trust binding are external.

The caller owns SourceRoot and OutputDir. OutputDir must be absent or empty; the
script never recursively cleans a caller-owned directory.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SourceRoot,

    [Parameter(Mandatory)]
    [string]$OutputDir,

    [string]$SdkVersion = '9.0.321',
    [string]$RuntimeFrameworkVersion = '8.0.34',
    [string]$DotnetPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'

function Stop-Publish([string]$Code, [string]$Message) {
    $exception = [System.Exception]::new($Message)
    $exception.Data['fixtureCode'] = $Code
    throw $exception
}

if ($null -eq ('RacBundleManifestReader' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Buffers.Binary;
using System.IO;
using System.Text;

public sealed class RacBundleManifest
{
    public bool MarkerFound { get; set; }
    public string MarkerHex { get; set; } = "";
    public long HeaderOffset { get; set; }
    public uint MajorVersion { get; set; }
    public uint MinorVersion { get; set; }
    public int FileCount { get; set; }
    public string BundleId { get; set; } = "";
    public long DepsJsonOffset { get; set; }
    public long DepsJsonSize { get; set; }
    public long RuntimeConfigOffset { get; set; }
    public long RuntimeConfigSize { get; set; }
    public ulong Flags { get; set; }
    public int AssemblyCount { get; set; }
    public int NativeBinaryCount { get; set; }
    public int DepsJsonCount { get; set; }
    public int RuntimeConfigJsonCount { get; set; }
    public int SymbolsCount { get; set; }
    public int UnknownCount { get; set; }
    public int NeedsExtractionCount { get; set; }
    public long ManifestEnd { get; set; }
    public long FileLength { get; set; }
}

public static class RacBundleManifestReader
{
    private static readonly byte[] Signature =
    {
        0x8b, 0x12, 0x02, 0xb9, 0x6a, 0x61, 0x20, 0x38,
        0x72, 0x7b, 0x93, 0x02, 0x14, 0xd7, 0xa0, 0x32,
        0x13, 0xf5, 0xb9, 0xe6, 0xef, 0xae, 0x33, 0x18,
        0xee, 0x3b, 0x2d, 0xce, 0x24, 0xb3, 0x6a, 0xae
    };

    private const int MaxFileBytes = 128 * 1024 * 1024;
    private const int MaxStringBytes = 4096;
    private const int MaxFileCount = 100000;

    public static RacBundleManifest Read(string path)
    {
        var length = new FileInfo(path).Length;
        if (length <= 0 || length > MaxFileBytes)
        {
            throw new InvalidDataException("Bundle length is outside the bounded reader range.");
        }

        var bytes = File.ReadAllBytes(path);
        var markerPosition = FindValidMarker(bytes);
        if (markerPosition < 8)
        {
            throw new InvalidDataException("HostWriter bundle marker was not found.");
        }

        var headerOffset = ReadInt64(bytes, markerPosition - 8);
        if (headerOffset <= 0 || headerOffset > bytes.Length - 52)
        {
            throw new InvalidDataException("Bundle header offset is outside the file.");
        }

        var position = checked((int)headerOffset);
        var result = new RacBundleManifest
        {
            MarkerFound = true,
            MarkerHex = Convert.ToHexString(Signature).ToLowerInvariant(),
            HeaderOffset = headerOffset,
            MajorVersion = ReadUInt32(bytes, ref position),
            MinorVersion = ReadUInt32(bytes, ref position),
            FileCount = ReadInt32(bytes, ref position),
            FileLength = bytes.Length
        };

        if (result.FileCount < 0 || result.FileCount > MaxFileCount)
        {
            throw new InvalidDataException("Bundle file count is outside the bounded reader range.");
        }

        result.BundleId = ReadString(bytes, ref position);
        if (result.BundleId.Length > 128)
        {
            throw new InvalidDataException("Bundle id is unexpectedly long.");
        }

        result.DepsJsonOffset = ReadInt64(bytes, ref position);
        result.DepsJsonSize = ReadInt64(bytes, ref position);
        result.RuntimeConfigOffset = ReadInt64(bytes, ref position);
        result.RuntimeConfigSize = ReadInt64(bytes, ref position);
        result.Flags = ReadUInt64(bytes, ref position);

        for (var index = 0; index < result.FileCount; index++)
        {
            var offset = ReadInt64(bytes, ref position);
            var size = ReadInt64(bytes, ref position);
            var compressedSize = ReadInt64(bytes, ref position);
            var type = ReadByte(bytes, ref position);
            var relativePath = ReadString(bytes, ref position);

            if (offset < 0 || size < 0 || compressedSize < 0 || type > 5 || relativePath.Length == 0)
            {
                throw new InvalidDataException("Bundle file entry is invalid.");
            }

            var storedSize = compressedSize > 0 ? compressedSize : size;
            if (offset > bytes.Length || storedSize > bytes.Length - offset)
            {
                throw new InvalidDataException("Bundle file entry points outside the file.");
            }

            switch (type)
            {
                case 0:
                    result.UnknownCount++;
                    break;
                case 1:
                    result.AssemblyCount++;
                    break;
                case 2:
                    result.NativeBinaryCount++;
                    break;
                case 3:
                    result.DepsJsonCount++;
                    break;
                case 4:
                    result.RuntimeConfigJsonCount++;
                    break;
                case 5:
                    result.SymbolsCount++;
                    break;
            }

            if ((result.Flags & 1) != 0 || (type != 1 && type != 3 && type != 4))
            {
                result.NeedsExtractionCount++;
            }
        }

        result.ManifestEnd = position;
        return result;
    }

    private static int FindValidMarker(byte[] bytes)
    {
        var span = bytes.AsSpan();
        var search = 0;
        while (search < span.Length)
        {
            var relative = span.Slice(search).IndexOf(Signature);
            if (relative < 0)
            {
                return -1;
            }

            var position = search + relative;
            if (position >= 8 && position + Signature.Length <= bytes.Length)
            {
                var headerOffset = ReadInt64(bytes, position - 8);
                if (headerOffset > 0 && headerOffset <= bytes.Length - 52)
                {
                    var major = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice((int)headerOffset, 4));
                    if (major == 1 || major == 2 || major == 6)
                    {
                        return position;
                    }
                }
            }

            search = position + 1;
        }

        return -1;
    }

    private static byte ReadByte(byte[] bytes, ref int position)
    {
        if (position < 0 || position >= bytes.Length)
        {
            throw new InvalidDataException("Bundle manifest is truncated.");
        }

        return bytes[position++];
    }

    private static uint ReadUInt32(byte[] bytes, ref int position)
    {
        EnsureAvailable(bytes, position, 4);
        var value = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(position, 4));
        position += 4;
        return value;
    }

    private static int ReadInt32(byte[] bytes, ref int position)
    {
        EnsureAvailable(bytes, position, 4);
        var value = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(position, 4));
        position += 4;
        return value;
    }

    private static long ReadInt64(byte[] bytes, int position)
    {
        EnsureAvailable(bytes, position, 8);
        return BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(position, 8));
    }

    private static long ReadInt64(byte[] bytes, ref int position)
    {
        var value = ReadInt64(bytes, position);
        position += 8;
        return value;
    }

    private static ulong ReadUInt64(byte[] bytes, ref int position)
    {
        EnsureAvailable(bytes, position, 8);
        var value = BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(position, 8));
        position += 8;
        return value;
    }

    private static string ReadString(byte[] bytes, ref int position)
    {
        var length = Read7BitEncodedInt(bytes, ref position);
        if (length < 0 || length > MaxStringBytes)
        {
            throw new InvalidDataException("Bundle string length is outside the bounded reader range.");
        }

        EnsureAvailable(bytes, position, length);
        var value = Encoding.UTF8.GetString(bytes, position, length);
        position += length;
        return value;
    }

    private static int Read7BitEncodedInt(byte[] bytes, ref int position)
    {
        var value = 0;
        var shift = 0;
        for (var index = 0; index < 5; index++)
        {
            var current = ReadByte(bytes, ref position);
            value |= (current & 0x7f) << shift;
            if ((current & 0x80) == 0)
            {
                return value;
            }

            shift += 7;
        }

        throw new InvalidDataException("Bundle string length prefix is invalid.");
    }

    private static void EnsureAvailable(byte[] bytes, int position, int length)
    {
        if (position < 0 || length < 0 || position > bytes.Length - length)
        {
            throw new InvalidDataException("Bundle manifest is truncated.");
        }
    }
}
'@ -Language CSharp
}

$source = [IO.Path]::GetFullPath($SourceRoot)
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    Stop-Publish 'fixture-artifact-source-missing' "SourceRoot is not a directory: $source"
}

$project = Join-Path $source 'Rac.WindowsPolicy.Helper.csproj'
if (-not (Test-Path -LiteralPath $project -PathType Leaf)) {
    Stop-Publish 'fixture-artifact-project-missing' "Project is missing: $project"
}

$output = [IO.Path]::GetFullPath($OutputDir)
if (Test-Path -LiteralPath $output) {
    if (Get-ChildItem -LiteralPath $output -Force | Select-Object -First 1) {
        Stop-Publish 'fixture-artifact-output-not-empty' "OutputDir must be empty: $output"
    }
}
else {
    New-Item -ItemType Directory -Path $output -Force | Out-Null
}

$dotnet = $null
if ([string]::IsNullOrWhiteSpace($DotnetPath)) {
    $dotnet = Get-Command dotnet -ErrorAction Stop
    $dotnetExecutable = $dotnet.Source
}
else {
    $dotnetExecutable = [IO.Path]::GetFullPath($DotnetPath)
    if (-not (Test-Path -LiteralPath $dotnetExecutable -PathType Leaf)) {
        Stop-Publish 'fixture-artifact-dotnet-path-missing' "Explicit dotnet path is not a file: $dotnetExecutable"
    }
}

$versionOutput = (& $dotnetExecutable --version 2>&1 | Out-String).Trim()
$versionExit = $LASTEXITCODE
if ($versionExit -ne 0) {
    Stop-Publish 'fixture-artifact-dotnet-version-failed' "dotnet --version failed with exit $versionExit.`n$versionOutput"
}
if ([string]::IsNullOrWhiteSpace($versionOutput)) {
    Stop-Publish 'fixture-artifact-dotnet-version-failed' 'dotnet --version returned no version.'
}
if ($versionOutput -ne $SdkVersion) {
    Stop-Publish 'fixture-artifact-sdk-mismatch' "Pinned .NET SDK $SdkVersion required; found $versionOutput"
}

$publishArguments = @(
    'publish',
    $project,
    '--configuration', 'Release',
    '--runtime', 'win-x64',
    '--self-contained', 'true',
    '--output', $output,
    '--nologo',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=false',
    '-p:EnableCompressionInSingleFile=false',
    '-p:PublishTrimmed=false',
    '-p:PublishReadyToRun=false',
    '-p:DebugType=None',
    '-p:DebugSymbols=false',
    '-p:Deterministic=true',
    '-p:ContinuousIntegrationBuild=true',
    "-p:RuntimeFrameworkVersion=$RuntimeFrameworkVersion"
)

$publishLog = (& $dotnetExecutable @publishArguments 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
    Stop-Publish 'fixture-artifact-publish-failed' (
        "Self-contained single-file publish failed. " +
        "Prerequisite: .NET SDK $SdkVersion and Microsoft.NETCore.App.Runtime.win-x64 " +
        "$RuntimeFrameworkVersion (plus Microsoft.NETCore.App.Host.win-x64) restorable " +
        "from the configured NuGet source.`n$publishLog")
}

$items = @(Get-ChildItem -LiteralPath $output -Force)
if (
    $items.Count -ne 1 -or
    $items[0].PSIsContainer -or
    $items[0].Name -ne 'rac-windows-policy-helper.exe'
) {
    Stop-Publish 'fixture-artifact-not-single-file' (
        "Expected exactly one file rac-windows-policy-helper.exe; found: " +
        (($items | ForEach-Object { $_.Name + $(if ($_.PSIsContainer) { '/' } else { '' }) }) -join ', '))
}

$artifact = $items[0]
$dotnetSha256 = (Get-FileHash -LiteralPath $dotnetExecutable -Algorithm SHA256).Hash.ToLowerInvariant()

try {
    $bundle = [RacBundleManifestReader]::Read($artifact.FullName)
}
catch {
    Stop-Publish 'fixture-artifact-bundle-manifest-invalid' $_.Exception.Message
}

$bundleManifest = [pscustomobject]@{
    markerFound = $bundle.MarkerFound
    hostWriterMarker = $bundle.MarkerHex
    headerOffset = $bundle.HeaderOffset
    headerVersion = "$($bundle.MajorVersion).$($bundle.MinorVersion)"
    majorVersion = $bundle.MajorVersion
    minorVersion = $bundle.MinorVersion
    flags = $bundle.Flags
    fileCount = $bundle.FileCount
    bundleId = $bundle.BundleId
    assemblyCount = $bundle.AssemblyCount
    nativeBinaryCount = $bundle.NativeBinaryCount
    depsJsonCount = $bundle.DepsJsonCount
    runtimeConfigJsonCount = $bundle.RuntimeConfigJsonCount
    symbolsCount = $bundle.SymbolsCount
    unknownCount = $bundle.UnknownCount
    needsExtractionCount = $bundle.NeedsExtractionCount
    depsJsonOffset = $bundle.DepsJsonOffset
    depsJsonSize = $bundle.DepsJsonSize
    runtimeConfigOffset = $bundle.RuntimeConfigOffset
    runtimeConfigSize = $bundle.RuntimeConfigSize
    manifestEnd = $bundle.ManifestEnd
    fileLength = $bundle.FileLength
}

$entryCount =
    $bundle.AssemblyCount + $bundle.NativeBinaryCount + $bundle.DepsJsonCount +
    $bundle.RuntimeConfigJsonCount + $bundle.SymbolsCount + $bundle.UnknownCount
if (
    -not $bundle.MarkerFound -or
    $bundle.MajorVersion -ne 6 -or
    $bundle.MinorVersion -ne 0 -or
    $bundle.Flags -ne 0 -or
    $bundle.FileCount -ne $entryCount -or
    $bundle.DepsJsonCount -ne 1 -or
    $bundle.RuntimeConfigJsonCount -ne 1 -or
    $bundle.NativeBinaryCount -ne 0 -or
    $bundle.SymbolsCount -ne 0 -or
    $bundle.UnknownCount -ne 0 -or
    $bundle.NeedsExtractionCount -ne 0 -or
    $bundle.ManifestEnd -ne $bundle.FileLength
) {
    Stop-Publish 'fixture-artifact-bundle-manifest-mismatch' (
        "Unexpected bundle manifest: $($bundleManifest | ConvertTo-Json -Compress)")
}

return [pscustomobject]@{
    schemaVersion = 1
    path = $artifact.FullName
    bytes = $artifact.Length
    sha256 = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    runtimeIdentifier = 'win-x64'
    selfContained = $true
    singleFile = $true
    nativeExtraction = $bundle.NeedsExtractionCount -ne 0
    bundleManifest = $bundleManifest
    determinismScope = 'same-host'
    sdkVersion = $SdkVersion
    runtimeFrameworkVersion = $RuntimeFrameworkVersion
    dotnetPath = $dotnetExecutable
    dotnetVersion = $versionOutput
    dotnetSha256 = $dotnetSha256
    targetFramework = 'net8.0-windows'
    publishProperties = @(
        'PublishSingleFile=true',
        'IncludeNativeLibrariesForSelfExtract=false',
        'EnableCompressionInSingleFile=false',
        'PublishTrimmed=false',
        'PublishReadyToRun=false',
        'DebugType=None',
        'DebugSymbols=false',
        'Deterministic=true',
        'ContinuousIntegrationBuild=true'
    )
}
