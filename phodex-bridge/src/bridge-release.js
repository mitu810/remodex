// Resolves stable bridge updates from this fork's GitHub releases.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { releaseRepository, version } = require("../package.json");

const repositoryURL = `https://github.com/${releaseRepository}`;
const latestReleaseURL = `https://api.github.com/repos/${releaseRepository}/releases/latest`;
const archiveName = "remodex-bridge-update.zip";
const maxArchiveSize = 8 * 1024 * 1024;
const updaterName = "update-remodex-bridge.cjs";
const updaterPath = path.join(__dirname, "..", "scripts", updaterName);
const execFileAsync = promisify(execFile);
const bridgeRoot = path.join(__dirname, "..");

class ReleaseValidationError extends Error {}

function supportsBridgeReleaseArchive() {
  const installRoot = path.dirname(bridgeRoot);
  return fs.existsSync(updaterPath)
    && fs.existsSync(path.join(installRoot, "setup-server.cjs"))
    && !fs.existsSync(path.join(installRoot, ".git"));
}

function parseBridgeRelease(release) {
  const tag = release?.tag_name;
  if (release?.draft !== false || release?.prerelease !== false
      || typeof tag !== "string" || !/^v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(tag)
      || !Array.isArray(release.assets)) {
    return null;
  }
  const url = `${repositoryURL}/releases/download/${tag}/${archiveName}`;
  const asset = release.assets.find((entry) => entry?.name === archiveName);
  if (asset?.browser_download_url !== url || asset?.state !== "uploaded"
      || !Number.isInteger(asset.size) || asset.size <= 0 || asset.size > maxArchiveSize
      || typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) {
    return null;
  }
  return { version: tag.slice(1), url, sha256: asset.digest.slice(7), size: asset.size };
}

async function fetchLatestBridgeRelease({ fetchImpl = fetch, signal = AbortSignal.timeout(4000) } = {}) {
  const response = await fetchImpl(latestReleaseURL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Remodex-Bridge" },
    redirect: "error",
    signal,
  });
  if (!response.ok) throw await httpFailure(response);
  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new ReleaseValidationError("GitHub returned invalid release JSON.");
    throw error;
  }
  const release = parseBridgeRelease(metadata);
  if (!release) throw new ReleaseValidationError("The latest GitHub release does not contain a verified bridge update.");
  return release;
}

function supportsInstalledBridgeUpdate() {
  if (process.platform !== "darwin" || !supportsBridgeReleaseArchive()) {
    return false;
  }
  try {
    const { readMacService } = require(updaterPath);
    const service = readMacService(
      (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }),
      os.homedir(),
      process.getuid()
    );
    return fs.realpathSync(service.entryPath) === fs.realpathSync(currentCLI());
  } catch {
    return false;
  }
}

function currentCLI() {
  return path.join(__dirname, "..", "bin", "remodex.js");
}

async function httpFailure(response) {
  await response.body?.cancel().catch(() => {});
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = /^\d+$/.test(retryAfter || "")
    ? Number(retryAfter) * 1000 : Math.max(0, (Date.parse(retryAfter) || 0) - Date.now());
  return Object.assign(new Error(`GitHub returned HTTP ${response.status}.`), { status: response.status, retryAfterMs });
}

async function downloadBridgeArchive(release, fetchImpl, signal) {
  const response = await fetchImpl(release.url, { signal });
  if (!response.ok) throw await httpFailure(response);
  if (!response.body) throw new ReleaseValidationError("GitHub returned an empty download.");
  const hash = createHash("sha256");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > release.size) throw new ReleaseValidationError("The bridge download exceeds the published size.");
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (size !== release.size || hash.digest("hex") !== release.sha256) {
    throw new ReleaseValidationError("The bridge download failed its SHA-256 verification.");
  }
  return Buffer.concat(chunks);
}

