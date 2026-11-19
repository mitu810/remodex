// FILE: package-version-status.js
// Purpose: Reads the installed Remodex package version and caches the latest published GitHub release.
// Layer: CLI helper
// Exports: createBridgePackageVersionStatusReader
// Depends on: https, ../package.json

const { version: installedVersion = "", releaseRepository } = require("../package.json");
const { fetchLatestBridgeRelease, supportsInstalledBridgeUpdate } = require("./bridge-release");

const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_EMPTY_CACHE_RETRY_MS = 60 * 1000;
const DEFAULT_INITIAL_FETCH_WAIT_MS = 250;

function createBridgePackageVersionStatusReader({
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  emptyCacheRetryMs = DEFAULT_EMPTY_CACHE_RETRY_MS,
  initialFetchWaitMs = DEFAULT_INITIAL_FETCH_WAIT_MS,
  fetchLatestPublishedVersionImpl = fetchLatestPublishedVersion,
} = {}) {
  let cachedLatestVersion = "";
  let lastSuccessfulResolveAt = 0;
  let lastAttemptedAt = 0;
  let inFlightPromise = null;
  const bridgeCanInstallRelease = supportsInstalledBridgeUpdate();

  // Shares one cached lookup across repeated Settings/account refreshes without
  // holding the local account status path hostage on a slow release lookup.
  return async function readBridgePackageVersionStatus() {
    const now = Date.now();
    refreshLatestVersionInBackground({
      now,
      cacheTtlMs,
      emptyCacheRetryMs,
      fetchLatestPublishedVersionImpl,
      getCachedLatestVersion: () => cachedLatestVersion,
      getLastSuccessfulResolveAt: () => lastSuccessfulResolveAt,
      getLastAttemptedAt: () => lastAttemptedAt,
      getInFlightPromise: () => inFlightPromise,
      setLastAttemptedAt: (value) => {
        lastAttemptedAt = value;
      },
      setInFlightPromise: (value) => {
        inFlightPromise = value;
      },
      setCachedLatestVersion: (value) => {
        cachedLatestVersion = value;
      },
      setLastSuccessfulResolveAt: (value) => {
        lastSuccessfulResolveAt = value;
      },
    });

    const reportedLatestVersion = await resolveReportedLatestVersion({
      initialFetchWaitMs,
      getCachedLatestVersion: () => cachedLatestVersion,
      getInFlightPromise: () => inFlightPromise,
    });

    return {
      bridgeVersion: normalizeVersion(installedVersion) || null,
      bridgeLatestVersion: reportedLatestVersion || null,
      bridgeReleaseRepository: releaseRepository,
      bridgeCanInstallRelease,
    };
  };
}

// Waits briefly on the very first lookup so fast release responses can populate
// Settings immediately, while slow/offline requests still fall back to background refresh.
async function resolveReportedLatestVersion({
  initialFetchWaitMs,
  getCachedLatestVersion,
  getInFlightPromise,
}) {
  const cachedLatestVersion = getCachedLatestVersion();
  if (cachedLatestVersion) {
    return cachedLatestVersion;
  }

  const inFlightPromise = getInFlightPromise();
  if (!inFlightPromise || initialFetchWaitMs <= 0) {
    return "";
  }

  const latestVersion = await Promise.race([
    inFlightPromise.catch(() => ""),
    delay(initialFetchWaitMs).then(() => ""),
  ]);

  return latestVersion || getCachedLatestVersion();
}

// Refreshes the published version opportunistically while keeping callers fast.
function refreshLatestVersionInBackground({
  now,
  cacheTtlMs,
  emptyCacheRetryMs,
  fetchLatestPublishedVersionImpl,
  getCachedLatestVersion,
  getLastSuccessfulResolveAt,
  getLastAttemptedAt,
  getInFlightPromise,
  setLastAttemptedAt,
  setInFlightPromise,
  setCachedLatestVersion,
  setLastSuccessfulResolveAt,
}) {
  if (getInFlightPromise()) {
    return;
  }

  const cachedLatestVersion = getCachedLatestVersion();
  const isCacheFresh = cachedLatestVersion && now - getLastSuccessfulResolveAt() < cacheTtlMs;
  const retryWindowMs = cachedLatestVersion ? cacheTtlMs : emptyCacheRetryMs;
  const recentlyAttempted = now - getLastAttemptedAt() < retryWindowMs;

  if (isCacheFresh || recentlyAttempted) {
    return;
  }

  setLastAttemptedAt(now);
  setInFlightPromise(
    fetchLatestPublishedVersionImpl()
      .then((latestVersion) => {
        setCachedLatestVersion(latestVersion);
        setLastSuccessfulResolveAt(Date.now());
        return latestVersion;
      })
      .catch(() => getCachedLatestVersion())
      .finally(() => {
        setInFlightPromise(null);
      })
  );
}

async function fetchLatestPublishedVersion() {
  return (await fetchLatestBridgeRelease()).version;
}

function normalizeVersion(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function delay(timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

module.exports = {
  createBridgePackageVersionStatusReader,
};
