#requires -Version 7.0

<#
.SYNOPSIS
Native Windows verification for the owner-only policy read/identity helper.

.DESCRIPTION
Publishes and exercises the fixed-identity Windows x64 self-contained single-file
qualification helper. The supplied -ScratchRoot is a parent directory, never the
fixture root: the fixture reserves a unique child, writes an ownership marker, and
removes only that child. It refuses a parent or ancestor that is a reparse point or
a canonical-path alias where detectable.

Only synthetic policy files and synthetic ACLs, junctions, hard links, replacement
and in-place changes are used. The helper is never given a real policy path, a live
deployment directory, or any path outside the owned child.
#>

[CmdletBinding()]
param(
    [string]$ScratchRoot,
    [switch]$KeepScratch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'

$requestedScratchParent = $ScratchRoot
$script:ScratchParent = $null
$script:ScratchRoot = $null
$script:ScratchChildName = $null

function Reset-OwnedChildAcl {
    param([string]$Child)

    if ($null -eq $script:UserSid) { return }

    $ownerRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $script:UserSid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow)

    $targets = @(
        Get-ChildItem -LiteralPath $Child -Recurse -Force -ErrorAction SilentlyContinue |
            Sort-Object { $_.FullName.Length } -Descending
    )

    foreach ($target in $targets) {
        if (($target.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        try {
            if ($target.PSIsContainer) {
                $acl = [Security.AccessControl.DirectorySecurity]::new()
            }
            else {
                $acl = [Security.AccessControl.FileSecurity]::new()
            }
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetOwner($script:UserSid)
            $acl.AddAccessRule($ownerRule)
            [System.IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $target.FullName -Force), $acl)
        }
        catch {
        }
    }

    try {
        $rootAcl = [Security.AccessControl.DirectorySecurity]::new()
        $rootAcl.SetAccessRuleProtection($true, $false)
        $rootAcl.SetOwner($script:UserSid)
        $rootAcl.AddAccessRule($ownerRule)
        [System.IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $Child -Force), $rootAcl)
    }
    catch {
    }
}

function Remove-OwnedScratch {
    if ($KeepScratch) { return }
    if (
        [string]::IsNullOrWhiteSpace($script:ScratchRoot) -or
        [string]::IsNullOrWhiteSpace($script:ScratchParent)
    ) {
        return
    }

    $child = [IO.Path]::GetFullPath($script:ScratchRoot)
    $parent = [IO.Path]::GetFullPath($script:ScratchParent)
    $prefix = $parent.TrimEnd('\') + '\'
    $leaf = Split-Path -Leaf $child
    if (
        -not $child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith('RacWindowsPolicyFixture-', [StringComparison]::Ordinal) -or
        $leaf -ne $script:ScratchChildName
    ) {
        Write-Warning "Refusing to remove a path that is not the owned child: $child"
        return
    }

    $marker = Join-Path $child '.rac-windows-policy-fixture-owned'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        Write-Warning "Refusing to remove an unmarked scratch child: $child"
        return
    }

    $markerValue = (Get-Content -LiteralPath $marker -Raw).Trim()
    if ($markerValue -ne $script:ScratchChildName) {
        Write-Warning "Refusing to remove a scratch child with a mismatched marker: $child"
        return
    }

    try {
        $childItem = Get-Item -LiteralPath $child -Force
        if (($childItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Write-Warning "Refusing to remove a reparse-point scratch child: $child"
            return
        }

        # Remove reparse points inside the owned child first, without following
        # them. The caller-owned parent is never enumerated or modified.
        Get-ChildItem -LiteralPath $child -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
            Sort-Object { $_.FullName.Length } -Descending |
            ForEach-Object {
                try {
                    if ($_.PSIsContainer) {
                        [IO.Directory]::Delete($_.FullName, $false)
                    }
                    else {
                        [IO.File]::Delete($_.FullName)
                    }
                }
                catch {
                }
            }

        Reset-OwnedChildAcl $child
        Remove-Item -LiteralPath $child -Recurse -Force -ErrorAction Stop
    }
    catch {
        Write-Warning "Could not remove owned scratch child: $child ($($_.Exception.Message))"
    }
}

function Stop-Fixture {
    param([string]$Code, [string]$Message)
    Remove-OwnedScratch
    [pscustomobject]@{
        suite = 'windows-policy-helper-native-fixture'
        status = 'FAIL'
        errorCode = $Code
        message = $Message
        scratchParent = $script:ScratchParent
        scratchRoot = $script:ScratchRoot
        scratchOwned = -not [string]::IsNullOrWhiteSpace($script:ScratchChildName)
    } | ConvertTo-Json -Depth 5
    exit 1
}

trap {
    $code = 'fixture-unhandled'
    if ($_.Exception.Data.Keys -contains 'fixtureCode') {
        $code = [string]$_.Exception.Data['fixtureCode']
    }
    Stop-Fixture $code $_.Exception.Message
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Stop-Fixture 'fixture-windows-required' 'This fixture is Windows-only.'
}

$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:ProjectSource = Join-Path $script:RepoRoot 'native/windows-policy/Rac.WindowsPolicy.Helper'
if (-not (Test-Path -LiteralPath $script:ProjectSource -PathType Container)) {
    Stop-Fixture 'fixture-source-missing' "Helper source not found: $script:ProjectSource"
}

$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $gitCommand) {
    Stop-Fixture 'fixture-binding-unavailable' 'git is unavailable for the qualification binding record.'
}
$bindingCommit = (& $gitCommand.Source -C $script:RepoRoot rev-parse HEAD 2>$null | Out-String).Trim()
$commitExit = $LASTEXITCODE
$bindingTree = (& $gitCommand.Source -C $script:RepoRoot rev-parse 'HEAD^{tree}' 2>$null | Out-String).Trim()
$treeExit = $LASTEXITCODE
$scopedStatus = @(& $gitCommand.Source -C $script:RepoRoot status --porcelain -- native/windows-policy qualification/windows/policy-file-fixture.ps1 2>$null)
$statusExit = $LASTEXITCODE
if (
    $commitExit -ne 0 -or
    $treeExit -ne 0 -or
    $statusExit -ne 0 -or
    [string]::IsNullOrWhiteSpace($bindingCommit) -or
    [string]::IsNullOrWhiteSpace($bindingTree)
) {
    Stop-Fixture 'fixture-binding-unavailable' 'Could not read the scoped git binding state.'
}
$script:Binding = [pscustomobject]@{
    commit = $bindingCommit
    tree = $bindingTree
    dirtyScoped = ($scopedStatus.Count -gt 0)
    scopedStatus = @($scopedStatus | ForEach-Object { [string]$_ })
}

