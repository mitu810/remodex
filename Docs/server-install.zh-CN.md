# Remodex 服务端安装

这份安装包适用于 macOS、原生 Windows 和 Linux。**每台电脑运行自己的 relay 和 bridge**，使用本机的 Codex、登录账号和工作区。iPhone 为每台电脑保存各自的 relay 地址。

在每台要连接的电脑上分别安装。以下域名是示例，请替换为该电脑自己的可达地址。

| 电脑 | 要运行的程序 | 配对入口示例 |
| --- | --- | --- |
| macOS | 本机 relay + 本机 bridge | `wss://mac.example.com/relay` |
| Windows | 本机 relay + 本机 bridge | `wss://windows.example.com/relay` |
| Linux | 本机 relay + 本机 bridge | `wss://linux.example.com/relay` |

每台电脑的 bridge 只连接本机 relay。哪台电脑离线，就只有那台电脑的连接受影响。切换到另一台时，iPhone 访问另一台自己的入口。

## 准备

在要安装的电脑上解压服务端 ZIP，把它放在一个长期保留的目录，然后在该目录中打开终端。安装程序兼容 Node.js 20.8 及以上版本，安装时使用当前受支持的 LTS 版本。安装完成后，确认 `node --version` 和 `npm --version` 能运行。[Node.js 官方下载](https://nodejs.org/en/download/)

每台运行 bridge 的电脑还需要 Git 和原生 Codex CLI。还没有 Codex 时，macOS 和 Linux 可运行 `npm install -g @openai/codex`，Windows PowerShell 可运行 `npm.cmd install -g @openai/codex`。安装后，以运行 bridge 的同一用户执行 `codex login` 和 `codex login status`。Windows 无需 WSL。[Codex 官方安装说明](https://github.com/openai/codex#installing-and-running-codex-cli)

## 安装为后台服务

Windows 和 Linux 都将 relay 和 bridge 设为开机自启。配置完成后可以关闭安装终端，电脑停在登录界面时也可以连接。示例 relay 监听 `127.0.0.1:9000`。需要外网连接时，先配置 [HTTPS 入口](#https-入口)。仅在受信任的局域网使用时，也可将 relay 绑定到电脑的局域网 IP，并把防火墙入站限制在该网段。

### Windows

在登录 Codex 的 Windows 账号下，用原生 PowerShell 进入安装目录并执行。以下命令会生成 relay 的监听配置，并显示 `node.exe` 的完整路径。

```powershell
node .\setup-server.cjs install relay
node .\setup-server.cjs install bridge
'RELAY_BIND_HOST=127.0.0.1','PORT=9000' | Set-Content -Encoding Ascii .\relay.env
(Get-Command node.exe).Source
```

1. 以管理员权限打开 **任务计划程序**，选择 **创建任务**，名称填 `Remodex-Relay`。在 **操作** 中选择 **启动程序**，填写上一步查到的 `node.exe` 路径。假设安装目录是 `C:\Remodex\remodex-server-kit`，参数填写 `"--env-file=C:\Remodex\remodex-server-kit\relay.env" "C:\Remodex\remodex-server-kit\relay\server.js"`。按实际安装目录替换两处路径。[Node.js 配置文件参数](https://nodejs.org/download/release/v20.18.2/docs/api/cli.html#--env-fileconfig)
2. 在 **常规** 中选择运行 Codex 的 Windows 账号和 **不管用户是否登录都要运行**，让任务计划程序使用账号密码保存任务。保持普通权限运行，取消 **不存储密码**。在 **触发器** 中选择 **启动时**。在 **条件** 中允许使用电池时运行，在 **设置** 中取消运行时限，启用失败后重试，并选择 **不启动新实例**。密码只在 Windows 的任务保存提示中输入。[Microsoft 开机触发器](https://learn.microsoft.com/windows/win32/taskschd/boottrigger) · [Microsoft 任务登录类型](https://learn.microsoft.com/windows/win32/api/taskschd/ne-taskschd-task_logon_type)
3. 在任务计划程序里运行 `Remodex-Relay`，用 `Invoke-RestMethod http://127.0.0.1:9000/health` 确认 `ok` 为 `True`。如果使用 WSS，接着配置并启动 [HTTPS 入口](#https-入口)。
4. 回到运行 Codex 的账号，在 PowerShell 执行下列命令。换成这台电脑能被 iPhone 访问的 relay 地址。安装命令会注册后台 bridge，并显示配对二维码。

   ```powershell
   node .\setup-server.cjs bridge 'wss://windows.example.com/relay'
   ```

5. 在 iPhone 扫码配对后，运行 `node .\phodex-bridge\bin\remodex.js stop`。回到任务计划程序，打开刚生成的 `Remodex-Bridge-…` 任务。保留 **操作** 和执行账号，按第 2 步设置 **不管用户是否登录都要运行**，将触发器改为 **启动时**。保存后右键 **运行**，手机即可用原配对重连。

日常通过任务计划程序启动或停止两个任务。Windows 上的 `remodex restart`、`remodex qr` 和再次执行 `setup-server.cjs bridge` 会重建 bridge 的任务定义。执行这些命令后，重新应用第 5 步的开机设置。在登录前运行的 bridge 可以自动重启自己管理的 Codex 进程。交互会话中另开的 Codex 桌面应用由该会话管理。

### Linux

需要 `systemd` 和 `systemd --user`。以日常运行 Codex 的账号进入安装目录。用 `loginctl enable-linger` 让该账号的用户服务在开机时启动，并在注销后继续运行。[systemd 用户服务与 linger](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)

```sh
node setup-server.cjs install relay
node setup-server.cjs install bridge
sudo loginctl enable-linger "$(id -un)"
```

运行 `mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"`。把下面的内容保存到该目录下的 `remodex-relay.service`。用 `command -v node` 查看 Node.js 的绝对路径，并按实际情况替换 `ExecStart` 中的两个路径。

```ini
[Unit]
Description=Remodex relay

[Service]
Type=simple
Environment=RELAY_BIND_HOST=127.0.0.1
Environment=PORT=9000
ExecStart="/usr/bin/node" "/home/yourname/remodex-server-kit/relay/server.js"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now remodex-relay.service
curl -fsS http://127.0.0.1:9000/health
```

如果使用 WSS，接着配置并启动 [HTTPS 入口](#https-入口)。随后用这台电脑的 relay 地址安装 bridge，并在 iPhone 扫描显示的二维码。安装命令会自动启用 `remodex-bridge.service`。

```sh
node setup-server.cjs bridge 'wss://linux.example.com/relay'
systemctl --user is-enabled remodex-relay.service remodex-bridge.service
systemctl --user is-active remodex-relay.service remodex-bridge.service
loginctl show-user "$(id -un)" --property=Linger
```

### macOS

使用 `launchd` 管理现有的 relay 和 bridge。安装包的 bridge 默认注册为用户 LaunchAgent，随该用户登录启动。已有 relay 和 HTTPS LaunchAgent 时，沿用原有配置。

```sh
node setup-server.cjs install bridge
node setup-server.cjs bridge 'wss://mac.example.com/relay'
```

## 配对与日常管理

电脑上的 bridge 和 iPhone 都需要能访问配对二维码中的地址。WSS 用自定义端口时，地址里也要写明端口。添加其他电脑时，从 iPhone 侧栏进入 **连接 → 添加连接**。如果系统找不到 Codex，可在安装 bridge 前将 `REMODEX_CODEX_COMMAND` 设为原生 Codex 可执行文件的绝对路径。

- 查看 bridge 状态和日志路径，运行 `node phodex-bridge/bin/remodex.js status`。
- Windows 通过任务计划程序管理运行状态。Linux 可用 `systemctl --user restart remodex-relay.service remodex-bridge.service` 重启，并用 `journalctl --user -u remodex-relay.service -n 50` 查看 relay 日志。
- 重启电脑后，在登录前用 iPhone 打开原入口的 `/health`，确认返回 `{"ok":true}`，再从 Remodex 打开已配对的设备。

## 升级已有安装

从 [本仓库 GitHub Releases](https://github.com/mitu810/remodex/releases/latest) 下载 `remodex-bridge-update.zip` 和 `update-remodex-bridge.cjs`。把两个文件放在同一个目录中，无需解压 ZIP。用原来运行 bridge 的账号进入该目录，然后执行 `node update-remodex-bridge.cjs`。Windows、Linux 和 macOS 使用同一组文件。脚本会备份旧 bridge，沿用已有服务配置并重启 bridge。已重新连接的 iPhone 可以继续使用已保存的配对。首次接入 GitHub 更新也可使用这个脚本。

Windows、Linux 和 macOS 的服务端安装包支持从 iPhone 的 **设置 → 桥接** 发起更新。Windows 和 Linux 若仍在使用 4.0.1 或更早的版本，先在电脑上运行一次本页的更新脚本，将 bridge 升级到 4.0.2 或更新版本。后续更新可从 iPhone 发起。更新时连接会短暂中断，原有 Windows 计划任务、Linux systemd 用户服务和开机自启配置会保留。

Windows 和 Linux 使用同一个服务端 ZIP。已配对的电脑可以沿用原安装目录和 relay 地址。

1. 等正在运行的 Codex 任务结束。Windows 在任务计划程序里停止两个任务。Linux 运行 `systemctl --user stop remodex-bridge.service remodex-relay.service`。若还在使用旧版临时启动方式，先停止旧进程以释放监听端口。
2. 把新版 ZIP 解压到临时目录，再将里面 `remodex-server-kit` 的内容复制到原安装目录。保留用户主目录里的 `.remodex`、`.codex` 和现有 HTTPS 配置。
3. 在原安装目录依次运行 `node setup-server.cjs install relay` 和 `node setup-server.cjs install bridge`。
4. 沿用原来的监听地址和端口。Windows 在任务计划程序里先启动 relay，再启动 bridge，保留已配置的开机触发器。Linux 运行 `systemctl --user start remodex-relay.service remodex-bridge.service`。尚未配置开机自启的电脑按对应平台章节完成设置。
5. 检查原 relay 地址的 `/health` 返回 `{"ok":true}`，再用原配对在 iPhone 上重连。

## HTTPS 入口

每台电脑使用自己的域名和 Caddy。iPhone 通过 WSS 直连该电脑，Caddy 把请求转发给本机 relay。公网入站只开放 Caddy 使用的 TCP 端口。

- **Windows** 把 Caddy 注册为自动启动的 Windows 服务，或在任务计划程序中给它使用与 `Remodex-Relay` 相同的开机设置。采用计划任务时，程序填 `caddy.exe` 的绝对路径，参数填 `run --config "C:\Remodex\Caddyfile" --adapter caddyfile --envfile "C:\Remodex\caddy.env"`。
- **Linux** 使用 Caddy 自带的 systemd 系统服务。将选用的示例复制到 `/etc/caddy/Caddyfile`，用 `sudo systemctl edit caddy` 添加 `[Service]` 和 `EnvironmentFile=/etc/caddy/remodex.env`，然后执行 `sudo systemctl enable --now caddy` 和 `sudo systemctl restart caddy`。

Caddy 的环境文件仅允许管理员或对应服务账号读取，并在升级时保留证书数据目录。使用 DDNS 时也将 DDNS 注册为当前系统的开机服务。[Caddy 后台服务配置](https://caddyserver.com/docs/running)

### DNS 和动态 IPv6

- IPv6 使用 `AAAA` 指向该电脑的公网 IPv6。只有 `AAAA` 的入口需要手机所在网络支持 IPv6。IPv4 使用 `A` 指向该电脑的公网 IPv4 或可转发的公网入口。同一公网 IPv4 下的多台电脑需要各自的外部端口。使用 Cloudflare 直连时选 **DNS only**（灰云）。
- 动态 IPv6 可用 [ddns-go](https://github.com/jeessy2/ddns-go) 更新 `AAAA`。在每台电脑上选择实际联网的网卡，使用当前有效的非临时公网 IPv6。若同一网卡有隐私地址和长期地址，可用 ddns-go 的命令模式筛选掉 `temporary`、`deprecated` 等地址。macOS 可用 `networksetup -listallhardwareports` 确认网卡名，再用 `ifconfig <网卡名> inet6` 查看地址。可每 30 秒检查一次地址变化，将管理界面限制在本机，或配置后以 `-noweb` 运行。
- Cloudflare API Token 使用 `Zone Read` 和 `DNS Edit`，范围只选对应域。启用 ddns-go 的 IPv6 更新，目标填 `relay.example.com?proxied=false` 以保持灰云。令牌和配置文件保存在本机受限目录，例子中的域名用自己的子域名替换。
- 如果 IPv6 前缀变化时路由器的入站规则仍指向旧地址，更新入站规则。DDNS 负责更新域名指向，手机仍需能访问新的地址和端口。

### 标准端口 443 可达

1. relay 使用 `127.0.0.1:9000`。安装 Caddy，让公网访问它的 TCP `443`。默认自动签证可以使用 `80` 上的 HTTP 验证或 `443` 上的 TLS 验证，按可达性配置防火墙。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https#acme-challenges)
2. 将 `relay/Caddyfile.example` 作为 Caddy 服务的配置，在环境文件中设置 `REMODEX_RELAY_DOMAIN`，再启动该服务。
3. 检查 `https://relay.example.com/health`，然后使用 `wss://relay.example.com/relay` 配对。

### 公网只开放高端口

以下配置适用于有公网 IPv6、标准端口无法完成入站验证或只能从公网访问高端口的电脑。Caddy 使用 Cloudflare DNS-01 自动签发和续签证书，iPhone 使用明确写入 URL 的高端口。这里以公网 TCP `9999` 为例，可选该电脑实际可达的端口。[Let's Encrypt DNS-01 验证](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)

1. 使用包含 `dns.providers.cloudflare` 模块的 Caddy，运行 `caddy list-modules` 检查。创建一个仅服务账号可读的本地环境文件，设置 `CF_API_TOKEN` 和 `REMODEX_RELAY_DOMAIN`。后者只填域名。使用不同 DNS 服务商时，改用对应的 Caddy DNS 模块。[Caddy Cloudflare 模块](https://github.com/caddy-dns/cloudflare#configuration)
2. 将 Windows 的 `relay.env` 或 Linux 的 relay unit 中的 `PORT` 改为 `9999`，启动后台 relay。这里 relay 用 IPv4 回环地址，Caddy 只监听 IPv6，两者可以使用相同端口。从公网明文 relay 迁移时，先停掉旧公网监听，再由 Caddy 接管。
3. 将 `relay/Caddyfile.ipv6.example` 作为 Caddy 服务的配置并启动。若使用其他公网端口，在 Caddy 环境文件中设置 `REMODEX_WSS_PORT`，并放行对应的公网 IPv6 TCP 端口。若本机 relay 使用其他端口，在同一文件中设置 `REMODEX_RELAY_PORT`，使它与后台 relay 的 `PORT` 一致。
4. 检查 `https://relay.example.com:9999/health`，然后使用 `wss://relay.example.com:9999/relay` 配对。

### 配对前检查

1. 从手机关闭 Wi-Fi 后打开 `/health`，应收到 `{"ok":true}`，浏览器应认可证书。再在运行 bridge 的电脑上检查相同地址。如果本机 DNS 把该域名解析到代理的合成地址，可为此域名配置本机解析到 Caddy 的监听地址，并保留原域名进行 TLS 校验。手机在外继续使用公网 DNS。
2. 两个示例都保留 `/relay/`、配对码和信任重连接口的原始路径。使用示例时，可仅在回环 relay 上设置 `REMODEX_TRUST_PROXY=true`，使用 Caddy 写入的客户端 IP 进行限速。公开的明文 relay 应关闭。服务日志应省略完整的会话路径和配对标识。[Caddy 反向代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

已在 Mac 和真实 iPhone 上验证自定义端口 WSS、Cloudflare DNS 签证及从外部 IPv6 网段扫码连接。Windows 与 Linux 的实机配对和开机恢复仍需在各自目标机器上验证。
