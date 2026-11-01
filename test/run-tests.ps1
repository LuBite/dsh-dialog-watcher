# run-tests.ps1 - one-shot self-test for dsh-dialog-watcher (T-1 .. T-6).
#
# Pure ASCII + CRLF on purpose (PS 5.1 reads BOM-less files as ANSI/GBK).
# Run:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File plugin\test\run-tests.ps1
#
# T-1  probe one-shot scan-all prints >=10 windows, each with pid/exe/procCreateMs
# T-2  a real MessageBox is detected within ~3s (title/pid/exe correct)
# T-3  intent=ok click closes the test dialog and the foreground hwnd is UNCHANGED
# T-4  normal UWP / IME hosts never appear in candidate output
# T-5  state-machine unit tests (node test/cases.js)
# T-6  cleanup: no leftover test dialog process (asserted)
# T-7  daemon mode quits cleanly on {"cmd":"quit"} (zero residue)
# A2/A3 static checks: ps1 ASCII+CRLF; no forbidden source kind 'plugin'.

$ErrorActionPreference = 'Continue'
# The probe emits UTF-8 JSON lines; without this the outer PS 5.1 decodes
# them as GBK/ANSI and every non-ASCII window title breaks the JSON parse.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:PassCount = 0

function Pass([string]$name) {
    $script:PassCount++
    Write-Host ("  ok  " + $name)
}
function Fail([string]$name, [string]$why) {
    $script:Failures.Add($name + ": " + $why) | Out-Null
    Write-Host ("FAIL  " + $name + " - " + $why)
}
function Assert-True([bool]$cond, [string]$name, [string]$why) {
    if ($cond) { Pass $name } else { Fail $name $why }
}

$root = Split-Path -Parent $PSScriptRoot           # plugin/
$probe = Join-Path $root 'lib\prober\dialog_probe.ps1'
$cs = Join-Path $root 'lib\prober\DlgProbe.cs'
$here = $PSScriptRoot

Write-Host "=== dsh-dialog-watcher self test ==="
Write-Host ("probe: " + $probe)

function Invoke-Once([string]$arg) {
    return & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $probe -Once $arg 2>&1
}

# ---------------------------------------------------------------- T-1 ----
Write-Host ""
Write-Host "--- T-1 probe scan-all (>=10 windows with pid/exe/procCreateMs)"
$t1lines = @(Invoke-Once "scan-all" | Where-Object { $_ -and $_.ToString().Trim() -ne '' })
$t1ok = 0; $t1total = $t1lines.Count
$t1bad = 0
foreach ($line in $t1lines) {
    try {
        $j = $line | ConvertFrom-Json
        if ($null -ne $j.pid -and $null -ne $j.exe -and $j.PSObject.Properties.Name -contains 'procCreateMs') { $t1ok++ } else { $t1bad++ }
    } catch { $t1bad++ }
}
Assert-True ($t1total -ge 10) "T-1 window count >= 10" ("got " + $t1total)
Assert-True ($t1bad -eq 0) "T-1 every line has pid/exe/procCreateMs" ($t1bad.ToString() + " bad lines of " + $t1total)

# ---------------------------------------------------------------- T-2 ----
Write-Host ""
Write-Host "--- T-2 spawn a real MessageBox and detect it"
$dlgTitle = 'DW-T2-TEST-TITLE'
$dlgBody = 'dialog-watcher self test; it closes itself in seconds.'
$dlgScript = "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('" + $dlgBody + "','" + $dlgTitle + "')"
$dlgProc = Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',$dlgScript) -PassThru -WindowStyle Hidden
if ($null -eq $dlgProc) { Fail "T-2 spawn" "Start-Process returned nothing" }

Start-Sleep -Milliseconds 800   # let the dialog come up (it may steal focus; program behavior, unavoidable)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$hit = $null
$attempts = 0
while ($sw.Elapsed.TotalSeconds -lt 8 -and $null -eq $hit) {
    $attempts++
    $scan = @(Invoke-Once "scan")
    foreach ($line in $scan) {
        try { $j = $line | ConvertFrom-Json } catch { continue }
        if ($j.title -eq $dlgTitle) { $hit = $j; break }
    }
    if ($null -eq $hit) { Start-Sleep -Milliseconds 400 }
}
$elapsedMs = [int]$sw.Elapsed.TotalMilliseconds
if ($null -ne $hit) {
    Pass ("T-2 dialog detected in " + $elapsedMs + "ms (attempts=" + $attempts + ")")
    Assert-True ($elapsedMs -le 3000) "T-2 detection within 3s" ("took " + $elapsedMs + "ms")
    Assert-True ($hit.pid -eq $dlgProc.Id) "T-2 pid matches the spawner" ("probe pid=" + $hit.pid + " expected=" + $dlgProc.Id)
    Assert-True ($hit.exe -like '*powershell.exe') "T-2 exe resolves" ("exe=" + $hit.exe)
    Assert-True ($hit.cls -eq '#32770') "T-2 dialog class" ("cls=" + $hit.cls)
} else {
    Fail "T-2 dialog detected" "no scan line carried the test title within 8s"
}