if ($null -eq ('RacFixtureNative' -as [type])) {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class RacFixtureNative
{
    private const uint FileReadAttributes = 0x00000080;
    private const uint Synchronize = 0x00100000;
    private const uint Delete = 0x00010000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        IntPtr fileHandle,
        [Out] StringBuilder path,
        uint pathLength,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(
        string longPath,
        IntPtr shortPath,
        uint bufferLength);

    public static string GetShortPath(string longPath)
    {
        var required = GetShortPathName(longPath, IntPtr.Zero, 0);
        if (required == 0)
        {
            return null;
        }

        var buffer = Marshal.AllocHGlobal(checked((int)required * 2));
        try
        {
            var written = GetShortPathName(longPath, buffer, required);
            if (written == 0 || written >= required)
            {
                return null;
            }

            return Marshal.PtrToStringUni(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static string GetFinalDosPath(string path)
    {
        var handle = CreateFileW(
            path,
            FileReadAttributes | Synchronize,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            var builder = new StringBuilder(1024);
            var length = GetFinalPathNameByHandle(handle, builder, (uint)builder.Capacity, 0);
            if (length == 0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            if (length >= builder.Capacity)
            {
                builder = new StringBuilder(checked((int)length + 1));
                length = GetFinalPathNameByHandle(handle, builder, (uint)builder.Capacity, 0);
                if (length == 0 || length >= builder.Capacity)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }

            var result = builder.ToString();
            if (result.StartsWith(@"\\?\", StringComparison.Ordinal))
            {
                result = result.Substring(4);
            }
            return result;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    public static IntPtr OpenDeleteCapableHandle(string path)
    {
        var handle = CreateFileW(
            path,
            Delete | Synchronize,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            FileAttributeNormal,
            IntPtr.Zero);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        return handle;
    }

    public static void Close(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
        {
            CloseHandle(handle);
        }
    }
}
'@
    }
    catch {
        Stop-Fixture 'fixture-native-probe-unavailable' $_.Exception.Message
    }
}

function Resolve-ScratchParent {
    param([string]$Candidate)

    if (
        [string]::IsNullOrWhiteSpace($Candidate) -or
        $Candidate -ne $Candidate.Trim() -or
        $Candidate -match '[/]' -or
        $Candidate -match '(^|[\\])\.\.?([\\]|$)' -or
        $Candidate -notmatch '^[A-Za-z]:\\' -or
        $Candidate.IndexOf(':') -ne 1
    ) {
        Stop-Fixture 'fixture-custody-parent-alias' "Scratch parent must be a simple local drive path: $Candidate"
    }

    $full = [IO.Path]::GetFullPath($Candidate)
    if ($full.IndexOf(':', 2) -ge 0 -or $full -match '^\\\\') {
        Stop-Fixture 'fixture-custody-parent-not-local' "Scratch parent must be a local drive path: $full"
    }

    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        Stop-Fixture 'fixture-custody-parent-missing' "Scratch parent is not an existing directory: $full"
    }

    try {
        $item = Get-Item -LiteralPath $full -Force
    }
    catch {
        Stop-Fixture 'fixture-custody-parent-open-failed' $_.Exception.Message
    }

    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-Fixture 'fixture-custody-parent-reparse' "Scratch parent is a reparse point: $full"
    }

    $root = [IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\'), $root.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Fixture 'fixture-custody-parent-drive-root' "Scratch parent must not be a drive root: $full"
    }

    $current = $item
    while ($null -ne $current) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Stop-Fixture 'fixture-custody-ancestor-reparse' "Scratch parent ancestor is a reparse point: $($current.FullName)"
        }
        $current = $current.Parent
    }

    try {
        $canonical = [RacFixtureNative]::GetFinalDosPath($full)
    }
    catch {
        Stop-Fixture 'fixture-custody-parent-canonical-failed' $_.Exception.Message
    }

    if (-not [string]::Equals($canonical, $full, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Fixture 'fixture-custody-parent-alias' "Scratch parent is an alias or reparse-resolved path: $full -> $canonical"
    }

    return $full
}

$scratchParentCandidate = $requestedScratchParent
if ([string]::IsNullOrWhiteSpace($scratchParentCandidate)) {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        Stop-Fixture 'fixture-custody-parent-unavailable' 'LocalApplicationData is unavailable; pass -ScratchRoot explicitly.'
    }
    $scratchParentCandidate = $localAppData
}

$script:ScratchParent = Resolve-ScratchParent $scratchParentCandidate
$script:ScratchChildName = 'RacWindowsPolicyFixture-' + [guid]::NewGuid().ToString('N')
$script:ScratchRoot = Join-Path $script:ScratchParent $script:ScratchChildName
try {
    New-Item -ItemType Directory -Path $script:ScratchRoot -ErrorAction Stop | Out-Null
}
catch {
    Stop-Fixture 'fixture-custody-child-create-failed' $_.Exception.Message
}

$ownershipMarker = Join-Path $script:ScratchRoot '.rac-windows-policy-fixture-owned'
try {
    [IO.File]::WriteAllText($ownershipMarker, $script:ScratchChildName, [Text.UTF8Encoding]::new($false))
}
catch {
    Stop-Fixture 'fixture-custody-marker-failed' $_.Exception.Message
}

$script:Marker = 'RAC-POLICY-FIXTURE-' + [guid]::NewGuid().ToString('N')
$script:UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$script:UsersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$script:Results = [Collections.Generic.List[object]]::new()

$sourceCopy = Join-Path $script:ScratchRoot 'source'
$sourceCopyB = Join-Path $script:ScratchRoot 'source-b'
$caseRoot = Join-Path $script:ScratchRoot 'cases'
New-Item -ItemType Directory -Path $sourceCopy, $sourceCopyB, $caseRoot -Force | Out-Null

$helperSourceNames = @(
    'Rac.WindowsPolicy.Helper.csproj',
    'Program.cs',
    'PolicyFailureException.cs',
    'PolicyPath.cs',
    'HandleQueries.cs',
    'WindowsSecurity.cs',
    'PolicyFileReader.cs',
    'PolicySnapshot.cs',
    'ProjectDirectoryIdentityReader.cs',
    'ProjectDirectoryIdentitySnapshot.cs',
    'NativeMethods.cs',
    'LaunchEnvironment.cs'
)
$copiedProjectRoot = Join-Path $sourceCopy 'Rac.WindowsPolicy.Helper'
$copiedProjectRootB = Join-Path $sourceCopyB 'Rac.WindowsPolicy.Helper'
New-Item -ItemType Directory -Path $copiedProjectRoot, $copiedProjectRootB -Force | Out-Null
try {
    foreach ($sourceName in $helperSourceNames) {
        $sourcePath = Join-Path $script:ProjectSource $sourceName
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Exact helper source is missing: $sourcePath"
        }

        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $copiedProjectRoot $sourceName) -ErrorAction Stop
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $copiedProjectRootB $sourceName) -ErrorAction Stop
    }
}
catch {
    Stop-Fixture 'fixture-source-copy-failed' $_.Exception.Message
}

$project = Join-Path $copiedProjectRoot 'Rac.WindowsPolicy.Helper.csproj'
$projectB = Join-Path $copiedProjectRootB 'Rac.WindowsPolicy.Helper.csproj'
if (
    -not (Test-Path -LiteralPath $project -PathType Leaf) -or
    -not (Test-Path -LiteralPath $projectB -PathType Leaf)
) {
    Stop-Fixture 'fixture-source-copy-missing-project' "Copied project not found: $project / $projectB"
}

$publishScript = Join-Path $script:RepoRoot 'native/windows-policy/publish-artifact.ps1'
if (-not (Test-Path -LiteralPath $publishScript -PathType Leaf)) {
    Stop-Fixture 'fixture-artifact-script-missing' "Publish script not found: $publishScript"
}

$dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
if ($null -eq $dotnetCommand) {
    Stop-Fixture 'fixture-artifact-dotnet-missing' 'dotnet executable is unavailable.'
}

try {
    $artifactA = & $publishScript -SourceRoot $copiedProjectRoot -OutputDir (Join-Path $script:ScratchRoot 'artifact-a') -DotnetPath $dotnetCommand.Source
}
catch {
    $code = 'fixture-artifact-publish-failed'
    if ($_.Exception.Data.Keys -contains 'fixtureCode') { $code = [string]$_.Exception.Data['fixtureCode'] }
    Stop-Fixture $code $_.Exception.Message
}

try {
    $artifactB = & $publishScript -SourceRoot $copiedProjectRootB -OutputDir (Join-Path $script:ScratchRoot 'artifact-b') -DotnetPath $dotnetCommand.Source
}
catch {
    $code = 'fixture-artifact-publish-failed'
    if ($_.Exception.Data.Keys -contains 'fixtureCode') { $code = [string]$_.Exception.Data['fixtureCode'] }
    Stop-Fixture $code $_.Exception.Message
}

if ($artifactA.sha256 -ne $artifactB.sha256) {
    Stop-Fixture 'fixture-artifact-not-reproducible' (
        "Two publications of the same pinned inputs differ: $($artifactA.sha256) vs $($artifactB.sha256)")
}

if (($artifactA.bundleManifest | ConvertTo-Json -Compress) -ne ($artifactB.bundleManifest | ConvertTo-Json -Compress)) {
    Stop-Fixture 'fixture-artifact-bundle-manifest-not-reproducible' 'Measured bundle manifests differ between publications.'
}

