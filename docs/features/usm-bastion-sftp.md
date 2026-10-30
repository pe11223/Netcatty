# SFTP through DAS-USM bastion virtual assets

DBAPP/Anheng **DAS-USM** bastions (明御运维审计与风险控制系统) do not expose one SSH
endpoint per asset. A single OpenSSH SFTP connection manages every asset behind the
bastion, and the client picks an asset by walking into a virtual directory:

```
/                                                     virtual root
/10.164.12.119:22_ssh_root@视频监控服务                 one directory per asset
/10.164.12.138:22_ssh_root@网络代理服务器
```

Two gateway behaviours broke the SFTP browser before this adapter:

1. **Entry names are GB18030 bytes.** Opening one while the channel is in GB18030
   mode makes the gateway drop the channel; the client only sees `EOF` /
   `Unexpected end of SFTP packet`. The gateway offers a charset toggle pseudo
   directory instead (`!now_gb18030,next_UTF-8`, renamed to
   `!now_UTF-8,next_gb18030` after switching), so the connection is switched to
   UTF-8 by a `REALPATH` through it first. That `REALPATH` returns an error status
   ("charactor is changed please refresh director") while the switch has already
   applied, so the failure is expected and the directory is re-read to confirm.
2. **`REALPATH` binds the whole SSH connection to one asset.** Every later absolute
   path is interpreted inside that asset, on every channel of that connection, and
   only a new SSH connection returns to the virtual root.

## How the adapter works

`electron/bridges/sftpBridge/usmGateway.cjs` keeps the renderer on plain paths
(`/<entry>/…`) and does the gateway-specific translation in the main process:

- `switchUsmGatewayToUtf8` switches the channel to UTF-8 before any path is encoded
  as GB18030, and remembers the result per channel.
- The first `listSftp` into an entry issues `REALPATH` on it and stores
  `{ boundAsset }` on the ssh2 `Client`, so session-backed transfer channels
  opened later on the same connection share the binding.
- `installUsmSftpChannel` wraps the SFTP channel in a `Proxy` that strips the
  `/<entry>` prefix from remote-path arguments once an asset is bound (`rename`,
  `symlink`, `fastPut` and path-taking calls each use their own argument
  position). `realpath` results get the prefix added back.
- Encoding state for a USM session is pinned to `utf-8`, so a user-selected GB18030
  cannot desynchronise the translated paths.
- After binding, the gateway can no longer list the virtual root, so `listSftp("/")`
  returns a synthetic one-entry directory for the bound asset to keep the
  breadcrumb consistent, and requesting a second asset reports a clear error
  instead of silently reading the wrong machine.

Limitation worth knowing: one SSH connection browses one asset. Switching assets
means opening a new SFTP session.

## Verification

`electron/bridges/sftpBridge/usmGateway.test.cjs` covers entry parsing, toggle
detection, path translation and proxy caching. The adapter was additionally
exercised against a live gateway: list root, enter an asset, list and stat inside
it, write/read/delete a file, upload via `fastPut`, the cross-asset error, and the
synthetic root.
