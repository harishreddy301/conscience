<#
.SYNOPSIS
  Registers the 'conscience-dashboard' logon task and starts it.

.DESCRIPTION
  Runs dist\dashboard.mjs (supervisor + server) at every logon of the current user,
  hidden via conhost --headless, bound to 127.0.0.1 only. Task Scheduler restarts it
  every minute (999 times) if the supervisor itself dies.

  Called by: jh dashboard install [--port N] [--open-at-logon]
  Undo with: scripts\uninstall-dashboard.ps1  (or jh dashboard uninstall)

.PARAMETER Port
  Local port (default 4777).
.PARAMETER JhHome
  Data directory passed as --home (default: $env:JOB_HUNTER_HOME or ~\.job-hunter).
.PARAMETER OpenAtLogon
  Also register 'conscience-dashboard-open', which opens the dashboard in the default
  browser shortly after logon.
#>
[CmdletBinding()]
param(
	[ValidateRange(1, 65535)][int]$Port = 4777,
	[string]$JhHome = $(if ($env:JOB_HUNTER_HOME) { $env:JOB_HUNTER_HOME } else { Join-Path $env:USERPROFILE ".job-hunter" }),
	[switch]$OpenAtLogon
)

$ErrorActionPreference = "Stop"
$TaskName = "conscience-dashboard"
$OpenTaskName = "conscience-dashboard-open"

$repo = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repo "dist\dashboard.mjs"
if (-not (Test-Path $entry)) {
	throw "Missing $entry. Run 'npm run build' in $repo first."
}
if (-not (Test-Path (Join-Path $repo "dist\dashboard-ui\index.html"))) {
	Write-Warning "dist\dashboard-ui\index.html not found; the API will work but the UI page will return 503 until the build copies dashboard-ui/."
}

# Absolute node path, so the task does not depend on PATH at logon.
$node = (Get-Command node -ErrorAction Stop).Source
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$JhHome = [System.IO.Path]::GetFullPath($JhHome)
New-Item -ItemType Directory -Force -Path (Join-Path $JhHome "logs") | Out-Null

$user = "$env:USERDOMAIN\$env:USERNAME"
$argLine = "--headless `"$node`" --disable-warning=ExperimentalWarning `"$entry`" --port $Port --home `"$JhHome`""

$action = New-ScheduledTaskAction -Execute $conhost -Argument $argLine -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
	-RestartCount 999 `
	-RestartInterval (New-TimeSpan -Minutes 1) `
	-ExecutionTimeLimit ([TimeSpan]::Zero) `
	-MultipleInstances IgnoreNew `
	-AllowStartIfOnBatteries `
	-DontStopIfGoingOnBatteries `
	-StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
	-Description "conscience job-hunt dashboard on http://127.0.0.1:$Port (study clock, interviews, pipeline)" -Force | Out-Null
Write-Host "Registered task '$TaskName' (node: $node, port: $Port, home: $JhHome)"

if ($OpenAtLogon) {
	$url = "http://127.0.0.1:$Port/"
	$openCmd = "Start-Sleep -Seconds 15; Start-Process '$url'"
	$openAction = New-ScheduledTaskAction -Execute $conhost `
		-Argument "--headless powershell.exe -NoProfile -NonInteractive -Command `"$openCmd`""
	$openSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
	Register-ScheduledTask -TaskName $OpenTaskName -Action $openAction -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
		-Principal $principal -Settings $openSettings -Description "Open the conscience dashboard after logon" -Force | Out-Null
	Write-Host "Registered task '$OpenTaskName' (opens $url after logon)"
} elseif (Get-ScheduledTask -TaskName $OpenTaskName -ErrorAction SilentlyContinue) {
	Unregister-ScheduledTask -TaskName $OpenTaskName -Confirm:$false
	Write-Host "Removed task '$OpenTaskName' (no -OpenAtLogon)"
}

# (Re)start now and wait for /healthz.
$state = (Get-ScheduledTask -TaskName $TaskName).State
if ($state -eq "Running") { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 1 }
Start-ScheduledTask -TaskName $TaskName

$health = "http://127.0.0.1:$Port/healthz"
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
	try {
		$r = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2
		if ($r.StatusCode -eq 200) {
			Write-Host "Dashboard is up: http://127.0.0.1:$Port/"
			exit 0
		}
	} catch {
		Start-Sleep -Milliseconds 700
	}
}
Write-Warning "Task registered but $health did not answer within 25s. See $(Join-Path $JhHome 'logs\dashboard.log')."
exit 1
