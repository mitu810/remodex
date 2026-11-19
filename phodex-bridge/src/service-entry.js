#!/usr/bin/env node
// Task Scheduler/systemd entrypoint. Restore the installing user's environment before loading the bridge.
const fs = require('node:fs');
const path = require('node:path');
const { protectPrivatePath } = require('./private-state');

function restoreServiceEnvironment(stateDir, processImpl) {
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('An absolute Remodex state directory is required.');
  processImpl.env.REMODEX_DEVICE_STATE_DIR = stateDir;
  const manifestPath = path.join(stateDir, 'service-environment.json');
  // Removing the CLI or configuration must not create an unbounded restart loop.
  if (!fs.existsSync(manifestPath) || !fs.existsSync(path.join(stateDir, 'daemon-config.json'))) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !path.isAbsolute(manifest.cwd)) throw new Error('Invalid Remodex service environment. Run `remodex start` to repair it.');
  const { SERVICE_ENV_KEYS } = require('./native-bridge-service');
  for (const key of SERVICE_ENV_KEYS) {
    if (typeof manifest.environment?.[key] === 'string') processImpl.env[key] = manifest.environment[key];
  }
  processImpl.env.REMODEX_DEVICE_STATE_DIR = stateDir;
  processImpl.chdir(manifest.cwd);
  return true;
}

async function runServiceEntry({
  stateDir = process.argv[2], processImpl = process, scheduleBridgeUpdate, onStatus,
} = {}) {
  if (!restoreServiceEnvironment(stateDir, processImpl)) return null;
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
  return await require('./service-runner').runBridgeService({
    env: processImpl.env, processImpl, scheduleBridgeUpdate, onStatus,
  });
}

async function runWorker(stateDir) {
  const { supportsBridgeReleaseArchive } = require('./bridge-release');
  let pending;
  let ready = false;
  let stopping = false;
  const runner = runServiceEntry({
    stateDir,
    scheduleBridgeUpdate: supportsBridgeReleaseArchive() ? requestUpdate : undefined,
    onStatus(status) {
      const connected = status?.state === 'running' && status.connectionStatus === 'connected';
      if (connected === ready) return;
      ready = connected;
      if (process.connected) process.send({ kind: 'status', ready }, () => {});
    },
  });

  function requestUpdate() {
    if (pending || !process.connected || stopping) {
      throw new Error('The bridge supervisor is busy or is no longer connected.');
    }
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      process.send({ kind: 'update' }, (error) => {
        if (!error) return;
        pending = null;
        reject(error);
      });
    });
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    pending?.reject(new Error('The bridge worker is stopping.'));
    pending = null;
    try {
      await (await runner)?.stop();
      process.exit(0);
    } catch (error) {
      console.error(`[remodex] ${error.message}`);
      process.exit(1);
    }
  }

  process.on('message', (message) => {
    if (message?.kind === 'stop') void stop();
    if (message?.kind !== 'updateResult' || !pending) return;
    const reply = pending;
    pending = null;
    if (message.error) reply.reject(new Error(message.error));
    else reply.resolve(message.version);
  });
  process.once('disconnect', () => { void stop(); });
  if (!await runner) void stop();
}

async function main(stateDir = process.argv[2], mode = process.argv[3]) {
  if (mode === '--worker' && process.send) return runWorker(stateDir);
  if (!restoreServiceEnvironment(stateDir, process)) return;
  const { runNativeServiceSupervisor } = require('./native-service-supervisor');
  process.exitCode = await runNativeServiceSupervisor({ stateDir, entryPath: __filename });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[remodex] ${error.message}`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}
module.exports = { runServiceEntry };
