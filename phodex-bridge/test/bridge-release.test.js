const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { fetchLatestBridgeRelease } = require("../src/bridge-release");

const archive = Buffer.from("test release");
const name = "remodex-bridge-update.zip";
const metadata = {
  tag_name: "v4.2.1", draft: false, prerelease: false,
  assets: [{
    name, state: "uploaded", size: archive.length,
    digest: "sha256:" + createHash("sha256").update(archive).digest("hex"),
    browser_download_url: "https://github.com/mitu810/remodex/releases/download/v4.2.1/" + name,
  }],
};

function installedRelease(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-release-fetch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(root, "phodex-bridge");
  const source = path.join(bridge, "src");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(bridge, "scripts"));
  fs.writeFileSync(path.join(root, "setup-server.cjs"), "");
  fs.writeFileSync(path.join(bridge, "scripts", "update-remodex-bridge.cjs"), "");
  fs.writeFileSync(path.join(bridge, "package.json"), JSON.stringify({ version: "4.2.0", releaseRepository: "mitu810/remodex" }));
  fs.copyFileSync(require.resolve("../src/bridge-release"), path.join(source, "bridge-release.js"));
  fs.writeFileSync(path.join(source, "private-state.js"), `module.exports = require(${JSON.stringify(require.resolve("../src/private-state"))});`);
  return require(path.join(source, "bridge-release.js"));
}

test("explicit update retries timed out metadata and interrupted ZIP bodies and stages one verified archive", async (t) => {
  const { stageBridgeRelease } = installedRelease(t);
  const waits = [];
  const requests = [];
  const interrupted = new TypeError("terminated", { cause: Object.assign(new Error("internal URL"), { code: "UND_ERR_SOCKET" }) });
  const release = await stageBridgeRelease({
    pause: async (ms) => waits.push(ms),
    async fetchImpl(url, { signal }) {
      assert.ok(signal instanceof AbortSignal);
      requests.push(url);
      switch (requests.length) {
        case 1: throw new DOMException("deadline", "TimeoutError");
        case 2: return Response.json(metadata);
        case 3: return { ok: true, body: (async function* () { yield archive.subarray(0, 4); throw interrupted; })() };
        case 4: return new Response(archive);
        default: assert.fail("unbounded fetch retries");
      }
    },
  });
  t.after(release.cleanUp);
  assert.deepEqual(fs.readFileSync(release.archive), archive);
  assert.equal(release.version, "4.2.1");
  assert.equal(requests[0], requests[1]);
  assert.equal(requests[2], requests[3]);
  assert.equal(requests[2], metadata.assets[0].browser_download_url);
  assert.deepEqual(waits, [500, 500]);
});

test("staging bounds transient failures, identifies the failed stage and hides underlying URL details", async (t) => {
  const { stageBridgeRelease } = installedRelease(t);
  for (const phase of ["metadata", "ZIP"]) {
    let attempts = 0;
    await assert.rejects(stageBridgeRelease({
      pause: async () => {},
      async fetchImpl(url) {
        if (phase === "ZIP" && url.includes("api.github.com")) return Response.json(metadata);
        attempts++;
        if (attempts === 1) return new Response("", { status: 503 });
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("sensitive proxy URL"), { code: "ECONNRESET" }) });
      },
    }), (error) => {
      assert.match(error.message, phase === "metadata" ? /release metadata failed after 3 attempts/ : /ZIP download failed after 3 attempts/);
      assert.match(error.message, /ECONNRESET/);
      assert.doesNotMatch(error.message, /sensitive/);
      return true;
    });
    assert.equal(attempts, 3);
  }
});

test("invalid releases, damaged bytes, permanent HTTP failures and long Retry-After abort the update immediately", async (t) => {
  const { stageBridgeRelease } = installedRelease(t);
  for (const [responses, failure] of [
    [[new Response("", { status: 403 })], /HTTP 403/],
    [[new Response("", { status: 429, headers: { "retry-after": "120" } })], /HTTP 429/],
    [[Response.json({ ...metadata, draft: true })], /verified bridge update/],
    [[new Response("invalid JSON")], /invalid release JSON/],
    [[Response.json(metadata), new Response("", { status: 404 })], /ZIP download.*HTTP 404/],
    [[Response.json(metadata), new Response(Buffer.alloc(archive.length))], /SHA-256/],
    [[Response.json(metadata), new Response(Buffer.alloc(archive.length + 1))], /published size/],
  ]) {
    let calls = 0;
    await assert.rejects(stageBridgeRelease({
      pause: () => assert.fail("unexpected retry"),
      fetchImpl: async () => responses[calls++],
    }), failure);
    assert.equal(calls, responses.length);
  }
});

test("passive version checks make one metadata request", async () => {
  let requests = 0;
  await assert.rejects(fetchLatestBridgeRelease({ fetchImpl: async () => {
    requests++;
    throw new DOMException("timeout", "TimeoutError");
  } }), /timeout/);
  assert.equal(requests, 1);
});

test("native supervisor reloads installed staging code and keeps its worker online across successive download failures", async (t) => {
  const { EventEmitter, once } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-release-supervisor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "logs"));
  const moduleFile = path.join(root, "bridge-release.js");
  const supervisorFile = path.join(root, "native-service-supervisor.js");
  fs.copyFileSync(require.resolve("../src/native-service-supervisor"), supervisorFile);
  const worker = new EventEmitter();
  worker.connected = true;
  worker.send = (message, callback) => {
    if (message.kind === "updateResult") worker.emit("reply", message);
    assert.notEqual(message.kind, "stop");
    callback();
  };
  const done = require(supervisorFile).runNativeServiceSupervisor({
    stateDir: root,
    entryPath: path.join(root, "service-entry.js"),
    processImpl: new EventEmitter(),
    forkWorker: () => worker,
    applyUpdate: () => assert.fail("failed downloads must leave existing services running"),
  });
  try {
    for (const version of ["first", "replacement"]) {
      fs.writeFileSync(moduleFile, `exports.stageBridgeRelease = async () => { throw new Error("${version} release metadata failed"); };`);
      const reply = once(worker, "reply");
      worker.emit("message", { kind: "update" });
      assert.deepEqual(await reply, [{ kind: "updateResult", error: version + " release metadata failed" }]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const log = fs.readFileSync(path.join(root, "logs", "bridge-update.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z Bridge update failed: first/);
    assert.match(log[1], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z Bridge update failed: replacement/);
  } finally {
    worker.emit("close", 0);
    await done;
  }
});
