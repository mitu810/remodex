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

function usableCredentialFingerprint(account, authStatus) {
  if (!isChatGPTAuthMethod(account?.account?.type) || !isChatGPTAuthMethod(authStatus?.authMethod)
    || typeof authStatus?.authToken !== "string" || !authStatus.authToken.trim()) return null;
  if (Object.hasOwn(account, "workspaceRouting") && !account.workspaceRouting?.chatgptAccountId) return null;
  const live = activeCredentialFingerprint(account, authStatus);
  const bearer = activeCredentialFingerprint(null, authStatus);
  return bearer && bearer !== live ? null : live;
}

// Some shared daemons retain a selected ChatGPT session while token/routing reads
// are incomplete. Its identity is authoritative independently of token readiness.
async function readLiveAccountIdentity(account, authStatus, listSessions) {
  const direct = activeCredentialFingerprint(account, authStatus);
  const email = account?.account?.email || null;
  const method = authStatus?.authMethod || account?.account?.type;
  if (!isChatGPTAuthMethod(method) || (direct && email)) return { fingerprint: direct, email };
  let sessions;
  try { sessions = await listSessions(); } catch { return { fingerprint: direct, email }; }
  const active = sessions?.activeSessionId && Array.isArray(sessions.sessions)
    && sessions.sessions.find(row => row?.sessionId === sessions.activeSessionId && row.isActive === true);
  if (typeof active?.userId !== "string" || !active.userId
    || typeof active.selectedWorkspaceAccountId !== "string" || !active.selectedWorkspaceAccountId) {
    return { fingerprint: direct, email };
  }
  const selected = fingerprint(active.userId, active.selectedWorkspaceAccountId);
  // Reads can straddle a desktop account switch. Never combine two identities.
  if ((account?.userId && account.userId !== active.userId)
    || (account?.workspaceRouting?.chatgptAccountId && account.workspaceRouting.chatgptAccountId !== active.selectedWorkspaceAccountId)
    || (direct && selected !== direct)) return { fingerprint: direct, email };
  return { fingerprint: selected, email: email || (typeof active.email === "string" && active.email) || null };
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
  return withIsolatedAccount(appPath, env, createTransport, async (home, connect) => {
    writePrivateFile(path.join(home, "auth.json"), raw);
    let read;
    try {
      read = await connect(async call => {
        const result = {};
        if (renew) {
          try { await call("account/read", { refreshToken: true }); }
          catch { result.renewalFailed = true; }
        }
        try { result.usage = await call("account/rateLimits/read", {}); }
        catch { result.usageUnavailable = true; }
        return result;
      });
    } catch (error) {
      // Preserve a rotation even when the next RPC or the transport fails.
      const recovered = readInstalledCredential(home);
      if (!recovered || recovered === raw || credentialIdentity(recovered) !== credentialIdentity(raw)) throw error;
      return { credential: recovered, usageUnavailable: true };
    }
    const current = readInstalledCredential(home);
    if (current && current !== raw && credentialIdentity(current) === credentialIdentity(raw)) read.credential = current;
    if (renew && !read.credential) read.renewalFailed = true;
    return read;
  });
}

// Verify the bearer with the backend without handing the probe a refresh token.
// Only the destination's managed Codex may rotate a credential during a switch.
async function checkSharedCredential(raw, appPath, createTransport = createCodexTransport) {
  const { tokens } = parseCredential(raw);
  const [, workspace] = JSON.parse(credentialIdentity(raw));
  try {
    await withIsolatedAccount(appPath, process.env, createTransport, (_home, connect) => connect(async call => {
      await call("account/login/start", {
        type: "chatgptAuthTokens", accessToken: tokens.access_token, chatgptAccountId: workspace,
      });
      await call("account/rateLimits/read", {});
    }));
  } catch {
    throw accountError("account_credential_unverified",
      "Codex could not verify this saved account online. Check the connection, renew the saved credential or import a fresh auth.json, then try again.");
  }
}

async function withIsolatedAccount(appPath, env, createTransport, operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-credential-"));
  try {
    ensurePrivateDirectory(home);
    writePrivateFile(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const isolatedEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/^(CODEX_HOME|OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_BASE_URL|CODEX_BASE_URL)$/i.test(key)));
    return await operation(home, check => withAccountTransport(
      createTransport({ appPath, env: { ...isolatedEnv, CODEX_HOME: home } }), check));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function withAccountTransport(transport, check) {
  const closed = new Promise(resolve => transport.onClose(resolve));
  try {
    return await runAccountCheck(transport, check, closed);
  } finally {
    transport.shutdown({ forceAfterMs: 1000 });
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
  }
}

function runAccountCheck(transport, check, closed) {
  return new Promise((resolve, reject) => {
    let id = 0;
    const pending = new Map();
    let finished = false;
    const timeout = setTimeout(() => finish(accountError("account_check_timeout", "Codex took too long to check this account.")), 35_000);

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      for (const reply of pending.values()) {
        reply.reject(error ?? accountError("account_check_failed", "Could not check this account."));
      }
      pending.clear();
      if (error) reject(error);
      else resolve(result);
    }

    function call(method, params) {
      if (finished) return Promise.reject(accountError("account_check_failed", "The Codex account check ended."));
      return new Promise((resolveCall, rejectCall) => {
        pending.set(++id, { resolve: resolveCall, reject: rejectCall });
        transport.send(JSON.stringify({ id, method, params }));
      });
    }

    const connectionFailed = () => finish(accountError("account_check_failed", "Could not reach Codex to check this account."));
    transport.onError(connectionFailed);
    closed.then(connectionFailed);
    transport.onMessage((line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const reply = pending.get(message?.id);
      if (finished || !reply || message.method) return;
      pending.delete(message.id);
      if (message.error || !message.result) reply.reject(accountError("account_check_failed", "Codex could not check this account."));
      else reply.resolve(message.result);
    });
    transport.onStarted(async () => {
      try {
        await call("initialize", { clientInfo: { name: "remodex-account-check", version: "1.0.0" }, capabilities: { experimentalApi: true } });
        transport.send(JSON.stringify({ method: "initialized" }));
        finish(null, await check(call));
      } catch (error) {
        finish(error);
      }
    });
  });
}

module.exports = {
  accountError, activeCredentialFingerprint, usableCredentialFingerprint, checkSharedCredential, withAccountTransport, credentialFingerprint, credentialIdentity,
  createCredentialCheckRecovery, queryCredential, readInstalledCredential, replaceCodexCredential,
  validateCodexCredentialReplacement, writeInstalledCredential, readLiveAccountIdentity,
};
