param(
    [string]$NodePath = '',
    [string]$DataDirectory = (Join-Path $PSScriptRoot '..\..\..\work\companion-shared'),
    [ValidateRange(1024,65535)][int]$Port = 4174,
    [string]$ElectronPath = (Join-Path $PSScriptRoot '..\node_modules\electron\dist\electron.exe'),
    [string]$ProfileDirectory = '',
    [switch]$Workspace
)

$ErrorActionPreference = 'Stop'
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$ElectronPath = [IO.Path]::GetFullPath($ElectronPath)
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mainPath = Join-Path $sourceRoot 'electron\productivity-main.cjs'
if (-not (Test-Path -LiteralPath $ElectronPath -PathType Leaf)) { throw "Installed Electron was not found: $ElectronPath. Set up this checkout's dependencies before opening the desktop app." }
if (-not (Test-Path -LiteralPath $mainPath -PathType Leaf)) { throw "Desktop source was not found: $mainPath" }

$backendArguments = @{ DataDirectory = $DataDirectory; Port = $Port; NoOpen = $true; View = 'assistant' }
if ($NodePath) { $backendArguments.NodePath = $NodePath }
& (Join-Path $PSScriptRoot 'start-shared.ps1') @backendArguments

$logDirectory = Join-Path $DataDirectory 'desktop-logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$logId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$variables = @{ COMPANION_DESKTOP_PORT = "$Port"; ELECTRON_RUN_AS_NODE = $null; NODE_OPTIONS = $null; NODE_PATH = $null }
if ($ProfileDirectory) { $variables.COMPANION_DESKTOP_PROFILE = [IO.Path]::GetFullPath($ProfileDirectory) }
$previous = @{}
try {
    foreach ($name in $variables.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        # Electron treats an existing empty ELECTRON_RUN_AS_NODE key as enabled.
        # Remove absent variables through Env: instead of marshaling null to ''.
        if ($null -eq $variables[$name]) {
            if ($null -ne [Environment]::GetEnvironmentVariable($name, 'Process')) { Remove-Item -LiteralPath "Env:$name" }
        }
        else { Set-Item -LiteralPath "Env:$name" -Value $variables[$name] }
    }
    $desktopArguments = @(('"' + $mainPath + '"'))
    if ($Workspace) { $desktopArguments += '--workspace' }
    $desktopProcess = Start-Process -FilePath $ElectronPath -ArgumentList $desktopArguments -WorkingDirectory $sourceRoot `
        -WindowStyle Normal -PassThru -RedirectStandardOutput (Join-Path $logDirectory "$logId.log") `
        -RedirectStandardError (Join-Path $logDirectory "$logId-error.log")
    Start-Sleep -Milliseconds 400
    $desktopProcess.Refresh()
    if ($desktopProcess.HasExited -and $desktopProcess.ExitCode -ne 0) { throw "Companion desktop could not open. See $logDirectory\$logId-error.log" }
    Write-Output 'Companion desktop is open. Ctrl+Alt+Space shows or hides the corner; Ctrl+Alt+Escape stops current work.'
    Write-Output 'Use the tray icon to open your workspace or quit the desktop. The local backend keeps running independently.'
} finally {
    foreach ($name in $previous.Keys) {
        if ($null -eq $previous[$name]) {
            if ($null -ne [Environment]::GetEnvironmentVariable($name, 'Process')) { Remove-Item -LiteralPath "Env:$name" }
        }
        else { Set-Item -LiteralPath "Env:$name" -Value $previous[$name] }
    }
}
