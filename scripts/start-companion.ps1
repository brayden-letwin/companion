param(
    [string]$NodePath = '',
    [string]$RuntimeRoot = (Join-Path $PSScriptRoot '..\..\companion-local'),
    [switch]$SkipAI,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$sharedArguments = @{ NoOpen = $true; View = 'assistant' }
if ($NodePath) { $sharedArguments.NodePath = $NodePath }
& (Join-Path $PSScriptRoot 'start-shared.ps1') @sharedArguments

if (-not $SkipAI) {
    $RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
    if (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'runtime\ollama.exe') -PathType Leaf) {
        try { & (Join-Path $PSScriptRoot 'start-local.ps1') -RuntimeRoot $RuntimeRoot -ServicesOnly }
        catch { Write-Warning "Local AI could not start: $($_.Exception.Message) The paper reader and math tools can still open." }
    } else {
        Write-Output 'For live answers and voice, follow the local AI setup in README.md. Reading, plots and notes work without AI.'
    }
}

Write-Output 'Companion: http://127.0.0.1:4174/assistant.html'
Write-Output 'Select a source and type a question, or click the microphone. Stop ends the current request.'
if (-not $NoOpen) { Start-Process 'http://127.0.0.1:4174/assistant.html' | Out-Null }
