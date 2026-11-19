// Owns a per-user Task Scheduler task. It runs only in that user's interactive logon session.
const os = require('node:os');
const { createHash } = require('node:crypto');
const { powershellData, runPowerShell } = require('./powershell');
const { windowsSystemTool } = require('./codex-launch');


function buildWindowsTaskAction(config) {
  const source = `${powershellData({ nodePath: config.nodePath, entryPath: config.entryPath, stateDir: config.stateDir })}
    if (-not (Test-Path -LiteralPath $data.nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $data.entryPath -PathType Leaf)) { exit 0; }
    & $data.nodePath $data.entryPath $data.stateDir;
    exit $LASTEXITCODE;
  `;
  // Task Scheduler expands %NAME% in action properties. Only system paths and base64 go there.
  return {
    execute: windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe', process.env),
    arguments: '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(source, 'utf16le').toString('base64'),
  };
}

function buildWindowsTaskScript(action, config) {
  const data = { ...config, action: buildWindowsTaskAction(config) };
  const prefix = `${powershellData(data)}\n$task = Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq $data.taskName };\n`;
  if (action === 'install') return `${prefix}
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user;
    $action = New-ScheduledTaskAction -Execute $data.action.execute -Argument $data.action.arguments;
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;
    Register-ScheduledTask -TaskPath '\\' -TaskName $data.taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null;
  `;
  if (action === 'start') return `${prefix} if (-not $task) { throw 'Remodex task is not installed.' }; Start-ScheduledTask -InputObject $task;`;
  if (action === 'stop') return `${prefix} if ($task) { Stop-ScheduledTask -InputObject $task; }`;
  if (action === 'remove') return `${prefix} if ($task) { Unregister-ScheduledTask -InputObject $task -Confirm:$false; }; @{removed=[bool]$task} | ConvertTo-Json -Compress;`;
  if (action === 'status') return `${prefix} @{installed=[bool]$task; running=([bool]$task -and $task.State -eq 'Running')} | ConvertTo-Json -Compress;`;
  throw new Error(`Unsupported task action: ${action}`);
}

function createWindowsService({ env = process.env, osImpl = os, execFileSyncImpl, ...launch } = {}) {
  const user = `${env.USERDOMAIN || ''}\\${env.USERNAME || osImpl.userInfo().username}`;
  const taskName = 'Remodex-Bridge-' + createHash('sha256').update(user.toLowerCase()).digest('hex').slice(0, 12);
  const invoke = (action) => runPowerShell(buildWindowsTaskScript(action, { ...launch, taskName }), { execFileSyncImpl });
  return {
    kind: 'scheduled-task', definitionPath: taskName,
    install() { invoke('install'); },
    start() { invoke('start'); },
    stop() { invoke('stop'); },
    remove() { return { ...JSON.parse(invoke('remove')), definitionPath: taskName }; },
    status() { return JSON.parse(invoke('status')); },
  };
}

module.exports = { buildWindowsTaskAction, buildWindowsTaskScript, createWindowsService };
