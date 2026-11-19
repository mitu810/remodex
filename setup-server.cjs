// Install or run the bridge and relay from a local checkout or the server kit.
const { spawnSync } = require("node:child_process");
const { isIP } = require("node:net");
const path = require("node:path");
const { createCliLaunch, resolveCliExecutable } = require("./phodex-bridge/src/codex-launch");

const usage = `Usage:
  node setup-server.cjs install bridge|relay
  node setup-server.cjs relay [bind-ip] [port]
  node setup-server.cjs bridge <ws(s)://host/relay> [--foreground]

Relay defaults to 127.0.0.1:9000. Use :: to listen on IPv6.
Bridge uses the native user service unless --foreground is passed.`;

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? (result.signal === "SIGINT" ? 130 : 1);
}

function install(component) {
  const cwd = path.join(__dirname, component === "bridge" ? "phodex-bridge" : "relay");
  const platform = process.platform;
  const env = process.env;
  const npmArgs = ["ci", "--ignore-scripts"];
  // npm may have launched this script itself. Otherwise use the platform's npm executable.
  if (process.env.npm_execpath && path.isAbsolute(process.env.npm_execpath)
      && path.basename(process.env.npm_execpath) === "npm-cli.js") {
    return run(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd, env });
  }
  const npm = resolveCliExecutable("npm", { env, platform });
  const launch = createCliLaunch(npm, npmArgs, { cwd, env }, platform);
  return run(launch.command, launch.args, launch.options);
}

function main(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.log(usage);
    return 0;
  }

  const [command, first, second] = args;
  if (command === "install" && args.length === 2 && ["bridge", "relay"].includes(first)) {
    return install(first);
  }

  if (command === "relay" && args.length <= 3) {
    const host = first ?? "127.0.0.1";
    const port = second ?? "9000";
    if (!isIP(host)) throw new Error("Pass a bind IP such as 127.0.0.1 or :: without square brackets.");
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error("Port must be an integer from 1 to 65535.");
    }
    return run(process.execPath, [path.join(__dirname, "relay", "server.js")], {
      env: { ...process.env, RELAY_BIND_HOST: host, PORT: port },
    });
  }

  if (command === "bridge" && first && (args.length === 2 || (args.length === 3 && second === "--foreground"))) {
    if (!/^wss?:\/\//i.test(first)) throw new Error("Relay URL must start with ws:// or wss://.");
    const url = new URL(first);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Relay URL must not contain credentials, a query, or a fragment.");
    }
    if (url.pathname === "/") url.pathname = "/relay";
    const action = second === "--foreground" ? "run" : "up";
    return run(process.execPath, [path.join(__dirname, "phodex-bridge", "bin", "remodex.js"), action], {
      env: { ...process.env, REMODEX_RELAY: url.href },
    });
  }

  console.error(usage);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // Avoid including the original input if URL parsing failed.
  console.error(`Remodex setup: ${error.message}`);
  process.exitCode = 1;
}