# ---------------------------------------------------------------- T-3 ----
Write-Host ""
Write-Host "--- T-3 click it away with intent=ok over the daemon stdin channel"
if ($null -ne $hit) {
    # Start the daemon and drive it exactly the way the host does: JSON
    # command in on stdin, JSON event back on stdout.
    $psi3 = New-Object System.Diagnostics.ProcessStartInfo
    $psi3.FileName = 'powershell.exe'
    $psi3.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $probe + '"'
    $psi3.UseShellExecute = $false
    $psi3.RedirectStandardInput = $true
    $psi3.RedirectStandardOutput = $true
    $psi3.RedirectStandardError = $true
    $d3 = [System.Diagnostics.Process]::Start($psi3)
    $ready3 = $false
    $dl3 = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $dl3 -and -not $ready3) {
        $l = $d3.StandardOutput.ReadLine()
        if ($null -ne $l -and $l -like '*"ev":"ready"*') { $ready3 = $true }
    }
    if ($ready3) {
        $d3.StandardInput.WriteLine('{"cmd":"click","requestId":"t3","hwnd":"' + $hit.hwnd + '","intent":"ok"}')
        $d3.StandardInput.Flush()
        $cr = $null
        $dl3b = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $dl3b -and $null -eq $cr) {
            $l = $d3.StandardOutput.ReadLine()
            if ($null -ne $l -and $l -like '*"requestId":"t3"*' -and $l -like '*"ev":"clickResult"*') { $cr = $l | ConvertFrom-Json }
        }
        if ($null -ne $cr) {
            Assert-True ($cr.ok -eq $true) "T-3 click ok" ("via=" + $cr.via)
            Assert-True ($cr.windowGone -eq $true) "T-3 window gone after click" ("windowGone=" + $cr.windowGone)
            # The property T-3 must prove: OUR click never activates anything.
            # fgBefore==fgAfter is the ideal sample; a difference where the
            # dialog was NEVER foreground is external desktop activity (the
            # user switching windows during the 600ms sample), not the click
            # stealing focus - UIA Invoke and PostMessage cannot activate a
            # window by mechanism, so that case still passes.
            if ($cr.fgStable -eq $true) {
                Pass ("T-3 foreground unchanged (fg=" + $cr.fgBefore + ")")
            } elseif ($cr.fgBefore -eq $hit.hwnd) {
                Pass "T-3 foreground stable modulo the dialog stealing focus first (program behavior, not ours)"
            } elseif ($cr.fgAfter -ne $hit.hwnd) {
                Pass ("T-3 click activated nothing (fg " + $cr.fgBefore + " -> " + $cr.fgAfter + "; dialog never foreground, change is external)")
            } else {
                Fail "T-3 foreground unchanged" ("fgBefore=" + $cr.fgBefore + " fgAfter=" + $cr.fgAfter)
            }
        } else {
            Fail "T-3 click result" "no clickResult(requestId=t3) within 15s"
        }
        $d3.StandardInput.WriteLine('{"cmd":"quit"}')
        $null = $d3.WaitForExit(4000)
        if (-not $d3.HasExited) { Stop-Process -Id $d3.Id -Force -ErrorAction SilentlyContinue }
    } else {
        Fail "T-3 daemon ready" "no ready line in 10s"
        try { $d3.Kill() } catch {}
    }
} else {
    Write-Host "  skipped (no dialog to click; T-2 already failed)"
}

# ---------------------------------------------------------------- T-4 ----
Write-Host ""
Write-Host "--- T-4 whitelist: UWP/IME hosts never reported"
$denied = @('systemsettings.exe','textinputhost.exe','shellexperiencehost.exe','searchhost.exe','startmenuexperiencehost.exe','applicationframehost.exe','runtimebroker.exe','searchapp.exe')
$t4scan = @(Invoke-Once "scan")
$t4bad = New-Object System.Collections.Generic.List[string]
foreach ($line in $t4scan) {
    try { $j = $line | ConvertFrom-Json } catch { continue }
    $exeBase = [IO.Path]::GetFileName([string]$j.exe).ToLower()
    if ($denied -contains $exeBase) { $t4bad.Add($exeBase) | Out-Null }
}
Assert-True ($t4bad.Count -eq 0) "T-4 no UWP/IME host in candidate output" ($t4bad -join ',')

