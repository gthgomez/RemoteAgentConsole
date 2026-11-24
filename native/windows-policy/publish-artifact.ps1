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
return [pscustomobject]@{
    schemaVersion = 1
    path = $artifact.FullName
    bytes = $artifact.Length
    sha256 = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    runtimeIdentifier = 'win-x64'
    selfContained = $true
    singleFile = $true
    nativeExtraction = $false
    sdkVersion = $SdkVersion
    runtimeFrameworkVersion = $RuntimeFrameworkVersion
    dotnetPath = $dotnetExecutable
    dotnetVersion = $versionOutput
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
