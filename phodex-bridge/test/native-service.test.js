const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remodex native 中文 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { HOME: root, PATH: '/custom/bin:/usr/bin', REMODEX_DEVICE_STATE_DIR: path.join(root, 'state'), REMODEX_RELAY: 'ws://localhost:9000/relay' } };
}

test('systemd unit preserves literal paths and bounds restart failures without shell expansion', () => {
  const { buildSystemdUnit } = require('../src/linux-service');
  const unit = buildSystemdUnit({ nodePath: '/node %n/$node', entryPath: '/repo/中文 "quote"/service-entry.js', stateDir: '/home/a/.remodex', homeDir: '/home/a' });
  assert.ok(unit.includes('ExecStart=:"/node %%n/$node"'));
  assert.ok(unit.includes('中文 \\"quote\\"'));
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /StartLimitBurst=3/);
  assert.match(unit, /RestartSec=10/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /WantedBy=default.target/);
  assert.match(unit, /^WorkingDirectory=~$/m);
  assert.ok(unit.includes('ConditionPathExists=/repo/中文 "quote"/service-entry.js'));
  assert.equal(unit.includes('/bin/sh'), false);
});

test('Linux systemd parses the generated unit without path or executable errors', { skip: process.platform !== 'linux' }, (t) => {
  const { buildSystemdUnit } = require('../src/linux-service');
  const { root } = fixture(t);
  const unitPath = path.join(root, 'remodex-verify.service');
  const entryPath = path.join(root, 'entry "quote" %n $node.js');
  fs.writeFileSync(entryPath, '');
  const nodePath = path.join(root, 'native $node %n');
  fs.symlinkSync(process.execPath, nodePath);
  fs.writeFileSync(unitPath, buildSystemdUnit({ nodePath, entryPath, stateDir: root, homeDir: root }));
  execFileSync('systemd-analyze', ['verify', unitPath], { encoding: 'utf8', timeout: 10000 });
});

test('Windows task uses an interactive limited user, literal executable paths and bounded restarts', () => {
  const { buildWindowsTaskScript } = require('../src/windows-service');
  const script = buildWindowsTaskScript('install', { taskName: 'Remodex-test', nodePath: 'C:\\Program Files\\Node\\node.exe', entryPath: 'C:\\a & b\\服务\\service-entry.js', stateDir: 'C:\\Users\\a\\.remodex', homeDir: 'C:\\Users\\a' });
  assert.match(script, /-LogonType Interactive/);
  assert.match(script, /-RunLevel Limited/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-RestartCount 3/);
  assert.match(script, /-AtLogOn/);
  assert.match(script, /-StartWhenAvailable/);
  assert.equal(script.includes('C:\\a & b'), false, 'configuration must be encoded data, not PowerShell source');
  assert.equal(script.includes('SYSTEM -'), false);
});

