#Requires -Version 7.0
<#
.SYNOPSIS
    Qualification for the owner-only Windows launch-ownership first slice.

.DESCRIPTION
    Builds the existing synthetic process-tree fixture plus the native launch library
    and its conformance runner, runs the ownership suite on this host, and writes a
    hash + test receipt into one unique scratch directory.

    This script does not install anything, register a service or task, change machine
    configuration, touch the repository working tree, or run the product monorepo
    build. Builds use one MSBuild job at a time and are redirected away from the
    repository with --artifacts-path. The receipt binds the initial HEAD tree and the
    initial scoped source/script hashes, then verifies they are unchanged before PASS.

.PARAMETER RepoRoot
    Repository root. Defaults to the worktree containing this script.

.PARAMETER ScratchRoot
    Caller-owned parent for the unique run directory. Defaults to a portable directory
    under the current user's temporary path.

.PARAMETER ExpectedCommit
    Required full 40-hex commit to bind. Pass the published commit being qualified.

.PARAMETER AllowOtherCommit
    Permit a HEAD that differs from the explicit -ExpectedCommit for diagnostics only;
    the mismatch is recorded and cannot produce an attested PASS.

.PARAMETER SkipSourceScan
    Skip the forbidden-API scan of the production library sources.

.EXAMPLE
    $commit = git -C . rev-parse HEAD
    pwsh qualification/windows/launch-ownership-fixture.ps1 -ExpectedCommit $commit -ScratchRoot "$env:TEMP\rac-windows-launch"
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$ScratchRoot = (Join-Path ([System.IO.Path]::GetTempPath()) 'rac-windows-launch'),
    [string]$ExpectedCommit = '',
    [switch]$AllowOtherCommit,
    [switch]$SkipSourceScan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), (([guid]::NewGuid().ToString('N')).Substring(0, 6))
$runDir = Join-Path $ScratchRoot $runId
$receiptPath = Join-Path $runDir 'receipt.json'
$script:status = 'FAIL'
$script:errorMessage = $null
$script:testData = $null
$script:suiteExit = $null
$script:sourceScan = $null
$script:artifacts = @()
$script:sourceHashes = @()
$script:head = $null
$script:fixtureExe = $null
$script:testExe = $null
$script:libraryDll = $null
$testReceipt = $null
$suiteLog = $null
$statusLines = @()
$scopedStatusLines = @()
$modifiedInputs = @()
$untrackedInputs = @()
$inputsDirty = $null
$script:boundCommit = $null
$script:scopedStatusLines = @()
$script:modifiedInputs = @()
$script:untrackedInputs = @()
$script:inputsDirty = $null
$script:initialHeadTree = $null
$script:finalHeadTree = $null
$script:finalHeadCommit = $null
$script:headTreeStable = $null
$script:initialScopedInputs = @()
$script:finalScopedInputs = @()
$script:scopedInputsStable = $null
$script:attested = $false

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-FileRecord {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$BasePath,
        [string]$Kind = 'source'
    )
    $item = Get-Item -LiteralPath $Path
    [pscustomobject][ordered]@{
        kind = $Kind
        path = $item.FullName
        relativePath = [System.IO.Path]::GetRelativePath($BasePath, $item.FullName)
        bytes = $item.Length
        sha256 = Get-Sha256 -Path $item.FullName
    }
}

function Invoke-Build {
    param(
        [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][string]$ArtifactsPath
    )

    Write-Host "BUILD $Project"
    $output = & dotnet build $Project -c Release --artifacts-path $ArtifactsPath -m:1 -nodeReuse:false -v:minimal --nologo -p:DebugType=None -p:DebugSymbols=false 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String)
    $text | Set-Content -LiteralPath (Join-Path $runDir ('build-' + [System.IO.Path]::GetFileNameWithoutExtension($Project) + '.log')) -Encoding utf8
    if ($exitCode -ne 0) {
        throw "dotnet build failed with exit code $exitCode for $Project`n$text"
    }

    if ($text -match 'error\s+[A-Z]+\d+') {
        throw "dotnet build printed an error for $Project despite exit code 0`n$text"
    }

    return $text
}

