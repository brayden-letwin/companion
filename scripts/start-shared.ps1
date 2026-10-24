param(
    [string]$NodePath = '',
    [string]$DataDirectory = (Join-Path $PSScriptRoot '..\..\..\work\companion-shared'),
    [ValidateRange(1024,65535)][int]$Port = 4174,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $sourceRoot 'server\room-server.mjs'
if (-not $NodePath) {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 24.15 or newer is required. Install Node 24 LTS or pass -NodePath with its executable.' }
    $NodePath = $nodeCommand.Source
}
$NodePath = [IO.Path]::GetFullPath($NodePath)
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node executable not found: $NodePath" }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "Shared-room source not found: $serverPath" }
$nodeVersion = (& $NodePath -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'24.15.0') { throw 'The shared room requires Node.js 24.15 or newer; Node 24 LTS is the tested runtime.' }
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
Write-Output "Companion shared room: $origin/room.html"
Write-Output 'This local pilot is available on this PC. Closing the browser keeps the server running.'
if (-not $NoOpen) { Start-Process "$origin/room.html" | Out-Null }