test('Task Scheduler action properties keep percent paths inside encoded launch data', () => {
  const { buildWindowsTaskAction } = require('../src/windows-service');
  const action = buildWindowsTaskAction({ nodePath: 'C:\\%PATH%\\node.exe', entryPath: 'C:\\a & b\\服务\\service-entry.js', stateDir: 'C:\\%USERNAME%\\state', homeDir: 'C:\\%USERNAME%' });
  assert.equal(JSON.stringify(action).includes('%'), false);
  assert.match(action.execute, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  const source = Buffer.from(action.arguments.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(source, /& \$data.nodePath \$data.entryPath \$data.stateDir/);
  const payload = source.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.equal(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).nodePath, 'C:\\%PATH%\\node.exe');
});

test('Windows task launcher executes literal percent and Unicode paths', { skip: process.platform !== 'win32' }, (t) => {
  const { buildWindowsTaskAction, buildWindowsTaskScript } = require('../src/windows-service');
  const { root } = fixture(t);
  const directory = path.join(root, '%PATH% & 服务');
  fs.mkdirSync(directory);
  const nodePath = path.join(directory, 'node.exe');
  fs.copyFileSync(process.execPath, nodePath);
  const entryPath = path.join(directory, 'entry.js');
  const stateDir = path.join(directory, '%USERNAME%');
  fs.writeFileSync(entryPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const action = buildWindowsTaskAction({ nodePath, entryPath, stateDir });
  const encoded = action.arguments.split(' ').at(-1);
  const output = execFileSync(action.execute, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 15000 });
  assert.deepEqual(JSON.parse(output), [stateDir]);
  const script = buildWindowsTaskScript('install', { nodePath, entryPath, stateDir, taskName: 'parse-only' });
  const { runPowerShell, powershellData } = require('../src/powershell');
  runPowerShell(`${powershellData({ script })} $tokens = $null; $errors = $null; [Management.Automation.Language.Parser]::ParseInput($data.script, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { throw ($errors | Out-String); }`);
});

test('Linux start persists a minimal user environment and restart reuses the relay configuration', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { root, env } = fixture(t);
  const calls = [];
  const backend = { kind: 'systemd', definitionPath: path.join(root, 'unit'), install: () => calls.push('install'), start: () => calls.push('start'), stop: () => calls.push('stop'), remove: () => calls.push('remove'), status: () => ({ installed: true, running: false }) };
  const service = createNativeBridgeService({ platform: 'linux', env: { ...env, CODEX_HOME: path.join(root, 'codex'), OPENAI_API_KEY: 'must-not-save', REMODEX_CODEX_COMMAND: '/bin/codex' }, backend });
  await service.start();
  const config = JSON.parse(fs.readFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'daemon-config.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'service-environment.json')));
  assert.equal(config.relayUrl, env.REMODEX_RELAY);
  assert.equal(manifest.environment.PATH, env.PATH);
  assert.equal(manifest.environment.CODEX_HOME, path.join(root, 'codex'));
  assert.equal(manifest.environment.REMODEX_CODEX_COMMAND, '/bin/codex');
  assert.equal(JSON.stringify(manifest).includes('must-not-save'), false);
  assert.equal(manifest.cwd, root);
  await createNativeBridgeService({ platform: 'linux', env: { ...env, REMODEX_RELAY: undefined }, backend }).restart();
  assert.deepEqual(calls, ['install', 'start', 'stop', 'install', 'start']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'daemon-config.json'))).relayUrl, env.REMODEX_RELAY);
});

test('service stop failure does not remove definitions or pairing state', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { env } = fixture(t);
  fs.mkdirSync(env.REMODEX_DEVICE_STATE_DIR);
  fs.writeFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'pairing-session.json'), '{}');
  const backend = { kind: 'systemd', stop: () => { throw new Error('permission denied'); }, remove: () => assert.fail('must not remove after failed stop') };
  const service = createNativeBridgeService({ platform: 'linux', env, backend });
  await assert.rejects(service.uninstall(), /permission denied/);
  assert.ok(fs.existsSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'pairing-session.json')));
});

test('service uninstall preserves saved configuration and identity', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { env } = fixture(t);
  fs.mkdirSync(env.REMODEX_DEVICE_STATE_DIR);
  for (const file of ['device-state.json', 'daemon-config.json', 'pairing-session.json', 'bridge-status.json']) fs.writeFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, file), '{}');
  const calls = [];
  const backend = { kind: 'systemd', stop: () => calls.push('stop'), remove: () => { calls.push('remove'); return { removed: true }; } };
  const result = await createNativeBridgeService({ platform: 'linux', env, backend }).uninstall();
  assert.equal(result.removed, true);
  assert.deepEqual(calls, ['stop', 'remove']);
  assert.ok(fs.existsSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'device-state.json')));
  assert.ok(fs.existsSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'daemon-config.json')));
  assert.equal(fs.existsSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'pairing-session.json')), false);
});

test('service status downgrades stale connected snapshots', (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { env } = fixture(t);
  fs.mkdirSync(env.REMODEX_DEVICE_STATE_DIR);
  fs.writeFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'bridge-status.json'), JSON.stringify({ connectionStatus: 'connected', updatedAt: '2000-01-01T00:00:00Z', pid: 4242 }));
  const backend = { kind: 'systemd', status: () => ({ installed: true, running: false }) };
  const status = createNativeBridgeService({ platform: 'linux', env, backend }).status();
  assert.equal(status.bridgeStatus.connectionStatus, 'disconnected');
  assert.equal(status.running, false);
});

test('daemon instance lock refuses live owners and recovers obsolete PID metadata', async (t) => {
  const { acquireServiceLock } = require('../src/service-runner');
  const { env } = fixture(t);
  const lock = await acquireServiceLock({ env, processImpl: process });
  await assert.rejects(acquireServiceLock({ env, processImpl: process }), /already running/);
  await lock.release();
  fs.writeFileSync(lock.path, JSON.stringify({ pid: process.pid, instanceId: 'old' }));
  const recovered = await acquireServiceLock({ env, processImpl: process });
  assert.notEqual(recovered.instanceId, 'old');
  await recovered.release();
});