const transientNetworkCodes = new Set([
  "EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

async function stageBridgeRelease({ fetchImpl = fetch, pause = delay } = {}) {
  if (!supportsBridgeReleaseArchive()) {
    throw new Error("Use the bridge update package from GitHub Releases on this computer.");
  }
  // Keep both downloads within the phone's update RPC window. Only the
  // user-initiated install retries; passive version lookups still take one shot.
  const deadline = Date.now() + 50_000;
  async function withRetries(stage, timeout, read) {
    for (let attempt = 1; ; attempt++) {
      const remaining = Math.max(1, deadline - Date.now());
      try {
        return await read(AbortSignal.timeout(Math.min(remaining, timeout)));
      } catch (error) {
        const timedOut = ["TimeoutError", "AbortError"].includes(error.name);
        const networkCode = error.cause?.code || error.code;
        const networkFailure = transientNetworkCodes.has(networkCode) || (error instanceof TypeError && !error.cause && error.message === "fetch failed");
        const retryable = timedOut || networkFailure || [408, 429, 500, 502, 503, 504].includes(error.status);
        const backoff = Math.max(500 * attempt, error.retryAfterMs || 0);
        if (retryable && attempt < 3 && Date.now() + backoff < deadline) {
          await pause(backoff);
          continue;
        }
        // Node fetch causes may contain request URLs or proxy credentials.
        const networkDetail = transientNetworkCodes.has(networkCode) ? `Network request failed (${networkCode}).` : "Network request failed.";
        const detail = timedOut ? "Request timed out."
          : (error.status || error instanceof ReleaseValidationError) ? error.message : networkDetail;
        throw new Error(`${stage} failed after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}. ${detail} The current services are still running.`, { cause: error });
      }
    }
  }
  const release = await withRetries("GitHub release metadata", 8000, (signal) => fetchLatestBridgeRelease({ fetchImpl, signal }));
  // A native supervisor can outlive a bridge update. Read the installed version
  // from disk so subsequent updates cannot downgrade a newer worker.
  const installed = JSON.parse(fs.readFileSync(path.join(bridgeRoot, "package.json"), "utf8")).version || version;
  if (release.version.localeCompare(installed, "en", { numeric: true }) < 0) {
    throw new Error("The published bridge is older than the installed version.");
  }
  const archive = await withRetries("Bridge update ZIP download", 30_000, (signal) => downloadBridgeArchive(release, fetchImpl, signal));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-bridge-release-"));
  const archivePath = path.join(stage, archiveName);
  const cleanUp = () => fs.rmSync(stage, { recursive: true, force: true });
  try {
    require("./private-state").protectPrivatePath(stage);
    fs.writeFileSync(archivePath, archive, { mode: 0o600, flag: "wx" });
    return { stage, archive: archivePath, version: release.version, cleanUp };
  } catch (error) {
    cleanUp();
    throw error;
  }
}

function readLocalRelayUpdateService() {
  if (!supportsBridgeReleaseArchive()) return null;
  return require(updaterPath).readCoInstalledRelayService(bridgeRoot);
}

async function scheduleInstalledBridgeUpdate({ logsDir, includeRelay = false }) {
  if (!supportsInstalledBridgeUpdate()) {
    throw new Error("Use the bridge update package from GitHub Releases on this computer.");
  }
  if (includeRelay && !readLocalRelayUpdateService()) {
    throw new Error("No active Relay from this server kit is managed by this user.");
  }
  const release = await stageBridgeRelease();
  const label = `com.remodex.bridge-release-update.${path.basename(release.stage)}`;
  try {
    const worker = path.join(release.stage, updaterName);
    fs.copyFileSync(updaterPath, worker, fs.constants.COPYFILE_EXCL);
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const log = path.join(logsDir, "bridge-update.log");
    fs.closeSync(fs.openSync(log, "a", 0o600));
    // A separate launchd job survives the bridge service stopping during the swap.
    await execFileAsync("/bin/launchctl", [
      "submit", "-l", label, "-o", log, "-e", log, "--",
      process.execPath, worker, "--managed", release.version, label, currentCLI(),
      ...(includeRelay ? ["relay"] : []),
    ], { timeout: 10_000 });
    return release.version;
  } catch (error) {
    release.cleanUp();
    throw error;
  }
}

module.exports = {
  fetchLatestBridgeRelease,
  parseBridgeRelease,
  readLocalRelayUpdateService,
  scheduleInstalledBridgeUpdate,
  stageBridgeRelease,
  supportsBridgeReleaseArchive,
  supportsInstalledBridgeUpdate,
};