$script:HelperPath = $artifactA.path
$script:HelperHash = $artifactA.sha256
$script:Artifact = [pscustomobject]@{
    path = $artifactA.path
    sha256 = $artifactA.sha256
    bytes = $artifactA.bytes
    runtimeIdentifier = $artifactA.runtimeIdentifier
    selfContained = $artifactA.selfContained
    singleFile = $artifactA.singleFile
    nativeExtraction = $artifactA.nativeExtraction
    bundleManifest = $artifactA.bundleManifest
    determinismScope = $artifactA.determinismScope
    sdkVersion = $artifactA.sdkVersion
    runtimeFrameworkVersion = $artifactA.runtimeFrameworkVersion
    dotnetPath = $artifactA.dotnetPath
    dotnetVersion = $artifactA.dotnetVersion
    dotnetSha256 = $artifactA.dotnetSha256
    targetFramework = $artifactA.targetFramework
    publishProperties = $artifactA.publishProperties
    publishScript = $publishScript
    publishScriptSha256 = (Get-FileHash -LiteralPath $publishScript -Algorithm SHA256).Hash.ToLowerInvariant()
    reproducible = $true
    secondPublicationSha256 = $artifactB.sha256
}

$sourceFiles = @(
    Get-ChildItem -LiteralPath $copiedProjectRoot -File |
        Sort-Object Name |
        ForEach-Object {
            [pscustomobject]@{
                name = $_.Name
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
)

function Get-Prop {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Add-Result {
    param(
        [string]$Name,
        [ValidateSet('PASS', 'FAIL', 'UNSUPPORTED')]
        [string]$Status,
        [string]$Detail = '',
        [string]$Expected = '',
        [string]$Actual = '',
        [string]$Code = ''
    )

    $script:Results.Add([pscustomobject]@{
        name = $Name
        status = $Status
        code = $Code
        detail = $Detail
        expected = $Expected
        actual = $Actual
    })
}

function Add-Failure {
    param(
        [string]$Name,
        [string]$Detail,
        [string]$Expected = '',
        [string]$Actual = '',
        [string]$Code = 'fixture-assertion'
    )
    Add-Result -Name $Name -Status 'FAIL' -Detail $Detail -Expected $Expected -Actual $Actual -Code $Code
}

function Add-Pass {
    param([string]$Name, [string]$Detail = '')
    Add-Result -Name $Name -Status 'PASS' -Detail $Detail
}

function Test-Sensitive {
    param($Result)
    $text = [string]$Result.Stdout + "`n" + [string]$Result.Stderr
    return $text.Contains($script:Marker) -or $text.Contains($script:UserSid.Value)
}

function Invoke-Helper {
    param(
        [string[]]$Arguments = @(),
        [hashtable]$Environment = @{}
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $script:HelperPath
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.WorkingDirectory = $script:ScratchRoot

    $unsafeEnvironmentNames = @(
        $startInfo.Environment.Keys |
            Where-Object {
                $_ -match '(?i)^(DOTNET_|COREHOST_|COMPLUS_)' -or
                $_ -ieq 'NATIVE_DLL_SEARCH_DIRECTORIES' -or
                $_ -ieq 'CLR_LOADER_OPTIMIZATION'
            }
    )
    foreach ($name in $unsafeEnvironmentNames) {
        [void]$startInfo.Environment.Remove($name)
    }

    foreach ($key in $Environment.Keys) {
        $startInfo.Environment[[string]$key] = [string]$Environment[$key]
    }
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            try { $process.Kill($true) } catch { }
            throw 'Helper timed out.'
        }

        $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
        $exitCode = $process.ExitCode
    }
    finally {
        $process.Dispose()
    }

    $json = $null
    $tooLarge = $stdout.Length -gt 1000000
    if (-not $tooLarge -and $stdout.Length -gt 0) {
        try {
            $json = $stdout | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            $json = $null
        }
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Stdout = $stdout
        Stderr = $stderr
        Json = $json
        OutputTooLarge = $tooLarge
    }
}

function Normalize-DriveCase {
    param([string]$Path)
    if ($Path.Length -ge 2 -and $Path[1] -eq ':') {
        return $Path.Substring(0, 1).ToUpperInvariant() + $Path.Substring(1)
    }
    return $Path
}

function Assert-Ok {
    param(
        [string]$Name,
        $Result,
        [string]$ExpectedPath,
        [string]$ExpectedDirectory,
        [byte[]]$ExpectedBytes
    )

    if ($Result.OutputTooLarge) {
        Add-Failure $Name 'helper output exceeded the bounded capture limit'
        return
    }

    if ($Result.Stderr.Length -gt 0) {
        Add-Failure $Name 'helper wrote to stderr' 'empty stderr' $Result.Stderr
        return
    }

    if ($Result.ExitCode -ne 0) {
        Add-Failure $Name 'helper did not return success' 'exit 0 status ok' ("exit $($Result.ExitCode) code $(Get-Prop $Result.Json 'code')")
        return
    }

    $status = Get-Prop $Result.Json 'status'
    if ($status -ne 'ok') {
        Add-Failure $Name 'helper did not return status ok' 'status ok' ("status $status")
        return
    }

    $schemaVersion = Get-Prop $Result.Json 'schemaVersion'
    if ([int]$schemaVersion -ne 1) {
        Add-Failure $Name 'unexpected success schemaVersion' '1' ([string]$schemaVersion)
        return
    }

    $path = [string](Get-Prop $Result.Json 'path')
    $directory = [string](Get-Prop $Result.Json 'directoryPath')
    if (-not [string]::Equals((Normalize-DriveCase $path), (Normalize-DriveCase $ExpectedPath), [StringComparison]::Ordinal)) {
        Add-Failure $Name 'canonical file path is not exact' $ExpectedPath $path
        return
    }

    if (-not [string]::Equals((Normalize-DriveCase $directory), (Normalize-DriveCase $ExpectedDirectory), [StringComparison]::Ordinal)) {
        Add-Failure $Name 'canonical directory path is not exact' $ExpectedDirectory $directory
        return
    }

    $base64 = [string](Get-Prop $Result.Json 'bytesBase64')
    try {
        $actualBytes = [Convert]::FromBase64String($base64)
    }
    catch {
        Add-Failure $Name 'bytesBase64 is not valid base64'
        return
    }

    if ([Convert]::ToBase64String($actualBytes) -ne [Convert]::ToBase64String($ExpectedBytes)) {
        Add-Failure $Name 'returned bytes do not match the synthetic policy'
        return
    }

    $byteLength = Get-Prop $Result.Json 'byteLength'
    if ([int]$byteLength -ne $ExpectedBytes.Length) {
        Add-Failure $Name 'byteLength mismatch' ([string]$ExpectedBytes.Length) ([string]$byteLength)
        return
    }

    $expectedHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($ExpectedBytes)).ToLowerInvariant()
    $actualHash = [string](Get-Prop $Result.Json 'sha256')
    if ($actualHash -ne $expectedHash) {
        Add-Failure $Name 'sha256 mismatch' $expectedHash $actualHash
        return
    }

    $volume = Get-Prop $Result.Json 'volume'
    $volumeGuid = [string](Get-Prop $volume 'guid')
    $serial = [string](Get-Prop $volume 'serialNumberHex')
    if ($volumeGuid -notmatch '^\\\\\?\\volume\{[0-9a-fA-F-]+\}$') {
        Add-Failure $Name 'volume GUID is not canonical' '\\?\volume{guid}' $volumeGuid
        return
    }

    if ($serial -notmatch '^[0-9a-f]{16}$') {
        Add-Failure $Name 'volume serial is not 16 lowercase hex digits' '16 hex digits' $serial
        return
    }

    $file = Get-Prop $Result.Json 'file'
    $fileId = [string](Get-Prop $file 'idHex')
    if ($fileId -notmatch '^[0-9a-f]{32}$') {
        Add-Failure $Name 'file id is not 32 lowercase hex digits' '32 hex digits' $fileId
        return
    }

    $numberOfLinks = Get-Prop $file 'numberOfLinks'
    if ([int]$numberOfLinks -ne 1) {
        Add-Failure $Name 'file link count is not one' '1' ([string]$numberOfLinks)
        return
    }

    $fileSize = Get-Prop $file 'size'
    if ([long]$fileSize -ne $ExpectedBytes.Length) {
        Add-Failure $Name 'file size mismatch' ([string]$ExpectedBytes.Length) ([string]$fileSize)
        return
    }

    $directoryInfo = Get-Prop $Result.Json 'directory'
    $directoryId = [string](Get-Prop $directoryInfo 'idHex')
    if ($directoryId -notmatch '^[0-9a-f]{32}$') {
        Add-Failure $Name 'directory id is not 32 lowercase hex digits' '32 hex digits' $directoryId
        return
    }

    $identities = Get-Prop $Result.Json 'identities'
    $identityVolume = [string](Get-Prop $identities 'volume')
    $identityFile = [string](Get-Prop $identities 'file')
    $identityDirectory = [string](Get-Prop $identities 'directory')
    if ($identityVolume -ne $volumeGuid) {
        Add-Failure $Name 'volume identity is inconsistent'
        return
    }

    if ($identityFile -ne ($volumeGuid + '#' + $fileId)) {
        Add-Failure $Name 'file identity is inconsistent'
        return
    }

    if ($identityDirectory -ne ($volumeGuid + '#' + $directoryId)) {
        Add-Failure $Name 'directory identity is inconsistent'
        return
    }

    $protection = Get-Prop $Result.Json 'protection'
    foreach ($flag in @('ownerSidVerified', 'daclProtected', 'daclOwnerOnly', 'parentChainSafe')) {
        if ((Get-Prop $protection $flag) -ne $true) {
            Add-Failure $Name "protection flag $flag is not true"
            return
        }
    }

    foreach ($fingerprintName in @('fileFingerprint', 'directoryFingerprint')) {
        $fingerprint = [string](Get-Prop $protection $fingerprintName)
        if ($fingerprint -notmatch '^[0-9a-f]{64}$') {
            Add-Failure $Name "$fingerprintName is not a 64-hex-digit security fingerprint" '64 lowercase hex digits' $fingerprint
            return
        }
    }

    foreach ($timeName in @('lastWriteTimeUtc', 'changeTimeUtc')) {
        $value = [string](Get-Prop $file $timeName)
        if ([string]::IsNullOrWhiteSpace($value)) {
            Add-Failure $Name "$timeName is missing"
            return
        }

        try {
            $null = [DateTimeOffset]::Parse($value, [Globalization.CultureInfo]::InvariantCulture)
        }
        catch {
            Add-Failure $Name "$timeName is not parseable"
            return
        }
    }

    Add-Pass $Name
}

function Assert-DirectoryIdentityOk {
    param(
        [string]$Name,
        $Result,
        [string]$ExpectedPath,
        [int]$ExpectedComponentCount,
        [switch]$NoPass
    )

    if ($Result.OutputTooLarge) {
        Add-Failure $Name 'directory identity output exceeded the bounded capture limit'
        return $false
    }

    if ($Result.Stderr.Length -gt 0) {
        Add-Failure $Name 'directory identity helper wrote to stderr' 'empty stderr' $Result.Stderr
        return $false
    }

    if ($Result.ExitCode -ne 0) {
        Add-Failure $Name 'directory identity helper did not return success' 'exit 0 status ok' ("exit $($Result.ExitCode) code $(Get-Prop $Result.Json 'code')")
        return $false
    }

    if ([string](Get-Prop $Result.Json 'status') -ne 'ok') {
        Add-Failure $Name 'directory identity helper did not return status ok'
        return $false
    }

    if ([int](Get-Prop $Result.Json 'schemaVersion') -ne 1) {
        Add-Failure $Name 'unexpected directory identity schemaVersion' '1' ([string](Get-Prop $Result.Json 'schemaVersion'))
        return $false
    }

    if ([string](Get-Prop $Result.Json 'mode') -ne 'project-directory-identity') {
        Add-Failure $Name 'unexpected directory identity mode' 'project-directory-identity' ([string](Get-Prop $Result.Json 'mode'))
        return $false
    }

    if ($Result.Stdout.Length -gt 16384) {
        Add-Failure $Name 'directory identity receipt is not strictly bounded' '<= 16384 characters' ([string]$Result.Stdout.Length)
        return $false
    }

    $path = [string](Get-Prop $Result.Json 'directoryPath')
    if (-not [string]::Equals((Normalize-DriveCase $path), (Normalize-DriveCase $ExpectedPath), [StringComparison]::Ordinal)) {
        Add-Failure $Name 'directory path is not exact' $ExpectedPath $path
        return $false
    }

    $volume = Get-Prop $Result.Json 'volume'
    $volumeGuid = [string](Get-Prop $volume 'guid')
    $serial = [string](Get-Prop $volume 'serialNumberHex')
    if ($volumeGuid -notmatch '^\\\\\?\\volume\{[0-9a-fA-F-]+\}$') {
        Add-Failure $Name 'volume GUID is not canonical' '\\?\volume{guid}' $volumeGuid
        return $false
    }
    if ($serial -notmatch '^[0-9a-f]{16}$') {
        Add-Failure $Name 'volume serial is not 16 lowercase hex digits' '16 hex digits' $serial
        return $false
    }

    $directory = Get-Prop $Result.Json 'directory'
    $directoryId = [string](Get-Prop $directory 'idHex')
    $componentCount = [int](Get-Prop $directory 'componentCount')
    if ($directoryId -notmatch '^[0-9a-f]{32}$') {
        Add-Failure $Name 'directory id is not 32 lowercase hex digits' '32 hex digits' $directoryId
        return $false
    }
    if ($componentCount -ne $ExpectedComponentCount) {
        Add-Failure $Name 'directory component count mismatch' ([string]$ExpectedComponentCount) ([string]$componentCount)
        return $false
    }

    $identity = [string](Get-Prop $Result.Json 'identity')
    if ($identity -ne ($volumeGuid + '#' + $directoryId)) {
        Add-Failure $Name 'directory identity is inconsistent'
        return $false
    }

    foreach ($forbiddenField in @('bytesBase64', 'file', 'identities', 'protection')) {
        if ($null -ne (Get-Prop $Result.Json $forbiddenField)) {
            Add-Failure $Name "directory receipt unexpectedly contains $forbiddenField" 'minimal identity fields only'
            return $false
        }
    }

    if ($Result.Stdout -match 'S-1-') {
        Add-Failure $Name 'directory receipt contains an SID'
        return $false
    }

    if (-not $NoPass) {
        Add-Pass $Name
    }
    return $true
}
function Assert-Denied {
    param(
        [string]$Name,
        $Result,
        [int]$ExpectedExitCode,
        [string[]]$ExpectedCodes,
        [string]$ExpectedStatus = 'denied'
    )

    if ($Result.OutputTooLarge) {
        Add-Failure $Name 'helper output exceeded the bounded capture limit'
        return
    }

    if ($Result.Stderr.Length -gt 0) {
        Add-Failure $Name 'helper wrote to stderr' 'empty stderr' $Result.Stderr
        return
    }

    $status = Get-Prop $Result.Json 'status'
    $code = Get-Prop $Result.Json 'code'
    if ($Result.ExitCode -ne $ExpectedExitCode) {
        Add-Failure $Name 'unexpected exit code' ([string]$ExpectedExitCode) ("exit $($Result.ExitCode) status $status code $code")
        return
    }

    if ($status -ne $ExpectedStatus) {
        Add-Failure $Name 'unexpected status' $ExpectedStatus ([string]$status)
        return
    }

    if ($ExpectedCodes -notcontains $code) {
        Add-Failure $Name 'unexpected denial code' ($ExpectedCodes -join ', ') ([string]$code)
        return
    }

    if (Test-Sensitive $Result) {
        Add-Failure $Name 'denial output contains a path marker or the current user SID'
        return
    }

    Add-Pass $Name ("code " + [string]$code)
}

function New-TestDirectory {
    param([string]$Name)
    $directory = Join-Path $caseRoot $Name
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    return $directory
}

function Write-TestFile {
    param([string]$Path, [byte[]]$Bytes)
    [IO.File]::WriteAllBytes($Path, $Bytes)
    return $Path
}

function Set-OwnerOnlyAcl {
    param(
        [string]$Path,
        [switch]$Directory,
        [Security.AccessControl.FileSystemRights]$Rights = [Security.AccessControl.FileSystemRights]::FullControl
    )

    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $script:UserSid,
        $Rights,
        [Security.AccessControl.AccessControlType]::Allow)

    if ($Directory) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($script:UserSid)
        $acl.AddAccessRule($rule)
        [System.IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $Path -Force), $acl)
    }
    else {
        $acl = [Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($script:UserSid)
        $acl.AddAccessRule($rule)
        [System.IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $Path -Force), $acl)
    }
}

