param(
    [string]$NodePath = '',
    [string]$DataDirectory = (Join-Path $PSScriptRoot '..\..\..\work\companion-shared'),
    [ValidateRange(1024,65535)][int]$Port = 4174,
    [switch]$NoOpen,
    [ValidateSet('room','assistant')][string]$View = 'room'
)

$ErrorActionPreference = 'Stop'
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $sourceRoot 'server\runtime-supervisor.mjs'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "Shared-room source not found: $serverPath" }
$origin = "http://127.0.0.1:$Port"
$hostLockPath = Join-Path $DataDirectory 'runtime-host.lock'
$supervisorLockPaths = @((Join-Path $DataDirectory 'runtime-supervisor.lock'), (Join-Path $sourceRoot ".companion-supervisor-$Port.lock"))
function Test-CompanionHealth {
    try { $response = Invoke-WebRequest -UseBasicParsing -Uri "$origin/api/health" -TimeoutSec 2 -MaximumRedirection 0 }
    catch { return $false }
    try { $health = $response.Content | ConvertFrom-Json }
    catch { throw 'The selected port returned an unidentified service. No duplicate was started.' }
    if ($health.service -ne 'companion-shared') { throw 'Another application is using the selected port.' }
    $metadataPath = Join-Path $DataDirectory 'runtime-host.json'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw 'This port belongs to an unidentified Companion workspace. No duplicate was started.' }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.sourceRoot -ne $sourceRoot -or $metadata.port -ne $Port) { throw 'This port belongs to a different Companion checkout or workspace. No duplicate was started.' }
    if ($metadata.status -ne 'ready') { return $false }
    if ([string]$response.Headers['X-Companion-Instance'] -ne [string]$metadata.instance) { throw 'The responding service does not match the saved runtime identity. No duplicate was started.' }
    return $true
}
$ownerMayBeRunning = $false
foreach ($ownerLockPath in @($supervisorLockPaths + $hostLockPath)) {
    $ownerRecovery = Test-Path -LiteralPath ($ownerLockPath + '.recovery')
    if (-not (Test-Path -LiteralPath $ownerLockPath -PathType Leaf)) {
        if ($ownerRecovery) { throw "Companion has an unconfirmed shutdown. Inspect the retained runtime at $DataDirectory; no ownership was reclaimed." }
        continue
    }
    try {
        $ownerLock = Get-Content -LiteralPath $ownerLockPath -Raw | ConvertFrom-Json
        if (-not $ownerLock.pid -or $ownerLock.port -ne $Port -or $ownerLock.sourceRoot -ne $sourceRoot) { throw 'The saved owner does not match this launcher.' }
        try { Get-Process -Id $ownerLock.pid -ErrorAction Stop | Out-Null; $ownerMayBeRunning = $true }
        catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw }; if ($ownerRecovery) { throw 'The previous owner disappeared without confirmed shutdown. Retained runtime needs review.' } }
    } catch { throw "Companion ownership needs review: $ownerLockPath. No second service was started." }
}
$ready = Test-CompanionHealth

if (-not $ready) {
    if ($ownerMayBeRunning) {
            Write-Output 'Companion is restarting. Waiting for your workspace...'
            for ($attempt = 0; $attempt -lt 160; $attempt++) {
                $ready = Test-CompanionHealth
                if ($ready) { break }
                Start-Sleep -Milliseconds 250
            }
            if (-not $ready) { throw "Companion is already managed but is not responding. See $DataDirectory\server-error.log. No second server was started." }
    }
}

if (-not $ready) {
    if (-not $NodePath) {
        $nodeCandidates = @()
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
        if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
        # This development installation already includes Node with Codex. A
        # downloaded checkout can instead use an ordinary Node 24 installation.
        $nodeCandidates += Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            try {
                $candidateVersion = (& $candidate -p 'process.versions.node').Trim()
                if ($LASTEXITCODE -eq 0 -and [version]$candidateVersion -ge [version]'24.15.0') { $NodePath = $candidate; break }
            } catch { }
        }
        if (-not $NodePath) { throw 'Install Node.js 24 LTS from https://nodejs.org, then double-click Start Companion.cmd again. No API key is needed.' }
    }
    $NodePath = [IO.Path]::GetFullPath($NodePath)
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node executable not found: $NodePath" }
    $nodeVersion = (& $NodePath -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'24.15.0') { throw 'Install Node.js 24 LTS from https://nodejs.org, then double-click Start Companion.cmd again.' }
    Write-Output 'Starting Companion...'
    New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
    $variables = @{ COMPANION_SHARED_DATA_DIR = $DataDirectory; COMPANION_SHARED_PORT = "$Port" }
    $previous = @{}
    try {
        foreach ($name in $variables.Keys) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $variables[$name], 'Process')
        }
        $serverProcess = Start-Process -FilePath $NodePath -ArgumentList @(('"' + $serverPath + '"')) `
            -WindowStyle Hidden -PassThru -WorkingDirectory $sourceRoot `
            -RedirectStandardOutput (Join-Path $DataDirectory 'server.log') `
            -RedirectStandardError (Join-Path $DataDirectory 'server-error.log')
    } finally {
        foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { throw "Companion stopped during startup. See $DataDirectory\server-error.log" }
        $ready = Test-CompanionHealth
        if ($ready) { break }
        Start-Sleep -Milliseconds 250
    }
}
if (-not $ready) { throw 'Companion did not become ready.' }
$entryPath = if ($View -eq 'assistant') { 'assistant.html' } else { 'room.html' }
Write-Output "Companion is ready: $origin/$entryPath"
if ($View -eq 'room') {
    Write-Output 'First visit: choose a group name, your name, and a password.'
    Write-Output 'Your discussions stay saved when you close the browser. This room runs on this PC.'
}
if (-not $NoOpen) { Start-Process "$origin/$entryPath" | Out-Null }
