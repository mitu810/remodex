// FILE: macos-launch-agent.js
// Purpose: Owns macOS-only launchd install/start/stop/uninstall/status helpers for the background Remodex bridge.
// Layer: CLI helper
// Exports: start/stop/uninstall/status helpers plus the launchd service runner used by `remodex up`.
// Depends on: child_process, fs, os, path, ./bridge, ./daemon-state, ./codex-desktop-refresher, ./qr, ./secure-device-state

const { execFileSync } = require("child_process");
const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readBridgeConfig } = require("./codex-desktop-refresher");
const { printQR } = require("./qr");
const { readBridgeDeviceState, resetBridgeTrustState } = require("./secure-device-state");
const {
  clearBridgeStatus,
  clearPairingSession,
  ensureRemodexLogsDir,
  ensureRemodexStateDir,
  readBridgeStatus,
  readDaemonConfig,
  readLivePairingSession,
  readPairingSession,
  resolveBridgeStderrLogPath,
  resolveBridgeStdoutLogPath,
  resolveRemodexStateDir,
  writeBridgeStatus,
  writeDaemonConfig,
  writePairingSession,
} = require("./daemon-state");

const { runBridgeService, mergeBridgeStatusForDaemon } = require('./service-runner');

const SERVICE_LABEL = "com.remodex.bridge";
const DEFAULT_PAIRING_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_PAIRING_WAIT_INTERVAL_MS = 200;

// If the saved Node binary or CLI entrypoint disappears (npm uninstall, deleted
// checkout), exit 0 so launchd's KeepAlive.SuccessfulExit=false stops rescheduling
// the job; `exec` keeps genuine daemon failures non-zero so they still restart.
const LAUNCH_AGENT_GUARD_SCRIPT = 'if [ ! -x "$1" ] || [ ! -f "$2" ]; then exit 0; fi; exec "$1" "$2" run-service';

// Keeps the guard script constant: the installed paths are shell positionals, never interpolated source.
function buildLaunchAgentProgramArguments({ nodePath, cliPath }) {
  return [
    "/bin/sh",
    "-c",
    LAUNCH_AGENT_GUARD_SCRIPT,
    SERVICE_LABEL,
    nodePath,
    cliPath,
  ];
}

// Runs the bridge inside launchd while keeping QR rendering in the foreground CLI command.
function runMacOSBridgeService({ env = process.env, platform = process.platform } = {}) {
  assertDarwinPlatform(platform);
  return runBridgeService({
    env,
    useLock: false,
    missingConfigMessage: "No relay URL configured for the macOS bridge service.",
  });
}

// Prepares config + launchd state and optionally waits for the fresh pairing payload written by the service.
async function startMacOSBridgeService({
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
  osImpl = os,
  nodePath = process.execPath,
  cliPath = path.resolve(__dirname, "..", "bin", "remodex.js"),
  waitForPairing = false,
  pairingTimeoutMs = DEFAULT_PAIRING_WAIT_TIMEOUT_MS,
  pairingPollIntervalMs = DEFAULT_PAIRING_WAIT_INTERVAL_MS,
} = {}) {
  assertDarwinPlatform(platform);
  const config = readBridgeConfig({ env });
  assertRelayConfigured(config);
  const startedAt = Date.now();

  writeDaemonConfig({ ...config, serviceEnvironment: readDaemonConfig({ env, fsImpl })?.serviceEnvironment }, { env, fsImpl });
  clearPairingSession({ env, fsImpl });
  clearBridgeStatus({ env, fsImpl });
  ensureRemodexStateDir({ env, fsImpl, osImpl });
  ensureRemodexLogsDir({ env, fsImpl, osImpl });

  const plistPath = writeLaunchAgentPlist({
    env,
    fsImpl,
    osImpl,
    nodePath,
    cliPath,
  });
  restartLaunchAgent({
    env,
    execFileSyncImpl,
    plistPath,
  });

  if (!waitForPairing) {
    return {
      plistPath,
      pairingSession: null,
    };
  }

  const pairingSession = await waitForFreshPairingSession({
    env,
    fsImpl,
    startedAt,
    timeoutMs: pairingTimeoutMs,
    intervalMs: pairingPollIntervalMs,
  });
  return {
    plistPath,
    pairingSession,
  };
}