function Set-AclWithExtraRule {
    param(
        [string]$Path,
        [switch]$Directory,
        [Security.Principal.SecurityIdentifier]$Sid,
        [Security.AccessControl.FileSystemRights]$Rights,
        [Security.AccessControl.AccessControlType]$AccessControlType = [Security.AccessControl.AccessControlType]::Allow
    )

    $ownerRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $script:UserSid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow)
    $extraRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $Sid,
        $Rights,
        $AccessControlType)

    if ($Directory) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($script:UserSid)
        $acl.AddAccessRule($ownerRule)
        $acl.AddAccessRule($extraRule)
        [System.IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $Path -Force), $acl)
    }
    else {
        $acl = [Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($script:UserSid)
        $acl.AddAccessRule($ownerRule)
        $acl.AddAccessRule($extraRule)
        [System.IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $Path -Force), $acl)
    }
}

function Set-UnprotectedAcl {
    param([string]$Path)

    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($false, $false)
    $acl.SetOwner($script:UserSid)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $script:UserSid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow))
    [System.IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $Path -Force), $acl)
}

function Run-Case {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
    }
    catch {
        Add-Failure $Name ('fixture exception: ' + $_.Exception.Message) -Code 'fixture-case-exception'
    }
}

$utf8 = [Text.UTF8Encoding]::new($false)
$policyBytes = $utf8.GetBytes('{"schemaVersion":1,"revision":"fixture-unicode","projects":[]}')
$changedPolicyBytes = $utf8.GetBytes('{"schemaVersion":1,"revision":"fixture-unicode-2","projects":[]}')