function Get-ScopedInputRecords {
    # Existing publication scope only: native component, this script, and the fixture.
    $records = @()
    $nativeRoot = Join-Path $RepoRoot 'native/windows-launch'
    if (Test-Path -LiteralPath $nativeRoot -PathType Container) {
        $records += @(Get-ChildItem -LiteralPath $nativeRoot -Recurse -File |
            Where-Object { $_.FullName -notmatch '[\\/](bin|obj)[\\/]' } |
            ForEach-Object { Get-FileRecord -Path $_.FullName -BasePath $RepoRoot -Kind 'scoped-input' })
    }

    foreach ($relativePath in @(
            'qualification/windows/launch-ownership-fixture.ps1',
            'qualification/windows/process-tree-fixture.cs')) {
        $path = Join-Path $RepoRoot $relativePath
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $records += Get-FileRecord -Path $path -BasePath $RepoRoot -Kind 'scoped-input'
        }
    }

    return @($records | Sort-Object relativePath)
}

function Test-ScopedInputsUnchanged {
    param(
        [object[]]$Initial,
        [object[]]$Final
    )

    if ($Initial.Count -ne $Final.Count) {
        return $false
    }

    $initialHashes = @{}
    foreach ($record in $Initial) {
        $initialHashes[$record.relativePath] = $record.sha256
    }

    foreach ($record in $Final) {
        if (-not $initialHashes.ContainsKey($record.relativePath)) {
            return $false
        }
        if ($initialHashes[$record.relativePath] -ne $record.sha256) {
            return $false
        }
    }

    return $true
}

