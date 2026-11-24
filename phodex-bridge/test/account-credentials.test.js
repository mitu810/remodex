const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  activeCredentialFingerprint, createCredentialCheckRecovery, credentialFingerprint, queryCredential, replaceCodexCredential,
} = require("../src/account-credentials");

function credential(accountId, lastRefresh) {
  const payload = Buffer.from(JSON.stringify({ sub: "fixture-user" })).toString("base64url");
  return JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: lastRefresh,
    tokens: { account_id: accountId, id_token: `header.${payload}.signature`, access_token: "access", refresh_token: "refresh" },
  });
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-account-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test("a lost renewal reply is recoverable by the submitted credential only until its TTL expires", () => {
  let now = 100;
  const recovery = createCredentialCheckRecovery({ now: () => now, ttlMs: 500 });
  const before = credential("one", "2026-11-01T00:00:00Z");
  const updated = credential("one", "2026-11-19T00:00:00Z");
  recovery.remember(before, { credential: updated, usageUnavailable: true });
  assert.equal(recovery.read(before)?.credential, updated);
  assert.equal(recovery.read(updated), null);
  now = 600;
  assert.equal(recovery.read(before), null);
});

test("a rotated credential survives the isolated Codex process closing before usage is returned", async () => {
  const before = credential("one", "2026-11-01T00:00:00Z");
  const updated = credential("one", "2026-11-19T00:00:00Z");
  let home;
  const result = await queryCredential(before, {
    renew: true,
    createTransport({ env }) {
      home = env.CODEX_HOME;
      let onMessage, onClose;
      return {
        onStarted(handler) { queueMicrotask(handler); },
        onError() {},
        onMessage(handler) { onMessage = handler; },
        onClose(handler) { onClose = handler; },
        shutdown() { onClose(); },
        send(raw) {
          const { id, method } = JSON.parse(raw);
          if (method === "initialized") return;
          if (method === "account/read") fs.writeFileSync(path.join(home, "auth.json"), updated);
          if (method === "account/rateLimits/read") return onClose();
          onMessage(JSON.stringify({ id, result: {} }));
        },
      };
    },
  });
  assert.deepEqual(result, { credential: updated, usageUnavailable: true });
  assert.equal(fs.existsSync(home), false);
});

test("matches the live ChatGPT account without returning its token or confusing workspaces", () => {
  const saved = credential("workspace/one");
  const token = `header.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_user_id: "fixture-user", chatgpt_account_id: "workspace/one" },
  })).toString("base64url")}.signature`;
  const status = { authMethod: "chatgpt", authToken: token };
  const expected = credentialFingerprint(saved);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(activeCredentialFingerprint({ account: { type: "chatgpt" } }, status), expected);
  assert.notEqual(activeCredentialFingerprint({ workspaceRouting: { chatgptAccountId: "workspace/two" } }, status), expected);
  assert.equal(activeCredentialFingerprint({}, { ...status, authMethod: "apiKey" }), null);
  assert.equal(activeCredentialFingerprint({}, { ...status, authToken: "invalid" }), null);
});

test("backs up the existing file and atomically applies the credential to the selected host", (t) => {
  const home = fixture(t);
  const live = path.join(home, "auth.json");
  const previous = credential("old");
  fs.writeFileSync(live, previous);
  assert.deepEqual(replaceCodexCredential(home, credential("new")), { restartRequired: true });
  assert.equal(JSON.parse(fs.readFileSync(live)).tokens.account_id, "new");
  const backups = path.join(home, "remodex-auth-backups");
  assert.equal(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0]), "utf8"), previous);
  assert.deepEqual(replaceCodexCredential(home, credential("new")), { restartRequired: false });
  assert.equal(fs.readdirSync(backups).length, 1);
  if (process.platform !== "win32") assert.equal(fs.statSync(live).mode & 0o777, 0o600);
});

test("rejects invalid input and leaves the installed credential alone", (t) => {
  const home = fixture(t);
  const live = path.join(home, "auth.json");
  fs.writeFileSync(live, credential("old"));
  assert.throws(() => replaceCodexCredential(home, '{"auth_mode":"apikey"}'), { errorCode: "invalid_account_credential" });
  assert.equal(fs.readFileSync(live, "utf8"), credential("old"));
});

test("rejects an older copy of the same account already on the device", (t) => {
  const home = fixture(t);
  const live = path.join(home, "auth.json");
  const newer = credential("account", "2026-11-19T00:00:00Z");
  fs.writeFileSync(live, newer);
  assert.throws(() => replaceCodexCredential(home, credential("account", "2026-11-01T00:00:00Z")),
    { errorCode: "account_newer_on_device" });
  assert.equal(fs.readFileSync(live, "utf8"), newer);
});