Run-Case 'happy-unicode-space' {
    $directory = New-TestDirectory 'happy owner only ünïcode 空 格'
    $file = Join-Path $directory 'policy file ünïcode.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($file)
    Assert-Ok 'happy-unicode-space' $result ([IO.Path]::GetFullPath($file)) ([IO.Path]::GetFullPath($directory)) $policyBytes
}

Run-Case 'runtime-environment-hardening' {
    $directory = New-TestDirectory 'runtime environment hardening'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $emptyDirectory = Join-Path $script:ScratchRoot 'empty-runtime-directory'
    New-Item -ItemType Directory -Path $emptyDirectory -Force | Out-Null

    $runtimeOverride = Invoke-Helper -Arguments @($file) -Environment @{
        DOTNET_ROOT = $emptyDirectory
    }
    Assert-Denied 'runtime-env-root-untrusted' $runtimeOverride 3 @('runtime-env-untrusted')

    $bundleOverride = Invoke-Helper -Arguments @($file) -Environment @{
        DOTNET_BUNDLE_EXTRACT_BASE_DIR = $emptyDirectory
    }
    Assert-Denied 'runtime-env-bundle-untrusted' $bundleOverride 3 @('runtime-env-untrusted')

    $nativeOverride = Invoke-Helper -Arguments @($file) -Environment @{
        NATIVE_DLL_SEARCH_DIRECTORIES = $emptyDirectory
    }
    Assert-Denied 'runtime-env-native-untrusted' $nativeOverride 3 @('runtime-env-untrusted')
}

Run-Case 'stable-snapshot-two-runs' {
    $directory = New-TestDirectory 'stable snapshot'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $first = Invoke-Helper @($file)
    $second = Invoke-Helper @($file)
    if ($first.ExitCode -ne 0 -or $second.ExitCode -ne 0) {
        Add-Failure 'stable-snapshot-two-runs' 'one of the two snapshots failed'
        return
    }

    $firstFile = Get-Prop $first.Json 'file'
    $secondFile = Get-Prop $second.Json 'file'
    $firstDirectory = Get-Prop $first.Json 'directory'
    $secondDirectory = Get-Prop $second.Json 'directory'
    $firstIdentities = Get-Prop $first.Json 'identities'
    $secondIdentities = Get-Prop $second.Json 'identities'
    $firstProtection = Get-Prop $first.Json 'protection'
    $secondProtection = Get-Prop $second.Json 'protection'
    if (
        (Get-Prop $firstFile 'idHex') -ne (Get-Prop $secondFile 'idHex') -or
        (Get-Prop $firstDirectory 'idHex') -ne (Get-Prop $secondDirectory 'idHex') -or
        (Get-Prop $firstIdentities 'file') -ne (Get-Prop $secondIdentities 'file') -or
        (Get-Prop $firstIdentities 'directory') -ne (Get-Prop $secondIdentities 'directory') -or
        (Get-Prop $firstProtection 'fileFingerprint') -ne (Get-Prop $secondProtection 'fileFingerprint') -or
        (Get-Prop $firstProtection 'directoryFingerprint') -ne (Get-Prop $secondProtection 'directoryFingerprint') -or
        (Get-Prop $first.Json 'sha256') -ne (Get-Prop $second.Json 'sha256')
    ) {
        Add-Failure 'stable-snapshot-two-runs' 'identity, protection fingerprint or content hash changed without a filesystem change'
        return
    }

    Add-Pass 'stable-snapshot-two-runs'
}

Run-Case 'directory-identity-shared-across-files' {
    $directory = New-TestDirectory 'directory identity'
    $firstFile = Join-Path $directory 'policy-a.json'
    $secondFile = Join-Path $directory 'policy-b.json'
    Write-TestFile $firstFile $policyBytes | Out-Null
    Write-TestFile $secondFile $changedPolicyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $firstFile
    Set-OwnerOnlyAcl -Path $secondFile
    Set-OwnerOnlyAcl -Path $directory -Directory

    $first = Invoke-Helper @($firstFile)
    $second = Invoke-Helper @($secondFile)
    if ($first.ExitCode -ne 0 -or $second.ExitCode -ne 0) {
        Add-Failure 'directory-identity-shared-across-files' 'one of the snapshots failed'
        return
    }

    $firstDirectory = Get-Prop $first.Json 'directory'
    $secondDirectory = Get-Prop $second.Json 'directory'
    $firstFileInfo = Get-Prop $first.Json 'file'
    $secondFileInfo = Get-Prop $second.Json 'file'
    if ((Get-Prop $firstDirectory 'idHex') -ne (Get-Prop $secondDirectory 'idHex')) {
        Add-Failure 'directory-identity-shared-across-files' 'directory identity differs for the same directory'
        return
    }

    if ((Get-Prop $firstFileInfo 'idHex') -eq (Get-Prop $secondFileInfo 'idHex')) {
        Add-Failure 'directory-identity-shared-across-files' 'distinct files reported the same file id'
        return
    }

    Add-Pass 'directory-identity-shared-across-files'
}

Run-Case 'project-directory-stable' {
    $directory = New-TestDirectory 'project directory stable'
    $expectedPath = [IO.Path]::GetFullPath($directory)
    $componentCount = ($expectedPath.Substring(3) -split '\\').Count

    $first = Invoke-Helper @('--project-directory-identity', $directory)
    $second = Invoke-Helper @('--project-directory-identity', $directory)
    $firstOk = Assert-DirectoryIdentityOk 'project-directory-stable-first' $first $expectedPath $componentCount -NoPass
    $secondOk = Assert-DirectoryIdentityOk 'project-directory-stable-second' $second $expectedPath $componentCount -NoPass
    if (-not ($firstOk -and $secondOk)) { return }

    $firstIdentity = [string](Get-Prop (Get-Prop $first.Json 'directory') 'idHex')
    $secondIdentity = [string](Get-Prop (Get-Prop $second.Json 'directory') 'idHex')
    if (
        $firstIdentity -ne $secondIdentity -or
        (Get-Prop $first.Json 'identity') -ne (Get-Prop $second.Json 'identity') -or
        (Get-Prop $first.Json 'directoryPath') -ne (Get-Prop $second.Json 'directoryPath') -or
        (Get-Prop (Get-Prop $first.Json 'volume') 'serialNumberHex') -ne (Get-Prop (Get-Prop $second.Json 'volume') 'serialNumberHex')
    ) {
        Add-Failure 'project-directory-stable' 'directory identity changed without a filesystem change'
        return
    }

    Add-Pass 'project-directory-stable'
}

