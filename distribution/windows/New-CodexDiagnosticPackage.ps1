#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OwnerBuild,
    [Parameter(Mandatory)][string]$MakeAppx,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$ExpectedOwnerSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

# Build only a disabled, unsigned MSIX draft. No signing, trust changes,
# startup registration, migrations, activation, or Add-AppxPackage.
if (!$IsWindows -or $ExpectedOwnerSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Windows and a lowercase SHA-256 for the selected diagnostic apphost are required.'
}
foreach ($path in @($OwnerBuild, $MakeAppx, $Output)) {
    if (![IO.Path]::IsPathFullyQualified($path)) { throw 'All package paths must be absolute.' }
}
if ((Split-Path -Leaf $MakeAppx) -ine 'makeappx.exe') { throw 'Select the Windows SDK MakeAppx executable.' }
if (Test-Path -LiteralPath $Output) { throw 'Package output already exists; select a new scratch path.' }
if (!(Test-Path -LiteralPath (Split-Path -Parent $Output) -PathType Container)) { throw 'Output parent does not exist.' }

$ownerName = 'RemoteAgentConsole.CodexDiagnosticOwner'
$payload = @("$ownerName.exe", "$ownerName.dll", "$ownerName.deps.json", "$ownerName.runtimeconfig.json",
             'RemoteAgentConsole.WindowsLaunch.dll', 'rac-windows-policy-helper.dll')
foreach ($name in $payload) {
    $file = Get-Item -LiteralPath (Join-Path $OwnerBuild $name)
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Package input is not a regular build file.'
    }
}
$hash = (Get-FileHash -LiteralPath (Join-Path $OwnerBuild "$ownerName.exe")).Hash.ToLowerInvariant()
if ($hash -cne $ExpectedOwnerSha256) { throw 'The owner executable does not match the selected build.' }

$out = New-Item -ItemType Directory -Path $Output
$stage = New-Item -ItemType Directory -Path (Join-Path $out.FullName 'stage')
$assets = New-Item -ItemType Directory -Path (Join-Path $stage.FullName 'Assets')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Diagnostic.AppxManifest.xml') -Destination (Join-Path $stage.FullName 'AppxManifest.xml')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\apps\web\public\icons\fieldwork-192.png') -Destination (Join-Path $assets.FullName 'Logo.png')
foreach ($name in $payload) {
    Copy-Item -LiteralPath (Join-Path $OwnerBuild $name) -Destination $stage.FullName
}

$package = Join-Path $out.FullName 'rac-codex-diagnostic-unsigned.msix'
& $MakeAppx pack /d $stage.FullName /p $package /no
$unpacked = Join-Path $out.FullName 'unpacked'
& $MakeAppx unpack /p $package /d $unpacked /no
$inventory = @(Get-ChildItem -LiteralPath $stage.FullName -Recurse -File | Sort-Object FullName | ForEach-Object {
    $path = [IO.Path]::GetRelativePath($stage.FullName, $_.FullName)
    $stageHash = (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    $unpackedHash = (Get-FileHash -LiteralPath (Join-Path $unpacked $path)).Hash.ToLowerInvariant()
    if ($unpackedHash -cne $stageHash) { throw "Package round-trip changed: $path" }
    [ordered]@{path=$path.Replace('\','/'); bytes=$_.Length; sha256=$stageHash}
})
$expected = @($inventory | ForEach-Object { $_.path }) + @('AppxBlockMap.xml', '[Content_Types].xml')
$actual = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File | ForEach-Object {
    [IO.Path]::GetRelativePath($unpacked, $_.FullName).Replace('\','/')
})
# MakeAppx variants may omit the container metadata files from unpack output.
if (@($actual | Where-Object { $_ -cnotin $expected }).Count) { throw 'Package has an unexpected file.' }

$receipt = [ordered]@{
    schemaVersion=1; disposition='unsigned-diagnostic-not-install-qualified'; platform='windows-x64';
    packagedProfiles=@(); installed=$false; ingressEnabled=$false
    sdkSha256=(Get-FileHash -LiteralPath $MakeAppx).Hash.ToLowerInvariant()
    packageSha256=(Get-FileHash -LiteralPath $package).Hash.ToLowerInvariant()
    ownerApphostSha256=$hash
    inventory=$inventory
}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $out.FullName 'receipt.json') -Encoding utf8