test('shared runner publishes fresh pairing and status without printing QR', async (t) => {
  const { runBridgeService } = require('../src/service-runner');
  const { env } = fixture(t);
  fs.mkdirSync(env.REMODEX_DEVICE_STATE_DIR);
  fs.writeFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'daemon-config.json'), JSON.stringify({ relayUrl: env.REMODEX_RELAY }));
  const listeners = new Map();
  const fakeProcess = { pid: process.pid, kill: process.kill.bind(process), once: (event, cb) => listeners.set(event, cb), emit: () => {} };
  const runner = await runBridgeService({ env, processImpl: fakeProcess, startBridgeImpl(options) { assert.equal(options.printPairingQr, false); options.onPairingSession({ pairingPayload: { sessionId: 'secret' } }); options.onBridgeStatus({ state: 'running', connectionStatus: 'connected' }); } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'pairing-session.json'))).pairingPayload.sessionId, 'secret');
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'bridge-status.json'))).connectionStatus, 'connected');
  await runner.dispose();
});

test('service QR waiting rejects expired payloads and accepts only a fresh session', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { writeBridgeStatus, writePairingSession } = require('../src/daemon-state');
  const { env } = fixture(t);
  let clock = 100000;
  let polls = 0;
  const backend = { install() {}, start() { writePairingSession({ pairingPayload: { sessionId: 'expired', expiresAt: clock - 1 } }, { env, now: () => clock }); }, status: () => ({ running: false }) };
  const result = await createNativeBridgeService({ platform: 'linux', env, backend, now: () => clock, sleep: async () => {
    polls++; clock += 200;
    if (polls === 1) writePairingSession({ pairingPayload: { sessionId: 'fresh', expiresAt: clock + 10000 } }, { env, now: () => clock });
    if (polls === 2) writeBridgeStatus({ state: 'running', connectionStatus: 'connected' }, { env, now: () => clock });
  } }).start({ waitForPairing: true });
  assert.equal(polls, 2);
  assert.equal(result.pairingSession.pairingPayload.sessionId, 'fresh');
});

test('a running foreground bridge is not overwritten by a background start', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { acquireServiceLock } = require('../src/service-runner');
  const { env } = fixture(t);
  const lock = await acquireServiceLock({ env });
  t.after(() => lock.release());
  const backend = { status: () => ({ running: false }), install: () => assert.fail('must not install over a foreground bridge') };
  await assert.rejects(createNativeBridgeService({ platform: 'linux', env, backend }).start(), /already running/);
  assert.equal(fs.existsSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'daemon-config.json')), false);
});

test('foreground runs share the daemon ownership lock and release it on startup failure', async (t) => {
  const { runForegroundBridge, acquireServiceLock } = require('../src/service-runner');
  const { env } = fixture(t);
  const processImpl = { ...process, once() {} };
  await assert.rejects(runForegroundBridge({ env, processImpl, startBridgeImpl() { throw new Error('launch failed'); } }), /launch failed/);
  const lock = await acquireServiceLock({ env });
  await lock.release();
  const runner = await runForegroundBridge({ env, processImpl, startBridgeImpl() {} });
  await assert.rejects(acquireServiceLock({ env }), /already running/);
  await runner.dispose();
});

test('library startBridge preserves the original synchronous stop handle contract', () => {
  assert.equal(require('../src').startBridge, require('../src/bridge').startBridge);
});