Run-Case 'project-directory-replacement-identity' {
    $parent = New-TestDirectory 'project directory replacement'
    $directory = Join-Path $parent 'project'
    New-Item -ItemType Directory -Path $directory | Out-Null
    $expectedPath = [IO.Path]::GetFullPath($directory)
    $componentCount = ($expectedPath.Substring(3) -split '\\').Count

    $before = Invoke-Helper @('--project-directory-identity', $directory)
    $beforeOk = Assert-DirectoryIdentityOk 'project-directory-replacement-before' $before $expectedPath $componentCount -NoPass
    if (-not $beforeOk) { return }

    $old = Join-Path $parent 'project-old'
    [IO.Directory]::Move($directory, $old)
    New-Item -ItemType Directory -Path $directory | Out-Null

    $after = Invoke-Helper @('--project-directory-identity', $directory)
    $afterOk = Assert-DirectoryIdentityOk 'project-directory-replacement-after' $after $expectedPath $componentCount -NoPass
    if (-not $afterOk) { return }

    $beforeId = [string](Get-Prop (Get-Prop $before.Json 'directory') 'idHex')
    $afterId = [string](Get-Prop (Get-Prop $after.Json 'directory') 'idHex')
    if ($beforeId -eq $afterId) {
        Add-Failure 'project-directory-replacement-identity' 'replacement did not change directory identity'
        return
    }

    if ((Get-Prop $before.Json 'identity') -eq (Get-Prop $after.Json 'identity')) {
        Add-Failure 'project-directory-replacement-identity' 'composite directory identity did not change'
        return
    }

    Add-Pass 'project-directory-replacement-identity'
}

Run-Case 'project-directory-file-denied' {
    $parent = New-TestDirectory 'project directory wrong kind'
    $file = Join-Path $parent 'not-a-directory'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $parent -Directory

    $result = Invoke-Helper @('--project-directory-identity', $file)
    Assert-Denied 'project-directory-file-denied' $result 3 @('component-not-directory')
}

Run-Case 'project-directory-junction-denied' {
    $parent = New-TestDirectory 'project directory junction'
    $target = New-TestDirectory 'project directory junction target'
    $junction = Join-Path $parent 'linked-project'
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null

    $result = Invoke-Helper @('--project-directory-identity', $junction)
    Assert-Denied 'project-directory-junction-denied' $result 3 @('component-reparse')
}

Run-Case 'project-directory-alias-denied' {
    $parent = New-TestDirectory 'project directory alias long name'
    $shortPath = [RacFixtureNative]::GetShortPath($parent)
    if ([string]::IsNullOrWhiteSpace($shortPath) -or [string]::Equals($shortPath, $parent, [StringComparison]::OrdinalIgnoreCase)) {
        Add-Result -Name 'project-directory-alias-denied' -Status 'UNSUPPORTED' -Detail '8.3 short-name generation is unavailable for the directory fixture path'
        return
    }

    $result = Invoke-Helper @('--project-directory-identity', $shortPath)
    Assert-Denied 'project-directory-alias-denied' $result 3 @('input-ambiguous')
}

Run-Case 'project-directory-case-mismatch-denied' {
    $directory = New-TestDirectory 'ProjectDirectoryCaseExact'
    $result = Invoke-Helper @('--project-directory-identity', $directory.ToLowerInvariant())
    Assert-Denied 'project-directory-case-mismatch-denied' $result 3 @('input-case-mismatch')
}

Run-Case 'project-directory-usage' {
    $onlyMode = Invoke-Helper @('--project-directory-identity')
    Assert-Denied 'project-directory-usage-mode-only' $onlyMode 2 @('usage') 'invalid'

    $extra = Invoke-Helper @('--project-directory-identity', $caseRoot, 'extra')
    Assert-Denied 'project-directory-usage-extra-argument' $extra 2 @('usage') 'invalid'
}
Run-Case 'replacement-changes-identity' {
    $directory = New-TestDirectory 'replacement identity'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $before = Invoke-Helper @($file)
    if ($before.ExitCode -ne 0) {
        Add-Failure 'replacement-changes-identity' 'initial snapshot failed'
        return
    }

    $replacement = Join-Path $directory 'policy.next.json'
    Write-TestFile $replacement $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $replacement
    [IO.File]::Move($replacement, $file, $true)
    Set-OwnerOnlyAcl -Path $file

    $after = Invoke-Helper @($file)
    if ($after.ExitCode -ne 0) {
        Add-Failure 'replacement-changes-identity' 'snapshot after replacement failed' '' ("code " + [string](Get-Prop $after.Json 'code'))
        return
    }

    $beforeFile = Get-Prop $before.Json 'file'
    $afterFile = Get-Prop $after.Json 'file'
    $beforeDirectory = Get-Prop $before.Json 'directory'
    $afterDirectory = Get-Prop $after.Json 'directory'
    if ((Get-Prop $beforeFile 'idHex') -eq (Get-Prop $afterFile 'idHex')) {
        Add-Failure 'replacement-changes-identity' 'replacement did not change file identity'
        return
    }

    if ((Get-Prop $before.Json 'sha256') -ne (Get-Prop $after.Json 'sha256')) {
        Add-Failure 'replacement-changes-identity' 'same bytes produced a different content hash'
        return
    }

    if ((Get-Prop $beforeDirectory 'idHex') -ne (Get-Prop $afterDirectory 'idHex')) {
        Add-Failure 'replacement-changes-identity' 'directory identity changed on file replacement'
        return
    }

    Add-Pass 'replacement-changes-identity'
}

Run-Case 'in-place-change-changes-hash-not-identity' {
    $directory = New-TestDirectory 'in place change'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $before = Invoke-Helper @($file)
    if ($before.ExitCode -ne 0) {
        Add-Failure 'in-place-change-changes-hash-not-identity' 'initial snapshot failed'
        return
    }

    [IO.File]::WriteAllBytes($file, $changedPolicyBytes)
    $after = Invoke-Helper @($file)
    if ($after.ExitCode -ne 0) {
        Add-Failure 'in-place-change-changes-hash-not-identity' 'snapshot after in-place change failed' '' ("code " + [string](Get-Prop $after.Json 'code'))
        return
    }

    $beforeFile = Get-Prop $before.Json 'file'
    $afterFile = Get-Prop $after.Json 'file'
    if ((Get-Prop $beforeFile 'idHex') -ne (Get-Prop $afterFile 'idHex')) {
        Add-Failure 'in-place-change-changes-hash-not-identity' 'in-place write changed file identity'
        return
    }

    if ((Get-Prop $before.Json 'sha256') -eq (Get-Prop $after.Json 'sha256')) {
        Add-Failure 'in-place-change-changes-hash-not-identity' 'in-place write did not change content hash'
        return
    }

    Add-Pass 'in-place-change-changes-hash-not-identity'
}

Run-Case 'protection-fingerprint-drift' {
    $directory = New-TestDirectory 'protection fingerprint drift'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $before = Invoke-Helper @($file)
    if ($before.ExitCode -ne 0) {
        Add-Failure 'protection-fingerprint-drift' 'initial protected snapshot failed' '' ("code " + [string](Get-Prop $before.Json 'code'))
        return
    }

    $beforeProtection = Get-Prop $before.Json 'protection'
    $beforeFileFingerprint = [string](Get-Prop $beforeProtection 'fileFingerprint')
    $beforeDirectoryFingerprint = [string](Get-Prop $beforeProtection 'directoryFingerprint')
    if ($beforeFileFingerprint -notmatch '^[0-9a-f]{64}$' -or $beforeDirectoryFingerprint -notmatch '^[0-9a-f]{64}$') {
        Add-Failure 'protection-fingerprint-drift' 'initial security fingerprints are malformed'
        return
    }

    $driftFileRights =
        [Security.AccessControl.FileSystemRights]::Modify -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions
    $driftDirectoryRights =
        $driftFileRights -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles

    Set-OwnerOnlyAcl -Path $file -Rights $driftFileRights
    Set-OwnerOnlyAcl -Path $directory -Directory -Rights $driftDirectoryRights

    $after = Invoke-Helper @($file)
    if ($after.ExitCode -ne 0) {
        Add-Failure 'protection-fingerprint-drift' 'snapshot after protected ACL drift failed' '' ("code " + [string](Get-Prop $after.Json 'code'))
        return
    }

    $afterProtection = Get-Prop $after.Json 'protection'
    $afterFileFingerprint = [string](Get-Prop $afterProtection 'fileFingerprint')
    $afterDirectoryFingerprint = [string](Get-Prop $afterProtection 'directoryFingerprint')
    if ($beforeFileFingerprint -eq $afterFileFingerprint) {
        Add-Failure 'protection-fingerprint-drift' 'file owner/DACL fingerprint did not change'
        return
    }

    if ($beforeDirectoryFingerprint -eq $afterDirectoryFingerprint) {
        Add-Failure 'protection-fingerprint-drift' 'directory owner/DACL fingerprint did not change'
        return
    }

    if ((Get-Prop $before.Json 'sha256') -ne (Get-Prop $after.Json 'sha256')) {
        Add-Failure 'protection-fingerprint-drift' 'content hash changed without a content change'
        return
    }

    Add-Pass 'protection-fingerprint-drift'
}

