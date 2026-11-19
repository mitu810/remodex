// Shared daemon hooks, per-state-directory ownership and graceful local stop requests.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { resolveRemodexStateDir, readDaemonConfig, readBridgeStatus, writeBridgeStatus, writePairingSession, clearPairingSession } = require('./daemon-state');
const { ensurePrivateDirectory } = require('./private-state');

async function acquireServiceLock({ env = process.env, processImpl = process, fsImpl = fs, scope = 'bridge' } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 8)) throw new Error('Native bridge services require Node.js 20.8 or newer.');
  const directory = resolveRemodexStateDir({ env });
  ensurePrivateDirectory(directory, { fsImpl });
  const { createServer, createConnection } = require('node:net');
  const { createHash } = require('node:crypto');
  const os = require('node:os');
  const canonical = fsImpl.realpathSync(directory);
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const key = createHash('sha256').update(`${scope}:${identity}`).digest('hex').slice(0, 32);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\remodex-${key}`
    : process.platform === 'linux' ? `\0remodex-${process.getuid()}-${key}`
    : path.join(os.tmpdir(), `remodex-${process.getuid()}-${key}.sock`);
  const lockPath = path.join(directory, scope === 'bridge' ? 'service-lock.json' : 'service-management-lock.json');
  const instanceId = randomUUID();
  const server = createServer((socket) => socket.destroy());
  const listen = () => new Promise((resolve, reject) => {
    const failed = (error) => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed).once('listening', ready).listen(address);
  });
  try { await listen(); }
  catch (error) {
    // Filesystem Unix sockets may outlive a crash. Native Linux uses abstract sockets;
    // Windows pipes disappear with their owner. macOS service ownership stays with launchd.
    if (process.platform === 'darwin' && error.code === 'EADDRINUSE') {
      const stale = await new Promise((resolve) => {
        const socket = createConnection(address);
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('error', (probe) => resolve(probe.code === 'ECONNREFUSED' || probe.code === 'ENOENT'));
      });
      if (stale) { fsImpl.rmSync(address, { force: true }); await listen(); }
      else throw Object.assign(new Error('A Remodex bridge or service operation is already running for this state directory.'), { code: 'REMODEX_ALREADY_RUNNING' });
    } else if (error.code === 'EADDRINUSE') {
      throw Object.assign(new Error('A Remodex bridge or service operation is already running for this state directory.'), { code: 'REMODEX_ALREADY_RUNNING' });
    } else throw error;
  }
  server.unref();
  const { writePrivateFile } = require('./private-state');
  try { writePrivateFile(lockPath, JSON.stringify({ pid: processImpl.pid, instanceId }), { fsImpl }); }
  catch (error) { server.close(); throw error; }
  let released = false;
  return {
    path: lockPath, instanceId,
    release() {
      if (released) return;
      released = true;
      try {
        if (JSON.parse(fsImpl.readFileSync(lockPath, 'utf8')).instanceId === instanceId) fsImpl.rmSync(lockPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function runBridgeService({ env = process.env, processImpl = process, startBridgeImpl, useLock = true, missingConfigMessage = 'No relay URL configured for the bridge service.' } = {}) {
  const config = readDaemonConfig({ env });
  if (!config?.relayUrl) {
    clearPairingSession({ env });
    writeBridgeStatus({ state: 'error', connectionStatus: 'error', pid: processImpl.pid, lastError: missingConfigMessage }, { env });
    console.error(`[remodex] ${missingConfigMessage}`);
    return null;
  }
  return launch();
  async function launch() {
    const lock = useLock ? await acquireServiceLock({ env, processImpl }) : null;
    const stopPath = path.join(resolveRemodexStateDir({ env }), 'service-stop.json');
    let stopRequested = false;
    const stopTimer = lock ? setInterval(() => {
      if (stopRequested) return;
      try {
        if (JSON.parse(fs.readFileSync(stopPath, 'utf8')).instanceId !== lock.instanceId) return;
        stopRequested = true;
        processImpl.emit('SIGTERM');
      } catch (error) { if (error.code !== 'ENOENT') console.error('[remodex] Could not read the local service stop request.'); }
    }, 250) : null;
    stopTimer?.unref();
    const dispose = () => {
      if (stopTimer) clearInterval(stopTimer);
      return lock?.release();
    };
    processImpl.once('exit', dispose);
    try {
      (startBridgeImpl || require('./bridge').startBridge)({
        config, printPairingQr: false,
        onPairingSession(pairing) { writePairingSession(pairing, { env }); },
        onBridgeStatus(status) { writeBridgeStatus(mergeBridgeStatusForDaemon(status, readBridgeStatus({ env })), { env }); },
      });
    } catch (error) { dispose(); throw error; }
    return { dispose };
  }
}

async function runForegroundBridge({ env = process.env, processImpl = process, startBridgeImpl, ...bridgeOptions } = {}) {
  const lock = await acquireServiceLock({ env, processImpl });
  const stopPath = path.join(resolveRemodexStateDir({ env }), 'service-stop.json');
  const timer = setInterval(() => {
    try {
      if (JSON.parse(fs.readFileSync(stopPath, 'utf8')).instanceId === lock.instanceId) processImpl.emit('SIGTERM');
    } catch (error) { if (error.code !== 'ENOENT') console.error('[remodex] Could not read the local stop request.'); }
  }, 250);
  timer.unref();
  const dispose = () => { clearInterval(timer); return lock.release(); };
  processImpl.once('exit', dispose);
  try {
    const bridge = (startBridgeImpl || require('./bridge').startBridge)(bridgeOptions);
    return { stop: async () => { await bridge?.stop(); await dispose(); }, dispose };
  } catch (error) { await dispose(); throw error; }
}

function mergeBridgeStatusForDaemon(nextStatus, persistedStatus) {
  if (!nextStatus || typeof nextStatus !== 'object') return nextStatus;
  if (nextStatus.lastError?.trim() || nextStatus.connectionStatus === 'connected') return nextStatus;
  if (nextStatus.codexLaunchState !== 'starting' || !['starting', 'connecting'].includes(nextStatus.connectionStatus)) return nextStatus;
  const lastError = typeof persistedStatus?.lastError === 'string' ? persistedStatus.lastError.trim() : '';
  return lastError ? { ...nextStatus, lastError } : nextStatus;
}

module.exports = { acquireServiceLock, mergeBridgeStatusForDaemon, runBridgeService, runForegroundBridge };
