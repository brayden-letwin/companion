param(
    [string]$DataDirectory = (Join-Path $PSScriptRoot '..\..\..\work\companion-shared'),
    [ValidateRange(1024,65535)][int]$Port = 4174
)

$ErrorActionPreference = 'Stop'
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ownerLockPath = Join-Path $DataDirectory 'runtime-supervisor.lock'
$portLockPath = Join-Path $sourceRoot ".companion-supervisor-$Port.lock"
$metadataPath = Join-Path $DataDirectory 'runtime-supervisor.json'
$requestPath = Join-Path $DataDirectory 'runtime-supervisor.stop'
$legacyLockPaths = @((Join-Path $DataDirectory 'runtime-host.lock'), (Join-Path $sourceRoot ".companion-runtime-$Port.lock"))
$recoveryPaths = @($ownerLockPath, $portLockPath) + $legacyLockPaths | ForEach-Object { $_ + '.recovery' }
$utf8 = New-Object Text.UTF8Encoding($false, $true)

function Read-PrivateJson {
    param([string]$Path, [int]$MaximumBytes = 4096)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Companion ownership needs manual review: $Path is not a regular file. Nothing was removed."
    }
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $buffer = New-Object byte[] ($MaximumBytes + 1)
        $length = 0
        while ($length -lt $buffer.Length) {
            $count = $stream.Read($buffer, $length, $buffer.Length - $length)
            if ($count -eq 0) { break }
            $length += $count
        }
        if ($length -gt $MaximumBytes) { throw "Companion ownership needs manual review: $Path exceeds its size limit. Nothing was removed." }
        return ($utf8.GetString($buffer, 0, $length) | ConvertFrom-Json -ErrorAction Stop)
    } finally { if ($stream) { $stream.Dispose() } }
}

function Test-PositiveInteger {
    param($Value)
    return (($Value -is [int] -or $Value -is [long]) -and $Value -gt 0 -and $Value -le [int]::MaxValue)
}

