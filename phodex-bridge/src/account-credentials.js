// Applies a phone-owned credential to the local Codex home and checks saved accounts in isolation.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { isChatGPTAuthMethod } = require("./account-status");
const { createCodexTransport } = require("./codex-transport");
const { ensurePrivateDirectory, writePrivateFile } = require("./private-state");

function accountError(errorCode, message) {
  return Object.assign(new Error(message), { errorCode, userMessage: message });
}

function parseCredential(raw) {
  const invalid = () => accountError("invalid_account_credential", "Select a Codex ChatGPT auth.json file.");
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 128 * 1024) throw invalid();
  let auth;
  try { auth = JSON.parse(raw); } catch { throw invalid(); }
  const tokens = auth?.tokens;
  if ((auth?.auth_mode != null && auth.auth_mode !== "chatgpt") || auth?.OPENAI_API_KEY
    || !["id_token", "access_token", "refresh_token"].every((key) =>
      typeof tokens?.[key] === "string" && tokens[key].trim())) {
    throw invalid();
  }
  return auth;
}

function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { return {}; }
}

function credentialIdentity(raw) {
  const auth = parseCredential(raw);
  const id = tokenClaims(auth.tokens.id_token);
  const access = tokenClaims(auth.tokens.access_token);
  const metadata = id?.["https://api.openai.com/auth"] ?? access?.["https://api.openai.com/auth"];
  const user = metadata?.chatgpt_user_id || metadata?.user_id || id?.sub || id?.email;
  const workspace = auth.tokens.account_id || metadata?.chatgpt_account_id || "";
  return typeof user === "string" && user && typeof workspace === "string" ? JSON.stringify([user, workspace]) : null;
}

function fingerprint(user, workspace) {
  const encoded = [user, workspace].map((value) => Buffer.from(value).toString("base64")).join(".");
  return createHash("sha256").update(encoded).digest("hex");
}

function credentialFingerprint(raw) {
  const identity = credentialIdentity(raw);
  return identity ? fingerprint(...JSON.parse(identity)) : null;
}

// Keeps recent rotations recoverable if the encrypted reply is lost on reconnect.
// The original content is keyed by a hash. Nothing is written to disk or logged.
function createCredentialCheckRecovery({ now = Date.now, ttlMs = 60 * 60 * 1000 } = {}) {
  const entries = new Map();
  const key = (credential) => createHash("sha256").update(credential).digest("hex");
  return {
    read(credential) {
      const id = key(credential);
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.expiresAt > now()) return entry.result;
      entries.delete(id);
      return null;
    },
    remember(credential, result) {
      if (!result?.credential || result.credential === credential) return;
      const time = now();
      for (const [id, entry] of entries) if (entry.expiresAt <= time) entries.delete(id);
      if (entries.size >= 32) entries.delete(entries.keys().next().value);
      entries.set(key(credential), { expiresAt: time + ttlMs, result });
    },
  };
}

// Read the identity from Codex's live account rather than trusting the auth.json on disk.
function activeCredentialFingerprint(account, authStatus) {
  if (!isChatGPTAuthMethod(authStatus?.authMethod || account?.account?.type)) return null;
  const claims = tokenClaims(authStatus?.authToken);
  const metadata = claims?.["https://api.openai.com/auth"];
  const user = account?.userId || metadata?.chatgpt_user_id || metadata?.user_id || claims?.sub;
  const workspace = account?.workspaceRouting?.chatgptAccountId || metadata?.chatgpt_account_id;
  return typeof user === "string" && user && typeof workspace === "string" ? fingerprint(user, workspace) : null;
}

function readInstalledCredential(home) {
  const file = path.join(home, "auth.json");
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 128 * 1024) {
      throw accountError("unsafe_account_file", "The host Codex credential must be a regular auth.json file.");
    }
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateCodexCredentialReplacement(home, raw) {
  const incoming = parseCredential(raw);
  const previous = readInstalledCredential(home);
  if (previous === raw) return previous;
  if (previous != null) {
    const incomingIdentity = credentialIdentity(raw);
    let installedIdentity;
    try { installedIdentity = credentialIdentity(previous); } catch {}
    if (incomingIdentity && installedIdentity === incomingIdentity
      && Date.parse(JSON.parse(previous).last_refresh) > (Date.parse(incoming.last_refresh) || 0)) {
      throw accountError("account_newer_on_device", "This device has a newer credential. Refresh the saved account while connected to this device first.");
    }
  }
  return previous;
}