for (const mode of ['service', 'foreground']) {
test(`native ${mode} runner pairs and stops a real subprocess without OS registration`, { timeout: 15000 }, async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { env, root } = fixture(t);
  const scriptPath = path.join(root, 'fake bridge 服务.cjs');
  const runnerModule = path.resolve(__dirname, '../src/service-runner.js');
  fs.writeFileSync(scriptPath, `
    const { runBridgeService, runForegroundBridge } = require(${JSON.stringify(runnerModule)});
    const state = require(${JSON.stringify(path.resolve(__dirname, '../src/daemon-state.js'))});
    const run = ${mode === 'service' ? 'runBridgeService' : 'runForegroundBridge'};
    run({ startBridgeImpl(options) {
      (options.onPairingSession || state.writePairingSession)({ pairingPayload: { sessionId: 'test-session', expiresAt: Date.now() + 60000 } });
      (options.onBridgeStatus || state.writeBridgeStatus)({ state: 'running', connectionStatus: 'connected', pid: process.pid });
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => process.exit(0));
    }}).catch((error) => { console.error(error); process.exit(1); });
  `);
  let child;
  let closed;
  const backend = {
    install() {},
    start() {
      child = spawn(process.execPath, [scriptPath], { env: { ...process.env, ...env }, stdio: 'pipe' });
      closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code)); });
    },
    stop() {},
    status: () => ({ installed: true, running: Boolean(child && child.exitCode === null) }),
  };
  t.after(() => { if (child && child.exitCode === null) child.kill(); });
  const service = createNativeBridgeService({ platform: 'linux', env, backend });
  const result = await service.start({ waitForPairing: true });
  assert.equal(result.pairingSession.pairingPayload.sessionId, 'test-session');
  // Pairing and status are separate writes. Windows ACL setup can put them several polls apart.
  const deadline = Date.now() + 5000;
  let status;
  do {
    status = service.status().bridgeStatus;
    if (status?.connectionStatus === 'connected') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(status?.connectionStatus, 'connected');
  await service.stop();
  assert.equal(await closed, 0);
  assert.equal(fs.existsSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'service-lock.json')), false);
  assert.equal(fs.existsSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'pairing-session.json')), false);
  assert.ok(fs.existsSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'daemon-config.json')));
});

}

test('service entry exits cleanly after its saved configuration is removed', (t) => {
  const { root } = fixture(t);
  execFileSync(process.execPath, [path.resolve(__dirname, '../src/service-entry.js'), root], { timeout: 5000 });
});

for (const failStartup of [false, true]) {
  test(`an App update ${failStartup ? 'rolls back a failed' : 'replaces a healthy'} native bridge worker`, { timeout: 15_000 }, async (t) => {
    const { fork } = require('node:child_process');
    const { EventEmitter } = require('node:events');
    const { runNativeServiceSupervisor } = require('../src/native-service-supervisor');
    const { updateBridge } = require('../scripts/update-remodex-bridge.cjs');
    const { root } = fixture(t);
    const bridge = path.join(root, 'phodex-bridge');
    const entry = path.join(bridge, 'src', 'service-entry.js');
    const ack = path.join(root, 'update-ack.json');
    const archive = path.join(root, 'verified.zip');
    fs.writeFileSync(path.join(root, 'setup-server.cjs'), '');
    fs.writeFileSync(archive, 'fixture archive');

    function writeBridge(directory, version, broken = false) {
      const src = path.join(directory, 'src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version }));
      fs.writeFileSync(path.join(directory, 'package-lock.json'), '{}');
      fs.writeFileSync(path.join(src, 'bridge.js'), '');
      fs.writeFileSync(path.join(src, 'service-entry.js'), `
        if (require.main === module) {
          if (${broken}) process.exit(23);
          const fs = require('node:fs');
          process.on('message', (message) => {
            if (message.kind === 'stop') process.exit(0);
            if (message.kind === 'updateResult') fs.writeFileSync(${JSON.stringify(ack)}, JSON.stringify(message));
          });
          process.send({ kind: 'status', ready: true, version: ${JSON.stringify(version)} });
        }
      `);
    }

    writeBridge(bridge, '4.0.2');
    fs.mkdirSync(path.join(bridge, 'node_modules'));
    const workers = [];
    const owner = new EventEmitter();
    const proc = { execPath: process.execPath, env: process.env, on: owner.on.bind(owner), off: owner.off.bind(owner) };
    const wait = async (condition) => {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        assert.ok(Date.now() < deadline, 'timed out waiting for a worker state');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    let disposed = false;
    const messages = [];
    const done = runNativeServiceSupervisor({
      stateDir: root, entryPath: entry, processImpl: proc,
      log: (message) => messages.push(message),
      forkWorker(file, args, options) {
        const child = fork(file, args, options);
        workers.push(child);
        child.on('message', (message) => { if (message.kind === 'status') child.version = message.version; });
        return child;
      },
      stageUpdate: async () => ({ version: '4.0.3', archive, cleanUp() { disposed = true; } }),
      async applyUpdate(service, file, options) {
        await wait(() => fs.existsSync(ack));
        assert.deepEqual(JSON.parse(fs.readFileSync(ack)), { kind: 'updateResult', version: '4.0.3' });
        return updateBridge(service, file, {
          ...options,
          pause: () => new Promise((resolve) => setTimeout(resolve, 20)),
          run(command, args, commandOptions) {
            if (command === process.execPath) return execFileSync(command, args, commandOptions);
            const workspace = fs.readdirSync(root).find((name) => name.startsWith('.remodex-bridge-update-'));
            writeBridge(path.join(root, workspace, 'release', 'phodex-bridge'), '4.0.3', failStartup);
          },
        });
      },
    });
    t.after(() => { for (const worker of workers) if (worker.exitCode === null) worker.kill(); });
    await wait(() => workers[0]?.version === '4.0.2');
    workers[0].emit('message', { kind: 'update' });
    await wait(() => disposed);
    assert.equal(workers[0].exitCode, 0);
    const expectedVersion = failStartup ? '4.0.2' : '4.0.3';
    try {
      assert.equal(workers.length, failStartup ? 3 : 2, messages.join('\n'));
      assert.equal(workers.at(-1).version, expectedVersion);
      assert.equal(JSON.parse(fs.readFileSync(path.join(bridge, 'package.json'))).version, expectedVersion);
      assert.equal(owner.listenerCount('SIGTERM'), 1);
    } finally {
      owner.emit('SIGTERM');
      await done;
    }
  });
}

test('fresh-shell start preserves installed runtime, endpoint and identity settings', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { root, env } = fixture(t);
  const backend = { install() {}, start() {}, stop() {}, status: () => ({ running: false }) };
  await createNativeBridgeService({ platform: 'linux', env: { ...env, CODEX_HOME: path.join(root, 'codex'), REMODEX_CODEX_COMMAND: '/custom/codex', REMODEX_DEVICE_STATE_FILE: path.join(root, 'identity.json'), REMODEX_CODEX_ENDPOINT: 'ws://127.0.0.1:4500' }, backend }).start();
  await createNativeBridgeService({ platform: 'linux', env, backend }).start();
  const manifest = JSON.parse(fs.readFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'service-environment.json')));
  const config = JSON.parse(fs.readFileSync(path.join(env.REMODEX_DEVICE_STATE_DIR, 'daemon-config.json')));
  assert.equal(manifest.environment.CODEX_HOME, path.join(root, 'codex'));
  assert.equal(manifest.environment.REMODEX_DEVICE_STATE_FILE, path.join(root, 'identity.json'));
  assert.equal(manifest.environment.REMODEX_CODEX_COMMAND, '/custom/codex');
  assert.equal(config.codexEndpoint, 'ws://127.0.0.1:4500');
});

