const fs = require("fs");
const path = require("path");
const { resolveBundledCodexCommand, resolveCodexAppPath } = require("./codex-desktop-app");

// Codex unloads only unsubscribed, inactive threads. This keeps explicit desktop handoffs responsive.
const APP_SERVER_ARGS = ["app-server", "-c", "thread_unload_delay_secs=1"];
const COMMAND_ENV = "REMODEX_CODEX_COMMAND";

function createCodexLaunchPlans({
  env = process.env,
  appPath = "",
  platform = process.platform,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const command = resolveCliExecutable("codex", { env, platform, fsImpl });
  const options = { env: { ...env }, stdio: ["pipe", "pipe", "pipe"] };
  const launches = [appServerLaunch(command)];
  if (platform === "darwin" && !codexCommandOverride(env, platform)) {
    const bundled = resolveBundledCodexCommand(
      resolveCodexAppPath({ appPath, platform, homeDir: env.HOME, fsImpl }),
      { fsImpl, pathImpl }
    );
    if (bundled) launches.push(appServerLaunch(bundled));
  }
  return launches;

  function appServerLaunch(file) {
    return {
      ...createCliLaunch(file, APP_SERVER_ARGS, options, platform),
      description: `\`${file} app-server\``,
    };
  }
}

function codexCommandOverride(env, platform) {
  return platform === "win32" ? windowsEnv(env, COMMAND_ENV) : env[COMMAND_ENV];
}

function resolveCliExecutable(name, { env, platform, fsImpl = fs }) {
  const override = name === "codex" && codexCommandOverride(env, platform);
  if (override) {
    if (platform === "win32") {
      if (!isWindowsAbsolutePath(override) || !/\.(exe|cmd)$/i.test(override)) {
        throw new Error(`${COMMAND_ENV} must be an absolute path to a .exe or .cmd file.`);
      }
    } else if (!path.posix.isAbsolute(override) || override.includes("\0")) {
      throw new Error(`${COMMAND_ENV} must be an absolute executable path.`);
    }
    return override;
  }
  if (platform !== "win32") return name;
  // A quoted Windows PATH entry can contain literal semicolons.
  const entries = (windowsEnv(env, "PATH") || "").match(/(?:"[^"]*"|[^;])+/g) || [];
  const dirs = entries
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(isWindowsAbsolutePath);
  for (const extension of ["exe", "cmd"]) {
    for (const dir of dirs) {
      const candidate = path.win32.join(dir, `${name}.${extension}`);
      try {
        if (fsImpl.statSync(candidate).isFile()) return candidate;
      } catch {
        // Skip missing and inaccessible PATH entries.
      }
    }
  }
  const hint = name === "codex" ? ` Install Codex or set ${COMMAND_ENV} to its absolute path.` : "";
  throw new Error(`Cannot find ${name}.exe or ${name}.cmd on PATH.${hint}`);
}

function createCliLaunch(command, args, options, platform) {
  if (platform !== "win32") return { command, args, options };
  if (!/\.cmd$/i.test(command)) return { command, args, options: { ...options, windowsHide: true } };
  // Only the bridge's fixed switches, package names and config tokens are used as cmd syntax.
  if (!args.every((arg) => /^[a-z0-9._/@:=+-]+$/i.test(arg))) {
    throw new Error("Unsupported argument for a Windows command shim.");
  }
  // cmd expands the quoted variable once. The filename (including %, ! and &) stays out of its syntax.
  return {
    command: windowsSystemTool("cmd.exe", options.env),
    args: ["/d", "/v:off", "/s", "/c", `""%REMODEX_SHIM_FILE%" ${args.join(" ")}"`],
    options: {
      ...options,
      env: { ...options.env, REMODEX_SHIM_FILE: command },
      windowsVerbatimArguments: true,
      windowsHide: true,
    },
  };
}

function isWindowsAbsolutePath(value) {
  // win32.isAbsolute also accepts paths relative to the current drive, such as "\\bin".
  return typeof value === "string" && !/["\x00-\x1f]/.test(value)
    && /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value);
}

function windowsEnv(env, name) {
  const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function windowsSystemTool(name, env) {
  const systemRoot = windowsEnv(env, "SystemRoot") || process.env.SystemRoot;
  return path.win32.join(isWindowsAbsolutePath(systemRoot) ? systemRoot : "C:\\Windows", "System32", name);
}

module.exports = { codexCommandOverride, createCliLaunch, createCodexLaunchPlans, resolveCliExecutable, windowsSystemTool };
