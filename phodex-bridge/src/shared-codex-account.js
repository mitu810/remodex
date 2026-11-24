// Switch file-backed credentials for the local Mac app-server daemon that owns this socket.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createCodexLaunchPlans } = require("./codex-launch");
const {
  accountError, readInstalledCredential, replaceCodexCredential,
  validateCodexCredentialReplacement, writeInstalledCredential,
} = require("./account-credentials");

const execFileAsync = promisify(execFile);
const unsupported = () => accountError("account_external_runtime",
  "Credential replacement requires a Codex process managed by this bridge.");

function samePath(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
}

function isLocalSharedCodex({ platform = process.platform, endpoint, home, server }) {
  if (platform !== "darwin" || server?.platformOs !== "macos" || !samePath(server.codexHome, home)) return false;
  const match = /^ws\+unix:\/\/localhost(\/[^?#]+):\/rpc$/.exec(endpoint);
  return !!match && samePath(match[1], path.join(home, "app-server-control", "app-server-control.sock"));
}

function daemonCommands(home, appPath) {
  const env = { ...process.env, CODEX_HOME: home };
  const commands = createCodexLaunchPlans({ env, appPath }).map(plan => plan.command);
  let selected;
  return async operation => {
    for (const command of selected ? [selected] : commands) {
      try {
        const { stdout } = await execFileAsync(command, ["app-server", "daemon", operation],
          { env, timeout: operation === "version" ? 5000 : 30000 });
        if (operation !== "version") return;
        const info = JSON.parse(stdout);
        selected = command;
        return info;
      } catch {
        if (selected) throw accountError("account_daemon_failed", "Codex could not restart the shared account service.");
      }
    }
    throw unsupported();
  };
}

async function requireIdleThreads(rpc) {
  const busy = () => accountError("account_runtime_busy", "Finish active Codex runs and sign-ins before applying a credential.");
  const seen = new Set();
  let cursor = null;
  do {
    const page = await rpc("thread/loaded/list", { cursor, limit: 16 });
    if (!Array.isArray(page?.data)) throw busy();
    const rows = await Promise.all(page.data.map(threadId => rpc("thread/read", { threadId, includeTurns: false })));
    if (rows.some(row => !["idle", "notLoaded", "systemError"].includes(row?.thread?.status?.type))) throw busy();
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== "string" || seen.has(cursor))) throw busy();
    seen.add(cursor);
  } while (cursor);
}

async function prepareSharedAccountSwitch(options) {
  const { home, credential, rpc, appPath, daemon = daemonCommands(home, appPath) } = options;
  if (!isLocalSharedCodex(options)) throw unsupported();
  const info = await daemon("version");
  if (info?.status !== "running" || !["pid", "launchd"].includes(info.backend)
    || !samePath(info.socketPath, path.join(home, "app-server-control", "app-server-control.sock"))) throw unsupported();
  const previous = validateCodexCredentialReplacement(home, credential);
  await requireIdleThreads(rpc);

  // The supervisor closes its own socket before this runs. Stop the daemon before writing:
  // a still-running account can rotate its tokens during shutdown.
  return async () => {
    try {
      await daemon("stop");
    } catch (error) {
      // A timed-out stop may already have taken effect. Start is idempotent.
      await daemon("start");
      throw error;
    }
    let replaced = false;
    try {
      if (previous !== readInstalledCredential(home)) {
        throw accountError("account_file_changed", "Codex updated the host credential during the operation. Try again.");
      }
      replaced = replaceCodexCredential(home, credential).restartRequired;
      await daemon("start");
    } catch (failure) {
      try {
        if (replaced && readInstalledCredential(home) === credential) writeInstalledCredential(home, credential, previous);
      } finally {
        await daemon("start");
      }
      throw failure;
    }
  };
}

module.exports = { isLocalSharedCodex, prepareSharedAccountSwitch, requireIdleThreads };
