$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Fixed Windows APIs only. JSON fields are data, never PowerShell source or commands.
function Stop-Desktop([string]$code, [string]$message) {
    $failure = New-Object System.InvalidOperationException($message)
    $failure.Data['CompanionCode'] = $code
    throw $failure
}
function Limit-Text([string]$value, [int]$limit) {
    if ($null -eq $value) { return '' }
    if ($value.Length -gt $limit) { return $value.Substring(0, $limit) }
    return $value
}
function Test-Terminal([string]$value) {
    return $value -match '(?i)(powershell|windows.?terminal|command.?prompt|\bcmd\b|\bpwsh\b|\bconhost\b|\bopenconsole\b|\bwsl\b|\bbash\b|\bmintty\b|\bwezterm\b|\balacritty\b)'
}
function Test-Sensitive([string]$value) {
    return $value -match '(?i)(password|passcode|one.?time.?code|verification.?code|api.?key|access.?token|credential|terminal|developer.?tools|devtools)'
}

try {
    $rawRequest = [Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($rawRequest) -gt 64000) { Stop-Desktop 'invalid_input' 'The desktop request is too large.' }
    $request = $rawRequest | ConvertFrom-Json
    if ($request.action -notin @('health','listApps','listWindows','openApp','focusWindow','openUrl','readWindow','readContext','performAction')) { Stop-Desktop 'invalid_input' 'That desktop action is not supported.' }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace CompanionDesktop {
  public sealed class WindowInfo {
    public string handle; public int pid; public string startTime;
    public string title; public string appName; public string className;
  }
  public static class Native {
    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr handle, int command);
    public static WindowInfo Read(long value) {
      IntPtr handle = new IntPtr(value);
      if (!IsWindow(handle) || !IsWindowVisible(handle)) return null;
      uint processId; GetWindowThreadProcessId(handle, out processId);
      if (processId == 0) return null;
      try {
        using (Process process = Process.GetProcessById((int)processId)) {
          StringBuilder title = new StringBuilder(601), name = new StringBuilder(201);
          GetWindowText(handle, title, title.Capacity); GetClassName(handle, name, name.Capacity);
          return new WindowInfo { handle=value.ToString(System.Globalization.CultureInfo.InvariantCulture), pid=(int)processId,
            startTime=process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
            title=title.ToString(), appName=process.ProcessName, className=name.ToString() };
        }
      } catch { return null; }
    }
    public static WindowInfo[] Windows() {
      List<WindowInfo> values = new List<WindowInfo>();
      EnumWindows(delegate(IntPtr handle, IntPtr unused) { var value=Read(handle.ToInt64()); if(value!=null && value.title.Length>0) values.Add(value); return values.Count<200; }, IntPtr.Zero);
      return values.ToArray();
    }
    public static bool Focus(long value) {
      IntPtr handle = new IntPtr(value); if (!IsWindow(handle)) return false;
      ShowWindowAsync(handle, 9); SetForegroundWindow(handle);
      return GetForegroundWindow()==handle;
    }
  }
}
'@

    function Assert-Window($expected) {
        if ($null -eq $expected -or [string]$expected.handle -notmatch '^\d{1,20}$') { Stop-Desktop 'invalid_input' 'Choose a known desktop window.' }
        $actual = [CompanionDesktop.Native]::Read([long]$expected.handle)
        if ($null -eq $actual -or $actual.pid -ne $expected.pid -or $actual.startTime -cne [string]$expected.startTime -or $actual.title -cne [string]$expected.title -or $actual.className -cne [string]$expected.className -or $actual.appName -cne [string]$expected.appName) { Stop-Desktop 'stale_window' 'The selected window changed or closed. List and read it again.' }
        if (Test-Terminal ($actual.appName + ' ' + $actual.title)) { Stop-Desktop 'protected_target' 'Terminal windows are outside desktop control.' }
        return $actual
    }
    function Get-Apps {
        $modulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\StartLayout\StartLayout.psd1'
        if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { Stop-Desktop 'bridge_unavailable' 'The Windows Start-menu app provider is unavailable.' }
        Import-Module -Name $modulePath -ErrorAction Stop | Out-Null
        $items = @(StartLayout\Get-StartApps | Sort-Object Name, AppID)
        $values = New-Object System.Collections.Generic.List[object]
        foreach ($item in $items) {
            if ($item.Name -and $item.AppID -and -not (Test-Terminal ($item.Name + ' ' + $item.AppID))) { [void]$values.Add([ordered]@{ name=(Limit-Text ([string]$item.Name) 200); sourceId=[string]$item.AppID }) }
            if ($values.Count -ge 500) { break }
        }
        return $values.ToArray()
    }
    function Get-Pattern($element, $identifier) {
        [object]$patternValue = $null
        if ($element.TryGetCurrentPattern($identifier, [ref]$patternValue)) { return $patternValue }
        return $null
    }
    function Test-ProtectedElement($element) {
        try {
            if ($element.Current.IsPassword) { return $true }
            return (Test-Sensitive ($element.Current.Name + ' ' + $element.Current.AutomationId + ' ' + $element.Current.ClassName))
        } catch { return $true }
    }
    function Element-Info($element) {
        if ((Test-ProtectedElement $element) -or $element.Current.IsOffscreen) { return $null }
        $runtimeId = ($element.GetRuntimeId() -join '.')
        if (-not $runtimeId) { return $null }
        $current = $element.Current
        $valuePattern = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
        $fullValue = ''
        $supported = New-Object System.Collections.Generic.List[string]
        if ($current.IsEnabled) {
            if ((Get-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)) -or (Get-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)) -or (Get-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern))) { [void]$supported.Add('click') }
            if ($valuePattern -and -not $valuePattern.Current.IsReadOnly) { [void]$supported.Add('setText') }
            if ($current.IsKeyboardFocusable) { [void]$supported.Add('pressKey') }
        }
        # IsPassword/credential labels are checked before accessing any value.
        if ($valuePattern) { $fullValue = [string]$valuePattern.Current.Value }
        $canonical = [ordered]@{ runtimeId=$runtimeId; name=[string]$current.Name; automationId=[string]$current.AutomationId; className=[string]$current.ClassName; controlType=$current.ControlType.ProgrammaticName; enabled=$current.IsEnabled; value=$fullValue }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($canonical | ConvertTo-Json -Compress))))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
        return [ordered]@{ runtimeId=$runtimeId; fingerprint=$fingerprint; name=(Limit-Text ([string]$current.Name) 500); automationId=(Limit-Text ([string]$current.AutomationId) 300); className=(Limit-Text ([string]$current.ClassName) 200); controlType=$current.ControlType.ProgrammaticName.Replace('ControlType.',''); enabled=[bool]$current.IsEnabled; isPassword=$false; value=(Limit-Text $fullValue 500); actions=@($supported.ToArray()) }
    }
    function Find-Element($rootElement, [string]$runtimeId) {
        $stack = New-Object 'System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]'
        $stack.Push($rootElement); $visited = 0; $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        while ($stack.Count -gt 0 -and $visited -lt 3000) {
            $candidate = $stack.Pop(); $visited += 1
            if (Test-ProtectedElement $candidate) { continue }
            try {
                if (($candidate.GetRuntimeId() -join '.') -ceq $runtimeId) { return $candidate }
                $childElement = $walker.GetLastChild($candidate)
                while ($null -ne $childElement -and $stack.Count -lt 6000) { $stack.Push($childElement); $childElement = $walker.GetPreviousSibling($childElement) }
            } catch {}
        }
        Stop-Desktop 'stale_element' 'The selected accessibility element is no longer present. Read the window again.'
    }
    function Test-CompanionWindow($rootElement, $knownWindow, [int]$companionPort) {
        if ($knownWindow.appName -match '^(?i:electron|companion)$') { return $true }
        $stack = New-Object 'System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]'
        $stack.Push($rootElement); $visited = 0; $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        while ($stack.Count -gt 0 -and $visited -lt 1500) {
            $candidate = $stack.Pop(); $visited += 1
            try {
                if (Test-ProtectedElement $candidate) { continue }
                $current = $candidate.Current
                if ($current.Name -ceq 'Companion desktop approval' -or $current.AutomationId -match '^desktop-(?:approval|approve|review|action-dialog)') { return $true }
                if (($current.Name + ' ' + $current.AutomationId) -match '(?i)(address|urlbar|omnibox|location)') {
                    $addressPattern = Get-Pattern $candidate ([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($addressPattern -and $addressPattern.Current.Value -match ('^(?:https?://)?(?:127\.0\.0\.1|localhost):' + $companionPort + '(?:/|$)')) { return $true }
                }
                $childElement = $walker.GetLastChild($candidate)
                while ($null -ne $childElement -and $stack.Count -lt 3000) { $stack.Push($childElement); $childElement = $walker.GetPreviousSibling($childElement) }
            } catch {}
        }
        return $false
    }

    # Context is a separate read-only path. Existing input snapshots keep their exact-title checks.
    function Assert-ContextWindow($expected) {
        if ($null -eq $expected -or [string]$expected.handle -notmatch '^\d{1,20}$') { Stop-Desktop 'invalid_input' 'Choose a known desktop window.' }
        $actual = [CompanionDesktop.Native]::Read([long]$expected.handle)
        if ($null -eq $actual -or $actual.pid -ne $expected.pid -or $actual.startTime -cne [string]$expected.startTime -or $actual.className -cne [string]$expected.className -or $actual.appName -cne [string]$expected.appName) { Stop-Desktop 'stale_window' 'The selected context window changed or closed.' }
        if ((Test-Terminal ($actual.appName + ' ' + $actual.title)) -or (Test-Sensitive ($actual.appName + ' ' + $actual.title))) { Stop-Desktop 'protected_target' 'Terminal and credential windows cannot be used as question context.' }
        return $actual
    }
    function Context-RuntimeId($rootElement) {
        try { return [string]($rootElement.GetRuntimeId() -join '.') } catch { return '' }
    }
    function Context-LimitText([string]$value, [int]$limit) {
        if ($null -eq $value) { return '' }
        $end = [Math]::Min($limit, $value.Length)
        if ($end -gt 0 -and $end -lt $value.Length -and [char]::IsHighSurrogate($value[$end - 1]) -and [char]::IsLowSurrogate($value[$end])) { $end -= 1 }
        return $value.Substring(0, $end)
    }
    function Context-Tree($rootElement) {
        $stack = New-Object 'System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]'
        $stack.Push($rootElement); $visited = 0; $nodes = New-Object System.Collections.Generic.List[object]
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        while ($stack.Count -gt 0 -and $visited -lt 3000) {
            $candidate = $stack.Pop(); $visited += 1
            # Validate privacy before ValuePattern or TextPattern reads, even for offscreen controls.
            if (Test-ProtectedElement $candidate) { Stop-Desktop 'protected_target' 'This window contains credential or protected controls and cannot be context.' }
            try {
                if (-not $candidate.Current.IsOffscreen) { [void]$nodes.Add($candidate) }
                $childElement = $walker.GetLastChild($candidate)
                while ($null -ne $childElement -and $stack.Count -lt 6000) { $stack.Push($childElement); $childElement = $walker.GetPreviousSibling($childElement) }
            } catch { Stop-Desktop 'stale_window' 'The context accessibility tree changed during its privacy check.' }
        }
        return [pscustomobject]@{ nodes=@($nodes.ToArray()); truncated=($stack.Count -gt 0) }
    }
    function Context-Body($tree) {
        # Bulk document text is used only after a complete protected-control scan.
        if (-not $tree.truncated) {
            foreach ($candidate in $tree.nodes) {
                if (Test-ProtectedElement $candidate) { Stop-Desktop 'protected_target' 'The selected source became protected.' }
                if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document) { continue }
                $pattern = Get-Pattern $candidate ([System.Windows.Automation.TextPattern]::Pattern)
                if ($null -ne $pattern) {
                    $value = [string]$pattern.DocumentRange.GetText(12001)
                    if ($value) { return [ordered]@{ text=(Context-LimitText $value 12000); truncated=($value.Length -gt 12000) } }
                }
            }
        }
        $builder = New-Object Text.StringBuilder; $clipped = [bool]$tree.truncated
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        foreach ($candidate in $tree.nodes) {
            if (Test-ProtectedElement $candidate) { Stop-Desktop 'protected_target' 'The selected source became protected.' }
            $current = $candidate.Current; $value = ''
            # Leaf edits cannot include unseen descendant credential fields. Prefer bounded TextPattern.
            if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $null -eq $walker.GetFirstChild($candidate)) {
                $pattern = Get-Pattern $candidate ([System.Windows.Automation.TextPattern]::Pattern)
                if ($null -ne $pattern) { $value = [string]$pattern.DocumentRange.GetText(12001) }
                else { $pattern = Get-Pattern $candidate ([System.Windows.Automation.ValuePattern]::Pattern); if ($null -ne $pattern) { $value = [string]$pattern.Current.Value } }
            }
            # Some read-only MSAA/WinForms documents expose their text as a leaf Pane name.
            $nameTextType = $current.ControlType -in @([System.Windows.Automation.ControlType]::Text, [System.Windows.Automation.ControlType]::Pane, [System.Windows.Automation.ControlType]::Document, [System.Windows.Automation.ControlType]::Edit)
            if (-not $value -and $nameTextType -and $null -eq $walker.GetFirstChild($candidate)) { $value = [string]$current.Name }
            if (-not $value) { continue }
            $remaining = 12000 - $builder.Length
            if ($remaining -le 1) { $clipped = $true; break }
            if ($builder.Length) { [void]$builder.Append("`n"); $remaining -= 1 }
            $piece = Context-LimitText $value $remaining; [void]$builder.Append($piece)
            if ($piece.Length -lt $value.Length) { $clipped = $true; break }
        }
        return [ordered]@{ text=$builder.ToString(); truncated=$clipped }
    }

    $result = $null
    switch ($request.action) {
        'health' { $desktopRoot = [System.Windows.Automation.AutomationElement]::RootElement; $result = [ordered]@{ available=([Environment]::UserInteractive -and $null -ne $desktopRoot); bridge='windows-uia'; interactive=[Environment]::UserInteractive } }
        'listApps' {
            $allApps = @(Get-Apps)
            $query = [string]$request.query
            $filtered = @($allApps | Where-Object { -not $query -or $_.name.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
            $result = [ordered]@{ apps=$filtered; truncated=($allApps.Count -ge 500) }
        }
        'listWindows' {
            $allWindows = @([CompanionDesktop.Native]::Windows() | Where-Object { -not (Test-Terminal ($_.appName + ' ' + $_.title)) })
            $query = [string]$request.query
            $filtered = @($allWindows | Where-Object { -not $query -or ($_.title + ' ' + $_.appName).IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
            $result = [ordered]@{ windows=$filtered; truncated=($allWindows.Count -ge 200) }
        }
        'openApp' {
            $selected = @(Get-Apps | Where-Object { $_.sourceId -ceq [string]$request.sourceId -and $_.name -ceq [string]$request.name })
            if ($selected.Count -ne 1) { Stop-Desktop 'app_unavailable' 'The installed app changed or is no longer available. Discover apps again.' }
            $shell = New-Object -ComObject Shell.Application
            $folder = $shell.NameSpace('shell:AppsFolder')
            $installedItem = $null
            foreach ($candidate in $folder.Items()) {
                if ([string]$candidate.Path -ceq [string]$request.sourceId -or [string]$candidate.ExtendedProperty('System.AppUserModel.ID') -ceq [string]$request.sourceId) { $installedItem = $candidate; break }
            }
            if ($null -eq $installedItem) { Stop-Desktop 'app_unavailable' 'Windows could not resolve that installed app safely.' }
            [void]$installedItem.InvokeVerb('open')
            $observed = @()
            for ($attempt = 0; $attempt -lt 8; $attempt++) {
                Start-Sleep -Milliseconds 100
                $observed = @([CompanionDesktop.Native]::Windows() | Where-Object { -not (Test-Terminal ($_.appName + ' ' + $_.title)) -and ($_.title.IndexOf([string]$request.name, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or ([string]$request.name).IndexOf($_.appName, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object -First 10)
                if ($observed.Count -gt 0) { break }
            }
            $result = [ordered]@{ accepted=$true; windows=$observed }
        }
        'openUrl' {
            $uri = $null
            if (-not [Uri]::TryCreate([string]$request.url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo) { Stop-Desktop 'invalid_input' 'Choose an HTTP or HTTPS URL without embedded credentials.' }
            $startInfo = New-Object Diagnostics.ProcessStartInfo
            $startInfo.FileName = $uri.AbsoluteUri
            $startInfo.UseShellExecute = $true
            [void][Diagnostics.Process]::Start($startInfo)
            $result = [ordered]@{ accepted=$true }
        }
        'focusWindow' {
            $knownWindow = Assert-Window $request.window
            $focused = [CompanionDesktop.Native]::Focus([long]$knownWindow.handle)
            if (-not $focused) { Stop-Desktop 'focus_denied' 'Windows did not allow the selected window to receive focus.' }
            $result = [ordered]@{ focused=$true }
        }
        'readWindow' {
            $knownWindow = Assert-Window $request.window
            $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$knownWindow.handle))
            $stack = New-Object 'System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]'
            $stack.Push($rootElement); $visited = 0; $elements = New-Object System.Collections.Generic.List[object]
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            while ($stack.Count -gt 0 -and $visited -lt 3000 -and $elements.Count -lt 200) {
                $candidate = $stack.Pop(); $visited += 1
                if (Test-ProtectedElement $candidate) { continue }
                try {
                    $info = Element-Info $candidate
                    if ($null -ne $info -and ($info.name -or $info.actions.Count -gt 0)) { [void]$elements.Add($info) }
                    $childElement = $walker.GetLastChild($candidate)
                    while ($null -ne $childElement -and $stack.Count -lt 6000) { $stack.Push($childElement); $childElement = $walker.GetPreviousSibling($childElement) }
                } catch {}
            }
            [void](Assert-Window $request.window)
            $result = [ordered]@{ elements=@($elements.ToArray()); protectedInput=(Test-CompanionWindow $rootElement $knownWindow ([int]$request.companionPort)); truncated=($stack.Count -gt 0) }
        }
        'readContext' {
            $knownWindow = Assert-ContextWindow $request.window
            $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$knownWindow.handle))
            $rootRuntimeId = Context-RuntimeId $rootElement
            if ($request.rootRuntimeId -and $rootRuntimeId -cne [string]$request.rootRuntimeId) { Stop-Desktop 'stale_window' 'The selected context root changed.' }
            if (Test-CompanionWindow $rootElement $knownWindow ([int]$request.companionPort)) { Stop-Desktop 'protected_target' 'Companion cannot be used as its own question context.' }
            $tree = Context-Tree $rootElement
            $body = [ordered]@{ text=''; truncated=[bool]$tree.truncated }
            if ($request.includeText -eq $true) { $body = Context-Body $tree }
            # Recheck the protected tree and exact current title before releasing any collected text.
            $finalTree = Context-Tree $rootElement
            if (-not $tree.truncated -and $finalTree.truncated) { Stop-Desktop 'protected_target' 'The context privacy scan changed and could not be completed.' }
            if (Test-CompanionWindow $rootElement $knownWindow ([int]$request.companionPort)) { Stop-Desktop 'protected_target' 'The selected source became Companion controls.' }
            [void](Assert-Window $knownWindow)
            $finalRuntimeId = Context-RuntimeId $rootElement
            if ($rootRuntimeId -and $rootRuntimeId -cne $finalRuntimeId) { Stop-Desktop 'stale_window' 'The selected context root changed during reading.' }
            $result = [ordered]@{ window=$knownWindow; rootRuntimeId=$rootRuntimeId; protectedContext=$false; text=$body.text; truncated=([bool]$body.truncated -or [bool]$finalTree.truncated) }
        }
        'performAction' {
            $knownWindow = Assert-Window $request.window
            $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$knownWindow.handle))
            if (Test-CompanionWindow $rootElement $knownWindow ([int]$request.companionPort)) { Stop-Desktop 'protected_target' 'Companion approval controls cannot be targeted by desktop input.' }
            $targetElement = Find-Element $rootElement ([string]$request.element.runtimeId)
            $info = Element-Info $targetElement
            if ($null -eq $info -or $info.fingerprint -cne [string]$request.element.fingerprint) { Stop-Desktop 'stale_element' 'The selected element or its value changed. Read the window again.' }
            $inputAction = [string]$request.input.action
            if ($inputAction -notin $info.actions) { Stop-Desktop 'unsupported_element' 'That element does not support the approved input.' }
            [void](Assert-Window $request.window)
            switch ($inputAction) {
                'click' {
                    $invoke = Get-Pattern $targetElement ([System.Windows.Automation.InvokePattern]::Pattern)
                    $toggle = Get-Pattern $targetElement ([System.Windows.Automation.TogglePattern]::Pattern)
                    $select = Get-Pattern $targetElement ([System.Windows.Automation.SelectionItemPattern]::Pattern)
                    if ($invoke) { $invoke.Invoke() } elseif ($toggle) { $toggle.Toggle() } elseif ($select) { $select.Select() } else { Stop-Desktop 'unsupported_element' 'That element cannot be invoked safely.' }
                }
                'setText' {
                    $replacement = [string]$request.input.text
                    if ($replacement.Length -gt 4000 -or $replacement.Contains([char]0) -or $replacement -match '^\s*(?i:file|javascript|data|shell|powershell):') { Stop-Desktop 'protected_target' 'That replacement is outside generic desktop text input.' }
                    $valuePattern = Get-Pattern $targetElement ([System.Windows.Automation.ValuePattern]::Pattern)
                    if (-not $valuePattern -or $valuePattern.Current.IsReadOnly) { Stop-Desktop 'unsupported_element' 'That element cannot accept text through UI Automation.' }
                    $valuePattern.SetValue($replacement)
                }
                'pressKey' {
                    $keyMap = @{ Enter='{ENTER}'; Tab='{TAB}'; Escape='{ESC}'; ArrowLeft='{LEFT}'; ArrowRight='{RIGHT}'; ArrowUp='{UP}'; ArrowDown='{DOWN}'; Home='{HOME}'; End='{END}'; PageUp='{PGUP}'; PageDown='{PGDN}'; Backspace='{BACKSPACE}'; Delete='{DELETE}'; Space=' '; 'Ctrl+A'='^a' }
                    $keyName = [string]$request.input.key
                    if (-not $keyMap.ContainsKey($keyName)) { Stop-Desktop 'invalid_input' 'Choose a supported fixed key name.' }
                    if (-not [CompanionDesktop.Native]::Focus([long]$knownWindow.handle)) { Stop-Desktop 'focus_denied' 'Windows did not focus the approved target window.' }
                    $targetElement.SetFocus()
                    $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
                    if ([CompanionDesktop.Native]::GetForegroundWindow().ToInt64() -ne [long]$knownWindow.handle -or ($focusedElement.GetRuntimeId() -join '.') -cne $info.runtimeId) { Stop-Desktop 'focus_denied' 'The approved element did not retain keyboard focus.' }
                    [void](Assert-Window $request.window)
                    if ((Element-Info $targetElement).fingerprint -cne [string]$request.element.fingerprint) { Stop-Desktop 'stale_element' 'The approved element changed before keyboard input.' }
                    # Only a fixed whitelist mapping reaches SendKeys. Text uses ValuePattern.
                    [System.Windows.Forms.SendKeys]::SendWait([string]$keyMap[$keyName])
                    if ([CompanionDesktop.Native]::GetForegroundWindow().ToInt64() -ne [long]$knownWindow.handle) { Stop-Desktop 'input_outcome_uncertain' 'Windows accepted the key, but focus changed afterward. Inspect the target before any retry.' }
                }
                default { Stop-Desktop 'invalid_input' 'Choose a supported input action.' }
            }
            $result = [ordered]@{ performed=$true; action=$inputAction }
        }
    }
    [Console]::Out.Write(([ordered]@{ ok=$true; result=$result } | ConvertTo-Json -Depth 15 -Compress))
} catch {
    $code = [string]$_.Exception.Data['CompanionCode']
    $message = 'Windows could not complete the desktop operation. The target may be unavailable, elevated or inaccessible.'
    if ($code) { $message = $_.Exception.Message } else { $code = 'bridge_unavailable' }
    [Console]::Out.Write(([ordered]@{ ok=$false; error=[ordered]@{ code=$code; message=$message } } | ConvertTo-Json -Compress))
}
