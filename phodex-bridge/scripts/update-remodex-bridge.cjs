#!/usr/bin/env node
// Updates a server-kit installation using its existing native service registration.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const ARCHIVE_NAME = "remodex-bridge-update.zip";
const LINUX_SERVICE = "remodex-bridge.service";
const MAC_SERVICE = "com.remodex.bridge";

function command(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      windowsHide: true,
      ...options,
    }).trim();
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message, { cause: error });
  }
}

function powerShell(run, env, script, data) {
  const encodedData = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const source = `
    $ErrorActionPreference = 'Stop';
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new();
    $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedData}')) | ConvertFrom-Json;
    ${script}
  `;
  const executable = path.win32.join(
    env.SystemRoot || env.SYSTEMROOT || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
  );
  return run(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
    "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64"),
  ]);
}

function readLinuxService(run, unit = LINUX_SERVICE) {
  const systemctl = (...args) => run("systemctl", ["--user", ...args]);
  const definition = systemctl("cat", unit);
  const start = definition.split(/\r?\n/).filter((line) => /^\s*ExecStart\s*=/.test(line)).at(-1);
  // Remodex writes its systemd command as two quoted absolute paths followed by the state directory.
  const args = start?.match(/^\s*ExecStart\s*=\s*:?\s*("(?:[^"\\]|\\.)*"|[^\s"\\]+)\s+("(?:[^"\\]|\\.)*"|[^\s"\\]+)(?:\s|$)/);
  if (!args) throw new Error("无法从 systemd 服务中识别 Remodex 的安装路径。");
  const [nodePath, entryPath] = args.slice(1).map((value) => (value.startsWith('"') ? JSON.parse(value) : value).replaceAll("%%", "%"));
  return {
    nodePath, entryPath,
    // Queue the job and observe ActiveState below. A synchronous systemctl can
    // time out after systemd has accepted the stop and will still carry it out.
    stop: () => systemctl("stop", "--no-block", unit),
    start: () => {
      systemctl("reset-failed", unit);
      systemctl("start", "--no-block", unit);
    },
    state: () => systemctl("show", unit, "--property=ActiveState", "--value"),
  };
}

function readMacService(run, home, uid, name = MAC_SERVICE, scriptName = "remodex.js") {
  const plist = path.join(home, "Library", "LaunchAgents", name + ".plist");
  const domain = `gui/${uid}`;
  const label = `${domain}/${name}`;
  const launch = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
  const args = launch.ProgramArguments || [];
  const entry = args.findIndex((arg) => path.basename(arg) === scriptName);
  if (entry < 1) throw new Error("无法从 LaunchAgent 中识别 Remodex 的安装路径。");
  function printJob() {
    try {
      return run("/bin/launchctl", ["print", label]);
    } catch (error) {
      if (/could not find service|no such process/i.test(error.message)) return null;
      throw error;
    }
  }
  return {
    nodePath: args[entry - 1], entryPath: args[entry],
    stop: () => {
      if (printJob() !== null) run("/bin/launchctl", ["bootout", label]);
    },
    start: () => {
      run("/bin/launchctl", ["bootstrap", domain, plist]);
      if (!launch.RunAtLoad) run("/bin/launchctl", ["kickstart", label]);
    },
    state: () => /^\s*pid\s*=\s*[1-9]\d*\s*$/m.test(printJob() || "") ? "active" : "inactive",
  };
}

function readWindowsService(run, env, username) {
  const account = `${env.USERDOMAIN || ""}\\${env.USERNAME || username}`.toLowerCase();
  const task = "Remodex-Bridge-" + createHash("sha256").update(account).digest("hex").slice(0, 12);
  const invoke = (script) => powerShell(run, env, `
    $task = Get-ScheduledTask -TaskName $data.task -TaskPath '\\';
    ${script}
  `, { task });
  const argumentsString = invoke("$task.Actions[0].Arguments");
  const encodedAction = argumentsString.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/i)?.[1];
  const action = Buffer.from(encodedAction || "", "base64").toString("utf16le");
  const encodedSettings = action.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  if (!encodedSettings) throw new Error("无法从计划任务中识别 Remodex 的安装路径。");
  const { nodePath, entryPath } = JSON.parse(Buffer.from(encodedSettings, "base64").toString("utf8"));
  return {
    nodePath, entryPath,
    stop: () => invoke("if ($task.State.ToString() -in @('Running', 'Queued')) { Stop-ScheduledTask -InputObject $task }"),
    start: () => invoke("Start-ScheduledTask -InputObject $task"),
    state: () => ({ Running: "active", Queued: "activating" })[invoke("$task.State.ToString()")] || "inactive",
  };
}