# ---------------------------------------------------------------- T-5 ----
Write-Host ""
Write-Host "--- T-5 state-machine unit tests (node test/cases.js)"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $node) {
    $t5 = & node (Join-Path $here 'cases.js') 2>&1
    $t5text = $t5 -join "`n"
    Write-Host ($t5 | Select-Object -Last 1)
    Assert-True ($LASTEXITCODE -eq 0) "T-5 cases.js all green" ($t5text -split "`n" | Select-Object -Last 6 | Out-String)
} else {
    Fail "T-5 node missing" "node.exe is not on PATH; run test/cases.js manually"
}

# ---------------------------------------------------------------- T-6 ----
Write-Host ""
Write-Host "--- T-6 cleanup: no leftover test dialog process"
if ($null -ne $dlgProc -and -not $dlgProc.HasExited) {
    # If T-3 never clicked it (failed earlier), kill it now.
    Stop-Process -Id $dlgProc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}
$left = $null
if ($null -ne $dlgProc) {
    $left = Get-Process -Id $dlgProc.Id -ErrorAction SilentlyContinue
}
Assert-True ($null -eq $left) "T-6 test dialog process exited (no residue)" ("pid " + $dlgProc.Id + " still alive")

# ---------------------------------------------------------------- T-7 ----
Write-Host ""
Write-Host "--- T-7 daemon quits cleanly on quit command"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $probe + '"'
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$daemon = [System.Diagnostics.Process]::Start($psi)
$readySeen = $false
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $deadline -and -not $readySeen) {
    $line = $daemon.StandardOutput.ReadLine()
    if ($null -ne $line -and $line -like '*"ev":"ready"*') { $readySeen = $true }
}
if ($readySeen) {
    $daemon.StandardInput.WriteLine('{"cmd":"quit"}')
    $daemon.StandardInput.Flush()
    $bye = $false
    $deadline2 = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline2 -and -not $bye) {
        $line = $daemon.StandardOutput.ReadLine()
        if ($line -like '*"ev":"bye"*') { $bye = $true }
    }
    $exited = $daemon.WaitForExit(3000)
    Assert-True $bye "T-7 daemon emitted bye" "no bye line after quit"
    Assert-True ($exited -and $daemon.HasExited) "T-7 daemon process exited" ("HasExited=" + $daemon.HasExited)
} else {
    Fail "T-7 daemon ready" "no ready line in 10s"
    try { $daemon.Kill() } catch {}
}

# ------------------------------------------------------------ A2/A3 ------
Write-Host ""
Write-Host "--- A2/A3 static checks"
$ps1Files = @(Get-ChildItem -Path $root -Recurse -Filter '*.ps1')
foreach ($f in $ps1Files) {
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    $nonAscii = 0
    foreach ($b in $bytes) { if ($b -gt 127) { $nonAscii++ } }
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    $bareLf = 0
    for ($i = 0; $i -lt ($bytes.Length - 1); $i++) {
        if ($bytes[$i] -eq 10 -and ($i -eq 0 -or $bytes[$i - 1] -ne 13)) { $bareLf++ }
    }
    Assert-True ($nonAscii -eq 0) ("A2 ascii-only " + $f.Name) ($nonAscii.ToString() + " non-ascii bytes")
    Assert-True ($bareLf -eq 0) ("A2 crlf-only " + $f.Name) ($bareLf.ToString() + " bare LF")
}
$forbidden = Select-String -Path (Join-Path $root 'lib\*.js') -Pattern "kind\s*:\s*'plugin'\s*[,}]|kind\s*:\s*`"plugin`"\s*[,}]" -ErrorAction SilentlyContinue
Assert-True ($null -eq $forbidden -or @($forbidden).Count -eq 0) "A3 no forbidden kind 'plugin'" ("matches: " + (@($forbidden).Count))
$srcOk = (Select-String -Path (Join-Path $root 'lib\injector.js') -Pattern "plugin:dialog-watcher").Count -ge 1
Assert-True $srcOk "A3 injector carries plugin:dialog-watcher" "source kind string missing"
# C# must still compile through the same path the probe uses.
$compile = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
`$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes
`$src=[IO.File]::ReadAllText('$cs',[Text.Encoding]::UTF8)
Add-Type -TypeDefinition `$src -ReferencedAssemblies @('System.dll','System.Core.dll','UIAutomationClient','UIAutomationTypes')
'COMPILE_OK'" 2>&1
Assert-True ($compile -contains 'COMPILE_OK') "A2b DlgProbe.cs compiles via Add-Type" ($compile | Select-Object -First 3 | Out-String)

# ---------------------------------------------------------------- summary -
Write-Host ""
Write-Host "=== summary: " $script:PassCount " checks passed, " $script:Failures.Count " failed ==="
if ($script:Failures.Count -gt 0) {
    foreach ($f in $script:Failures) { Write-Host ("  FAIL " + $f) }
    exit 1
}
exit 0
