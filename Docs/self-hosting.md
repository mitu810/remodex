# Running Remodex Locally

Remodex runs Codex, Git and repository operations on your own macOS, native Windows or Linux computer. The phone connects through a local relay using QR pairing and encrypted application messages. Windows does not require WSL.

The [Chinese server installation guide](server-install.zh-CN.md) covers the portable setup script, independent relays, and public WSS with dynamic DNS.

## Prerequisites

- Node.js 20.8 or newer; prefer a current LTS release.
- Native Codex CLI and Git available to the user running the bridge.
- Codex already authenticated: run `codex login status` in that user’s terminal.
- A signed Remodex app on the iPhone.
- A LAN, private-network, or public WSS address both the phone and the bridge can reach.

## Start a local relay

From the repository root, install dependencies without automatic Codex installation:

```text
npm --prefix relay ci --ignore-scripts
npm --prefix phodex-bridge ci --ignore-scripts
node relay/server.js
```

Keep that terminal open. The relay listens on port 9000 by default. Allow inbound connections to this port on your trusted local network when prompted by the host firewall.

Check `http://127.0.0.1:9000/health` on the computer. In PowerShell, use `Invoke-RestMethod http://127.0.0.1:9000/health`; on macOS/Linux use `curl http://127.0.0.1:9000/health`. The response should contain `ok: true`.

## Pair from Windows PowerShell

Replace the example address with your computer’s LAN or private-network address:

```powershell
$env:REMODEX_RELAY = "ws://192.168.1.10:9000/relay"
node .\phodex-bridge\bin\remodex.js up
```

This registers and starts a current-user scheduled task and prints the pairing QR. It uses native Windows Codex, files and Git. It does not require administrator privileges, WSL, or a SYSTEM service. The task starts again at user logon and needs the user to remain logged in.

Use `run` instead of `up` for an initial foreground check. If Codex is installed outside PATH, set `$env:REMODEX_CODEX_COMMAND` to its absolute `.exe` or `.cmd` path before starting. The background service saves that selection and the supported user environment.

## Pair from Linux

```sh
REMODEX_RELAY="ws://192.168.1.10:9000/relay" node ./phodex-bridge/bin/remodex.js up
```

This installs `~/.config/systemd/user/remodex-bridge.service` (or the equivalent under `XDG_CONFIG_HOME`) and starts it with `systemctl --user`. It uses the current user’s home, Codex authentication and PATH. No root service is installed.

If the system has no systemd user manager, use `run` instead of `up`. Whether the user service survives logout depends on the host’s user-manager configuration. Remodex does not enable lingering or change system login policy automatically.

## Pair from macOS

The convenience launcher keeps a local relay and foreground bridge together:

```sh
./run-local-remodex.sh --hostname <phone-reachable-hostname-or-ip>
```

For background operation, keep the relay running separately, set `REMODEX_RELAY` to its reachable address, and run `node ./phodex-bridge/bin/remodex.js up`. The existing launchd LaunchAgent owns the background bridge.

## Scan and reconnect

1. Scan the QR from inside the Remodex app.
2. Create or continue a thread, then send a message.
3. Reopen the phone app and let saved trust reconnect before scanning again.

The phone cannot use `localhost` to reach another computer. Keep the relay running as well as the bridge. Remodex manages the bridge service lifecycle, and the relay has its own process.

Pairing preserves legacy protocol field names so existing Mac records continue to work. Windows paths keep their drive/UNC spelling; Linux paths remain POSIX paths. Paths are interpreted on the host, not as iPhone filesystem paths.

## Public access with WSS

Run a relay, bridge, and TLS reverse proxy on each computer you want to reach. Point that computer's hostname at its public address. For IPv6, publish an `AAAA` record. A dynamic DNS client such as [ddns-go](https://github.com/jeessy2/ddns-go) can update it from the host's current non-temporary public IPv6. Use **DNS only** for a direct Cloudflare DNS setup.

- When public TCP `443` is reachable, run `node setup-server.cjs relay 127.0.0.1 9000` and use the [standard Caddy example](../relay/Caddyfile.example).
- When only a high port is reachable, the [IPv6 Caddy example](../relay/Caddyfile.ipv6.example) uses Cloudflare DNS-01 and public TCP `9999` by default. Start the relay with `node setup-server.cjs relay 127.0.0.1 9999`. Caddy listens on IPv6 and the relay stays on IPv4 loopback.

Use the public `wss://` URL for the bridge and QR. Include a custom port in the URL. Check `/health` from the phone on cellular and from the bridge host. If the host cannot reach its public address, resolve that hostname locally to Caddy's listener and keep the same hostname for TLS. A DNS address change preserves pairing when the hostname and port stay the same. If the URL changes, start the bridge with the new URL and scan a fresh QR.

The [HTTPS section of the server installation guide](server-install.zh-CN.md#https-入口) lists the DNS token permissions, Caddy commands, and pairing checks. The high-port IPv6 setup was verified from a real iPhone in a different public IPv6 network.

## Service lifecycle

Use `node ./phodex-bridge/bin/remodex.js <command>` from the source checkout, or `remodex <command>` for a global installation:

| Command | Behavior |
|---|---|
| `up` | Save settings, start the native user service, print a fresh QR |
| `run` | Run in the foreground |
| `start` | Start/refresh service registration without printing QR |
| `restart` | Restart using saved configuration and runtime settings |
| `qr` / `pair` | Refresh the service QR while preserving installed settings |
| `status --json` | Read sanitized service and bridge status |
| `stop` | Stop the service; Windows/Linux also target an active foreground bridge |
| `uninstall-service` | Stop/remove registration, preserve trust and configuration |
| `reset-pairing` | Stop the bridge, clear trusted phones, preserve the host identity |

Run `restart` after updating a global package so its saved launch paths are refreshed. Keep your source checkout in place while a service points at it.

Configuration, service environment, logs and identity normally live under `~/.remodex` (`%USERPROFILE%\.remodex` on Windows). Windows uses current-user ACLs for private state; POSIX files are owner-only. API keys from the invoking terminal are not copied into service manifests. Authenticate Codex directly instead.

## Troubleshooting and scope

- **QR does not appear:** check `status` and the reported log paths. Verify native `codex login status`, Codex executable selection and the relay address.
- **Phone cannot connect:** verify reachability and local firewall rules. A successful health check on the computer does not prove the phone can reach the same address.
- **Linux service unavailable:** use foreground `run`; do not use sudo to start a different user’s Codex.
- **Another bridge is running:** stop it before starting another instance with the same state directory. Native instances use an OS-owned lock that releases when the process exits.
- **Windows SSH terminal:** SSH is a separate connection. Its shell may be PowerShell or cmd.exe, so enter `cd` manually; the app does not send a POSIX auto-cd command for Windows directories.
- **Desktop features:** core thread control works through app-server. Existing IPC mirroring and rollout recovery remain available when a compatible local bus exists. AppleScript refresh and the advertised desktop-handoff capability remain macOS features; Windows/Linux desktop UI parity is not claimed.

CI covers three-platform runtime/service contracts and Linux unit parsing. Actual Windows/Linux phone pairing, stop, reboot, and reconnect remain device-validation steps. No Xcode tests are required for local bridge checks.

Push is optional and disabled by default. Keep live relay addresses, pairing identifiers, identity files, and notification credentials out of Git and logs.
