// Keeps the existing scheduled task or systemd service alive while its bridge worker is replaced.
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { stageBridgeRelease } = require("./bridge-release");

function send(child, message) {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => error ? reject(error) : resolve());
  });
}

function applyRelease(service, archive, options) {
  const { updateBridge } = require("../scripts/update-remodex-bridge.cjs");
  return updateBridge(service, archive, options);
}

function runNativeServiceSupervisor({
  stateDir,
  entryPath,
  processImpl = process,
  forkWorker = fork,
  stageUpdate = stageBridgeRelease,
  applyUpdate = applyRelease,
  log = (message) => fs.appendFileSync(path.join(stateDir, "logs", "bridge-update.log"), `${message}\n`, { mode: 0o600 }),
}) {
  let child = null;
  let ready = false;
  let workerFailed = false;
  let updating = false;
  let shuttingDown = false;

  return new Promise((resolve, reject) => {
    const service = {
      nodePath: processImpl.execPath,
      entryPath,
      state() {
        if (child) return ready ? "active" : "activating";
        return workerFailed ? "failed" : "inactive";
      },
      start: startWorker,
      stop: stopWorker,
    };

    function finish(code) {
      processImpl.off("SIGINT", requestShutdown);
      processImpl.off("SIGTERM", requestShutdown);
      resolve(code);
    }

    function requestShutdown() {
      shuttingDown = true;
      // Let a swap finish or roll back before stopping its resulting worker.
      if (!updating) stopWorker();
    }

    function stopWorker() {
      if (child?.connected) void send(child, { kind: "stop" }).catch(() => {});
    }

    function startWorker() {
      const next = forkWorker(entryPath, [stateDir, "--worker"], {
        cwd: stateDir,
        env: processImpl.env,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        windowsHide: true,
      });
      child = next;
      ready = false;
      workerFailed = false;
      next.on("message", (message) => {
        if (next !== child) return;
        if (message?.kind === "status") ready = message.ready === true;
        if (message?.kind === "update") void installUpdate(next);
      });
      next.on("error", (error) => record(`Bridge worker error: ${error.message}`));
      next.once("close", (code) => {
        if (next !== child) return;
        child = null;
        ready = false;
        workerFailed = code !== 0;
        if (!updating) finish(shuttingDown ? 0 : (code ?? 1));
      });
    }

    function record(message) {
      try { log(message); } catch { console.error(message); }
    }

    async function installUpdate(requester) {
      if (updating || shuttingDown) {
        await send(requester, { kind: "updateResult", error: "A bridge update or shutdown is already in progress." }).catch(() => {});
        return;
      }
      updating = true;
      let release;
      let acknowledged = false;
      try {
        release = await stageUpdate();
        if (shuttingDown) throw new Error("The bridge service is stopping.");
        await send(requester, { kind: "updateResult", version: release.version });
        acknowledged = true;
        // Allow the bridge to acknowledge the phone before its transport closes.
        await delay(1500);
        await applyUpdate(service, release.archive, { expectedVersion: release.version, log: record });
      } catch (error) {
        record(`Bridge update failed: ${error.message}`);
        if (!acknowledged) await send(requester, { kind: "updateResult", error: error.message }).catch(() => {});
      } finally {
        try { release?.cleanUp(); } catch (error) { record(`Bridge update cleanup failed: ${error.message}`); }
        updating = false;
        if (!child) finish(shuttingDown ? 0 : 1);
        else if (shuttingDown) stopWorker();
      }
    }

    try {
      processImpl.on("SIGINT", requestShutdown);
      processImpl.on("SIGTERM", requestShutdown);
      startWorker();
    } catch (error) {
      processImpl.off("SIGINT", requestShutdown);
      processImpl.off("SIGTERM", requestShutdown);
      reject(error);
    }
  });
}

module.exports = { runNativeServiceSupervisor };
