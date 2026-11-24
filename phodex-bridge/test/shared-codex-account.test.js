const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareSharedAccountSwitch } = require("../src/shared-codex-account");

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remodex-daemon-account-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const socketPath = path.join(home, "app-server-control", "app-server-control.sock");
  fs.mkdirSync(path.dirname(socketPath));
  fs.writeFileSync(socketPath, "");
  const previous = '{"OPENAI_API_KEY":"fixture"}';
  const file = path.join(home, "auth.json");
  fs.writeFileSync(file, previous);
  const jwt = "e30." + Buffer.from('{"sub":"user"}').toString("base64url") + ".AA";
  const credential = JSON.stringify({tokens: { id_token: jwt, access_token: jwt, refresh_token: "fixture", account_id: "account" }});
  const calls = [];
  const options = {
    home, endpoint: "ws+unix://localhost" + socketPath + ":/rpc",
    server: { platformOs: "macos", codexHome: home }, platform: "darwin", credential,
    rpc: async (method, params) => {
      if (method === "thread/loaded/list") return params.cursor ? { data: ["last"] } : { data: ["first"], nextCursor: "next" };
      assert.equal(method, "thread/read");
      return { thread: { status: { type: "idle" } } };
    },
    daemon: async (command) => {
      calls.push(command);
      if (command === "version") return {status: "running", backend: "pid", socketPath};
    },
  };
  return { options, calls, file, previous };
}

test("switches only the selected local daemon and installs the saved credential while stopped", async t => {
  const {options, calls, file, previous} = fixture(t);
  const run = options.daemon;
  options.daemon = async command => {
    if (command === "stop") assert.equal(fs.readFileSync(file, "utf8"), previous);
    if (command === "start") assert.equal(fs.readFileSync(file, "utf8"), options.credential);
    return run(command);
  };
  const restart = await prepareSharedAccountSwitch(options);
  assert.equal(fs.readFileSync(file, "utf8"), previous);
  await restart();
  assert.deepEqual(calls, ["version", "stop", "start"]);
});

test("rejects remote endpoints, another home or another daemon before writing", async t => {
  const { options, calls, file, previous } = fixture(t);
  for (const changes of [{endpoint: "wss://example.invalid/rpc"}, {server: {...options.server, codexHome: os.tmpdir()}},
    {daemon: async () => ({status:"running",backend:"pid",socketPath:"/another/socket"})}]) {
    await assert.rejects(prepareSharedAccountSwitch({...options, ...changes}), {errorCode:"account_external_runtime"});
  }
  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(file, "utf8"), previous);
});

test("a desktop-only active turn on the second page prevents any change", async t => {
  const {options, calls, file, previous} = fixture(t);
  const rpc = options.rpc;
  options.rpc = (method, params) => params.threadId === "last" ? {thread:{status:{type:"active"}}} : rpc(method, params);
  await assert.rejects(prepareSharedAccountSwitch(options), {errorCode:"account_runtime_busy"});
  assert.ok(!calls.includes("stop"));
  assert.equal(fs.readFileSync(file, "utf8"), previous);
});

test("failed startup restores the previous credential and starts the daemon with it", async t => {
  const {options, calls, file, previous} = fixture(t);
  const run = options.daemon;
  options.daemon = async command => {
    const response = await run(command);
    if (command === "start" && calls.filter(c => c === "start").length === 1) throw Error("fixture start failure");
    return response;
  };
  const restart = await prepareSharedAccountSwitch(options);
  await assert.rejects(restart());
  assert.deepEqual(calls, ["version","stop","start","start"]);
  assert.equal(fs.readFileSync(file,"utf8"), previous);
});

test("work started during reply delivery cancels the daemon restart and reconnects the phone", async () => {
  const { createBridgeSessionSupervisor } = require("../src/bridge");
  let schedule, switched = false;
  const connections = [];
  const bridge = createBridgeSessionSupervisor(({ scheduleRestart, desktopRestartFailed }) => {
    connections.push(desktopRestartFailed);
    schedule = scheduleRestart;
    return { relaySessionId: "fixture", stop: async () => {} };
  }, { restartDelayMs: 0 });
  await schedule(async () => { switched = true; }, async () => { throw Error("desktop busy"); });
  assert.equal(switched, false);
  assert.deepEqual(connections, [undefined, true]);
  await bridge.stop();
});