test("checks and renews a saved credential in a temporary home", async () => {
  const before = credential("account", "2026-11-01T00:00:00Z");
  const renewed = credential("account", "2026-11-19T00:00:00Z");
  const methods = [];
  let temp;
  const result = await queryCredential(before, {
    renew: true,
    env: { OPENAI_API_KEY: "fixture-host-key", CODEX_HOME: "fixture-host-home" },
    createTransport({ env }) {
      temp = env.CODEX_HOME;
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.notEqual(temp, "fixture-host-home");
      const filename = path.join(temp, "auth.json");
      assert.equal(fs.readFileSync(filename, "utf8"), before);
      let onMessage;
      let onClose;
      return {
        onStarted(handler) { queueMicrotask(handler); },
        onError() {},
        onMessage(handler) { onMessage = handler; },
        onClose(handler) { onClose = handler; },
        shutdown() { onClose(); },
        send(raw) {
          const { id, method, params } = JSON.parse(raw);
          methods.push(method);
          if (method === "initialized") return;
          if (method === "account/read") {
            assert.equal(params.refreshToken, true);
            fs.writeFileSync(filename, renewed);
          }
          onMessage(JSON.stringify({ id, result: method === "account/rateLimits/read" ? { rateLimits: {} } : {} }));
        },
      };
    },
  });
  assert.deepEqual(methods, ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  assert.deepEqual(result, { usage: { rateLimits: {} }, credential: renewed });
  assert.equal(fs.existsSync(temp), false);
});

test("shared runtime matches its selected login and workspace even without a live access token", async () => {
  const { readLiveAccountIdentity } = require("../src/account-credentials");
  const row = { sessionId: "second", isActive: true, userId: "fixture-user", selectedWorkspaceAccountId: "workspace", email: "second@example.invalid" };
  const response = { activeSessionId: "second", sessions: [{...row, sessionId:"first", isActive:false, email:"other@example.invalid"}, row] };
  const auth = { authMethod: "chatgpt", authToken: null };
  const read = (account, sessions) => readLiveAccountIdentity(account, auth, async () => sessions);
  assert.deepEqual(await read({account:null}, response), {
    fingerprint: credentialFingerprint(credential("workspace")), email: row.email,
  });
  for (const sessions of [{...response, activeSessionId:null}, {...response, activeSessionId:"first"},
    {...response, sessions:[{...row, selectedWorkspaceAccountId:null}]}]) {
    assert.deepEqual(await read({}, sessions), {fingerprint:null, email:null});
  }
  assert.deepEqual(await read({userId:"other"}, response), {fingerprint:null,email:null});
  assert.deepEqual(await readLiveAccountIdentity({}, auth, async () => { throw Error("unsupported"); }), {fingerprint:null,email:null});
  assert.deepEqual(await readLiveAccountIdentity({}, {authMethod:"apiKey"}, () => assert.fail("unexpected session lookup")), {fingerprint:null,email:null});
});

test("a selected account alone cannot confirm a usable desktop login", () => {
  const { usableCredentialFingerprint } = require("../src/account-credentials");
  const account = { account: { type: "chatgpt" }, userId: "fixture-user", workspaceRouting: { chatgptAccountId: "work" } };
  const status = { authMethod: "chatgpt", authToken: "access" };
  assert.equal(usableCredentialFingerprint(account, status), credentialFingerprint(credential("work")));
  assert.equal(usableCredentialFingerprint({ ...account, workspaceRouting: null }, status), null);
  assert.equal(usableCredentialFingerprint({ ...account, account: null }, status), null);
  const other = { "https://api.openai.com/auth": { chatgpt_user_id: "other", chatgpt_account_id: "work" } };
  const otherToken = "x." + Buffer.from(JSON.stringify(other)).toString("base64url") + ".x";
  assert.equal(usableCredentialFingerprint(account, { ...status, authToken: otherToken }), null);
  assert.equal(usableCredentialFingerprint(account, { ...status, authToken: null }), null);
});

test("the online preflight gives the isolated Codex only the access token and rejects a failed request", async () => {
  const { checkSharedCredential } = require("../src/account-credentials");
  let temporaryHome;
  const createTransport = ({ env }) => {
    temporaryHome = env.CODEX_HOME;
    assert.equal(fs.existsSync(path.join(temporaryHome, "auth.json")), false);
    let message, close;
    return {
      onStarted(fn) { queueMicrotask(fn); }, onError() {},
      onMessage(fn) { message = fn; }, onClose(fn) { close = fn; }, shutdown() { close(); },
      send(raw) {
        const { method, id, params } = JSON.parse(raw);
        if (method === "initialized") return;
        if (method === "account/login/start") {
          assert.deepEqual(params, { type: "chatgptAuthTokens", accessToken: "access", chatgptAccountId: "work" });
        }
        message(JSON.stringify(method === "account/rateLimits/read"
          ? { id, error: { message: "unauthorized" } } : { id, result: {} }));
      },
    };
  };
  await assert.rejects(checkSharedCredential(credential("work"), "", createTransport), { errorCode: "account_credential_unverified" });
  assert.equal(fs.existsSync(temporaryHome), false);
});
