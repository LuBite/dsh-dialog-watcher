# dialog_probe.ps1 - resident blocking-dialog probe for dsh-dialog-watcher.
#
# Pure ASCII on purpose: PowerShell 5.1 decodes BOM-less files as ANSI/GBK,
# so any non-ASCII literal here would corrupt the source. All Chinese button
# labels and SmartScreen markers live in DlgProbe.cs as \u escapes; this file
# only passes ASCII intents through.
#
# Modes:
#   daemon (default):  powershell -NoProfile -ExecutionPolicy Bypass -File dialog_probe.ps1
#                      Emits one JSON event per stdout line, accepts one JSON
#                      command per stdin line, exits cleanly on {"cmd":"quit"}
#                      or stdin EOF.
#   one-shot:          -Once scan | -Once scan-all | -Once '{"cmd":"click",...}'
param(
    [int]$BusyMs = 1500,
    [int]$IdleMs = 5000,
    [string]$Once = ""
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$csPath = Join-Path $PSScriptRoot 'DlgProbe.cs'
if (-not (Test-Path $csPath)) {
    Write-Error "DlgProbe.cs not found next to dialog_probe.ps1"
    exit 3
}

# ReadAllText with explicit UTF8: Add-Type -TypeDefinition compiles in-proc
# and the C# file is pure ASCII, so the encoding choice only guards against
# a mangled deployment.
$csSource = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
# Load the UIA assemblies first, then compile against them by short name
# (a ".dll" suffix makes Add-Type look for a literal file path and fail).
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$refs = @('System.dll', 'System.Core.dll', 'UIAutomationClient', 'UIAutomationTypes')
try {
    Add-Type -TypeDefinition $csSource -ReferencedAssemblies $refs | Out-Null
} catch {
    # A previous compile of the same namespace in this session is harmless.
    if ($_.Exception.Message -notmatch 'already exists|type .* already') { throw }
}

if ($Once -ne '') {
    [DlgKit.Probe]::Once($Once)
    try { [Console]::Out.Flush() } catch {}
    exit 0
}

[DlgKit.Probe]::Daemon($BusyMs, $IdleMs)
exit 0