function readWindowsRelayService(run, env) {
  const invoke = (script) => powerShell(run, env, `
    $task = Get-ScheduledTask -TaskName 'Remodex-Relay' -TaskPath '\\';
    $account = $task.Principal.UserId;
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent();
    $sid = if ($account -match '^S-1-') { $account } else {
      ([Security.Principal.NTAccount]::new($account)).Translate([Security.Principal.SecurityIdentifier]).Value
    };
    if ($sid -ne $identity.User.Value -or $task.Actions.Count -ne 1) { throw 'Relay task is not owned by this user'; }
    ${script}
  `, {});
  const action = JSON.parse(invoke("$task.Actions[0] | Select-Object Execute, Arguments | ConvertTo-Json -Compress"));
  // The server kit registers Node directly with an optional env file, followed by server.js.
  const match = action.Arguments?.match(/^\s*(?:"--env-file=[^"]+"\s+)?"([^"\r\n]+)"\s*$/);
  if (!match) throw new Error("Could not read the registered Relay script path.");
  return {
    nodePath: action.Execute,
    entryPath: match[1],
    stop: () => invoke("if ($task.State.ToString() -in @('Running', 'Queued')) { Stop-ScheduledTask -InputObject $task }"),
    start: () => invoke("Start-ScheduledTask -InputObject $task"),
    state: () => ({ Running: "active", Queued: "activating" })[invoke("$task.State.ToString()")] || "inactive",
  };
}

function readCoInstalledRelayService(bridgeRoot, {
  platform = process.platform, env = process.env, run = (file, args) => command(file, args, { timeout: 2500 }),
} = {}) {
  try {
    const relayRoot = path.join(path.dirname(fs.realpathSync(bridgeRoot)), "relay");
    if (fs.realpathSync(relayRoot) !== relayRoot) return null;
    const { name, version } = JSON.parse(fs.readFileSync(path.join(relayRoot, "package.json"), "utf8"));
    if (name !== "remodex-relay") return null;
    const readCandidates = {
      linux: [() => readLinuxService(run, "remodex-relay.service")],
      darwin: ["com.remodex.relay", "com.remodex.loopback-relay"].map((label) => (
        () => readMacService(run, os.homedir(), process.getuid(), label, "server.js")
      )),
      win32: [() => readWindowsRelayService(run, env)],
    }[platform] ?? [];
    for (const read of readCandidates) {
      try {
        const service = read();
        if (path.isAbsolute(service.nodePath) && path.parse(fs.realpathSync(service.nodePath)).name.toLowerCase() === "node"
          && path.isAbsolute(service.entryPath) && fs.realpathSync(service.entryPath) === path.join(relayRoot, "server.js")
          && service.state() === "active") {
          return { ...service, root: relayRoot, version };
        }
      } catch {
        // An unavailable registration does not rule out the other launchd label.
      }
    }
  } catch {
    // An installation without a valid sibling Relay cannot update it.
  }
  return null;
}

function installedBridge(service) {
  if (![service.nodePath, service.entryPath].every((file) => typeof file === "string" && path.isAbsolute(file))) {
    throw new Error("bridge 的服务配置缺少有效的 Node.js 或程序路径。");
  }
  const entry = fs.realpathSync(service.entryPath);
  const bridge = path.dirname(path.dirname(entry));
  const install = path.dirname(bridge);
  if (path.basename(bridge) !== "phodex-bridge" || !fs.existsSync(path.join(install, "setup-server.cjs"))) {
    throw new Error("已注册的 bridge 不是用服务端安装包安装的版本。");
  }
  return bridge;
}

function extractArchive(archive, folder, platform, run, env) {
  if (platform === "win32") {
    powerShell(run, env, "Expand-Archive -LiteralPath $data.archive -DestinationPath $data.folder;", { archive, folder });
  } else {
    run("unzip", ["-q", archive, "-d", folder]);
  }
}

async function waitForService(service, state, pause) {
  let checks = 0;
  const deadline = Date.now() + 20_000;
  do {
    const current = service.state();
    if (state === "active" && current === "failed") break;
    checks = (current === state || (state === "inactive" && current === "failed")) ? checks + 1 : 0;
    if (checks >= (state === "active" ? 3 : 1)) return;
    await pause(1_000);
  } while (Date.now() < deadline);
  throw new Error(state === "active" ? "bridge 未能稳定启动。" : "原 bridge 未能完全停止。");
}

async function updateBridge(service, archive, options) {
  if (!fs.existsSync(archive)) throw new Error(`找不到更新包\n${archive}`);
  const bridge = installedBridge(service);
  const lock = path.join(path.dirname(bridge), ".remodex-bridge-update.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`已有 bridge 更新锁，请确认没有更新正在运行。\n${lock}`);
  }
  try {
    return await replaceBridge(service, archive, bridge, options);
  } finally {
    fs.rmdirSync(lock);
  }
}

async function replaceBridge(service, archive, bridge, {
  platform = process.platform, env = process.env, run = command, pause = delay, log = console.log,
  expectedVersion, includeRelay = false, relayService,
} = {}) {
  if (includeRelay) {
    relayService ||= readCoInstalledRelayService(bridge);
    if (!relayService) throw new Error("No active Relay from this server kit is managed by this user.");
  }
  const components = [{
    kind: "bridge", name: "phodex-bridge", root: bridge, service,
    smokeTest: 'require("./src/bridge"); require("./src/service-entry");',
  }];
  if (includeRelay) {
    components.unshift({
      kind: "relay", name: "relay", root: relayService.root, service: relayService,
      smokeTest: 'require("./server");',
    });
  }
  const workspace = fs.mkdtempSync(path.join(path.dirname(bridge), ".remodex-bridge-update-"));
  const release = path.join(workspace, "release");
  let keepWorkspace = false;
  try {
    extractArchive(archive, workspace, platform, run, env);
    for (const component of components) {
      component.staging = path.join(release, component.name);
      component.backup = path.join(workspace, `previous-${component.kind}`);
      const version = JSON.parse(fs.readFileSync(path.join(component.staging, "package.json"), "utf8")).version;
      const installedVersion = JSON.parse(fs.readFileSync(path.join(component.root, "package.json"), "utf8")).version;
      if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || (expectedVersion && version !== expectedVersion)
        || (installedVersion && version.localeCompare(installedVersion, "en", { numeric: true }) < 0)) {
        throw new Error(`${component.kind} release version does not match the requested update or would downgrade the installation.`);
      }
      const lockName = "package-lock.json";
      const oldModules = path.join(component.root, "node_modules");
      const oldLock = path.join(component.root, lockName);
      if (fs.existsSync(oldModules) && fs.existsSync(oldLock)
          && dependencyLocksMatch(oldLock, path.join(component.staging, lockName))) {
        fs.cpSync(oldModules, path.join(component.staging, "node_modules"), { recursive: true, verbatimSymlinks: true });
      } else {
        log(`Installing dependencies for ${component.kind}…`);
        const node = component.service.nodePath;
        run(node, [path.join(release, "setup-server.cjs"), "install", component.kind], {
          cwd: release, timeout: 180_000,
          env: { ...env, PATH: [path.dirname(node), env.PATH].filter(Boolean).join(path.delimiter) },
        });
      }
      run(component.service.nodePath, ["-e", component.smokeTest], { cwd: component.staging });
      component.wasRunning = ["active", "activating"].includes(component.service.state());
    }

    const stopOrder = [...components].reverse();
    try {
      for (const component of stopOrder) {
        component.stopRequested = true;
        await component.service.stop();
        await waitForService(component.service, "inactive", pause);
        component.stopped = true;
      }
      for (const component of components) {
        if (component.kind === "relay") preserveRelayLocalFiles(component.root, component.staging);
        fs.renameSync(component.root, component.backup);
        keepWorkspace = true;
        fs.renameSync(component.staging, component.root);
        component.swapped = true;
      }
      for (const component of components) {
        component.started = true;
        await component.service.start();
        await waitForService(component.service, "active", pause);
      }
    } catch (error) {
      const recoveryErrors = [];
      for (const component of stopOrder) {
        if (!component.started && (!component.stopRequested || component.stopped)) continue;
        try {
          // The manager can accept a stop before the command reports an error.
          // Settle even that in-flight job before restoring or starting services.
          const current = component.service.state();
          if (current === "inactive" || current === "failed") continue;
          if (current !== "deactivating") {
            await component.service.stop();
          }
          await waitForService(component.service, "inactive", pause);
        } catch (stopError) {
          component.recoveryBlocked = true;
          recoveryErrors.push(`Stop ${component.kind}: ${stopError.message}`);
        }
      }
      // Restore all install directories before attempting to bring either
      // service online. A broken Relay must not strand Bridge in the backup.
      for (const component of components) {
        if (component.recoveryBlocked || !fs.existsSync(component.backup)) continue;
        try {
          if (component.swapped) fs.renameSync(component.root, path.join(workspace, `failed-${component.kind}`));
          fs.renameSync(component.backup, component.root);
        } catch (restoreError) {
          component.recoveryBlocked = true;
          recoveryErrors.push(`Restore ${component.kind}: ${restoreError.message}`);
        }
      }
      for (const component of components) {
        if (component.recoveryBlocked || !component.stopRequested || !component.wasRunning) continue;
        try {
          await component.service.start();
          await waitForService(component.service, "active", pause);
        } catch (startError) {
          recoveryErrors.push(`Start ${component.kind}: ${startError.message}`);
        }
      }
      if (recoveryErrors.length) {
        keepWorkspace = true;
        throw new Error(`${error.message}\nAutomatic recovery failed: ${recoveryErrors.join("\n")}\nBackup: ${workspace}`);
      }
      keepWorkspace = false;
      throw new Error(`${error.message}\nThe previous installation was preserved or restored.`);
    }
    fs.rmSync(release, { recursive: true, force: true });
    log(`Updated and restarted ${components.map(({ kind }) => kind).join(" and ")}. Backup: ${workspace}`);
    return components.at(-1).backup;
  } finally {
    if (!keepWorkspace) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// Both lockfiles describe the same dependencies when only the release version changes.
function dependencyLocksMatch(current, next) {
  const dependencies = (file) => {
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    delete lock.version;
    if (lock.packages?.[""]) delete lock.packages[""].version;
    return JSON.stringify(lock);
  };
  return dependencies(current) === dependencies(next);
}

function preserveRelayLocalFiles(current, next) {
  for (const filename of fs.readdirSync(current)) {
    if (filename === "node_modules" || fs.existsSync(path.join(next, filename))) continue;
    fs.cpSync(path.join(current, filename), path.join(next, filename), { recursive: true, verbatimSymlinks: true });
  }
}

async function main() {
  const [mode, expectedVersion, label, expectedEntry, component] = process.argv.slice(2);
  const managed = mode === "--managed" && process.platform === "darwin";
  if (managed && (!path.basename(__dirname).startsWith("remodex-bridge-release-")
      || label !== `com.remodex.bridge-release-update.${path.basename(__dirname)}`
      || !expectedVersion || !expectedEntry)) {
    throw new Error("无效的后台更新参数。");
  }
  const archive = path.join(__dirname, ARCHIVE_NAME);
  if (!fs.existsSync(archive)) throw new Error(`请将更新 ZIP 和脚本放在同一目录。\n缺少 ${archive}`);
  const readers = {
    linux: () => readLinuxService(command),
    darwin: () => readMacService(command, os.homedir(), process.getuid()),
    win32: () => readWindowsService(command, process.env, os.userInfo().username),
  };
  const read = readers[process.platform];
  if (!read) throw new Error("此更新脚本支持 Windows、Linux 和 macOS。");
  if (!managed) {
    await updateBridge(read(), archive, { includeRelay: mode === "--with-relay" });
    return;
  }
  try {
    // Give the bridge time to return the encrypted RPC response before stopping it.
    await delay(1500);
    const service = read();
    if (fs.realpathSync(service.entryPath) !== fs.realpathSync(expectedEntry)) {
      throw new Error("bridge 服务的安装路径已更改，请重新发起更新。");
    }
    await updateBridge(service, archive, { expectedVersion, includeRelay: component === "relay" });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    fs.unlinkSync(archive);
    fs.unlinkSync(__filename);
    fs.rmdirSync(__dirname);
    command("/bin/launchctl", ["remove", label]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { readCoInstalledRelayService, readLinuxService, readMacService, readWindowsService, updateBridge };