Run-Case 'file-unsafe-acl' {
    $directory = New-TestDirectory ('file unsafe acl ' + $script:Marker)
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-AclWithExtraRule -Path $file -Sid $script:UsersSid -Rights ([Security.AccessControl.FileSystemRights]::Read)
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($file)
    Assert-Denied 'file-unsafe-acl' $result 3 @('file-dacl-unexpected-trustee')
}

Run-Case 'file-deny-ace-unsupported' {
    $directory = New-TestDirectory 'file deny ace'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    $unrelatedSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-111111111-222222222-333333333-4444')
    Set-AclWithExtraRule -Path $file -Sid $unrelatedSid -Rights ([Security.AccessControl.FileSystemRights]::Read) -AccessControlType ([Security.AccessControl.AccessControlType]::Deny)
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($file)
    Assert-Denied 'file-deny-ace-unsupported' $result 3 @('file-dacl-unsupported')
}

Run-Case 'directory-unsafe-acl' {
    $directory = New-TestDirectory 'directory unsafe acl'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-AclWithExtraRule -Path $directory -Directory -Sid $script:UsersSid -Rights ([Security.AccessControl.FileSystemRights]::Read)

    $result = Invoke-Helper @($file)
    Assert-Denied 'directory-unsafe-acl' $result 3 @('directory-dacl-unexpected-trustee')
}

Run-Case 'file-unprotected-dacl' {
    $directory = New-TestDirectory 'file unprotected dacl'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory
    Set-UnprotectedAcl -Path $file

    $result = Invoke-Helper @($file)
    Assert-Denied 'file-unprotected-dacl' $result 3 @('file-dacl-unprotected')
}

Run-Case 'unsafe-ancestor' {
    $root = New-TestDirectory 'unsafe ancestor'
    $unsafe = Join-Path $root 'unsafe ancestor'
    $safe = Join-Path $unsafe 'safe parent'
    New-Item -ItemType Directory -Path $safe -Force | Out-Null
    $file = Join-Path $safe 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $safe -Directory
    Set-AclWithExtraRule -Path $unsafe -Directory -Sid $script:UsersSid -Rights ([Security.AccessControl.FileSystemRights]::Modify)

    $result = Invoke-Helper @($file)
    Assert-Denied 'unsafe-ancestor' $result 3 @('parent-dacl-unsafe')
}

Run-Case 'ancestor-create-only-allowed' {
    $root = New-TestDirectory 'create only ancestor'
    $ancestor = Join-Path $root 'create only'
    $safe = Join-Path $ancestor 'safe parent'
    New-Item -ItemType Directory -Path $safe -Force | Out-Null
    $file = Join-Path $safe 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $safe -Directory
    Set-AclWithExtraRule -Path $ancestor -Directory -Sid $script:UsersSid -Rights (
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories)

    $result = Invoke-Helper @($file)
    Assert-Ok 'ancestor-create-only-allowed' $result ([IO.Path]::GetFullPath($file)) ([IO.Path]::GetFullPath($safe)) $policyBytes
}

Run-Case 'ancestor-delete-child-denied' {
    $root = New-TestDirectory 'delete child ancestor'
    $ancestor = Join-Path $root 'delete child'
    $safe = Join-Path $ancestor 'safe parent'
    New-Item -ItemType Directory -Path $safe -Force | Out-Null
    $file = Join-Path $safe 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $safe -Directory
    Set-AclWithExtraRule -Path $ancestor -Directory -Sid $script:UsersSid -Rights (
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)

    $result = Invoke-Helper @($file)
    Assert-Denied 'ancestor-delete-child-denied' $result 3 @('parent-dacl-unsafe')
}

Run-Case 'ancestor-change-permissions-denied' {
    $root = New-TestDirectory 'change permissions ancestor'
    $ancestor = Join-Path $root 'change permissions'
    $safe = Join-Path $ancestor 'safe parent'
    New-Item -ItemType Directory -Path $safe -Force | Out-Null
    $file = Join-Path $safe 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $safe -Directory
    Set-AclWithExtraRule -Path $ancestor -Directory -Sid $script:UsersSid -Rights (
        [Security.AccessControl.FileSystemRights]::ChangePermissions)

    $result = Invoke-Helper @($file)
    Assert-Denied 'ancestor-change-permissions-denied' $result 3 @('parent-dacl-unsafe')
}

Run-Case 'leaf-junction-reparse' {
    $directory = New-TestDirectory 'leaf junction'
    $target = New-TestDirectory 'leaf junction target'
    Set-OwnerOnlyAcl -Path $directory -Directory
    $junction = Join-Path $directory 'policy.json'
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null

    $result = Invoke-Helper @($junction)
    Assert-Denied 'leaf-junction-reparse' $result 3 @('file-reparse', 'file-not-regular')
}

Run-Case 'ancestor-junction-reparse' {
    $root = New-TestDirectory ('ancestor junction ' + $script:Marker)
    $real = Join-Path $root 'real'
    New-Item -ItemType Directory -Path $real -Force | Out-Null
    $file = Join-Path $real 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $real -Directory
    $junction = Join-Path $root 'link'
    New-Item -ItemType Junction -Path $junction -Target $real | Out-Null

    $result = Invoke-Helper @((Join-Path $junction 'policy.json'))
    Assert-Denied 'ancestor-junction-reparse' $result 3 @('component-reparse')
}

Run-Case 'leaf-directory-not-regular' {
    $directory = New-TestDirectory 'leaf directory'
    $leaf = Join-Path $directory 'policy.json'
    New-Item -ItemType Directory -Path $leaf -Force | Out-Null
    Set-OwnerOnlyAcl -Path $leaf -Directory
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($leaf)
    Assert-Denied 'leaf-directory-not-regular' $result 3 @('file-not-regular')
}

Run-Case 'file-as-ancestor' {
    $directory = New-TestDirectory 'file ancestor'
    $blocker = Join-Path $directory 'blocker'
    Write-TestFile $blocker $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $blocker
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @((Join-Path $blocker 'policy.json'))
    Assert-Denied 'file-as-ancestor' $result 3 @('component-not-directory')
}

Run-Case 'empty-file' {
    $directory = New-TestDirectory 'empty file'
    $file = Join-Path $directory 'policy.json'
    [IO.File]::WriteAllBytes($file, [byte[]]@())
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($file)
    Assert-Denied 'empty-file' $result 3 @('file-empty')
}

Run-Case 'oversize-file' {
    $directory = New-TestDirectory 'oversize file'
    $file = Join-Path $directory 'policy.json'
    [IO.File]::WriteAllBytes($file, [byte[]]::new((256 * 1024) + 1))
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($file)
    Assert-Denied 'oversize-file' $result 3 @('file-oversize')
}

Run-Case 'maximum-size-file' {
    $directory = New-TestDirectory 'maximum size file'
    $file = Join-Path $directory 'policy.json'
    $bytes = [byte[]]::new(256 * 1024)
    [IO.File]::WriteAllBytes($file, $bytes)
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($file)
    Assert-Ok 'maximum-size-file' $result ([IO.Path]::GetFullPath($file)) ([IO.Path]::GetFullPath($directory)) $bytes
}

Run-Case 'hardlink-rejected' {
    $directory = New-TestDirectory 'hardlink'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory
    $link = Join-Path $directory 'policy-link.json'
    New-Item -ItemType HardLink -Path $link -Target $file | Out-Null

    $result = Invoke-Helper @($link)
    Assert-Denied 'hardlink-rejected' $result 3 @('file-hardlinked')
}

Run-Case 'existing-writer-fails-closed' {
    $directory = New-TestDirectory 'existing writer'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $writer = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $result = Invoke-Helper @($file)
        Assert-Denied 'existing-writer-fails-closed' $result 3 @('file-open-failed', 'file-unavailable', 'read-failed')
    }
    finally {
        $writer.Dispose()
    }
}

