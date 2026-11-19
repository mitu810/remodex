// FILE: codex-transport.js
// Purpose: Abstracts the Codex-side transport so the bridge can talk to either a spawned app-server or an existing WebSocket endpoint.
// Layer: CLI helper
// Exports: createCodexTransport
// Depends on: child_process, ws, ./codex-launch

const { spawn } = require("child_process");
const WebSocket = require("ws");
const { createCodexLaunchPlans, windowsSystemTool } = require("./codex-launch");

function createCodexTransport({
  endpoint = "",
  env = process.env,
  appPath = "",
  platform = process.platform,
  spawnImpl = spawn,
  WebSocketImpl = WebSocket,
} = {}) {
  if (endpoint) {
    return createWebSocketTransport({ endpoint, WebSocketImpl });
  }

  return createSpawnTransport({ env, appPath, platform, spawnImpl });
}

function createSpawnTransport({ env, appPath, platform, spawnImpl = spawn }) {
  let launchPlans = [];
  let launchIndex = -1;
  let activeLaunch = null;
  let codex = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let didRequestShutdown = false;
  let didReportError = false;
  const listeners = createListenerBag();

  try {
    launchPlans = createCodexLaunchPlans({ env, appPath, platform });
    spawnNextLaunch();
  } catch (error) {
    // Preserve the same onError contract for discovery and asynchronous spawn errors.
    queueMicrotask(() => listeners.emitError(error));
  }

  return {
    mode: "spawn",
    describe() {
      return activeLaunch?.description || launchPlans[0]?.description || "`codex app-server`";
    },
    send(message) {
      if (!codex?.stdin.writable || codex.stdin.destroyed || codex.stdin.writableEnded) {
        return;
      }

      codex.stdin.write(message.endsWith("\n") ? message : `${message}\n`);
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    onStarted(handler) {
      listeners.onStarted = handler;
    },
    shutdown({ forceAfterMs } = {}) {
      if (didRequestShutdown) return;
      didRequestShutdown = true;
      shutdownCodexProcess(codex, { env, platform, spawnImpl });
      if (forceAfterMs && platform !== "win32" && codex?.pid) {
        const child = codex;
        const timer = setTimeout(() => {
          if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
        }, forceAfterMs);
        timer.unref?.();
        child.once("close", () => clearTimeout(timer));
      }
    },
  };

  // Retries the launch once with the bundled desktop binary when the shell-visible
  // `codex` command is unavailable in daemon environments like launchd.
  function spawnNextLaunch() {
    launchIndex += 1;
    activeLaunch = launchPlans[launchIndex] || null;
    if (!activeLaunch) {
      return;
    }

    stdoutBuffer = "";
    stderrBuffer = "";
    codex = spawnImpl(activeLaunch.command, activeLaunch.args, activeLaunch.options);
    attachChildListeners(codex, activeLaunch);
  }

  function attachChildListeners(child, launch) {
    child.on("spawn", () => {
      if (child !== codex) {
        return;
      }

      listeners.emitStarted({
        mode: "spawn",
        launchDescription: launch.description,
      });
    });
    child.on("error", (error) => {
      if (child !== codex) {
        return;
      }

      if (!didRequestShutdown && shouldRetryLaunchError(error, launchIndex, launchPlans)) {
        spawnNextLaunch();
        return;
      }

      didReportError = true;
      listeners.emitError(error);
    });
    child.on("close", (code, signal) => {
      if (child !== codex) {
        return;
      }

      if (!didRequestShutdown && !didReportError && code !== 0) {
        didReportError = true;
        listeners.emitError(createCodexCloseError({
          code,
          signal,
          stderrBuffer,
          launchDescription: launch.description,
        }));
        return;
      }

      listeners.emitClose(code, signal);
    });
    // Ignore broken-pipe shutdown noise once the child is already going away.
    child.stdin.on("error", (error) => {
      if (child !== codex) {
        return;
      }

      if (didRequestShutdown && isIgnorableStdinShutdownError(error)) {
        return;
      }

      if (isIgnorableStdinShutdownError(error)) {
        return;
      }

      didReportError = true;
      listeners.emitError(error);
    });
    // Keep stderr muted during normal operation, but preserve enough output to
    // explain launch failures when the child exits before the bridge can use it.
    child.stderr.on("data", (chunk) => {
      if (child !== codex) {
        return;
      }
      stderrBuffer = appendOutputBuffer(stderrBuffer, chunk.toString("utf8"));
    });

    child.stdout.on("data", (chunk) => {
      if (child !== codex) {
        return;
      }
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.substring(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
        if (line) {
          listeners.emitMessage(line);
        }
      }
    });
  }
}

// Stops the exact process tree we launched on Windows so the shell wrapper
// does not leave a child Codex process running in the background.
function shutdownCodexProcess(codex, { env, platform, spawnImpl }) {
  if (!codex || codex.killed || codex.exitCode !== null || codex.signalCode) {
    return;
  }

  if (platform === "win32" && codex.pid) {
    const killer = spawnImpl(windowsSystemTool("taskkill.exe", env), ["/pid", String(codex.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    function killChildIfRunning() {
      if (codex.exitCode === null && !codex.signalCode && !codex.killed) codex.kill();
    }
    killer.on("error", killChildIfRunning);
    killer.on("close", (code) => {
      if (code !== 0) killChildIfRunning();
    });
    return;
  }

  codex.kill("SIGTERM");
}

function createCodexCloseError({ code, signal, stderrBuffer, launchDescription }) {
  const details = stderrBuffer.trim();
  const reason = details || `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}.`;
  return new Error(formatCodexLaunchFailure({
    launchDescription,
    reason,
  }));
}

// Turns common Codex auth/config failures into recovery guidance without handling secrets in Remodex.
function formatCodexLaunchFailure({ launchDescription, reason }) {
  const message = `Codex launcher ${launchDescription} failed: ${reason}`;
  const missingEnvVar = extractMissingEnvironmentVariable(reason);
  if (!missingEnvVar) {
    return message;
  }

  const guidance = [
    `Codex is asking for ${missingEnvVar}, which usually means your Codex config forces API-key auth or a custom provider env var.`,
    "Remodex does not store or forward OpenAI API keys.",
    "Recommended fix: run `codex login` on the bridge host, then restart Remodex.",
    "If you intentionally use API-key auth, use `codex login --with-api-key` with your key on standard input or make the required environment variable available to the Remodex service.",
  ];
  return `${message}\n${guidance.join("\n")}`;
}

function extractMissingEnvironmentVariable(reason) {
  const match = String(reason || "").match(/Missing environment variable:\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/i);
  return match ? match[1] : "";
}

function appendOutputBuffer(buffer, chunk) {
  const next = `${buffer}${chunk}`;
  return next.slice(-4_096);
}

function isIgnorableStdinShutdownError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
}

function shouldRetryLaunchError(error, launchIndex, launchPlans) {
  return error?.code === "ENOENT" && launchIndex < launchPlans.length - 1;
}

function createWebSocketTransport({ endpoint, WebSocketImpl = WebSocket }) {
  const socket = new WebSocketImpl(endpoint);
  const listeners = createListenerBag();
  const openState = WebSocketImpl.OPEN ?? WebSocket.OPEN ?? 1;
  const connectingState = WebSocketImpl.CONNECTING ?? WebSocket.CONNECTING ?? 0;

  socket.on("message", (chunk) => {
    const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (message.trim()) {
      listeners.emitMessage(message);
    }
  });
  socket.on("open", () => {
    listeners.emitStarted({
      mode: "websocket",
      launchDescription: endpoint,
    });
  });

  socket.on("close", (code, reason) => {
    const safeReason = reason ? reason.toString("utf8") : "no reason";
    listeners.emitClose(code, safeReason);
  });

  socket.on("error", (error) => listeners.emitError(error));

  return {
    mode: "websocket",
    describe() {
      return endpoint;
    },
    send(message) {
      if (socket.readyState === openState) {
        socket.send(message);
      }
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    onStarted(handler) {
      listeners.onStarted = handler;
    },
    shutdown() {
      if (socket.readyState === openState || socket.readyState === connectingState) {
        socket.close();
      }
    },
  };
}

function createListenerBag() {
  return {
    onMessage: null,
    onClose: null,
    onError: null,
    onStarted: null,
    emitMessage(message) {
      this.onMessage?.(message);
    },
    emitClose(...args) {
      this.onClose?.(...args);
    },
    emitError(error) {
      this.onError?.(error);
    },
    emitStarted(info) {
      this.onStarted?.(info);
    },
  };
}

module.exports = {
  createCodexLaunchPlans,
  createCodexTransport,
  extractMissingEnvironmentVariable,
  formatCodexLaunchFailure,
};
