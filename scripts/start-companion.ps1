param(
    [string]$NodePath = '',
    [string]$RuntimeRoot = (Join-Path $PSScriptRoot '..\..\companion-local'),
    [switch]$SkipAI,
    [switch]$StartLocalModel,
    [switch]$Browser,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$sharedArguments = @{ NoOpen = $true; View = 'assistant' }
if ($NodePath) { $sharedArguments.NodePath = $NodePath }
& (Join-Path $PSScriptRoot 'start-shared.ps1') @sharedArguments

if (-not $SkipAI) {
    $RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
    if ($StartLocalModel -and (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'runtime\ollama.exe') -PathType Leaf)) {
        try { & (Join-Path $PSScriptRoot 'start-local.ps1') -RuntimeRoot $RuntimeRoot -ServicesOnly }
        catch { Write-Warning "The optional local model could not start: $($_.Exception.Message) Other configured AI connections remain available." }
    } else {
        $speechRuntime = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\work'))
        if (Test-Path -LiteralPath (Join-Path $speechRuntime '.venv-speech\Scripts\python.exe') -PathType Leaf) {
            try { & (Join-Path $PSScriptRoot 'start-speech.ps1') -RuntimeRoot $speechRuntime }
            catch { Write-Warning "Voice could not start: $($_.Exception.Message) You can still type requests." }
        }
    }
}

Write-Output 'Companion: http://127.0.0.1:4174/assistant.html'
Write-Output 'Tell Companion what you want to get done. Settings connects GPT, Claude, and other AI services.'
Write-Output 'Build a feature adds missing capabilities through checked source changes with rollback.'
if (-not $NoOpen) {
    $desktopRuntime = Join-Path $PSScriptRoot '..\node_modules\electron\dist\electron.exe'
    if (-not $Browser -and (Test-Path -LiteralPath $desktopRuntime -PathType Leaf)) {
        $desktopArguments = @{}
        if ($NodePath) { $desktopArguments.NodePath = $NodePath }
        & (Join-Path $PSScriptRoot 'start-desktop.ps1') @desktopArguments
    } else {
        Start-Process 'http://127.0.0.1:4174/assistant.html' | Out-Null
    }
}