test('reset refuses to report success while a foreground owner remains alive', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { acquireServiceLock } = require('../src/service-runner');
  const { env } = fixture(t);
  const lock = await acquireServiceLock({ env });
  t.after(() => lock.release());
  let clock = 0;
  const pairingPath = path.join(env.REMODEX_DEVICE_STATE_DIR, 'pairing-session.json');
  fs.writeFileSync(pairingPath, '{}');
  const service = createNativeBridgeService({ platform: 'linux', env, backend: { stop() {} }, stopTimeoutMs: 100, now: () => clock, sleep: async () => { clock += 100; } });
  await assert.rejects(service.resetPairing(), /still running|did not stop/);
  assert.ok(fs.existsSync(pairingPath));
});

test('reset uses the installed custom identity file and preserves its device key', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { root, env } = fixture(t);
  const backend = { install() {}, start() {}, stop() {}, status: () => ({ running: false }) };
  const identityPath = path.join(root, 'custom-identity.json');
  await createNativeBridgeService({ platform: 'linux', env: { ...env, REMODEX_DEVICE_STATE_FILE: identityPath }, backend }).start();
  fs.writeFileSync(identityPath, JSON.stringify({ version: 1, macDeviceId: 'host', macIdentityPublicKey: 'pub', macIdentityPrivateKey: 'priv', trustedPhones: { phone: 'key' } }));
  await createNativeBridgeService({ platform: 'linux', env, backend }).resetPairing();
  const identity = JSON.parse(fs.readFileSync(identityPath));
  assert.deepEqual(identity.trustedPhones, {});
  assert.equal(identity.macIdentityPrivateKey, 'priv');
});

test('management operations cannot interleave service configuration and QR writes', async (t) => {
  const { createNativeBridgeService } = require('../src/native-bridge-service');
  const { acquireServiceLock } = require('../src/service-runner');
  const { env } = fixture(t);
  const operation = await acquireServiceLock({ env, scope: 'management' });
  t.after(() => operation.release());
  const service = createNativeBridgeService({ platform: 'linux', env, backend: { install: () => assert.fail('must not change service during another lifecycle operation') } });
  await assert.rejects(service.start(), /already|progress/);
});