// Restarts the installed LaunchAgent without rewriting relay config, regenerating the plist so
// legacy launch definitions pick up the current Node/CLI paths and launch policy.
async function restartMacOSBridgeService({
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
  osImpl = os,
  nodePath = process.execPath,
  cliPath = path.resolve(__dirname, "..", "bin", "remodex.js"),
  waitForPairing = false,
  pairingTimeoutMs = DEFAULT_PAIRING_WAIT_TIMEOUT_MS,
  pairingPollIntervalMs = DEFAULT_PAIRING_WAIT_INTERVAL_MS,
} = {}) {
  assertDarwinPlatform(platform);
  const plistPath = resolveLaunchAgentPlistPath({ env, osImpl });
  if (!fsImpl.existsSync(plistPath)) {
    return startMacOSBridgeService({
      env,
      platform,
      fsImpl,
      execFileSyncImpl,
      osImpl,
      nodePath,
      cliPath,
      waitForPairing,
      pairingTimeoutMs,
      pairingPollIntervalMs,
    });
  }

  const startedAt = Date.now();
  if (waitForPairing) {
    clearPairingSession({ env, fsImpl });
  }

  ensureRemodexStateDir({ env, fsImpl, osImpl });
  ensureRemodexLogsDir({ env, fsImpl, osImpl });
  writeLaunchAgentPlist({
    env,
    fsImpl,
    osImpl,
    nodePath,
    cliPath,
  });
  restartLaunchAgent({
    env,
    execFileSyncImpl,
    plistPath,
  });

  if (waitForPairing) {
    const pairingSession = await waitForFreshPairingSession({
      env,
      fsImpl,
      startedAt,
      timeoutMs: pairingTimeoutMs,
      intervalMs: pairingPollIntervalMs,
    });
    return {
      plistPath,
      pairingSession,
    };
  }

  return {
    plistPath,
    pairingSession: null,
  };
}

function stopMacOSBridgeService({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  processImpl = process,
} = {}) {
  assertDarwinPlatform(platform);
  const previousStatus = readBridgeStatus({ env, fsImpl });
  bootoutLaunchAgent({
    env,
    execFileSyncImpl,
    ignoreMissing: true,
  });
  terminateRecordedBridgeProcess(previousStatus, {
    execFileSyncImpl,
    processImpl,
  });
  clearPairingSession({ env, fsImpl });
  clearBridgeStatus({ env, fsImpl });
}

// Removes launchd ownership of the bridge (unload + plist) while preserving daemon config,
// logs, device trust, and pairing identity for a future reinstall.
function uninstallMacOSBridgeService({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  osImpl = os,
  processImpl = process,
} = {}) {
  assertDarwinPlatform(platform);
  const plistPath = resolveLaunchAgentPlistPath({ env, osImpl });
  const removed = fsImpl.existsSync(plistPath);
  // Stop first: a real bootout failure throws here and leaves the plist on disk.
  stopMacOSBridgeService({
    env,
    platform,
    execFileSyncImpl,
    fsImpl,
    processImpl,
  });
  fsImpl.rmSync(plistPath, { force: true });
  return { plistPath, removed };
}

// Revokes pairing immediately on macOS by stopping the daemon before rotating identity/trust state.
function resetMacOSBridgePairing({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  resetBridgePairingImpl = resetBridgeTrustState,
} = {}) {
  assertDarwinPlatform(platform);
  stopMacOSBridgeService({
    env,
    platform,
    execFileSyncImpl,
    fsImpl,
  });
  return resetBridgePairingImpl();
}

