// Resolves stable bridge updates from this fork's GitHub releases.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const { releaseRepository, version } = require("../package.json");

const repositoryURL = `https://github.com/${releaseRepository}`;
const latestReleaseURL = `https://api.github.com/repos/${releaseRepository}/releases/latest`;
const archiveName = "remodex-bridge-update.zip";
const maxArchiveSize = 8 * 1024 * 1024;
const updaterName = "update-remodex-bridge.cjs";
const updaterPath = path.join(__dirname, "..", "scripts", updaterName);
const execFileAsync = promisify(execFile);
const bridgeRoot = path.join(__dirname, "..");

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

async function fetchLatestBridgeRelease() {
  const response = await fetch(latestReleaseURL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Remodex-Bridge" },
    redirect: "error",
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Could not read the bridge release from GitHub (${response.status}).`);
  const release = parseBridgeRelease(await response.json());
  if (!release) throw new Error("The latest GitHub release does not contain a verified bridge update.");
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

async function downloadBridgeArchive(release) {
  const response = await fetch(release.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`Bridge download failed (${response.status}).`);
  const hash = createHash("sha256");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > release.size) throw new Error("The bridge download exceeds the published size.");
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (size !== release.size || hash.digest("hex") !== release.sha256) {
    throw new Error("The bridge download failed its SHA-256 verification.");
  }
  return Buffer.concat(chunks);
}

async function stageBridgeRelease() {
  if (!supportsBridgeReleaseArchive()) {
    throw new Error("Use the bridge update package from GitHub Releases on this computer.");
  }
  const release = await fetchLatestBridgeRelease();
  // A native supervisor can outlive a bridge update. Read the installed version
  // from disk so subsequent updates cannot downgrade a newer worker.
  const installed = JSON.parse(fs.readFileSync(path.join(bridgeRoot, "package.json"), "utf8")).version || version;
  if (release.version.localeCompare(installed, "en", { numeric: true }) < 0) {
    throw new Error("The published bridge is older than the installed version.");
  }
  const archive = await downloadBridgeArchive(release);
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
