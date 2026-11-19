// FILE: codex-transport.test.js
// Purpose: Verifies native launcher selection, child lifecycle, and endpoint-backed transport.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/codex-transport

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createCodexLaunchPlans,
  createCodexTransport,
  extractMissingEnvironmentVariable,
  formatCodexLaunchFailure,
} = require("../src/codex-transport");

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static latestInstance = null;

  constructor(endpoint) {
    this.endpoint = endpoint;
    this.readyState = FakeWebSocket.CONNECTING;
    this.handlers = {};
    this.sentMessages = [];
    FakeWebSocket.latestInstance = this;
  }

  on(eventName, handler) {
    this.handlers[eventName] = handler;
  }

  send(message) {
    this.sentMessages.push(message);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(eventName, ...args) {
    this.handlers[eventName]?.(...args);
  }
}

test("endpoint transport only sends outbound messages after the websocket opens", () => {
  const transport = createCodexTransport({
    endpoint: "ws://127.0.0.1:4321/codex",
    WebSocketImpl: FakeWebSocket,
  });

  const socket = FakeWebSocket.latestInstance;
  assert.ok(socket);
  assert.equal(socket.endpoint, "ws://127.0.0.1:4321/codex");

  transport.send('{"id":"init-1","method":"initialize"}');
  transport.send('{"id":"list-1","method":"thread/list"}');
  assert.deepEqual(socket.sentMessages, []);

  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");

  assert.deepEqual(socket.sentMessages, []);

  transport.send('{"id":"list-2","method":"thread/list"}');
  assert.deepEqual(socket.sentMessages, ['{"id":"list-2","method":"thread/list"}']);
});