// Stops orphaned run-service processes left behind when launchd reports the job missing.
function terminateRecordedBridgeProcess(status, {
  execFileSyncImpl = execFileSync,
  processImpl = process,
} = {}) {
  const pid = Number(status?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === processImpl.pid) {
    return false;
  }

  if (!isRecordedRemodexBridgeProcess(pid, { execFileSyncImpl })) {
    return false;
  }

  try {
    processImpl.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// Checks the command line before killing so stale status files cannot target unrelated processes.
function isRecordedRemodexBridgeProcess(pid, { execFileSyncImpl = execFileSync } = {}) {
  try {
    const command = execFileSyncImpl("ps", [
      "-p",
      String(pid),
      "-o",
      "command=",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return command.includes("remodex")
      && command.includes("run-service");
  } catch {
    return false;
  }
}

function getMacOSBridgeServiceStatus({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
} = {}) {
  assertDarwinPlatform(platform);
  const launchd = readLaunchAgentState({ env, execFileSyncImpl });
  return {
    label: SERVICE_LABEL,
    platform: "darwin",
    installed: fsImpl.existsSync(resolveLaunchAgentPlistPath({ env })),
    launchdLoaded: launchd.loaded,
    launchdPid: launchd.pid,
    daemonConfig: readDaemonConfig({ env, fsImpl }),
    bridgeStatus: readBridgeStatus({ env, fsImpl }),
    pairingSession: readPairingSession({ env, fsImpl }),
    trustedDevice: buildTrustedDeviceSummary(readBridgeDeviceState()),
    stdoutLogPath: resolveBridgeStdoutLogPath({ env }),
    stderrLogPath: resolveBridgeStderrLogPath({ env }),
  };
}

function printMacOSBridgeServiceStatus(options = {}) {
  const status = getMacOSBridgeServiceStatus(options);
  const bridgeState = status.bridgeStatus?.state || "unknown";
  const connectionStatus = status.bridgeStatus?.connectionStatus || "unknown";
  const pairingCreatedAt = status.pairingSession?.createdAt || "none";
  const activeDevice = status.bridgeStatus?.activeDevice || status.bridgeStatus?.activePhone;
  const trustedPhoneCount = status.trustedDevice?.trustedPhoneCount || 0;
  const activeDeviceName = formatDeviceKind(activeDevice?.deviceKind) || "device";
  const trustedDeviceName = formatDeviceKind(status.trustedDevice?.lastSeenDeviceKind) || "device";
  console.log(`[remodex] Service label: ${status.label}`);
  console.log(`[remodex] Installed: ${status.installed ? "yes" : "no"}`);
  console.log(`[remodex] Launchd loaded: ${status.launchdLoaded ? "yes" : "no"}`);
  console.log(`[remodex] PID: ${status.launchdPid || status.bridgeStatus?.pid || "unknown"}`);
  console.log(`[remodex] Bridge state: ${bridgeState}`);
  console.log(`[remodex] Connection: ${connectionStatus}`);
  console.log(`[remodex] Active ${activeDeviceName}: ${activeDevice?.connected ? activeDevice.phoneFingerprint || "yes" : "no"}`);
  console.log(`[remodex] Trusted ${trustedDeviceName}: ${trustedPhoneCount > 0 ? "yes" : "no"}`);
  console.log(`[remodex] Pairing payload: ${pairingCreatedAt}`);
  console.log(`[remodex] Stdout log: ${status.stdoutLogPath}`);
  console.log(`[remodex] Stderr log: ${status.stderrLogPath}`);
}

function readMacOSBridgePairingSession({ env = process.env, fsImpl = fs, execFileSyncImpl = execFileSync } = {}) {
  const launchd = readLaunchAgentState({ env, execFileSyncImpl });
  return launchd.pid ? readLivePairingSession({ env, fsImpl }) : null;
}

function printMacOSBridgePairingQr({ pairingSession = null, includeCopyableCode = false, ...options } = {}) {
  const nextPairingSession = pairingSession || readMacOSBridgePairingSession(options);
  if (!nextPairingSession?.pairingPayload || nextPairingSession.pairingPayload.expiresAt <= Date.now()) {
    throw new Error("No live pairing QR is available. Run `remodex qr --refresh` for a new invitation.");
  }

  printQR(nextPairingSession, { includeCopyableCode });
}

// Persists a launch agent that always runs the Node CLI entrypoint in service mode.
function writeLaunchAgentPlist({
  env = process.env,
  fsImpl = fs,
  osImpl = os,
  nodePath = process.execPath,
  cliPath = path.resolve(__dirname, "..", "bin", "remodex.js"),
} = {}) {
  const plistPath = resolveLaunchAgentPlistPath({ env, osImpl });
  const stateDir = resolveRemodexStateDir({ env, osImpl });
  const stdoutLogPath = resolveBridgeStdoutLogPath({ env, osImpl });
  const stderrLogPath = resolveBridgeStderrLogPath({ env, osImpl });
  const homeDir = env.HOME || osImpl.homedir();
  const daemonConfig = readDaemonConfig({ env, fsImpl }) || {};
  const serviceEnvironment = { ...daemonConfig.serviceEnvironment };
  for (const key of ['CODEX_HOME', 'REMODEX_CODEX_COMMAND', 'REMODEX_DEVICE_STATE_FILE']) {
    if (typeof env[key] === 'string') serviceEnvironment[key] = env[key];
  }
  if (Object.keys(serviceEnvironment).length) writeDaemonConfig({ ...daemonConfig, serviceEnvironment }, { env, fsImpl });
  const serialized = buildLaunchAgentPlist({
    homeDir,
    pathEnv: env.PATH || "",
    serviceEnvironment,
    stateDir,
    stdoutLogPath,
    stderrLogPath,
    nodePath,
    cliPath,
  });

  fsImpl.mkdirSync(path.dirname(plistPath), { recursive: true });
  fsImpl.writeFileSync(plistPath, serialized, "utf8");
  return plistPath;
}

function buildLaunchAgentPlist({
  serviceEnvironment = {},
  homeDir,
  pathEnv,
  stateDir,
  stdoutLogPath,
  stderrLogPath,
  nodePath,
  cliPath,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${buildLaunchAgentProgramArguments({ nodePath, cliPath })
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homeDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(homeDir)}</string>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
    <key>REMODEX_DEVICE_STATE_DIR</key>
    <string>${escapeXml(stateDir)}</string>
${Object.entries(serviceEnvironment).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLogPath)}</string>
</dict>
</plist>
`;
}

async function waitForFreshPairingSession({
  env = process.env,
  fsImpl = fs,
  startedAt = Date.now(),
  timeoutMs = DEFAULT_PAIRING_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_PAIRING_WAIT_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const pairingSession = readLivePairingSession({ env, fsImpl, startedAt });
    if (pairingSession) return pairingSession;
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for the macOS bridge service to publish a pairing QR. `
    + `Check ${resolveBridgeStderrLogPath({ env })}.`
  );
}

function restartLaunchAgent({
  env = process.env,
  execFileSyncImpl = execFileSync,
  plistPath,
} = {}) {
  bootoutLaunchAgent({
    env,
    execFileSyncImpl,
    ignoreMissing: true,
  });
  execFileSyncImpl("launchctl", [
    "bootstrap",
    launchAgentDomain(env),
    plistPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSyncImpl("launchctl", [
    "kickstart",
    "-k",
    launchAgentLabelDomain(env),
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

function bootoutLaunchAgent({
  env = process.env,
  execFileSyncImpl = execFileSync,
  ignoreMissing = false,
} = {}) {
  const bootoutTargets = [
    // Some macOS setups only fully unload the agent when bootout targets the plist path.
    [launchAgentDomain(env), resolveLaunchAgentPlistPath({ env })],
    [launchAgentLabelDomain(env)],
  ];
  let lastError = null;

  for (const targetArgs of bootoutTargets) {
    try {
      execFileSyncImpl("launchctl", [
        "bootout",
        ...targetArgs,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (ignoreMissing && isMissingLaunchAgentError(lastError)) {
    return;
  }
  throw lastError;
}

function readLaunchAgentState({
  env = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    const output = execFileSyncImpl("launchctl", [
      "print",
      launchAgentLabelDomain(env),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return {
      loaded: true,
      pid: parseLaunchdPid(output),
      raw: output,
    };
  } catch (error) {
    if (isMissingLaunchAgentError(error)) {
      return {
        loaded: false,
        pid: null,
        raw: "",
      };
    }
    throw error;
  }
}

function resolveLaunchAgentPlistPath({ env = process.env, osImpl = os } = {}) {
  const homeDir = env.HOME || osImpl.homedir();
  return path.join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function assertDarwinPlatform(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error("macOS bridge service management is only available on macOS.");
  }
}

function assertRelayConfigured(config) {
  if (typeof config?.relayUrl === "string" && config.relayUrl.trim()) {
    return;
  }
  throw new Error("No relay URL configured. Run ./run-local-remodex.sh or set REMODEX_RELAY before enabling the macOS bridge service.");
}

function launchAgentDomain(env) {
  return `gui/${resolveUid(env)}`;
}

function launchAgentLabelDomain(env) {
  return `${launchAgentDomain(env)}/${SERVICE_LABEL}`;
}

function resolveUid(env) {
  if (typeof process.getuid === "function") {
    return process.getuid();
  }

  const uid = Number.parseInt(env.UID || "", 10);
  if (Number.isFinite(uid)) {
    return uid;
  }

  throw new Error("Could not determine the current macOS user id for launchctl.");
}

function parseLaunchdPid(output) {
  const match = typeof output === "string" ? output.match(/\bpid = (\d+)/) : null;
  return match ? Number.parseInt(match[1], 10) : null;
}

function isMissingLaunchAgentError(error) {
  const combined = [
    error?.message,
    error?.stderr?.toString?.("utf8"),
    error?.stdout?.toString?.("utf8"),
  ].filter(Boolean).join("\n").toLowerCase();
  return combined.includes("could not find service")
    || combined.includes("service could not be found")
    || combined.includes("no such process");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function buildTrustedDeviceSummary(deviceState) {
  const trustedPhoneEntries = Object.entries(deviceState?.trustedPhones || {})
    .filter(([phoneDeviceId, publicKey]) => normalizeNonEmptyString(phoneDeviceId) && normalizeNonEmptyString(publicKey));
  const firstTrustedPhoneId = trustedPhoneEntries[0]?.[0] || "";
  const lastSeenPhoneAppVersion = normalizeNonEmptyString(deviceState?.lastSeenPhoneAppVersion) || null;
  return {
    macDeviceFingerprint: shortFingerprint(deviceState?.macDeviceId),
    trustedPhoneCount: trustedPhoneEntries.length,
    trustedPhoneFingerprint: shortFingerprint(firstTrustedPhoneId),
    lastSeenDeviceKind: normalizeNonEmptyString(deviceState?.lastSeenDeviceKind) || (lastSeenPhoneAppVersion ? "iphone" : null),
    lastSeenPhoneAppVersion,
  };
}

function formatDeviceKind(deviceKind) {
  const normalized = normalizeNonEmptyString(deviceKind).toLowerCase();
  if (normalized === "iphone") {
    return "iPhone";
  }
  if (normalized === "android") {
    return "Android";
  }
  if (normalized === "mac") {
    return "Mac";
  }
  return "";
}

function shortFingerprint(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return null;
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

module.exports = {
  buildTrustedDeviceSummary,
  buildLaunchAgentPlist,
  buildLaunchAgentProgramArguments,
  getMacOSBridgeServiceStatus,
  readMacOSBridgePairingSession,
  mergeBridgeStatusForDaemon,
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  resetMacOSBridgePairing,
  resolveLaunchAgentPlistPath,
  restartMacOSBridgeService,
  runMacOSBridgeService,
  startMacOSBridgeService,
  stopMacOSBridgeService,
  uninstallMacOSBridgeService,
};
