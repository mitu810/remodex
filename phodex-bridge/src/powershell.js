// Runs fixed PowerShell source with configuration encoded as data, never shell interpolation.
const { execFileSync } = require('node:child_process');
const { windowsSystemTool } = require('./codex-launch');

function powershellData(value) {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json;`;
}

function runPowerShell(script, { execFileSyncImpl = execFileSync } = {}) {
  return execFileSyncImpl(windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe', process.env), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}

module.exports = { powershellData, runPowerShell };