test("spawn launch plans add the bundled Codex app binary as a fallback on macOS", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-codex-app-"));
  const appPath = path.join(tempDir, "Codex.app");
  const bundledCodexPath = path.join(appPath, "Contents", "Resources", "codex");
  fs.mkdirSync(path.dirname(bundledCodexPath), { recursive: true });
  fs.writeFileSync(bundledCodexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    const launches = createCodexLaunchPlans({
      env: { PATH: "/usr/bin:/bin" },
      appPath,
      platform: "darwin",
    });

    assert.deepEqual(
      launches.map((launch) => launch.command),
      ["codex", bundledCodexPath]
    );
    assert.equal(launches[1].description, `\`${bundledCodexPath} app-server\``);
    assert.deepEqual(launches.map((launch) => launch.args), [
      ["app-server", "-c", "thread_unload_delay_secs=1"],
      ["app-server", "-c", "thread_unload_delay_secs=1"],
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("spawn launch plans keep the default codex command first even when a bundled fallback exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-codex-path-"));
  const appPath = path.join(tempDir, "Codex.app");
  const bundledCodexPath = path.join(appPath, "Contents", "Resources", "codex");
  fs.mkdirSync(path.dirname(bundledCodexPath), { recursive: true });
  fs.writeFileSync(bundledCodexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    const launches = createCodexLaunchPlans({
      env: { PATH: "/usr/bin:/bin" },
      appPath,
      platform: "darwin",
    });

    assert.equal(launches[0].command, "codex");
    assert.equal(launches[1].command, bundledCodexPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("spawn transport retries with the current ChatGPT bundle CLI after an ENOENT launch error", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-codex-fallback-"));
  const appPath = path.join(tempDir, "ChatGPT.app");
  const bundledCodexPath = path.join(appPath, "Contents", "Resources", "codex-cli", "bin", "codex");
  fs.mkdirSync(path.dirname(bundledCodexPath), { recursive: true });
  fs.writeFileSync(bundledCodexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const spawnCalls = [];
  const children = [];
  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const child = createFakeChild();
    children.push(child);
    return child;
  };

  try {
    let startedInfo = null;
    const transport = createCodexTransport({
      env: { PATH: "/usr/bin:/bin" },
      appPath,
      platform: "darwin",
      spawnImpl,
    });
    transport.onStarted((info) => {
      startedInfo = info;
    });

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "codex");

    const firstError = new Error("spawn codex ENOENT");
    firstError.code = "ENOENT";
    children[0].emit("error", firstError);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(spawnCalls.length, 2);
    assert.equal(spawnCalls[1].command, bundledCodexPath);
    children[1].emit("spawn");
    assert.deepEqual(startedInfo, {
      mode: "spawn",
      launchDescription: `\`${bundledCodexPath} app-server\``,
    });
    assert.equal(transport.describe(), `\`${bundledCodexPath} app-server\``);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("spawn transport explains Codex API-key environment failures without asking Remodex to store secrets", () => {
  const children = [];
  const transport = createCodexTransport({
    env: { PATH: "/usr/bin:/bin" },
    platform: "darwin",
    spawnImpl() {
      const child = createFakeChild();
      children.push(child);
      return child;
    },
  });

  let reportedError = null;
  transport.onError((error) => {
    reportedError = error;
  });

  children[0].emitStderr("data", Buffer.from("Error: Missing environment variable: `CODEX_API_KEY`.\n"));
  children[0].emit("close", 1, null);

  assert.ok(reportedError);
  assert.match(reportedError.message, /Codex launcher `codex app-server` failed/);
  assert.match(reportedError.message, /Codex is asking for CODEX_API_KEY/);
  assert.match(reportedError.message, /Remodex does not store or forward OpenAI API keys/);
  assert.match(reportedError.message, /codex login/);
});

test("missing environment variable diagnostics are extracted from Codex stderr", () => {
  assert.equal(
    extractMissingEnvironmentVariable("Error: Missing environment variable: `CODEX_API_KEY`."),
    "CODEX_API_KEY"
  );
  assert.equal(extractMissingEnvironmentVariable("Process exited with code 1."), "");

  const message = formatCodexLaunchFailure({
    launchDescription: "`codex app-server`",
    reason: "Missing environment variable: `CUSTOM_PROVIDER_KEY`.",
  });
  assert.match(message, /CUSTOM_PROVIDER_KEY/);
  assert.match(message, /custom provider env var/);
});

const appServerArgs = ["app-server", "-c", "thread_unload_delay_secs=1"];

test("Windows resolves an absolute native exe before npm shims across PATH entries", () => {
  const native = String.raw`D:\Program Files\工具; & 100%\codex.exe`;
  const shim = String.raw`C:\Users\someone\npm\codex.cmd`;
  const env = { Path: `.;relative;"${path.win32.dirname(shim)}";"${path.win32.dirname(native)}"` };
  const [launch] = createCodexLaunchPlans({
    platform: "win32", env,
    fsImpl: { statSync: (file) => ({ isFile: () => [native, shim, "codex.exe"].includes(file) }) },
  });
  assert.equal(launch.command, native);
  assert.deepEqual(launch.args, appServerArgs);
  assert.equal(launch.options.env.Path, env.Path);
  assert.ok(!launch.options.shell);
});

test("Windows discovers a shim with an absolute path and keeps its filename out of shell syntax", () => {
  const bin = String.raw`D:\用户 & %PATH%!\global bin`;
  const shim = path.win32.join(bin, "codex.cmd");
  const [launch] = createCodexLaunchPlans({
    platform: "win32", env: { PATH: bin, SystemRoot: String.raw`C:\Windows` },
    fsImpl: { statSync: (file) => ({ isFile: () => file === shim }) },
  });
  assert.equal(launch.command, String.raw`C:\Windows\System32\cmd.exe`);
  assert.ok(Object.values(launch.options.env).includes(shim));
  assert.ok(!launch.args.join(" ").includes(shim));
  assert.equal(launch.options.windowsVerbatimArguments, true);
});

test("Linux uses PATH without consulting a Mac desktop bundle", () => {
  const plans = createCodexLaunchPlans({
    platform: "linux", env: { PATH: "/opt/codex/bin" }, appPath: "/opt/Codex.app",
    fsImpl: { statSync: () => ({ isFile: () => true }) },
  });
  assert.deepEqual(plans.map(({ command, args }) => [command, args]), [["codex", appServerArgs]]);
});

test("an explicit absolute executable is the only launch plan on each platform", () => {
  for (const [platform, command] of [
    ["linux", "/opt/my bin/codex & λ"],
    ["darwin", "/Applications/custom codex"],
    ["win32", String.raw`D:\Native Codex\codex.exe`],
  ]) {
    const plans = createCodexLaunchPlans({ platform, env: { REMODEX_CODEX_COMMAND: command } });
    assert.deepEqual(plans.map((plan) => [plan.command, plan.args]), [[command, appServerArgs]]);
  }
});

test("invalid executable overrides are rejected before spawning", () => {
  for (const [platform, command] of [
    ["linux", "codex --other"], ["win32", "codex.exe"], ["win32", String.raw`C:bin\codex.exe`],
    ["win32", String.raw`\bin\codex.exe`], ["win32", String.raw`C:\bin\run.ps1`],
    ["win32", 'C:\\bin\\name"withquote.cmd'],
  ]) {
    assert.throws(
      () => createCodexLaunchPlans({ platform, env: { REMODEX_CODEX_COMMAND: command } }),
      /REMODEX_CODEX_COMMAND/
    );
  }
});

test("a missing Windows executable reports through the transport without searching the working directory", async () => {
  let spawned = false;
  const transport = createCodexTransport({
    platform: "win32", env: { Path: ".;relative" },
    spawnImpl() { spawned = true; return createFakeChild(); },
  });
  const errors = [];
  transport.onError((error) => errors.push(error.message));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned, false);
  assert.match(errors[0], /PATH/);
  transport.send("{}");
  transport.shutdown();
});

test("Windows shutdown requests the launched PID tree exactly once", () => {
  const calls = [];
  const child = createFakeChild();
  const transport = createCodexTransport({
    platform: "win32",
    env: { REMODEX_CODEX_COMMAND: String.raw`D:\Codex\codex.exe`, SystemRoot: String.raw`C:\Windows` },
    spawnImpl(command, args) {
      calls.push([command, args]);
      return calls.length === 1 ? child : createFakeChild();
    },
  });
  transport.shutdown();
  transport.shutdown();
  assert.deepEqual(calls.slice(1), [[String.raw`C:\Windows\System32\taskkill.exe`, ["/pid", "123", "/t", "/f"]]]);
});

test("shutdown never looks up an already terminated Windows child's PID", () => {
  const child = createFakeChild();
  child.signalCode = "SIGTERM";
  const calls = [];
  const transport = createCodexTransport({
    platform: "win32", env: { REMODEX_CODEX_COMMAND: String.raw`D:\Codex\codex.exe` },
    spawnImpl(command) { calls.push(command); return child; },
  });
  transport.shutdown();
  assert.equal(calls.length, 1);
  assert.equal(child.killed, false);
});

test("Linux shutdown sends SIGTERM directly to the child", () => {
  const child = createFakeChild();
  let signal;
  child.kill = (value) => { signal = value; };
  const transport = createCodexTransport({
    platform: "linux", env: {}, spawnImpl: () => child,
  });
  transport.shutdown();
  assert.equal(signal, "SIGTERM");
});

test("a timed restart stops a Unix child that ignores SIGTERM", async () => {
  const child = createFakeChild();
  const signals = [];
  child.once = () => {};
  child.kill = (signal) => { signals.push(signal); };
  const transport = createCodexTransport({
    platform: "linux", env: {}, spawnImpl: () => child,
  });
  transport.shutdown({ forceAfterMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("the native launcher preserves a literal executable path, app-server arguments and stdio", { timeout: 10_000 }, async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "codex 工具 & %PATH%! "));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const windows = process.platform === "win32";
  const file = path.join(bin, windows ? "codex.cmd" : "codex");
  const script = windows
    ? "@echo off\r\necho %*\r\nset /p packet=\r\nset packet\r\n"
    : '#!/bin/sh\nprintf "%s\\n" "$*"\nIFS= read -r packet\nprintf "packet=%s\\n" "$packet"\n';
  fs.writeFileSync(file, script, { mode: 0o755 });
  const transport = createCodexTransport({ env: { PATH: bin, SystemRoot: process.env.SystemRoot } });
  t.after(() => transport.shutdown());
  const lines = [];
  transport.onMessage((line) => lines.push(line));
  transport.onStarted(() => transport.send('{"id":1}'));
  await new Promise((resolve, reject) => {
    transport.onClose(resolve);
    transport.onError(reject);
  });
  assert.deepEqual(lines, ["app-server -c thread_unload_delay_secs=1", 'packet={"id":1}']);
});

function createFakeChild() {
  const handlers = new Map();
  const stdinHandlers = new Map();

  return {
    killed: false,
    exitCode: null,
    pid: 123,
    stdin: {
      writable: true,
      destroyed: false,
      writableEnded: false,
      on(eventName, handler) {
        stdinHandlers.set(eventName, handler);
      },
      write() {},
    },
    stdout: {
      on(eventName, handler) {
        handlers.set(`stdout:${eventName}`, handler);
      },
    },
    stderr: {
      on(eventName, handler) {
        handlers.set(`stderr:${eventName}`, handler);
      },
    },
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    kill() {
      this.killed = true;
    },
    emit(eventName, ...args) {
      handlers.get(eventName)?.(...args);
    },
    emitStdout(eventName, ...args) {
      handlers.get(`stdout:${eventName}`)?.(...args);
    },
    emitStderr(eventName, ...args) {
      handlers.get(`stderr:${eventName}`)?.(...args);
    },
    emitStdin(eventName, ...args) {
      stdinHandlers.get(eventName)?.(...args);
    },
  };
}
