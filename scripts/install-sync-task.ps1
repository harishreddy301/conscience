<#
.SYNOPSIS
  Optional: registers 'conscience-sync', which runs `claude -p "/track"` a few times a day.

.DESCRIPTION
  The primary way to sync Gmail/Calendar is `/loop 2h /track` inside a running Claude Code
  session. This task is the fallback for days without a session. It runs headless
  (conhost --headless) as the current user, only when logged on, and appends output to
  <JhHome>\logs\sync.log.

  The Gmail and Calendar connectors must be available to headless `claude -p` runs.
  If they are not, the email-tracker / calendar-sync agents record
  `jh sync end <run> --error connector_unavailable` and the dashboard shows a red chip.

.PARAMETER Times
  Local times (HH:mm) to run each day. Default 05:15, 12:30, 18:30.
.PARAMETER AllowedTools
  Value for claude --allowedTools. Grant the Gmail/Calendar connector tools here once
  their names are verified (e.g. add the connector's mcp__ prefix).
.PARAMETER Uninstall
  Remove the task instead.
#>
[CmdletBinding()]
param(
	[string[]]$Times = @("05:15", "12:30", "18:30"),
	[string]$AllowedTools = "Bash(node:*),Read,Write,Glob,Grep",
	[string]$JhHome = $(if ($env:JOB_HUNTER_HOME) { $env:JOB_HUNTER_HOME } else { Join-Path $env:USERPROFILE ".job-hunter" }),
	[switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "conscience-sync"

if ($Uninstall) {
	if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
		Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
		Write-Host "Removed task '$TaskName'"
	} else {
		Write-Host "Task '$TaskName' not installed"
	}
	exit 0
}

foreach ($t in $Times) {
	if ($t -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "Invalid time '$t' (use HH:mm, 24h)" }
}

$repo = Split-Path -Parent $PSScriptRoot
$claude = (Get-Command claude -ErrorAction Stop).Source
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$JhHome = [System.IO.Path]::GetFullPath($JhHome)
$logDir = Join-Path $JhHome "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "sync.log"

# Single quotes inside the -Command string; paths are quoted for spaces.
$cmd = "Set-Location -LiteralPath '$repo'; " +
	"Add-Content -LiteralPath '$log' -Value ('=== ' + (Get-Date -Format o)); " +
	"& '$claude' -p '/track' --allowedTools '$AllowedTools' *>> '$log'"
$action = New-ScheduledTaskAction -Execute $conhost `
	-Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `"$cmd`"" `
	-WorkingDirectory $repo

$triggers = foreach ($t in $Times) { New-ScheduledTaskTrigger -Daily -At $t }
$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
	-ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
	-MultipleInstances IgnoreNew `
	-StartWhenAvailable `
	-AllowStartIfOnBatteries `
	-DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
	-Description "conscience: run /track (Gmail + Calendar sync) at $($Times -join ', ')" -Force | Out-Null
Write-Host "Registered '$TaskName' at $($Times -join ', ') (claude: $claude, log: $log)"
exit 0
