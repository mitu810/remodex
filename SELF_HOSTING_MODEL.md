# Local Runtime and Pairing Model

Remodex runs on computers you control. The repository includes the iOS client, the Node.js bridge, and the local relay. It does not include a hosted endpoint or private credentials.

## What runs where

- macOS, native Windows, or Linux: Codex, Git, repository files, bridge identity, and the bridge.
- Your local computer or another device on your private network: the relay.
- iPhone: the paired remote client.

The relay forwards encrypted application messages. It does not run Codex or Git. The first QR scan establishes trust; reconnects reuse the saved computer identity. Legacy `macDeviceId` and relay role names remain protocol compatibility fields, not macOS requirements.

## Foreground and background operation

`remodex run` runs the bridge in its terminal. `remodex up` starts the native background service and prints a fresh pairing QR:

| Platform | Background owner | Session scope |
|---|---|---|
| macOS | launchd LaunchAgent | Current user |
| Windows | Task Scheduler | Current user, while logged in; starts at logon |
| Linux | systemd user service | User manager; logout behavior depends on its configuration |

Windows runs native Codex and does not require WSL. A Linux host without systemd can use the foreground bridge. User services do not install or keep alive the local relay; manage that process separately.

## Configuration and trust

Authenticate Codex on the same computer and as the same user that runs the bridge. Keep `CODEX_HOME`, executable selection, Git and repositories in that native environment. The service captures supported nonsecret environment settings, including `CODEX_HOME` and `REMODEX_CODEX_COMMAND`; it does not copy API keys from the terminal into its service manifest.

Set `REMODEX_RELAY` to an address reachable by both the host and phone. For public access, use a stable WSS hostname and keep the relay behind a TLS proxy on the same computer. A DDNS update can move the hostname to a new IP without changing the pairing URL. Keep real hostnames, pairing files, identity keys, and notification credentials private. See the [WSS setup](Docs/self-hosting.md#public-access-with-wss).

After the phone pairs, normal bridge restarts and updates reuse the saved pairing. To replace the paired phone, run `remodex reset-pairing`, then run `remodex up` and scan the new QR code. Reset clears phone trust and the saved relay session while preserving the computer’s identity key. `remodex uninstall-service` removes service registration while preserving local configuration and trust.

See [Docs/self-hosting.md](Docs/self-hosting.md) for native setup. Automated checks cover runtime and service contracts; real Windows/Linux phone pairing, reboot and reconnect checks are still required before declaring those environments fully validated.
