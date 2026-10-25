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
$serverPath = Join-Path $sourceRoot 'server\room-server.mjs'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "Shared-room source not found: $serverPath" }
$origin = "http://127.0.0.1:$Port"
$ready = $false
try {
    $health = Invoke-RestMethod -Uri "$origin/api/health" -TimeoutSec 2 -MaximumRedirection 0
    if ($health.service -ne 'companion-shared') { throw 'Another application is using the shared-room port.' }
    $ready = $true
} catch {
    if ($_.Exception.Message -eq 'Another application is using the shared-room port.') { throw }
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
    Write-Output 'Starting your reading room...'
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
        if ($serverProcess.HasExited) { throw "Shared room stopped during startup. See $DataDirectory\server-error.log" }
        try {
            $health = Invoke-RestMethod -Uri "$origin/api/health" -TimeoutSec 1 -MaximumRedirection 0
            $ready = $health.service -eq 'companion-shared'
            if ($ready) { break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
}
if (-not $ready) { throw 'The shared room did not become ready.' }
$entryPath = if ($View -eq 'assistant') { 'assistant.html' } else { 'room.html' }
Write-Output "Companion is ready: $origin/$entryPath"
if ($View -eq 'room') {
    Write-Output 'First visit: choose a group name, your name, and a password.'
    Write-Output 'Your discussions stay saved when you close the browser. This room runs on this PC.'
}
if (-not $NoOpen) { Start-Process "$origin/$entryPath" | Out-Null }
