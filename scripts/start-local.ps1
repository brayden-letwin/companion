param(
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [string]$SpeechRuntimeRoot = (Join-Path $PSScriptRoot '..\..\..\work'),
    [string]$AppPath = (Join-Path $PSScriptRoot '..\release\Companion-0.4.0\Companion.exe'),
    [switch]$SkipSpeech
)

$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$AppPath = [IO.Path]::GetFullPath($AppPath)
$ollamaPath = Join-Path $RuntimeRoot 'runtime\ollama.exe'
if (-not (Test-Path -LiteralPath $ollamaPath -PathType Leaf)) { throw "Local Ollama runtime missing: $ollamaPath. See README local setup." }
if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) { throw "Companion build missing: $AppPath. Package Companion-0.4.0 first." }
$developmentElectron = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\node_modules\electron\dist\electron.exe'))
$existing = Get-Process -Name Companion,electron -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq 'Companion' -or $_.Path -eq $developmentElectron
}
if ($existing) { throw 'Companion is already open. Focus its small corner and press Alt+F4, then run this launcher again so local mode takes effect.' }
$logRoot = Join-Path $RuntimeRoot 'logs'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$variables = @{
    OLLAMA_HOST = '127.0.0.1:11434'
    OLLAMA_MODELS = (Join-Path $RuntimeRoot 'models')
    OLLAMA_NO_CLOUD = '1'
    OLLAMA_CONTEXT_LENGTH = '4096'
    OLLAMA_MAX_LOADED_MODELS = '1'
    OLLAMA_NUM_PARALLEL = '1'
    COMPANION_PROVIDER = 'local'
    COMPANION_LOCAL_MODEL = 'companion-math'
}
$previous = @{}
try {
    foreach ($name in $variables.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $variables[$name], 'Process')
    }
    $ready = $false
    try { $ready = [bool](Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 -MaximumRedirection 0).version } catch { }
    if (-not $ready) {
        $server = Start-Process -FilePath $ollamaPath -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
            -WorkingDirectory $RuntimeRoot -RedirectStandardOutput (Join-Path $logRoot 'ollama.log') `
            -RedirectStandardError (Join-Path $logRoot 'ollama-error.log')
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $server.Refresh()
            if ($server.HasExited) { throw "Local model server stopped. See $logRoot\ollama-error.log" }
            try { $ready = [bool](Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 1 -MaximumRedirection 0).version } catch { }
            if ($ready) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $ready) { throw 'Local model server is not responding.' }
    $models = (Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3 -MaximumRedirection 0).models
    $model = $models | Where-Object { $_.name -eq 'companion-math:latest' }
    if (-not $model -or $model.details.format -ne 'gguf' -or $model.remote_host -or $model.remote_model) {
        throw 'Install the local companion-math model using the README setup steps first.'
    }
    if (-not $SkipSpeech) {
        try { & (Join-Path $PSScriptRoot 'start-speech.ps1') -RuntimeRoot $SpeechRuntimeRoot }
        catch { Write-Warning "Voice is unavailable; typed local questions still work. $($_.Exception.Message)" }
    }
    Start-Process -FilePath $AppPath -WorkingDirectory ([IO.Path]::GetDirectoryName($AppPath)) | Out-Null
    Write-Output 'Companion started with local AI. No API key is needed.'
} finally {
    foreach ($name in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}