Run-Case 'delete-capable-handle-sharing-denied' {
    $directory = New-TestDirectory 'delete capable handle'
    $file = Join-Path $directory 'policy.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $handle = [RacFixtureNative]::OpenDeleteCapableHandle($file)
    try {
        $result = Invoke-Helper @($file)
        Assert-Denied 'delete-capable-handle-sharing-denied' $result 3 @('file-open-failed', 'file-unavailable')
    }
    finally {
        [RacFixtureNative]::Close($handle)
    }
}

Run-Case 'missing-file-no-sensitive-output' {
    $directory = New-TestDirectory 'missing file'
    $file = Join-Path $directory ('policy-' + $script:Marker + '-missing.json')
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($file)
    Assert-Denied 'missing-file-no-sensitive-output' $result 3 @('file-open-failed')
}

Run-Case 'case-mismatch-refused' {
    $directory = New-TestDirectory 'CaseExactPath'
    $file = Join-Path $directory 'Policy.JSON'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $result = Invoke-Helper @($file.ToLowerInvariant())
    Assert-Denied 'case-mismatch-refused' $result 3 @('input-case-mismatch')
}

Run-Case 'short-name-alias' {
    $directory = New-TestDirectory 'short name alias long directory'
    $file = Join-Path $directory 'long policy name.json'
    Write-TestFile $file $policyBytes | Out-Null
    Set-OwnerOnlyAcl -Path $file
    Set-OwnerOnlyAcl -Path $directory -Directory

    $shortPath = [RacFixtureNative]::GetShortPath($file)
    if ([string]::IsNullOrWhiteSpace($shortPath) -or [string]::Equals($shortPath, $file, [StringComparison]::OrdinalIgnoreCase)) {
        Add-Result -Name 'short-name-alias' -Status 'UNSUPPORTED' -Detail '8.3 short-name generation is unavailable for the fixture path'
        return
    }

    $result = Invoke-Helper @($shortPath)
    Assert-Denied 'short-name-alias' $result 3 @('input-ambiguous')
}

Run-Case 'invalid-input-refusals' {
    $cases = @(
        @{ Name = 'drive-root'; Arguments = @('C:\'); Codes = @('input-drive-root') },
        @{ Name = 'drive-relative'; Arguments = @('C:relative'); Codes = @('input-not-drive-absolute') },
        @{ Name = 'extended-prefix'; Arguments = @('\\?\C:\' + $script:Marker); Codes = @('input-not-drive-absolute') },
        @{ Name = 'unc'; Arguments = @('\\localhost\C$\' + $script:Marker); Codes = @('input-not-drive-absolute') },
        @{ Name = 'forward-slash'; Arguments = @('C:/' + $script:Marker + '/policy.json'); Codes = @('input-not-drive-absolute', 'input-alternate') },
        @{ Name = 'dot-dot'; Arguments = @('C:\' + $script:Marker + '\..\policy.json'); Codes = @('input-component-invalid') },
        @{ Name = 'ads'; Arguments = @('C:\' + $script:Marker + '\policy.json:stream'); Codes = @('input-alternate') },
        @{ Name = 'reserved-device'; Arguments = @('C:\' + $script:Marker + '\CON'); Codes = @('input-alternate') },
        @{ Name = 'trailing-dot'; Arguments = @('C:\' + $script:Marker + '\policy.json.'); Codes = @('input-component-invalid') },
        @{ Name = 'trailing-space'; Arguments = @('C:\' + $script:Marker + '\policy.json '); Codes = @('input-component-invalid') },
        @{ Name = 'too-deep'; Arguments = @('C:\' + ('a\' * 64) + 'policy.json'); Codes = @('input-too-deep') },
        @{ Name = 'component-too-long'; Arguments = @('C:\' + ('x' * 256)); Codes = @('input-component-invalid') },
        @{ Name = 'path-too-long'; Arguments = @('C:\' + ('a' * 8190)); Codes = @('input-too-long') },
        @{ Name = 'empty-argument'; Arguments = @(''); Codes = @('input-empty') }
    )

    foreach ($case in $cases) {
        $result = Invoke-Helper $case.Arguments
        Assert-Denied ('invalid-input-' + $case.Name) $result 2 $case.Codes 'invalid'
    }
}

Run-Case 'usage-refusals' {
    $zero = Invoke-Helper @()
    Assert-Denied 'usage-zero-arguments' $zero 2 @('usage') 'invalid'

    $two = Invoke-Helper @((Join-Path $caseRoot 'unused.json'), 'extra')
    Assert-Denied 'usage-two-arguments' $two 2 @('usage') 'invalid'
}

$failures = @($script:Results | Where-Object { $_.status -eq 'FAIL' })
$unsupported = @($script:Results | Where-Object { $_.status -eq 'UNSUPPORTED' })
$overall = if ($failures.Count -gt 0) { 'FAIL' } elseif ($unsupported.Count -gt 0) { 'INCOMPLETE' } else { 'PASS' }

$summary = [pscustomobject]@{
    suite = 'windows-policy-helper-native-fixture'
    status = $overall
    binding = $script:Binding
    scratchParent = $script:ScratchParent
    scratchRoot = $script:ScratchRoot
    scratchOwned = -not [string]::IsNullOrWhiteSpace($script:ScratchChildName)
    helper = [pscustomobject]@{
        path = $script:HelperPath
        sha256 = $script:HelperHash
    }
    artifact = $script:Artifact
    source = [pscustomobject]@{
        project = $script:ProjectSource
        files = $sourceFiles
    }
    cases = @($script:Results)
    coverageGaps = @(
        'A true file symlink was not created in this environment; a directory junction is used as the leaf reparse witness.',
        'If writing the fixture ownership marker fails, cleanup refuses to delete the unmarked child; the child may leak rather than risk caller data.',
        'The helper rejects DENY ACEs on the leaf/immediate directory as unsupported; ancestor DENY behavior is not separately exercised.',
        'The measured bundle manifest reports needsExtractionCount=0 (header 6.0, flags 0, 169 assemblies, one deps JSON, one runtimeconfig JSON); DOTNET_BUNDLE_EXTRACT_BASE_DIR and other DOTNET_* overrides are rejected. If extraction appears in a future manifest, protected extraction becomes a new mandatory launch boundary.',
        'COREHOST_TRACE can emit host stderr before managed Main; the helper rejection is after host start, so launchers must clear COREHOST_* before launch.',
        'Changing the file owner to another SID requires privilege and is not exercised.',
        'A non-fixed/remote volume is not mounted for this fixture; drive-type refusal is covered by code inspection only.',
        'Within-read concurrent ACL drift is not forced deterministically; the helper re-reads owner/DACL before release, and cross-run fingerprint drift plus a delete-capable handle sharing denial are covered.',
        'Ancestor owner/DACL is checked before the leaf read but not re-read at the end; only the leaf and immediate directory are re-read.',
        'An ancestor create-only ACE is intentionally allowed because it cannot replace or delete an existing name; delete-child and change-permissions ancestor cases are exercised.',
        'Case-sensitive NTFS directories are not probed; the helper instead requires exact canonical component spelling and rejects case-only mismatches.',
        'The self-contained non-extracting single-file artifact is unsigned; package trust binding is downstream.',
        'The helper is built for x64; ARM64 Windows is not exercised.',
        'Long paths above the documented 8192-character/64-component bound and ReFS file IDs are not exercised.'
        'Project-directory identity mode is not an ACL/ownership/approval or policy-content determination and is not sufficient for dispatch admission.'
        'Project-directory mode releases handles before output; replacement or ACL changes after the final identity query are effect-lifetime TOCTOU. Stable/replaced directory identities, wrong kind, junction and short/case aliases are exercised, but a deterministic within-probe replacement race is not.'
        'Policy mode directory identity is the policy file parent, not the registered project root; the explicit directory mode is required for project-root identity.'
        'Non-fixed/remote project volumes are not mounted for this fixture; short-name alias coverage is UNSUPPORTED when 8.3 name generation is unavailable.'
        'The shared strict path shape refuses a drive root as a project directory; the fixture uses subdirectories.'
        'Drive-substitution aliases are not separately probed; short-name/case and junction aliases are covered.'
    )
}

$summary | ConvertTo-Json -Depth 10

Remove-OwnedScratch

if ($failures.Count -gt 0) { exit 1 }
if ($unsupported.Count -gt 0) { exit 2 }
exit 0
