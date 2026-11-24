// Owns user-level systemd registration. Foreground mode remains available without systemd.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writePrivateFile } = require('./private-state');
const UNIT_NAME = 'remodex-bridge.service';

function quoteUnit(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Service paths cannot contain control characters.');
  const escaped = String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return `"${escaped}"`;
}

function buildSystemdUnit({ nodePath, entryPath, stateDir }) {
  // Single-path directives do not tokenize/unquote values like ExecStart does.
  const conditionPath = (value) => {
    if (/[\r\n\0]/.test(value) || value.endsWith('\\')) throw new Error('Unsupported systemd condition path.');
    return String(value).replaceAll('%', '%%');
  };
  return `[Unit]
Description=Remodex local bridge
StartLimitIntervalSec=120
StartLimitBurst=3
ConditionPathExists=${conditionPath(nodePath)}
ConditionPathExists=${conditionPath(entryPath)}
ConditionPathExists=${conditionPath(path.join(stateDir, 'daemon-config.json'))}

[Service]
Type=simple
WorkingDirectory=~
ExecStart=:${[nodePath, entryPath, stateDir].map(quoteUnit).join(' ')}
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=default.target
`;
}

function createLinuxService({ env = process.env, fsImpl = fs, osImpl = os, execFileSyncImpl = execFileSync, ...launch } = {}) {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || osImpl.homedir(), '.config');
  const definitionPath = path.join(configHome, 'systemd', 'user', UNIT_NAME);
  function systemctl(args) {
    try {
      return execFileSyncImpl('systemctl', ['--user', ...args], { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }) || '';
    } catch (error) {
      const detail = String(error.stderr || error.message || '').trim();
      throw new Error(`Unable to manage the systemd user service. Use \`remodex run\` when systemd or a user session is unavailable. ${detail}`);
    }
  }
  return {
    kind: 'systemd', definitionPath,
    install() {
      systemctl(['show-environment']);
      writePrivateFile(definitionPath, buildSystemdUnit(launch), { fsImpl });
      systemctl(['daemon-reload']);
      systemctl(['enable', UNIT_NAME]);
    },
    start() {
      if (systemctl(['show', UNIT_NAME, '--property=ActiveState', '--value']).trim() === 'failed') {
        systemctl(['reset-failed', UNIT_NAME]);
      }
      systemctl(['start', UNIT_NAME]);
    },
    stop() { if (fsImpl.existsSync(definitionPath)) systemctl(['stop', UNIT_NAME]); },
    remove() {
      const removed = fsImpl.existsSync(definitionPath);
      if (removed) {
        systemctl(['disable', UNIT_NAME]);
        fsImpl.rmSync(definitionPath);
        systemctl(['daemon-reload']);
      }
      return { removed, definitionPath };
    },
    status() {
      const installed = fsImpl.existsSync(definitionPath);
      if (!installed) return { installed: false, running: false };
      const output = systemctl(['show', UNIT_NAME, '--property=ActiveState,MainPID', '--no-pager']);
      return { installed, running: /^ActiveState=active$/m.test(output), pid: Number(output.match(/^MainPID=(\d+)$/m)?.[1]) || null };
    },
  };
}

module.exports = { buildSystemdUnit, createLinuxService };
