#!/usr/bin/env node
// Task Scheduler/systemd entrypoint. Restore the installing user's environment before loading the bridge.
const fs = require('node:fs');
const path = require('node:path');
const { protectPrivatePath } = require('./private-state');

async function runServiceEntry({ stateDir = process.argv[2], processImpl = process } = {}) {
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('An absolute Remodex state directory is required.');
  processImpl.env.REMODEX_DEVICE_STATE_DIR = stateDir;
  const manifestPath = path.join(stateDir, 'service-environment.json');
  // Removing the CLI or configuration must not create an unbounded restart loop.
  if (!fs.existsSync(manifestPath) || !fs.existsSync(path.join(stateDir, 'daemon-config.json'))) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !path.isAbsolute(manifest.cwd)) throw new Error('Invalid Remodex service environment. Run `remodex start` to repair it.');
  const { SERVICE_ENV_KEYS } = require('./native-bridge-service');
  for (const key of SERVICE_ENV_KEYS) {
    if (typeof manifest.environment?.[key] === 'string') processImpl.env[key] = manifest.environment[key];
  }
  processImpl.env.REMODEX_DEVICE_STATE_DIR = stateDir;
  processImpl.chdir(manifest.cwd);
  const logs = path.join(stateDir, 'logs');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  for (const [stream, filename] of [[processImpl.stdout, 'bridge.stdout.log'], [processImpl.stderr, 'bridge.stderr.log']]) {
    const logPath = path.join(logs, filename);
    const fd = fs.openSync(logPath, 'a', 0o600);
    protectPrivatePath(logPath);
    stream.write = (chunk, encoding, callback) => {
      if (typeof encoding === 'function') callback = encoding;
      fs.writeSync(fd, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      if (callback) callback();
      return true;
    };
  }
  return await require('./service-runner').runBridgeService({ env: processImpl.env, processImpl });
}

if (require.main === module) {
  void runServiceEntry().catch((error) => { console.error(`[remodex] ${error.message}`); process.exitCode = 1; });
}
module.exports = { runServiceEntry };
