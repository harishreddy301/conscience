<#
.SYNOPSIS
  Stops and removes the 'conscience-dashboard' (and '-open') logon tasks.

.DESCRIPTION
  Called by: jh dashboard uninstall
  Also stops any node process still running dist\dashboard.mjs from this checkout.
  Data in ~\.job-hunter is never touched.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$names = @("conscience-dashboard", "conscience-dashboard-open")
$repo = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repo "dist\dashboard.mjs"

foreach ($name in $names) {
	$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
	if (-not $task) { Write-Host "Task '$name' not installed"; continue }
	if ($task.State -eq "Running") { Stop-ScheduledTask -TaskName $name }
	Unregister-ScheduledTask -TaskName $name -Confirm:$false
	Write-Host "Removed task '$name'"
}

# The supervisor's node child can outlive conhost; stop only our dashboard processes.
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
	Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) }
foreach ($p in $procs) {
	Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
	Write-Host "Stopped node pid $($p.ProcessId)"
}
exit 0
