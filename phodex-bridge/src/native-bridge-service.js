// Coordinates shared daemon state around native Windows/Linux service adapters.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readBridgeConfig } = require('./codex-desktop-refresher');
const state = require('./daemon-state');
const { ensurePrivateDirectory, writePrivateFile } = require('./private-state');
const { printQR } = require('./qr');
const SERVICE_ENV_KEYS = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'REMODEX_CODEX_COMMAND', 'REMODEX_DEVICE_STATE_FILE'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createNativeBridgeService({
  platform = process.platform, env = process.env, backend, fsImpl = fs, osImpl = os,
  execFileSyncImpl, nodePath = process.execPath,
  entryPath = path.join(__dirname, 'service-entry.js'),
  now = Date.now, sleep = delay, stopTimeoutMs = 5000, pairingTimeoutMs = 15000,
} = {}) {
  if (!['linux', 'win32'].includes(platform)) throw new Error(`Unsupported native host platform: ${platform}`);
  const stateDir = path.resolve(state.resolveRemodexStateDir({ env, osImpl }));
  env = { ...env, REMODEX_DEVICE_STATE_DIR: stateDir };
  const options = { env, fsImpl, osImpl };
  const homeDir = platform === 'win32' ? env.USERPROFILE || osImpl.homedir() : env.HOME || osImpl.homedir();
  const manifestPath = path.join(stateDir, 'service-environment.json');
  const lockPath = path.join(stateDir, 'service-lock.json');
  backend ||= (platform === 'win32' ? require('./windows-service').createWindowsService : require('./linux-service').createLinuxService)({ env, fsImpl, osImpl, execFileSyncImpl, nodePath, entryPath, stateDir, homeDir });
  const privateOptions = { fsImpl, platform, execFileSyncImpl };

  async function start({ waitForPairing = false } = {}) {
    ensurePrivateDirectory(stateDir, privateOptions);
    const saved = state.readDaemonConfig(options);
    const computed = readBridgeConfig({ env, platform, fsImpl });
    const config = { ...computed, ...saved };
    const explicitSettings = {
      relayUrl: ['REMODEX_RELAY', 'PHODEX_RELAY'], pushServiceUrl: ['REMODEX_PUSH_SERVICE_URL'],
      codexEndpoint: ['REMODEX_CODEX_ENDPOINT', 'PHODEX_CODEX_ENDPOINT'],
      codexEndpointInitialize: ['REMODEX_CODEX_ENDPOINT_INITIALIZE'], codexEndpointMethods: ['REMODEX_CODEX_ENDPOINT_METHODS'],
      refreshEnabled: ['REMODEX_REFRESH_ENABLED'], refreshCommand: ['REMODEX_REFRESH_COMMAND', 'PHODEX_ON_PHONE_MESSAGE'],
      keepMacAwakeEnabled: ['REMODEX_KEEP_MAC_AWAKE'], desktopIpcSocketPath: ['REMODEX_DESKTOP_IPC_SOCKET'],
      desktopIpcLiveSyncEnabled: ['REMODEX_DESKTOP_IPC_LIVE_SYNC'], desktopAutoFollowEnabled: ['REMODEX_DESKTOP_AUTO_FOLLOW'],
      desktopIpcSnapshotDebounceMs: ['REMODEX_DESKTOP_IPC_SNAPSHOT_DEBOUNCE_MS'],
      refreshDebounceMs: ['REMODEX_REFRESH_DEBOUNCE_MS'], pushPreviewMaxChars: ['REMODEX_PUSH_PREVIEW_MAX_CHARS'],
      codexBundleId: ['REMODEX_CODEX_BUNDLE_ID'], codexAppPath: ['REMODEX_CODEX_APP_PATH'],
    };
    for (const [field, names] of Object.entries(explicitSettings)) {
      if (names.some((name) => env[name] !== undefined)) config[field] = computed[field];
    }
    if (!config.relayUrl) throw new Error('No relay URL configured. Set REMODEX_RELAY to your local relay before running `remodex up`.');
    // Stop before replacing runtime state: a second `up` must not discard a running QR or trust.
    if (backend.status?.().running) await stop();
    // The management lock serializes lifecycle writes; runtime ownership also prevents
    // replacing state while a separately launched foreground bridge is still active.
    const preflight = await require('./service-runner').acquireServiceLock({ env, fsImpl });
    await preflight.release();
    writePrivateFile(state.resolveDaemonConfigPath(options), JSON.stringify(config, null, 2), privateOptions);
    let previousEnvironment = {};
    if (fsImpl.existsSync(manifestPath)) previousEnvironment = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8')).environment || {};
    const environment = Object.fromEntries(SERVICE_ENV_KEYS.filter((key) => typeof (env[key] ?? previousEnvironment[key]) === 'string').map((key) => [key, env[key] ?? previousEnvironment[key]]));
    writePrivateFile(manifestPath, JSON.stringify({ version: 1, cwd: homeDir, environment }, null, 2), privateOptions);
    backend.install();
    state.clearPairingSession(options);
    state.clearBridgeStatus(options);
    const startedAt = now();
    backend.start();
    let pairingSession = null;
    if (waitForPairing) {
      const deadline = startedAt + pairingTimeoutMs;
      while (now() < deadline) {
        const status = state.readBridgeStatus(options);
        if (status?.state === 'error' && status.lastError) throw new Error(status.lastError);
        pairingSession = state.readLivePairingSession({ ...options, startedAt, now });
        if (pairingSession) break;
        await sleep(200);
      }
      if (!pairingSession) throw new Error('The bridge did not publish a fresh pairing QR. Run `remodex status` and inspect the service logs.');
    }
    return { definitionPath: backend.definitionPath, pairingSession };
  }

  async function stop() {
    let lock;
    try { lock = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (lock?.instanceId) {
      writePrivateFile(path.join(stateDir, 'service-stop.json'), JSON.stringify({ instanceId: lock.instanceId }), privateOptions);
      const deadline = now() + stopTimeoutMs;
      while (fsImpl.existsSync(lockPath) && now() < deadline) await sleep(100);
    }
    // The system manager owns the task/control group; never kill an arbitrary persisted PID.
    backend.stop();
    const deadline = now() + stopTimeoutMs;
    while (true) {
      try {
        const ownership = await require('./service-runner').acquireServiceLock({ env, fsImpl });
        await ownership.release();
        break;
      } catch (error) {
        if (error.code !== 'REMODEX_ALREADY_RUNNING') throw error;
        if (now() >= deadline) throw new Error('The bridge did not stop and is still running. Saved pairing has not been reset.');
        await sleep(100);
      }
    }
    state.clearPairingSession(options);
    state.clearBridgeStatus(options);
    fsImpl.rmSync(path.join(stateDir, 'service-stop.json'), { force: true });
  }

  function status() {
    const serviceStatus = backend.status();
    let bridgeStatus = state.readBridgeStatus(options);
    if (bridgeStatus && (!serviceStatus.running || !(now() - Date.parse(bridgeStatus.updatedAt) < 45000))) {
      bridgeStatus = { ...bridgeStatus, state: serviceStatus.running ? 'unknown' : 'stopped', connectionStatus: 'disconnected' };
    }
    return { label: backend.definitionPath, platform, serviceKind: backend.kind, ...serviceStatus, daemonConfig: state.readDaemonConfig(options), bridgeStatus, pairingSession: serviceStatus.running ? state.readPairingSession(options) : null, stdoutLogPath: state.resolveBridgeStdoutLogPath(options), stderrLogPath: state.resolveBridgeStderrLogPath(options) };
  }

  async function managed(operation) {
    const ownership = await require('./service-runner').acquireServiceLock({ env, fsImpl, scope: 'management' });
    try { return await operation(); } finally { await ownership.release(); }
  }

  function readPairingSession() {
    return backend.status().running ? state.readLivePairingSession({ ...options, now }) : null;
  }

  return {
    start: (options) => managed(() => start(options)),
    stop: () => managed(stop), status,
    restart: (options) => managed(async () => { await stop(); return start(options); }),
    uninstall: () => managed(async () => { await stop(); return backend.remove(); }),
    resetPairing: () => managed(async () => {
      await stop();
      const installed = fsImpl.existsSync(manifestPath) ? JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8')).environment : {};
      return require('./secure-device-state').resetBridgeTrustState({ env: { ...env, REMODEX_DEVICE_STATE_FILE: installed?.REMODEX_DEVICE_STATE_FILE || env.REMODEX_DEVICE_STATE_FILE } });
    }),
    readPairingSession,
    printPairingQr({ pairingSession, includeCopyableCode = false } = {}) {
      pairingSession ||= readPairingSession();
      if (!pairingSession?.pairingPayload || pairingSession.pairingPayload.expiresAt <= now()) throw new Error('No live pairing QR is available. Run `remodex qr --refresh` for a new invitation.');
      printQR(pairingSession, { includeCopyableCode });
    },
    printStatus() {
      const current = status();
      console.log(`[remodex] Service: ${current.serviceKind}`);
      console.log(`[remodex] Installed: ${current.installed ? 'yes' : 'no'}`);
      console.log(`[remodex] Running: ${current.running ? 'yes' : 'no'}`);
      console.log(`[remodex] Connection: ${current.bridgeStatus?.connectionStatus || 'unknown'}`);
      if (current.bridgeStatus?.lastError) console.log(`[remodex] Error: ${current.bridgeStatus.lastError}`);
      console.log(`[remodex] Stdout log: ${current.stdoutLogPath}`);
      console.log(`[remodex] Stderr log: ${current.stderrLogPath}`);
    },
  };
}

module.exports = { createNativeBridgeService, SERVICE_ENV_KEYS };