function replaceCodexCredential(home, raw) {
  const previous = validateCodexCredentialReplacement(home, raw);
  if (previous === raw) return { restartRequired: false };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (previous != null) {
    const backups = path.join(home, "remodex-auth-backups");
    ensurePrivateDirectory(backups);
    writePrivateFile(path.join(backups, `${randomUUID()}.json`), previous);
  }
  writeInstalledCredential(home, previous, raw);
  return { restartRequired: true };
}

// Used for both installation and recovery. Never overwrite a concurrent login.
function writeInstalledCredential(home, previous, raw) {
  const staging = fs.mkdtempSync(path.join(home, ".remodex-auth-"));
  try {
    ensurePrivateDirectory(staging);
    const stagedFile = path.join(staging, "auth.json");
    if (raw !== null) writePrivateFile(stagedFile, raw);
    if (readInstalledCredential(home) !== previous) {
      throw accountError("account_file_changed", "Codex updated the host credential during the operation. Try again.");
    }
    if (raw === null) fs.unlinkSync(path.join(home, "auth.json"));
    else fs.renameSync(stagedFile, path.join(home, "auth.json"));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// Reuses the bridge's platform-aware Codex launcher, including Windows npm shims.
async function queryCredential(raw, { renew, appPath, env = process.env, createTransport = createCodexTransport }) {
  parseCredential(raw);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-credential-"));
  let transport;
  let closed;
  try {
    ensurePrivateDirectory(home);
    writePrivateFile(path.join(home, "auth.json"), raw);
    writePrivateFile(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const isolatedEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/^(CODEX_HOME|OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_BASE_URL|CODEX_BASE_URL)$/i.test(key)));
    transport = createTransport({ appPath, env: { ...isolatedEnv, CODEX_HOME: home } });
    closed = new Promise((resolve) => transport.onClose(resolve));
    let read;
    try {
      read = await runAccountCheck(transport, renew, closed);
    } catch (error) {
      // Codex can have already persisted the rotated auth before its next RPC fails.
      try {
        const recovered = readInstalledCredential(home);
        if (recovered && recovered !== raw && credentialIdentity(recovered) === credentialIdentity(raw)) {
          return { credential: recovered, usageUnavailable: true };
        }
      } catch {}
      throw error;
    }
    const current = readInstalledCredential(home);
    if (current && current !== raw && credentialIdentity(current) === credentialIdentity(raw)) read.credential = current;
    if (renew && !read.credential) read.renewalFailed = true;
    return read;
  } finally {
    if (transport) {
      transport.shutdown();
      let timer;
      await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runAccountCheck(transport, renew, closed) {
  return new Promise((resolve, reject) => {
    let id = 0;
    let pending;
    let finished = false;
    const timeout = setTimeout(() => finish(accountError("account_check_timeout", "Codex took too long to check this account.")), 35_000);

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (pending) {
        const reply = pending;
        pending = null;
        reply.reject(error ?? accountError("account_check_failed", "Could not check this account."));
      }
      if (error) reject(error);
      else resolve(result);
    }

    function call(method, params) {
      return new Promise((resolveCall, rejectCall) => {
        pending = { id: ++id, resolve: resolveCall, reject: rejectCall };
        transport.send(JSON.stringify({ id, method, params }));
      });
    }

    const connectionFailed = () => finish(accountError("account_check_failed", "Could not reach Codex to check this account."));
    transport.onError(connectionFailed);
    closed.then(connectionFailed);
    transport.onMessage((line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (finished || !pending || message?.id !== pending.id || message.method) return;
      const reply = pending;
      pending = null;
      if (message.error || !message.result) reply.reject(accountError("account_check_failed", "Codex could not check this account."));
      else reply.resolve(message.result);
    });
    transport.onStarted(async () => {
      try {
        await call("initialize", { clientInfo: { name: "remodex-account-check", version: "1.0.0" } });
        transport.send(JSON.stringify({ method: "initialized" }));
        const result = {};
        if (renew) {
          try { await call("account/read", { refreshToken: true }); }
          catch { result.renewalFailed = true; }
        }
        try { result.usage = await call("account/rateLimits/read", {}); }
        catch { result.usageUnavailable = true; }
        finish(null, result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

module.exports = {
  accountError, activeCredentialFingerprint, credentialFingerprint, credentialIdentity,
  createCredentialCheckRecovery, queryCredential, readInstalledCredential, replaceCodexCredential,
  validateCodexCredentialReplacement, writeInstalledCredential,
};
