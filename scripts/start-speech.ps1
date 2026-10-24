param(
    [string]$RuntimeRoot = (Join-Path $PSScriptRoot '..\..\..\work'),
    [string]$VenvPath = '',
    [string]$ModelPath = ''
)

$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
if (-not $VenvPath) { $VenvPath = Join-Path $RuntimeRoot '.venv-speech' }
$speechRoot = Join-Path $RuntimeRoot 'companion-speech'
if (-not $ModelPath) { $ModelPath = Join-Path $speechRoot 'model' }
$VenvPath = [IO.Path]::GetFullPath($VenvPath)
$ModelPath = [IO.Path]::GetFullPath($ModelPath)
$pythonPath = Join-Path $VenvPath 'Scripts\python.exe'
$serverPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\speech\server.py'))
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "Companion's isolated speech environment is missing: $VenvPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $ModelPath 'model.bin') -PathType Leaf)) {
    throw "Companion's local speech model is missing: $ModelPath"
}

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8178/health' -TimeoutSec 2
    if ($health.ready -eq $true -and $health.model -eq 'base.en' -and $health.device -eq 'cpu') {
        Write-Output 'Companion speech is already ready.'
        return
    }
    throw 'A different service is using the Companion speech port.'
} catch {
    if ($_.Exception.Message -eq 'A different service is using the Companion speech port.') { throw }
}

New-Item -ItemType Directory -Force -Path $speechRoot | Out-Null
$variables = @{
    COMPANION_SPEECH_MODEL_DIR = $ModelPath
    HF_HOME = (Join-Path $speechRoot 'huggingface')
    XDG_CACHE_HOME = (Join-Path $speechRoot 'cache')
    HF_HUB_OFFLINE = '1'
    HF_HUB_DISABLE_TELEMETRY = '1'
    DO_NOT_TRACK = '1'
    PYTHONDONTWRITEBYTECODE = '1'
}
$previous = @{}
try {
    foreach ($name in $variables.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $variables[$name], 'Process')
    }
    $process = Start-Process -FilePath $pythonPath -ArgumentList @('-u', ('"' + $serverPath + '"')) `
        -WindowStyle Hidden -PassThru -WorkingDirectory $speechRoot `
        -RedirectStandardOutput (Join-Path $speechRoot 'server.log') `
        -RedirectStandardError (Join-Path $speechRoot 'server-error.log')
} finally {
    foreach ($name in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $process.Refresh()
    if ($process.HasExited) { throw "Companion speech stopped during startup. See $speechRoot\server-error.log" }
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8178/health' -TimeoutSec 1
        if ($health.ready -eq $true -and $health.model -eq 'base.en' -and $health.device -eq 'cpu') {
            Write-Output "Companion speech is ready (PID $($process.Id))."
            return
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}
throw "Companion speech has not become ready. See $speechRoot\server-error.log"
