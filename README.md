<p align="center">
  <img src="CodexMobile/CodexMobile/Assets.xcassets/remodex-og1.imageset/remodex-og2%20%281%29.png" alt="Remodex" />
</p>

# Remodex

[GitHub Releases](https://github.com/mitu810/remodex/releases/latest)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[Follow on X](https://x.com/emanueledpt)

Control [Codex](https://openai.com/index/codex/) or [OpenCode](https://opencode.ai/) from your iPhone. Remodex is a local-first open-source bridge + iOS app. The coding runtime stays on your macOS, native Windows, or Linux computer, and your phone connects through a paired encrypted session. Windows does not require WSL.

## Key App Features

- End-to-end encrypted pairing and chats between your iPhone and Mac
- Fast mode for lower-latency turns
- Plan mode for structured planning before execution
- Subagents from iPhone with the `/subagents` command
- Steer active runs without starting over
- Queue follow-up prompts while a turn is still running
- In-app notifications when turns finish or need attention
- Git actions from your phone, including commit, push, pull, and branch switching
- Reasoning controls to tune how much thinking Codex uses
- Access controls with On-Request or Full access
- Photo attachments from camera or library
- One-time QR bootstrap with trusted Mac reconnects
- Native user-level background services: macOS `launchd`, Windows Task Scheduler, Linux `systemd --user`
- Live streaming on your phone while Codex runs on your Mac
- Shared thread history with Codex on your Mac
- OpenCode chats with a model chosen at creation, including Zen, Go, and Free models, and shared sessions from your Mac

The repo stays local-first and self-host friendly: the iOS app source does not embed a public hosted endpoint, and the transport layer remains inspectable for anyone who wants to run their own setup.

Background services reuse the current user’s Codex credentials and saved pairing. Windows starts at user logon; Linux requires a working systemd user manager. Foreground `remodex run` works without a service manager. Native Windows/Linux device validation is still required; CI covers platform launch and service contracts.

If you want the public-repo distribution model explained clearly, read [SELF_HOSTING_MODEL.md](SELF_HOSTING_MODEL.md).

> **I am very early in this project. Expect bugs.**
>
> I am not actively accepting contributions yet. If you still want to help, read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Get the App

The app is live on the [App Store](https://apps.apple.com/us/app/remodex-remote-ai-coding/id6760243963).

Build the iOS app from source in Xcode, install your own signed build on-device, then use the in-app onboarding flow to pair by scanning the QR from `remodex up`.

If you scan the pairing QR with a generic camera or QR reader before installing the app, your device may treat the QR payload as plain text and open a web search instead of pairing.

## Architecture

```
┌──────────────┐       Paired session   ┌───────────────┐       stdin/stdout       ┌─────────────┐
│  Remodex iOS │ ◄────────────────────► │ remodex host  │ ◄──────────────────────► │ codex       │
│  app         │    WebSocket bridge    │ bridge        │    JSON-RPC              │ app-server  │
└──────────────┘                        └───────────────┘                          └─────────────┘
                                               │                                         │
                                               │  Local Codex IPC live state              │ JSONL rollout
                                               ▼                                         ▼
                                        ┌─────────────┐                           ┌─────────────┐
                                        │  Codex.app  │ ◄─── persisted fallback ─│  ~/.codex/  │
                                        │  (desktop)  │      disk on navigate     │  sessions   │
                                        └─────────────┘                           └─────────────┘
```

1. Run `remodex up` on your Mac
2. On macOS, Remodex installs/starts a lightweight background bridge service and prints a QR for first-time pairing or recovery
3. Scan the QR once with the Remodex iOS app to trust that Mac
4. After the first handshake, the iPhone can resolve the Mac's live session through the configured relay and reconnect automatically
5. Your phone sends instructions to Codex through the bridge and receives responses in real-time
6. The bridge handles git operations and local session persistence on your Mac
7. When the local Codex IPC bus is available, Remodex broadcasts live conversation state to Codex Desktop / VSCode; persisted JSONL history and the optional refresh workaround remain as fallbacks

## Repository Structure

This repo contains the local bridge, the iOS app target, and their tests:

```
├── phodex-bridge/                # Node.js bridge package used by `remodex`
│   ├── bin/                      # CLI entrypoints
│   └── src/                      # Bridge runtime, git/workspace handlers, refresh helpers
├── CodexMobile/                  # Xcode project root
│   ├── CodexMobile/              # App source target
│   │   ├── Services/             # Connection, sync, incoming-event, git, and persistence logic
│   │   ├── Views/                # SwiftUI screens and timeline/sidebar components
│   │   ├── Models/               # RPC, thread, message, and UI models
│   │   └── Assets.xcassets/      # App icons and UI assets
│   ├── CodexMobileTests/         # Unit tests
│   ├── CodexMobileUITests/       # UI tests
│   └── BuildSupport/             # Info.plist, xcconfig defaults, and local override templates
```

## Prerequisites

- **Node.js** v20.8+ (a current LTS release is recommended)
- **[Codex CLI](https://github.com/openai/codex)** installed and in your PATH
- **Codex CLI authenticated on the host computer** (`codex login status` should succeed)
- **[OpenCode CLI](https://opencode.ai/docs/)** installed on the Mac for OpenCode chats; authenticate Zen or Go in OpenCode before selecting those models
- **[Codex desktop app](https://openai.com/index/codex/)** (optional — for viewing threads on your Mac)
- **A signed Remodex iOS build** installed on your iPhone or iPad before scanning the pairing QR
- **macOS, Windows, or Linux** for the local bridge; macOS is required for AppleScript desktop refresh
- **Xcode 16+** (only if building the iOS app from source)

## Codex Authentication

Remodex does not manage OpenAI credentials. It expects the local Codex CLI to be installed and authenticated on the host before the bridge starts:

```sh
codex login status
codex login
```

If startup fails with `Missing environment variable: CODEX_API_KEY`, that error is coming from your Codex CLI configuration, not from Remodex. The safest recovery is to authenticate Codex directly, then restart Remodex:

```sh
codex login
remodex restart
```

If you intentionally use API-key auth, configure Codex itself rather than storing keys in Remodex:

```sh
printenv OPENAI_API_KEY | codex login --with-api-key
remodex restart
```

Do not put live OpenAI API keys into the Remodex launchd plist or relay configuration.

## Install the Bridge

Download the server kit from [GitHub Releases](https://github.com/mitu810/remodex/releases/latest). Follow the [server installation guide](Docs/server-install.zh-CN.md) for the native macOS, Windows, or Linux service.

For an existing server-kit installation, download the bridge update ZIP and update script to the same folder. Run `node update-remodex-bridge.cjs` as the account that runs the bridge. The updater backs up the bridge, restarts the existing service, and preserves pairing.

## Quick Start

Start the installed bridge on your computer to display a pairing QR code.

On first connect, open the Remodex app, follow the onboarding flow, then scan the QR code from inside the app.

After that first scan:

- the iPhone saves the Mac as a trusted device
- the Mac bridge keeps its identity locally
- the app tries trusted reconnect automatically on later launches
- the QR remains available as a recovery path if trust changes or the relay cannot resolve the live session

On Windows the bridge runs in your logged-in user session. On Linux it runs through `systemd --user`. Keep the relay running and reachable from the phone; the bridge service does not manage the relay process.

## Run Locally

See the [native self-hosting guide](Docs/self-hosting.md) for local setup and reconnect troubleshooting, or the [Chinese server installation guide](Docs/server-install.zh-CN.md) for the portable installer, public IPv6 with WSS, and dynamic DNS.

On macOS, the existing convenience launcher starts a local relay and foreground bridge together:

```sh
./run-local-remodex.sh --hostname <phone-reachable-hostname-or-ip>
```

For native Windows or Linux, install dependencies and keep a local relay running in one terminal:

```text
npm --prefix relay ci --ignore-scripts
npm --prefix phodex-bridge ci --ignore-scripts
node relay/server.js
```

In another terminal, configure the relay address the **phone can reach**. A phone cannot use `localhost` to reach your computer. The following addresses are examples to replace with your own LAN or private-network address.

Windows PowerShell:

```powershell
$env:REMODEX_RELAY = "ws://192.168.1.10:9000/relay"
node .\phodex-bridge\bin\remodex.js up
```

Linux:

```sh
REMODEX_RELAY="ws://192.168.1.10:9000/relay" node ./phodex-bridge/bin/remodex.js up
```

Use `run` instead of `up` to keep the bridge in the foreground. For regular use over a private network, configure a stable address reachable from both computer and phone. Do not expose the Codex app-server directly to the network.

## Custom Relay Endpoint

Set `REMODEX_RELAY` to the address of a relay you control. Both the phone and bridge must reach that address. For direct access over the internet, keep the relay on loopback and put a TLS reverse proxy in front of it. Set up a separate hostname and relay on each computer you want to control. See [Public access with WSS](Docs/self-hosting.md#public-access-with-wss).

## Commands

### `remodex up`

Starts Remodex.

`remodex up` starts the native background bridge service on macOS, Windows and systemd-based Linux:

- Saves daemon configuration and the user runtime environment
- Starts or restarts the background bridge service
- Waits for a pairing payload and prints a QR for first-time trust or recovery
- Keeps the bridge alive even if you close the terminal later

On Linux without a working systemd user manager, use `remodex run`. On Windows the scheduled task runs in the current user’s logged-in session. No administrator or SYSTEM account is required.

In both cases the bridge:

- Spawns `codex app-server` (or connects to an existing endpoint)
- Connects the local bridge to the configured relay
- Forwards JSON-RPC messages bidirectionally
- Handles git commands from the phone
- Persists the active thread for later resumption

### `remodex start`

Starts the native background bridge service without waiting for or printing a QR in the current terminal.
If the service is already loaded, this path refreshes it in place.

### `remodex restart`

Restarts the native background bridge service with saved relay and runtime settings. Run it after updating the package to refresh the service launch paths. On macOS this regenerates the LaunchAgent plist; Windows updates the user task; Linux refreshes the user unit.

### `remodex stop`

Stops the background bridge service and clears its transient runtime status. Windows/Linux also send a targeted local stop request to an active foreground bridge. A stop failure leaves saved pairing intact.

### `remodex uninstall-service`

Stops and removes the platform’s background bridge registration. Saved configuration, logs, and trusted-device data in `~/.remodex` are preserved for a future reinstall.

To remove Remodex completely and safely:

```sh
remodex uninstall-service
```

### `remodex status`

Prints the native service and bridge state. Use `--json` for machine-readable status. Expired heartbeats are not reported as connected on Windows/Linux.

### `remodex run-service`

Internal daemon entrypoint. Use `up` or `run` instead of invoking this manually.

### `remodex --version`

Prints the installed Remodex CLI version.

```sh
remodex --version
# => 4.0.0
```

### `remodex reset-pairing`

Stops the bridge and clears trusted phones while preserving the host’s identity key. The next connection requires QR pairing again.
You normally do not need this for corrupted local state anymore: recent Remodex builds auto-repair unreadable pairing files/mirrors on startup.

```sh
remodex reset-pairing
# => [remodex] Cleared the saved pairing state. Run `remodex up` to pair again.
```

### `remodex resume`

Reopens the last active thread in Codex.app on your Mac.

```sh
remodex resume
# => [remodex] Opened last active thread: abc-123 (phone)
```

### `remodex watch [threadId]`

Tails the event log for a thread in real-time.

```sh
remodex watch
# => [14:32:01] Phone: "Fix the login bug in auth.ts"
# => [14:32:05] Codex: "I'll look at auth.ts and fix the login..."
# => [14:32:18] Task started
# => [14:33:42] Task complete
```

## Environment Variables

Start the local relay and bridge with `./run-local-remodex.sh`, or set `REMODEX_RELAY` to a relay you control. The source checkout does not include a default remote relay.

| Variable | Default | Description |
|----------|---------|-------------|
| `REMODEX_CODEX_COMMAND` | PATH discovery | Absolute Codex executable path (`.exe` or `.cmd` on Windows); captured for the background service. |
| `REMODEX_RELAY` | configured by the local launcher, otherwise unset in source checkouts | Session base URL used for QR bootstrap, trusted-session resolve, and phone/Mac session routing |
| `REMODEX_PUSH_SERVICE_URL` | disabled by default | Optional HTTP base URL for managed push registration/completion |
| `REMODEX_CODEX_ENDPOINT` | — | Connect to an existing Codex WebSocket instead of spawning a local `codex app-server` |
| `REMODEX_CODEX_ENDPOINT_INITIALIZE` | `false` | Perform the app-server handshake before connecting to the relay |
| `REMODEX_CODEX_ENDPOINT_METHODS` | — | Comma-separated Remodex RPCs a custom Codex endpoint handles in place of the local bridge |
| `REMODEX_CODEX_APP_PATH` | auto-detected on macOS | Override the local ChatGPT or Codex desktop bundle used for the bundled CLI and handoff |
| `REMODEX_OPENCODE_BIN` | `~/.opencode/bin/opencode` | Path to the local OpenCode executable if installed elsewhere |
| `REMODEX_DESKTOP_IPC_LIVE_SYNC` | `true` | Broadcast Remodex-owned active threads over the local Codex Desktop / VSCode IPC bus |
| `REMODEX_DESKTOP_AUTO_FOLLOW` | `false` | Explicitly opt in to opening phone-driven threads in Codex Desktop |
| `REMODEX_DESKTOP_IPC_SOCKET` | auto-detected | Override the local Codex IPC socket or Windows named pipe path |
| `REMODEX_DESKTOP_IPC_SNAPSHOT_DEBOUNCE_MS` | `75` | Debounce window (ms) for IPC `conversationState` snapshot / patch broadcasts |
| `REMODEX_REFRESH_ENABLED` | `false` | Auto-refresh Codex.app when phone activity is detected (`true` enables it explicitly) |
| `REMODEX_REFRESH_DEBOUNCE_MS` | `1200` | Debounce window (ms) for coalescing refresh events |
| `REMODEX_REFRESH_COMMAND` | — | Custom shell command to run instead of the built-in AppleScript refresh |
| `REMODEX_CODEX_BUNDLE_ID` | `com.openai.codex` | macOS bundle ID of the Codex app |
| `CODEX_HOME` | `~/.codex` | Codex data directory (used here for `sessions/` rollout files) |

```sh
# Enable desktop refresh explicitly
REMODEX_REFRESH_ENABLED=true remodex up

# Disable local Desktop / VSCode IPC live sync
REMODEX_DESKTOP_IPC_LIVE_SYNC=false remodex up

# Optionally open phone-driven threads in Desktop automatically
REMODEX_DESKTOP_AUTO_FOLLOW=true remodex up

# Connect to a stock local Codex app-server WebSocket
REMODEX_CODEX_ENDPOINT=ws://localhost:8080 REMODEX_CODEX_ENDPOINT_INITIALIZE=true remodex up

# Use a relay on a trusted local network
REMODEX_RELAY="ws://192.168.1.10:9000/relay" remodex up

# Enable managed push only if your self-hosted relay also exposes a configured APNs push service
REMODEX_RELAY="wss://relay.example/relay" \
REMODEX_PUSH_SERVICE_URL="https://relay.example" \
remodex up
```

Custom endpoints can opt into exact Remodex RPC names with `REMODEX_CODEX_ENDPOINT_METHODS`.
Supported overrides are `project/quickLocations`, `project/projectlessRoots`,
`project/listDirectory`, `project/searchDirectories`, `project/validatePath`,
`project/createDirectory`, `project/createRootlessChatRoot`,
`thread/contextWindow/read`, `thread/generateTitle`, and `workspace/readImage`.
The endpoint must implement the corresponding Remodex request and response shape.

On the local relay, keep push disabled until you actually want it. The HTTP push endpoints are off by default and only turn on when you set `REMODEX_ENABLE_PUSH_SERVICE=true`.

## Pairing and Safety

- Codex, Git, and workspace operations run on the paired computer.
- Use `wss://` for public relay connections. TLS protects the connection and its handshake in transit. Remodex encrypts application messages end to end between the phone and the bridge.
- The pairing QR carries the connection URL, the session ID, and the bridge identity key used to bootstrap end-to-end encryption. After the first scan, the iPhone stores the trusted computer in Keychain and the bridge saves the phone identity locally.
- On macOS, the bridge can keep running as a lightweight `launchd` service, so the phone can resolve the Mac's current live relay session and reconnect without scanning a new QR every time.
- The QR is still the recovery path when trust changes, the bridge identity rotates, or the relay cannot resolve the current live session.
- The bridge state lives canonically in `~/.remodex/device-state.json` with local-only permissions. On macOS the bridge also mirrors that state to Keychain as best-effort backup/migration data, and recent builds auto-repair unreadable local state on startup instead of requiring manual cleanup.
- The CLI no longer prints the connection URL in plain text below the QR.
- Enable `REMODEX_TRUST_PROXY` only for a private relay behind a trusted proxy that overwrites client IP headers.
- The transport implementation is public in [`relay/`](relay/), but your real deployed hostname and credentials should stay private.
- On the iPhone, the default agent permission mode is `On-Request`. Switching the app to `Full access` auto-approves runtime approval prompts from the agent.

## Security and Privacy

Remodex now uses an authenticated end-to-end encrypted channel between the paired iPhone and the bridge running on your computer. The transport layer still carries the WebSocket traffic, but it does not get the plaintext contents of prompts, tool calls, Codex responses, git output, or workspace RPC payloads once the secure session is established.

The secure channel is built in these steps:

1. The bridge generates and persists a long-term device identity keypair on the Mac.
2. The pairing QR shares the connection URL, session ID, bridge device ID, bridge identity public key, and a short expiry window.
3. During pairing, the iPhone and bridge exchange fresh X25519 ephemeral keys and nonces.
4. The bridge signs the handshake transcript with its Ed25519 identity key, and the iPhone verifies that signature against the public key from the QR code or the previously trusted Mac record.
5. The iPhone signs a client-auth transcript with its own Ed25519 identity key, and the bridge verifies that before accepting the session.
6. Both sides derive directional AES-256-GCM keys with HKDF-SHA256 and then wrap application messages in encrypted envelopes with monotonic counters for replay protection.

Privacy notes:

- The transport layer can still see connection metadata and the plaintext secure control messages used to set up the encrypted session, including session IDs, device IDs, public keys, nonces, and handshake result codes.
- The transport layer does not see decrypted application payloads after the secure handshake succeeds.
- A fresh QR scan can replace the previously trusted iPhone automatically. Use `remodex reset-pairing` only when you intentionally want to wipe the remembered pairing state yourself.
- On-device message history is also encrypted at rest on iPhone using a Keychain-backed AES key.

## SSH Terminal

Remodex can open a native SSH terminal session from your iPhone to a Mac or Windows PC, without going through the bridge. The connection runs directly from the phone over SSH.

Private key material and the optional passphrase are stored in the iOS Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. This means they are protected by iOS Keychain data protection, accessible only while the device is unlocked, never included in iCloud or iTunes backups, and never migrated to another device. If you switch phones you need to re-import the key.

The in-app setup guide walks you through enabling SSH on the target machine (Remote Login on macOS, OpenSSH Server on Windows), creating a dedicated key pair, and entering the connection details. A ready-made Codex prompt is available in the guide so the AI can walk you through the full setup interactively.

## Git Integration

The bridge intercepts `git/*` JSON-RPC calls from the phone and executes them locally:

| Command | Description |
|---------|-------------|
| `git/status` | Branch, tracking info, dirty state, file list, and diff |
| `git/commit` | Commit staged changes with an optional message |
| `git/push` | Push to remote |
| `git/pull` | Pull from remote (auto-aborts on conflict) |
| `git/branches` | List all branches with current/default markers |
| `git/checkout` | Switch branches |
| `git/createBranch` | Create and switch to a new branch |
| `git/log` | Recent commit history |
| `git/stash` | Stash working changes |
| `git/stashPop` | Pop the latest stash |
| `git/resetToRemote` | Hard reset to remote (requires confirmation) |
| `git/remoteUrl` | Get the remote URL and owner/repo |

## Workspace Integration

The bridge also handles local workspace-scoped revert operations for the assistant revert flow:

| Command | Description |
|---------|-------------|
| `workspace/revertPatchPreview` | Checks whether a reverse patch can be applied cleanly in the local repo |
| `workspace/revertPatchApply` | Applies the reverse patch locally when the preview succeeds |

## Codex Desktop App Integration

Remodex works with both the Codex CLI and the Codex desktop app (`Codex.app`). Under the hood, the bridge spawns a `codex app-server` process — the same JSON-RPC interface that powers the desktop app and IDE extensions. Conversations are persisted as JSONL rollout files under `~/.codex/sessions`, so threads started from your phone show up in the desktop app too.

What is live today:

- The iPhone conversation is live while the bridge session is connected.
- The Mac-side Codex runtime is the real runtime doing the work.
- Desktop-owned threads mirror live to the phone: when you open a thread that Codex Desktop is running, the bridge follows Desktop's IPC `conversationState` stream and projects the timeline, approvals, archive state, title, status, and token usage to the phone.
- Remodex-owned active threads are broadcast over the local Codex IPC bus as Desktop / VSCode-compatible `conversationState` updates, and the bridge answers `thread-follower-*` requests (continue, steer, interrupt, approvals, user input) from any IPC client that chooses to follow them.
- On macOS, a newly created phone thread waits for its rollout to materialize, then Remodex opens that exact Codex route once. Codex responds with `thread-stream-following-changed`; Remodex uses that handshake to deliver an immediate full baseline and keep later patches live.

Current boundaries:

- Codex Desktop only accepts an external stream after that thread's route is mounted. Remodex therefore auto-opens a new phone-driven thread while Codex is already running; it does not cold-launch the desktop app. If Codex is closed or auto-follow is disabled, the thread still reaches the shared session catalog and becomes live when you open it.
- Remodex joins the local IPC bus when Codex Desktop or VSCode has created it. If no local IPC router is running, Remodex starts a compatible local router.
- IPC sync keeps a short debounce and falls back to a full snapshot when a patch would be too large or when a client reconnect requires a fresh baseline.
- The IPC protocol is private to Codex clients, so future Codex Desktop / VSCode changes may require bridge updates.

Remodex also keeps the hand-off button in the iPhone app. It explicitly opens the matching thread in `Codex.app` when you want to switch devices or force Desktop to mount a thread.

The older repeated deep-link refresh workaround remains available, but it is off by default. It is separate from the default one-time auto-follow activation.

```sh
# Enable the old deep-link refresh workaround manually
REMODEX_REFRESH_ENABLED=true remodex up
```

This enables debounced remounts of `codex://threads/<id>` during rollout growth and completion. If the local desktop path is unavailable, the bridge self-disables desktop refresh for the rest of that run instead of retrying noisily forever.

## Connection Resilience

- **Auto-reconnect**: If the session connection drops, the bridge reconnects with exponential backoff (1 s → 5 s max)
- **Secure catch-up**: The bridge keeps a bounded local outbound buffer and re-sends missed encrypted messages after a secure reconnect
- **Codex persistence**: The Codex process stays alive across transient session reconnects during the current bridge run
- **Graceful shutdown**: SIGINT/SIGTERM cleanly close all connections

## Building the iOS App

```sh
cd CodexMobile
open CodexMobile.xcodeproj
```

Build and run on a physical device or simulator with Xcode. The app uses SwiftUI and the current project target is iOS 18.6.

## Contributing

I'm not actively accepting contributions yet. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## FAQ

**Do I need an OpenAI API key?**
Not for Remodex itself. You need Codex CLI set up and working independently.

**Does this work on Linux/Windows?**
Native Windows and Linux use the same Codex forwarding, approvals, Git and encrypted pairing as macOS. Windows uses a current-user scheduled task; Linux uses a systemd user service. WSL is not required. AppleScript refresh and the advertised desktop handoff capability remain macOS features; existing IPC mirroring is attempted when a compatible local bus is available. Real Windows/Linux end-to-end device validation remains pending.

**What happens if I close the terminal?**
`up` starts the bridge in the background using the platform’s user service. `run` stays in the foreground and stops when its terminal closes. Windows requires the user to remain logged in; Linux logout behavior depends on user-manager configuration. The separately started local relay must also remain running.

**How do I force a fresh QR pairing?**
Run `remodex reset-pairing`, then start the bridge again with `remodex up`. You should only need this when you intentionally want to replace the paired iPhone or wipe the remembered pairing.

**Can I connect to a remote Codex instance?**
Yes — set `REMODEX_CODEX_ENDPOINT=ws://host:port` to skip spawning a local `codex app-server`.

**Why don't my phone threads show up in the Codex desktop app immediately?**
Phone-created threads appear through the shared local session catalog. Open a thread manually in Codex Desktop to follow its live stream. Remodex does not navigate or activate Desktop by default. `REMODEX_DESKTOP_AUTO_FOLLOW=true` explicitly opts in to automatic navigation.

**Does Remodex support true live sync between phone and `Codex.app`?**
Yes while the relevant client is following the thread. Both directions stream over the local IPC bus. Opening a thread establishes its subscription; phone activity does not need to change the active desktop view. Disk persistence is still the fallback while Codex is closed.

**Can I self-host the relay?**
Yes. The relay is included in [`relay/`](relay/). Run it on the computer you want to control and set `REMODEX_RELAY` to the reachable address. For public IPv6, see [Public access with WSS](Docs/self-hosting.md#public-access-with-wss).

**Can I use Tailscale?**
Yes. Set `REMODEX_RELAY` to an address both devices can reach on the private network and pair by QR. Direct public WSS also works without a VPN when the phone can reach the host's public address and port.

**Is the transport layer safe for sensitive work?**
It is much stronger than a plain text proxy: traffic can be protected in transit with TLS, application payloads are end-to-end encrypted after the secure handshake, and all Codex execution still happens on your computer. The transport can still observe connection metadata and handshake control messages, so the tightest trust model is to run it yourself.

## License

[Apache License 2.0](LICENSE)

The Remodex name, marks, and branding are not licensed for use in forks or derivative projects. If you fork, redistribute, or publish a modified version, use a different app name and branding.