function Assert-ProductionSourceScan {
    $productionRoot = Join-Path $RepoRoot 'native/windows-launch/src'
    if (-not (Test-Path -LiteralPath $productionRoot -PathType Container)) {
        throw "Production source directory not found: $productionRoot"
    }

    $patterns = [ordered]@{
        'GetProcessById'              = 'PID lookup'
        'GetProcesses'                = 'process enumeration'
        'Process.Start'               = 'unqualified process start'
        'MainModule'                  = 'image-path inspection'
        'taskkill'                    = 'name/PID termination utility'
        'Stop-Process'                = 'name/PID termination cmdlet'
        'UseShellExecute'             = 'shell execution'
        'inheritHandles: true'        = 'unconditional inherit-all handle inheritance'
        'AssignProcessToJobObject'    = 'post-create job assignment (creation-time assignment is required)'
        'GetEnvironmentVariable'      = 'ambient environment read'
        'GetEnvironmentVariables'     = 'ambient environment enumeration'
        'SetEnvironmentVariable'      = 'ambient environment write'
        'ExpandEnvironmentStrings'    = 'environment expansion'
        'CREATE_BREAKAWAY_FROM_JOB'   = 'breakaway creation flag'
        '0x01000000'                  = 'breakaway flag value'
        'HttpListener'                = 'network listener'
        'TcpListener'                 = 'network listener'
        'Socket'                      = 'network socket'
        'RegistryKey'                 = 'registry persistence'
        'New-Service'                 = 'service creation'
        'schtasks'                    = 'scheduler registration'
    }

    $files = @(Get-ChildItem -LiteralPath $productionRoot -Recurse -File -Filter '*.cs')
    $violations = @()
    foreach ($file in $files) {
        foreach ($pattern in $patterns.Keys) {
            $match = Select-String -LiteralPath $file.FullName -Pattern $pattern -SimpleMatch -CaseSensitive
            if ($match) {
                $violations += "$($file.FullName): '$pattern' ($($patterns[$pattern]))"
            }
        }
    }

    $projectFiles = @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'native/windows-launch') -Recurse -File -Filter '*.csproj' |
        Where-Object { $_.FullName -like '*\src\*' })
    foreach ($projectFile in $projectFiles) {
        if (Select-String -LiteralPath $projectFile.FullName -Pattern 'PackageReference' -SimpleMatch) {
            $violations += "$($projectFile.FullName): external PackageReference is not allowed in this slice"
        }
    }

    $allSource = ($files | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
    $requiredPatterns = [ordered]@{
        'PROC_THREAD_ATTRIBUTE_JOB_LIST'    = 'creation-time job containment'
        'PROC_THREAD_ATTRIBUTE_HANDLE_LIST' = 'explicit per-create stdio handle list'
        'StartfUseStdHandles'               = 'explicit child standard handles'
        'SetHandleInformation'              = 'explicit inheritable child / non-inheritable parent ends'
    }
    foreach ($requiredPattern in $requiredPatterns.Keys) {
        if (-not $allSource.Contains($requiredPattern, [System.StringComparison]::Ordinal)) {
            $violations += "Production source is missing '$requiredPattern' ($($requiredPatterns[$requiredPattern]))."
        }
    }

    if ($violations.Count -gt 0) {
        throw "Production source scan failed:`n$($violations -join "`n")"
    }

    [pscustomobject][ordered]@{
        status = 'PASS'
        filesScanned = $files.Count
        patterns = @($patterns.Keys)
        requiredPatterns = @($requiredPatterns.Keys)
        note = 'Library sources contain no PID/name process control, shell execution, breakaway flag, inherit-all spawn, network listener/socket, registry, service or scheduler surface, and no external package reference. Creation-time JOB_LIST and explicit HANDLE_LIST are both present; child standard handles are explicit and pipe ends are explicitly marked inheritable/non-inheritable.'
    }
}

try {
    if (-not $IsWindows) {
        throw 'This qualification requires Windows.'
    }

    if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
        throw 'This qualification requires a 64-bit Windows host and a 64-bit PowerShell process.'
    }

    $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if (-not $dotnet) {
        throw 'The .NET SDK (dotnet) was not found on PATH.'
    }

    $RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'AGENTS.md') -PathType Leaf)) {
        throw "RepoRoot does not look like the Remote Agent Console repository: $RepoRoot"
    }

    if ([string]::IsNullOrWhiteSpace($ExpectedCommit)) {
        throw 'Pass -ExpectedCommit with the full 40-hex commit to bind, for example -ExpectedCommit 0123456789abcdef0123456789abcdef01234567.'
    }
    if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
        throw "-ExpectedCommit must be the full 40-hex commit, not '$ExpectedCommit'."
    }
    $script:boundCommit = $ExpectedCommit.ToLowerInvariant()

    $runFull = [System.IO.Path]::GetFullPath($runDir)
    if ($runFull.StartsWith($RepoRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Scratch output must not live inside the repository: $runFull"
    }

    if (-not (Test-Path -LiteralPath $ScratchRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $ScratchRoot -Force | Out-Null
    }
    New-Item -ItemType Directory -Path $runDir -Force | Out-Null

    $script:head = (& git -C $RepoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "git rev-parse failed in $RepoRoot"
    }

    $script:initialHeadTree = (& git -C $RepoRoot rev-parse "$($script:head)^{tree}").Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($script:initialHeadTree)) {
        throw "git rev-parse of the initial HEAD tree failed in $RepoRoot"
    }

    if ($script:head -ne $script:boundCommit -and -not $AllowOtherCommit) {
        throw "HEAD $($script:head) does not match the explicit expected commit $($script:boundCommit). Use -AllowOtherCommit only for a diagnostic run; it cannot attest PASS."
    }

    $statusLines = @(& git -C $RepoRoot status --porcelain)
    $scopedStatusLines = @(& git -C $RepoRoot status --porcelain --untracked-files=all -- native/windows-launch qualification/windows/launch-ownership-fixture.ps1 qualification/windows/process-tree-fixture.cs)
    $modifiedInputs = @($scopedStatusLines | Where-Object { $_ -match '\S' -and $_ -notmatch '^\?\?' } | ForEach-Object { $_.Substring(3).Trim() })
    $untrackedInputs = @($scopedStatusLines | Where-Object { $_ -match '^\?\?' } | ForEach-Object { $_.Substring(3).Trim() })
    $inputsDirty = ($modifiedInputs.Count + $untrackedInputs.Count) -gt 0
    $script:scopedStatusLines = $scopedStatusLines
    $script:modifiedInputs = $modifiedInputs
    $script:untrackedInputs = $untrackedInputs
    $script:inputsDirty = $inputsDirty

    $freeKb = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
    if ($freeKb -lt 1048576) {
        throw "Only $([math]::Round($freeKb / 1024)) MiB of physical memory is free; refusing a build on this host."
    }

    Write-Host "RUN $runId"
    Write-Host "BASE $($script:head)"
    Write-Host "EXPECTED $($script:boundCommit) DIRTY_INPUTS=$inputsDirty"

    $fixtureSource = Join-Path $RepoRoot 'qualification/windows/process-tree-fixture.cs'
    $testProject = Join-Path $RepoRoot 'native/windows-launch/tests/RemoteAgentConsole.WindowsLaunch.Tests/RemoteAgentConsole.WindowsLaunch.Tests.csproj'
    $libraryProject = Join-Path $RepoRoot 'native/windows-launch/src/RemoteAgentConsole.WindowsLaunch/RemoteAgentConsole.WindowsLaunch.csproj'
    foreach ($required in @($fixtureSource, $testProject, $libraryProject)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Required source file was not found: $required"
        }
    }

    $script:initialScopedInputs = @(Get-ScopedInputRecords)
    if ($script:initialScopedInputs.Count -eq 0) {
        throw "No scoped inputs were found for the initial binding."
    }

    if (-not $SkipSourceScan) {
        $script:sourceScan = Assert-ProductionSourceScan
        Write-Host "SCAN PASS ($($script:sourceScan.filesScanned) production files)"
    }

    # Fixture project lives in scratch; the fixture source stays where the repository owns it.
    $fixtureProjectDir = Join-Path $runDir 'fixture-src'
    New-Item -ItemType Directory -Path $fixtureProjectDir -Force | Out-Null
    $fixtureProject = Join-Path $fixtureProjectDir 'ProcessTreeFixture.csproj'
    $escapedFixture = [System.Security.SecurityElement]::Escape($fixtureSource)
    @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <AssemblyName>ProcessTreeFixture</AssemblyName>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <UseAppHost>true</UseAppHost>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="$escapedFixture" Link="process-tree-fixture.cs" />
  </ItemGroup>
</Project>
"@ | Set-Content -LiteralPath $fixtureProject -Encoding utf8

    $fixtureArtifacts = Join-Path $runDir 'fixture-artifacts'
    Invoke-Build -Project $fixtureProject -ArtifactsPath $fixtureArtifacts | Out-Null
    $fixtureOut = Join-Path $fixtureArtifacts 'bin/ProcessTreeFixture/release'
    $fixtureExeBuilt = Join-Path $fixtureOut 'ProcessTreeFixture.exe'
    if (-not (Test-Path -LiteralPath $fixtureExeBuilt -PathType Leaf)) {
        throw "The synthetic fixture executable was not produced: $fixtureExeBuilt"
    }

    # Exercise spaces and Unicode in both the image path and the argument paths.
    $fixtureDir = Join-Path $runDir 'fixture bïnaries 树'
    New-Item -ItemType Directory -Path $fixtureDir -Force | Out-Null
    Get-ChildItem -LiteralPath $fixtureOut -File | Copy-Item -Destination $fixtureDir -Force
    $script:fixtureExe = Join-Path $fixtureDir 'ProcessTreeFixture.exe'

    # One build graph for the library and runner; MSBuild is limited to one job.
    $launcherArtifacts = Join-Path $runDir 'launcher-artifacts'
    Invoke-Build -Project $testProject -ArtifactsPath $launcherArtifacts | Out-Null
    $script:testExe = Join-Path $launcherArtifacts 'bin/RemoteAgentConsole.WindowsLaunch.Tests/release/RemoteAgentConsole.WindowsLaunch.Tests.exe'
    $script:libraryDll = Join-Path $launcherArtifacts 'bin/RemoteAgentConsole.WindowsLaunch/release/RemoteAgentConsole.WindowsLaunch.dll'
    $runnerDll = Join-Path $launcherArtifacts 'bin/RemoteAgentConsole.WindowsLaunch.Tests/release/RemoteAgentConsole.WindowsLaunch.Tests.dll'
    $probeExe = Join-Path $launcherArtifacts 'bin/RemoteAgentConsole.WindowsLaunch.EnvironmentProbe/release/RemoteAgentConsole.WindowsLaunch.EnvironmentProbe.exe'
    $probeDll = Join-Path $launcherArtifacts 'bin/RemoteAgentConsole.WindowsLaunch.EnvironmentProbe/release/RemoteAgentConsole.WindowsLaunch.EnvironmentProbe.dll'
    $stdioProbeExe = Join-Path $launcherArtifacts 'bin/RemoteAgentConsole.WindowsLaunch.StdioProbe/release/RemoteAgentConsole.WindowsLaunch.StdioProbe.exe'
    $stdioProbeDll = Join-Path $launcherArtifacts 'bin/RemoteAgentConsole.WindowsLaunch.StdioProbe/release/RemoteAgentConsole.WindowsLaunch.StdioProbe.dll'
    $fixtureDll = Join-Path $fixtureDir 'ProcessTreeFixture.dll'
    foreach ($artifact in @($script:testExe, $script:libraryDll, $runnerDll, $probeExe, $probeDll, $stdioProbeExe, $stdioProbeDll, $fixtureDll)) {
        if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
            throw "The launcher build did not produce $artifact"
        }
    }

    $witness = Join-Path $runDir 'witness'
    $testReceipt = Join-Path $runDir 'test-receipt.json'
    $suiteLog = Join-Path $runDir 'test-output.log'
    $suiteOutput = & $script:testExe --fixture $script:fixtureExe --scratch $witness --receipt $testReceipt --probe $probeExe --stdio-probe $stdioProbeExe 2>&1
    $script:suiteExit = $LASTEXITCODE
    $suiteText = ($suiteOutput | Out-String)
    $suiteText | Set-Content -LiteralPath $suiteLog -Encoding utf8
    Write-Host $suiteText.TrimEnd()

    if (-not (Test-Path -LiteralPath $testReceipt -PathType Leaf)) {
        throw "The conformance runner did not write its receipt: $testReceipt"
    }

    $script:testData = Get-Content -LiteralPath $testReceipt -Raw | ConvertFrom-Json
    $failedTests = @($script:testData.tests | Where-Object { $_.status -ne 'PASS' })
    $expectedTests = @(
        'contract-validation'
        'normal-stop'
        'root-crash'
        'dispose-kill-on-close'
        'supervisor-death'
        'creation-time-assignment-failure'
        'resume-count-guard'
        'environment-policy'
        'stdio-pipes'
        'stdio-handle-list-failure'
        'no-start'
    )
    $observedTests = @($script:testData.tests | ForEach-Object { $_.name })
    $missingTests = @($expectedTests | Where-Object { $observedTests -notcontains $_ })
    if ($missingTests.Count -gt 0) {
        throw "The conformance receipt is missing required tests: $($missingTests -join ', ')"
    }

    if ($script:suiteExit -ne 0 -or $failedTests.Count -gt 0 -or $script:testData.status -ne 'PASS') {
        throw "The conformance suite failed (exit $($script:suiteExit), $($failedTests.Count) failed test(s))."
    }


    $script:artifacts = @(
        (Get-FileRecord -Path $script:libraryDll -BasePath $runDir -Kind 'native-library-dll'),
        (Get-FileRecord -Path $script:testExe -BasePath $runDir -Kind 'conformance-runner-apphost'),
        (Get-FileRecord -Path $runnerDll -BasePath $runDir -Kind 'conformance-runner-dll'),
        (Get-FileRecord -Path $script:fixtureExe -BasePath $runDir -Kind 'synthetic-fixture-apphost'),
        (Get-FileRecord -Path $fixtureDll -BasePath $runDir -Kind 'synthetic-fixture-dll'),
        (Get-FileRecord -Path $probeExe -BasePath $runDir -Kind 'environment-probe-apphost'),
        (Get-FileRecord -Path $probeDll -BasePath $runDir -Kind 'environment-probe-dll'),
        (Get-FileRecord -Path $stdioProbeExe -BasePath $runDir -Kind 'stdio-probe-apphost'),
        (Get-FileRecord -Path $stdioProbeDll -BasePath $runDir -Kind 'stdio-probe-dll'),
        (Get-FileRecord -Path $fixtureSource -BasePath $RepoRoot -Kind 'fixture-source'),
        (Get-FileRecord -Path $PSCommandPath -BasePath $RepoRoot -Kind 'qualification-script')
    )

    $sourceRoot = Join-Path $RepoRoot 'native/windows-launch'
    $script:sourceHashes = @(
        Get-ChildItem -LiteralPath $sourceRoot -Recurse -File |
            Where-Object { $_.FullName -notmatch '[\\/](bin|obj)[\\/]' } |
            Sort-Object FullName |
            ForEach-Object { Get-FileRecord -Path $_.FullName -BasePath $RepoRoot -Kind 'source' }
    )
    # Bind the initial commit tree and initial scoped source/script hashes, then
    # re-read them immediately before any attested PASS. This is the existing
    # publication scope, not a broad worktree sweep.
    $finalHead = (& git -C $RepoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "git rev-parse of final HEAD failed in $RepoRoot"
    }
    $finalTree = (& git -C $RepoRoot rev-parse "$($finalHead)^{tree}").Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($finalTree)) {
        throw "git rev-parse of the final HEAD tree failed in $RepoRoot"
    }

    $script:finalHeadCommit = $finalHead
    $script:finalHeadTree = $finalTree
    $script:headTreeStable = ($finalHead -eq $script:head) -and ($finalTree -eq $script:initialHeadTree)
    $script:finalScopedInputs = @(Get-ScopedInputRecords)
    $script:scopedInputsStable = Test-ScopedInputsUnchanged -Initial $script:initialScopedInputs -Final $script:finalScopedInputs

    if (-not $script:headTreeStable) {
        throw "HEAD commit or tree changed during qualification; initial=$($script:head)/$($script:initialHeadTree) final=$finalHead/$finalTree."
    }
    if (-not $script:scopedInputsStable) {
        throw "Scoped source/script hashes changed during qualification; the binding is not stable."
    }
    if ($script:head -ne $script:boundCommit) {
        throw "Attested qualification requires HEAD to equal the exact expected commit $($script:boundCommit); this run is diagnostic only."
    }

    $script:attested = $true
    $script:status = 'PASS'
}
catch {
    $script:status = 'FAIL'
    $script:errorMessage = $_.Exception.Message
    Write-Host "ERROR $($script:errorMessage)"
}
finally {
    if (-not (Test-Path -LiteralPath $runDir -PathType Container)) {
        New-Item -ItemType Directory -Path $runDir -Force | Out-Null
    }

    $receipt = [ordered]@{
        schemaVersion = 2
        suite = 'windows-launch-ownership'
        status = $script:status
        generatedUtc = (Get-Date).ToUniversalTime().ToString('o')
        runId = $runId
        runDirectory = $runDir
        repository = $RepoRoot
        baseCommit = $script:head
        expectedBaseCommit = $script:boundCommit
        baseMatchesExpected = ($script:head -eq $script:boundCommit)
        commitBinding = if (-not $script:head -or -not $script:boundCommit) { 'unbound' } elseif ($script:head -eq $script:boundCommit) { 'exact' } elseif ($AllowOtherCommit) { 'mismatch-allowed' } else { 'unbound' }
        attested = $script:attested
        initialHeadTree = $script:initialHeadTree
        finalHeadCommit = $script:finalHeadCommit
        finalHeadTree = $script:finalHeadTree
        headTreeStable = $script:headTreeStable
        scopedInputsStable = $script:scopedInputsStable
        initialScopedInputs = @($script:initialScopedInputs)
        finalScopedInputs = @($script:finalScopedInputs)
        inputsDirty = $script:inputsDirty
        cleanInputs = ($script:inputsDirty -eq $false)
        scopedWorkingTreeStatus = @($script:scopedStatusLines)
        modifiedInputs = @($script:modifiedInputs)
        untrackedInputs = @($script:untrackedInputs)
        scratchRoot = $ScratchRoot
        error = $script:errorMessage
        scope = [ordered]@{
            artifact = 'managed native library (DLL) plus console conformance runner and synthetic environment/stdio probes'
            installedProduct = $false
            productionReachable = $false
            hostOrRelayReference = $false
            serviceSchedulerOrInstaller = $false
            networkListener = $false
            stdioCustodyAvailable = $true
            stdioHostBinding = $false
            installedCodexBinding = $false
            note = 'First slice only. Nothing under apps/ or packages/ references this library; optional stdio pipes are library-only, with no host, Codex app-server, daemon or remote binding. No machine configuration is changed.'
        }
        host = [ordered]@{
            os = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
            osVersion = [Environment]::OSVersion.Version.ToString()
            is64Bit = [Environment]::Is64BitProcess
            dotnetSdk = (& dotnet --version)
            powershell = $PSVersionTable.PSVersion.ToString()
            processorCount = [Environment]::ProcessorCount
            freePhysicalMiB = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
        }
        workingTreeStatus = @($statusLines)
        containment = 'Creation-time STARTUPINFOEX/PROC_THREAD_ATTRIBUTE_JOB_LIST plus JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no post-create assignment and no unsandboxed fallback.'
        resumeSemantics = 'ResumeThread accepts exactly the observed previous count 1; observed 0 is unknown/externally runnable, observed >1 remains suspended, injected values are marked simulated and never treated as observed.'
        resumeTestCoverage = 'The launcher test injects count 2 and asserts injected/observed flags plus record-level semantics; observed 0, observed >1 and ResumeThread-error branches are not independently executed.'
        unsupportedTestCoverage = 'The creation-time assignment failure is injected before CreateProcess; a real host rejection of PROC_THREAD_ATTRIBUTE_JOB_LIST is not exercised by this suite.'
        buildRestore = 'dotnet build may run an implicit restore for framework/reference packs from the installed SDK; this slice declares no PackageReference and no external package.'
        stdioCustody = 'Optional typed stdin/stdout/stderr pipes with explicit per-create PROC_THREAD_ATTRIBUTE_HANDLE_LIST; default none; child ends inheritable only for the create window; parent ends non-inheritable; stderr is a distinct pipe and is never merged.'
        stdioHostBinding = 'No host, maintained Codex app-server, daemon or remote binding is installed or exercised; pipe custody is library-only.'
        stdioTestCoverage = 'The synthetic child performs a bounded PING/PONG request, a distinct stderr line, BYE shutdown and an EOF shutdown; it also reports absence of an unrelated inheritable sentinel handle. Parent pipe ends are checked non-inheritable. An injected explicit-handle-list failure fails closed before child code. Pipe-enabled launches are serialized in the owner process during the inheritable create window.'
        cleanupSemantics = 'Exit is confirmed only by a bounded wait on the exact handle; AccessDenied termination results are recorded as suggestions and never set confirmed flags.'
        environment = 'Required frozen caller-supplied Unicode environment block; no ambient environment read or merge.'
        sourceScan = $script:sourceScan
        suiteExitCode = $script:suiteExit
        artifacts = $script:artifacts
        sources = $script:sourceHashes
        tests = if ($script:testData) { $script:testData.tests } else { @() }
        testReceiptPath = $testReceipt
        testOutputPath = $suiteLog
        limitations = @(
            'The component is a DLL/framework artifact; it is not packaged, installed, signed or reachable from the host or relay. Optional stdio pipes are library-only, with no host, Codex app-server, daemon or remote binding.'
            'dotnet build may run an implicit restore for framework/reference packs from the installed SDK; there is no PackageReference and no external package is declared.'
            'Pipe custody is synchronous and library-only. The owner process must be a dedicated launcher: three child ends are inheritable during the bounded create window; pipe-enabled launches are serialized, but unrelated inherit-all spawns in the same process are not prevented by this component.'
            'No maintained Codex app-server, daemon, host integration or remote command surface is installed, bound or exercised.'
            'Creation-time job assignment uses STARTUPINFOEX/PROC_THREAD_ATTRIBUTE_JOB_LIST (Windows 10 1607+). The suite injects the attribute-boundary failure before CreateProcess; a real host rejection of the OS attribute is not exercised. If the real API is unavailable, launch fails before process creation with Unsupported=true; no post-create assignment or unsandboxed fallback exists.'
            'Only creation-time attribute failure, explicit stdio handle-list failure and unsafe resume count are fault-injected; containment verification shares the rollback path but is not separately injected.'
            'An injected explicit stdio handle-list failure fails closed before CreateProcess; it is not a real OS rejection of the attribute.'
            'The launcher test injects resume count 2 and asserts injected/observed flags plus record-level semantics; observed 0, observed >1 and ResumeThread-error branches are not independently executed.'
            'The environment is an explicit frozen caller-supplied policy; the library reads no ambient environment. The caller must include required variables such as SystemRoot and must not include live credentials.'
            'ResumeThread accepts only a previous suspension count of exactly 1; any other count is rolled back before resumption.'
            'The library accepts any absolute .exe from its caller by design; production must enforce the project and launch-profile allowlist outside this component.'
            'The synthetic fixtures are same-user; cross-user, AppContainer and restricted-token containment are not covered.'
            'Console hosts allocated by owned children are contained and killed with the job; deliberate attachment to an unrelated console is out of scope.'
            'Qualified on Windows 10.0.26200 x64; nested-job assignment assumes Windows 8 or later.'
            'No real Command Code/OpenCode/Happier process, phone or production packaging was exercised.'
            'Attested PASS requires HEAD to equal the exact expected commit and requires the initial HEAD tree and scoped input hashes to remain unchanged; dirty inputs are recorded by hash but are not a clean publication state.'
        )
        packagingPrerequisites = @(
            'Publish win-x64 framework-dependent (requires .NET 8) or self-contained, and sign the resulting binaries.'
            'Integrate only behind the host launch-profile allowlist; never accept a remote path or argv.'
            'Add stdio pipe ownership and an explicit child environment before real agent use.'
            'Define per-user install directory ACLs, versioned ABI, upgrade and rollback behavior.'
            'Keep service, scheduler, Task Scheduler and per-machine installation out of scope until separately authorized.'
        )
    }

    $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    Write-Host ''
    Write-Host "STATUS $($script:status)"
    Write-Host "RECEIPT $receiptPath"
}

if ($script:status -ne 'PASS') {
    exit 1
}

exit 0
