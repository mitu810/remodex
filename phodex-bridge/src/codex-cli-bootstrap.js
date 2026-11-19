// FILE: codex-cli-bootstrap.js
// Purpose: Detects, installs, and updates the global Codex CLI with transparent logs for Remodex installs and startup flows.
// Layer: CLI helper
// Exports: ensureCodexCLI, shouldSkipCodexBootstrap
// Depends on: child_process

const { execFileSync } = require("child_process");
const { codexCommandOverride, createCliLaunch, resolveCliExecutable } = require("./codex-launch");

const CODEX_PACKAGE_SPEC = "@openai/codex@latest";
const SKIP_BOOTSTRAP_ENV_NAME = "REMODEX_SKIP_CODEX_BOOTSTRAP";

// Keeps the Codex bootstrap flow explicit and reusable across postinstall and runtime startup paths.
function ensureCodexCLI({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl,
  logger = console,
  shouldUpdate = true,
  npmInstallArgs = ["install", "-g", CODEX_PACKAGE_SPEC],
} = {}) {
  if (shouldSkipCodexBootstrap(env)) {
    logInfo(logger, `[remodex] Skipping Codex CLI bootstrap because ${SKIP_BOOTSTRAP_ENV_NAME}=1.`);
    return {
      status: "skipped",
      versionBefore: null,
      versionAfter: null,
    };
  }

  logInfo(logger, "[remodex] Checking Codex CLI...");
  const versionBefore = readVersion("codex");

  if (versionBefore) {
    logInfo(logger, `[remodex] Codex CLI found (${versionBefore}).`);
  } else {
    logInfo(logger, "[remodex] Codex CLI not found.");
  }

  const override = codexCommandOverride(env, platform);
  if (override && !versionBefore) {
    logWarn(logger, "[remodex] Cannot run REMODEX_CODEX_COMMAND. Check the executable path and permissions.");
    return { status: "failed", versionBefore: null, versionAfter: null };
  }
  if (versionBefore && (!shouldUpdate || override)) {
    return {
      status: "current",
      versionBefore,
      versionAfter: versionBefore,
    };
  }

  const npmVersion = readVersion("npm");

  if (!npmVersion) {
    logWarn(
      logger,
      "[remodex] npm is unavailable, so Remodex could not install or update the Codex CLI automatically."
    );
    return {
      status: "failed",
      versionBefore,
      versionAfter: versionBefore,
    };
  }

  const actionVerb = versionBefore ? "Updating" : "Installing";
  logInfo(logger, `[remodex] ${actionVerb} Codex CLI via npm (${CODEX_PACKAGE_SPEC})...`);

  try {
    runCli("npm", npmInstallArgs, { stdio: "inherit" });
  } catch (error) {
    const message = extractCommandFailureMessage(error);
    logWarn(
      logger,
      `[remodex] Codex CLI ${versionBefore ? "update" : "install"} failed. ${message}`
    );
    return {
      status: "failed",
      versionBefore,
      versionAfter: versionBefore,
    };
  }

  const versionAfter = readVersion("codex");

  if (!versionAfter) {
    logWarn(
      logger,
      "[remodex] Codex CLI bootstrap finished, but `codex --version` is still unavailable in this shell."
    );
    return {
      status: "failed",
      versionBefore,
      versionAfter: versionBefore,
    };
  }

  logInfo(
    logger,
    `[remodex] Codex CLI ${versionBefore ? "updated" : "installed"} (${versionAfter}).`
  );
  return {
    status: versionBefore ? "updated" : "installed",
    versionBefore,
    versionAfter,
  };

  function runCli(name, args, options) {
    const file = resolveCliExecutable(name, { env, platform, fsImpl });
    const launch = createCliLaunch(file, args, { ...options, env }, platform);
    return execFileSyncImpl(launch.command, launch.args, launch.options);
  }

  function readVersion(name) {
    try {
      return parseVersion(runCli(name, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch {
      return null;
    }
  }
}

function shouldSkipCodexBootstrap(env = process.env) {
  const raw = String(env[SKIP_BOOTSTRAP_ENV_NAME] || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseVersion(output) {
  const match = String(output || "").match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? match[0] : null;
}

function extractCommandFailureMessage(error) {
  const stderr = error?.stderr?.toString?.("utf8")?.trim();
  const stdout = error?.stdout?.toString?.("utf8")?.trim();
  const fallback = error?.message?.trim();
  return stderr || stdout || fallback || "No additional details were reported.";
}

function logInfo(logger, message) {
  const writer = typeof logger?.log === "function" ? logger.log.bind(logger) : console.log;
  writer(message);
}

function logWarn(logger, message) {
  if (typeof logger?.warn === "function") {
    logger.warn(message);
    return;
  }

  if (typeof logger?.error === "function") {
    logger.error(message);
    return;
  }

  logInfo(logger, message);
}

module.exports = {
  ensureCodexCLI,
  shouldSkipCodexBootstrap,
};