test('combined updates only target the active Relay registered in the same server kit', (t) => {
  const { readCoInstalledRelayService } = require('../scripts/update-remodex-bridge.cjs');
  const { root } = fixture(t);
  const bridge = path.join(root, 'phodex-bridge');
  const relay = path.join(root, 'relay');
  fs.mkdirSync(bridge);
  fs.mkdirSync(relay);
  fs.writeFileSync(path.join(relay, 'server.js'), '');
  fs.writeFileSync(path.join(relay, 'package.json'), JSON.stringify({ name: 'remodex-relay', version: '4.0.8' }));

  const read = (entry, state) => readCoInstalledRelayService(bridge, {
    platform: 'linux',
    run(file, args) {
      assert.equal(file, 'systemctl');
      assert.equal(args[0], '--user');
      assert.equal(args[2], 'remodex-relay.service');
      return args[1] === 'cat' ? `ExecStart="${process.execPath}" "${entry}"` : state;
    },
  });
  assert.equal(read(path.join(relay, 'server.js'), 'active')?.version, '4.0.8');
  assert.equal(read(path.join(relay, 'server.js'), 'inactive'), null);
  assert.equal(read(path.join(bridge, 'server.js'), 'active'), null);

  const macRelay = readCoInstalledRelayService(bridge, {
    platform: 'darwin',
    run(file, args) {
      if (file === '/usr/bin/plutil') {
        const legacy = args.at(-1).endsWith('/com.remodex.loopback-relay.plist');
        return JSON.stringify({ ProgramArguments: [process.execPath, path.join(legacy ? relay : bridge, 'server.js')] });
      }
      assert.equal(file, '/bin/launchctl');
      assert.match(args.at(-1), /\/com\.remodex\.loopback-relay$/);
      return 'pid = 123';
    },
  });
  assert.equal(macRelay?.version, '4.0.8');
});

for (const failComponent of [null, 'relay', 'bridge']) {
  test(`combined release ${failComponent ? `rolls both components back when ${failComponent} fails` : 'updates both components in dependency order'}`, async (t) => {
    const { updateBridge } = require('../scripts/update-remodex-bridge.cjs');
    const { root } = fixture(t);
    const archive = path.join(root, 'verified.zip');
    fs.writeFileSync(archive, 'fixture archive');
    fs.writeFileSync(path.join(root, 'setup-server.cjs'), '');
    const events = [];

    function writeComponent(base, name, version) {
      const dir = path.join(base, name);
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
      fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ version }));
      if (name === 'phodex-bridge') {
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'service-entry.js'), '');
      }
      return dir;
    }

    const bridgeRoot = writeComponent(root, 'phodex-bridge', '4.0.8');
    const relayRoot = writeComponent(root, 'relay', '4.0.8');
    fs.writeFileSync(path.join(relayRoot, '.env'), 'PORT=9000');

    function service(component, directory) {
      let status = 'active';
      return {
        root: directory,
        nodePath: process.execPath,
        state: () => status,
        stop() { events.push(`stop ${component}`); status = 'inactive'; },
        start() {
          const { version } = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
          events.push(`start ${component} ${version}`);
          status = failComponent === component && version === '4.0.9' ? 'failed' : 'active';
        },
      };
    }
    const result = updateBridge({ ...service('bridge', bridgeRoot), entryPath: path.join(bridgeRoot, 'src', 'service-entry.js') }, archive, {
      includeRelay: true, relayService: service('relay', relayRoot), expectedVersion: '4.0.9',
      platform: 'linux', pause: async () => {}, log() {},
      run(file, args) {
        if (file === process.execPath) {
          assert.equal(args[0], '-e'); // A version-only change should reuse installed dependencies.
          return;
        }
        const stage = path.join(args.at(-1), 'release');
        writeComponent(stage, 'phodex-bridge', '4.0.9');
        writeComponent(stage, 'relay', '4.0.9');
      },
    });
    if (failComponent) {
      await assert.rejects(result, /previous installation was preserved or restored/);
      assert.deepEqual(events.slice(-2), ['start relay 4.0.8', 'start bridge 4.0.8']);
    } else {
      await result;
      assert.deepEqual(events, ['stop bridge', 'stop relay', 'start relay 4.0.9', 'start bridge 4.0.9']);
    }
    for (const dir of [bridgeRoot, relayRoot]) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, failComponent ? '4.0.8' : '4.0.9');
    }
    assert.equal(fs.readFileSync(path.join(relayRoot, '.env'), 'utf8'), 'PORT=9000');
  });
}