function Test-OwnerClaim {
    param($Claim)
    if (-not $Claim -or -not (Test-PositiveInteger $Claim.pid) -or -not (Test-PositiveInteger $Claim.port)) { return $false }
    if ($Claim.port -ne $Port -or $Claim.nonce -isnot [string] -or $Claim.sourceRoot -isnot [string]) { return $false }
    if ($Claim.nonce -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') { return $false }
    if (-not [IO.Path]::IsPathRooted($Claim.sourceRoot)) { return $false }
    try { return [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($Claim.sourceRoot), $sourceRoot) }
    catch { return $false }
}

function Test-SameOwner {
    param($Value, $Expected)
    return ((Test-OwnerClaim $Value) -and $Value.pid -eq $Expected.pid -and $Value.port -eq $Expected.port `
        -and $Value.nonce -ceq $Expected.nonce -and $Value.sourceRoot -ceq $Expected.sourceRoot)
}

function Test-SameStopRequest {
    param($Value, $Expected)
    $names = @($Value.PSObject.Properties.Name)
    return ($names.Count -eq 5 -and @('pid', 'nonce', 'port', 'sourceRoot', 'action' | Where-Object { $names -notcontains $_ }).Count -eq 0 `
        -and (Test-SameOwner $Value $Expected) -and $Value.action -ceq 'shutdown')
}

function Assert-RecoveryOwner {
    param($Expected)
    foreach ($recoveryPath in $recoveryPaths) {
        if (-not (Test-Path -LiteralPath $recoveryPath)) { continue }
        try { $marker = Read-PrivateJson $recoveryPath }
        catch { if (-not (Test-Path -LiteralPath $recoveryPath)) { continue }; throw }
        if (-not (Test-SameOwner $marker $Expected)) { throw "Companion recovery ownership does not match this launcher: $recoveryPath. Inspect it manually; nothing was removed." }
    }
}

if (-not (Test-Path -LiteralPath $ownerLockPath)) {
    foreach ($recoveryPath in $recoveryPaths) {
        if (Test-Path -LiteralPath $recoveryPath) { throw "Companion has an unconfirmed shutdown. Inspect retained ownership at $DataDirectory before restarting. No process was killed and no recovery marker was removed." }
    }
    if (Test-Path -LiteralPath $portLockPath) { throw 'Companion launcher ownership is incomplete. Inspect its retained locks; no shutdown request was sent.' }
    foreach ($legacyLockPath in $legacyLockPaths) {
        if (Test-Path -LiteralPath $legacyLockPath) { throw 'This Companion service uses a legacy direct host. Stop its owning console with Ctrl+C, then open Start Companion.cmd. No process was killed.' }
    }
    if (Test-Path -LiteralPath $requestPath) { throw "An unconfirmed Companion stop request remains at $requestPath. Inspect it manually; nothing was overwritten or removed." }
    Write-Output 'Companion service is already stopped. No managed launcher owns this workspace.'
    return
}

$owner = Read-PrivateJson $ownerLockPath
if (-not (Test-OwnerClaim $owner)) { throw 'The saved launcher does not match this Companion source, port, or valid process identity. No shutdown request was sent.' }
Assert-RecoveryOwner $owner
if (Test-Path -LiteralPath $portLockPath) {
    $portOwner = Read-PrivateJson $portLockPath
    if (-not (Test-SameOwner $portOwner $owner)) { throw 'The source and data locks name different launchers. Inspect retained ownership; no shutdown request was sent.' }
}

$ownerProcess = $null
try {
    try {
        $ownerProcess = [Diagnostics.Process]::GetProcessById([int]$owner.pid)
        $null = $ownerProcess.Handle
    } catch [ArgumentException] {
        throw 'The recorded launcher is no longer running, but retained ownership still needs manual review. Nothing was removed.'
    } catch {
        throw 'The owning launcher process could not be verified. Inspect retained ownership manually; no shutdown request was sent.'
    }

    $request = [ordered]@{ pid = [int]$owner.pid; nonce = [string]$owner.nonce; port = $Port; sourceRoot = [string]$owner.sourceRoot; action = 'shutdown' }
    $body = $utf8.GetBytes(($request | ConvertTo-Json -Compress))
    if ($body.Length -gt 4096) { throw 'The source path exceeds the stop protocol limit. No shutdown request was sent.' }
    $writer = $null
    try {
        $writer = [IO.File]::Open($requestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $writer.Write($body, 0, $body.Length)
        $writer.Flush($true)
    } catch [IO.IOException] {
        if ($writer -or -not (Test-Path -LiteralPath $requestPath)) { throw 'The stop request could not be saved safely. Inspect retained ownership; nothing was overwritten or removed.' }
        $existing = Read-PrivateJson $requestPath
        if (-not (Test-SameStopRequest $existing $owner)) { throw 'A different or invalid stop request already exists. Inspect it manually; nothing was overwritten or removed.' }
    } finally { if ($writer) { $writer.Dispose() } }

    Write-Output 'Stopping Companion service. Waiting for its launcher, host, and worker to close...'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $lastReason = 'The owning launcher has not confirmed shutdown.'
    while ($timer.ElapsedMilliseconds -lt 45000) {
        Assert-RecoveryOwner $owner
        $metadata = $null
        try { $metadata = Read-PrivateJson $metadataPath -MaximumBytes 16384 }
        catch { $lastReason = 'The saved shutdown status could not be read.' }
        if ($metadata) {
            if (-not (Test-SameOwner $metadata $owner)) { throw 'Launcher ownership changed during shutdown. The new launcher was left untouched; inspect its current state.' }
            $released = -not (Test-Path -LiteralPath $ownerLockPath) -and -not (Test-Path -LiteralPath $portLockPath)
            if ($metadata.status -ceq 'stopped' -and $released) {
                try { $exited = $ownerProcess.HasExited } catch { throw 'Shutdown was recorded, but the original launcher exit could not be verified. Inspect the retained runtime manually.' }
                if ($exited) { Write-Output 'Companion service stopped. Open Start Companion.cmd to start it again.'; return }
                $lastReason = 'Shutdown was recorded, but the original launcher has not exited.'
            }
        }
        try { $ownerExited = $ownerProcess.HasExited } catch { throw 'The original launcher exit could not be verified. Inspect the retained runtime manually.' }
        if ($ownerExited) {
            $final = $null
            try { $final = Read-PrivateJson $metadataPath -MaximumBytes 16384 } catch { }
            $finalReleased = -not (Test-Path -LiteralPath $ownerLockPath) -and -not (Test-Path -LiteralPath $portLockPath)
            if ($final -and (Test-SameOwner $final $owner) -and $final.status -ceq 'stopped' -and $finalReleased) { Write-Output 'Companion service stopped. Open Start Companion.cmd to start it again.'; return }
            throw "The original launcher exited without confirmed shutdown. Inspect retained ownership at $DataDirectory before restarting. Nothing was killed or removed."
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Companion shutdown was not confirmed within 45 seconds. $lastReason Inspect $DataDirectory before restarting. No process was killed and no marker was removed."
} finally { if ($ownerProcess) { $ownerProcess.Dispose() } }
