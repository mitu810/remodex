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

function readLinuxService(run) {
  const systemctl = (...args) => run("systemctl", ["--user", ...args]);
  const definition = systemctl("cat", LINUX_SERVICE);
  const start = definition.split(/\r?\n/).filter((line) => /^\s*ExecStart\s*=/.test(line)).at(-1);
  // Remodex writes its systemd command as two quoted absolute paths followed by the state directory.
  const args = start?.match(/^\s*ExecStart\s*=\s*:?\s*("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")/);
  if (!args) throw new Error("无法从 systemd 服务中识别 Remodex 的安装路径。");
  const [nodePath, entryPath] = args.slice(1).map((value) => JSON.parse(value).replaceAll("%%", "%"));
  return {
    nodePath, entryPath,
    stop: () => systemctl("stop", LINUX_SERVICE),
    start: () => {
      systemctl("reset-failed", LINUX_SERVICE);
      systemctl("start", LINUX_SERVICE);
    },
    state: () => systemctl("show", LINUX_SERVICE, "--property=ActiveState", "--value"),
  };
}

function readMacService(run, home, uid) {
  const plist = path.join(home, "Library", "LaunchAgents", MAC_SERVICE + ".plist");
  const domain = `gui/${uid}`;
  const label = `${domain}/${MAC_SERVICE}`;
  const launch = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
  const args = launch.ProgramArguments || [];
  const entry = args.findIndex((arg) => path.basename(arg) === "remodex.js");
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
  platform = process.platform, env = process.env, run = command, pause = delay, log = console.log, expectedVersion,
} = {}) {
  const workspace = fs.mkdtempSync(path.join(path.dirname(bridge), ".remodex-bridge-update-"));
  const staging = path.join(workspace, "release", "phodex-bridge");
  const backup = path.join(workspace, "previous-bridge");
  let keepWorkspace = false;
  log(`正在更新 ${bridge}`);
  try {
    extractArchive(archive, workspace, platform, run, env);
    const releaseVersion = JSON.parse(fs.readFileSync(path.join(staging, "package.json"), "utf8")).version;
    if (expectedVersion && releaseVersion !== expectedVersion) {
      throw new Error("更新包内的 bridge 版本与 GitHub 发布版本不一致。");
    }
    const lockName = "package-lock.json";
    const wasInstalled = path.join(bridge, "node_modules");
    const currentLock = path.join(bridge, lockName);
    const lockMatches = fs.existsSync(currentLock)
      && fs.readFileSync(currentLock).equals(fs.readFileSync(path.join(staging, lockName)));
    if (lockMatches && fs.existsSync(wasInstalled)) {
      fs.cpSync(wasInstalled, path.join(staging, "node_modules"), { recursive: true, verbatimSymlinks: true });
    } else {
      log("正在为新版 bridge 安装匹配的依赖…");
      run(service.nodePath, [path.join(workspace, "release", "setup-server.cjs"), "install", "bridge"], {
        cwd: path.dirname(staging), timeout: 180_000,
        env: { ...env, PATH: [path.dirname(service.nodePath), env.PATH].filter(Boolean).join(path.delimiter) },
      });
    }
    run(service.nodePath, ["-e", 'require("./src/bridge"); require("./src/service-entry");'], { cwd: staging });

    const wasRunning = service.state() === "active";
    let stopped = false;
    let swapped = false;
    try {
      service.stop();
      stopped = true;
      await waitForService(service, "inactive", pause);
      fs.renameSync(bridge, backup);
      keepWorkspace = true;
      fs.renameSync(staging, bridge);
      swapped = true;
      service.start();
      await waitForService(service, "active", pause);
    } catch (error) {
      try {
        if (swapped) {
          service.stop();
          await waitForService(service, "inactive", pause);
          fs.renameSync(bridge, path.join(workspace, "failed-update"));
        }
        if (fs.existsSync(backup)) fs.renameSync(backup, bridge);
        if (stopped && wasRunning) {
          service.start();
          await waitForService(service, "active", pause);
        }
      } catch (rollbackError) {
        keepWorkspace = true;
        throw new Error(`${error.message}\n自动恢复失败：${rollbackError.message}\n更新备份目录：${workspace}`);
      }
      keepWorkspace = false;
      throw new Error(`${error.message}\n原 bridge 文件已保留或恢复。`);
    }
    fs.rmSync(path.join(workspace, "release"), { recursive: true, force: true });
    log(`bridge 已更新并重启。备份：${backup}`);
    return backup;
  } finally {
    if (!keepWorkspace) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, expectedVersion, label, expectedEntry] = process.argv.slice(2);
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
    await updateBridge(read(), archive);
    return;
  }
  try {
    // Give the bridge time to return the encrypted RPC response before stopping it.
    await delay(1500);
    const service = read();
    if (fs.realpathSync(service.entryPath) !== fs.realpathSync(expectedEntry)) {
      throw new Error("bridge 服务的安装路径已更改，请重新发起更新。");
    }
    await updateBridge(service, archive, { expectedVersion });
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

module.exports = { readLinuxService, readMacService, readWindowsService, updateBridge };
