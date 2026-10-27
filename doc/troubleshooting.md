# Troubleshooting / 故障排除

Common problems and solutions.

## "Config File not found" / 配置文件未找到

**Symptom**: `failed to read config: Config File "silkspool" Not Found`

**Solution**:
- Run from BaseDir (where `spool` binary and `silkspool.yaml` are located)
- Or use `--config /path/to/silkspool.yaml`

## "SSH connection failed" / SSH 连接失败

**Symptom**: `failed to connect: dial tcp: connection refused` or `timeout`

**Solutions**:
1. Check host address format: `user@ip` (e.g., `silkspool@192.168.7.230`)
2. Verify SSH key path in `silkspool.yaml`: `global.ssh_key_path`
3. Check SSH key permissions: `chmod 600 keys/id_silkspool`
4. For non-standard port, set `ssh_port` in host config
5. Test manually: `ssh -i keys/id_silkspool -p <port> user@host`

## "Host key verification failed" / 主机密钥验证失败

**Symptom**: `failed to setup host key verification: knownhosts: key mismatch`

**Solution**:
- Run `spool init <host>` first to trust the host key
- This adds the host's public key to `known_hosts` in BaseDir
- If host key changed (reinstall), remove old entry from `known_hosts` and re-run `init`

## "n8n client failed" / n8n 客户端失败

**Symptom**: `N8N_API_KEY not found in hosts/<host>/.env` or `API error (401)`

**Solutions**:
1. Ensure `n8n` section exists in `silkspool.yaml` with correct `host` and `api_url`
2. Add `N8N_API_KEY` to `hosts/<n8n.host>/.env`
3. If n8n API is on `localhost`, ensure SSH connection works (remote curl fallback)
4. Verify n8n container is running: `spool service <host> status n8n`

## "Docker compose not found" / Docker Compose 未找到

**Symptom**: `docker compose not found on remote host`

**Solution**:
- SilkSpool auto-detects `docker compose` (v2) or `docker-compose` (v1)
- If neither exists, install Docker Compose on the remote host
- Detection is cached per-host; clear by restarting spool

## "Permission denied (publickey)" / 权限被拒绝

**Symptom**: `Permission denied (publickey)` during SSH

**Solutions**:
1. Check SSH key file exists: `ls -la keys/id_silkspool`
2. Verify permissions: `chmod 600 keys/id_silkspool`, `chmod 700 keys/`
3. Ensure public key is in remote `~/.ssh/authorized_keys`
4. Run `spool init <host>` to deploy the public key

## "Sync failed" / 同步失败

**Symptom**: `Pull failed: <file>` or `Push failed: <file>`

**Solutions**:
1. Check `sync_rules` paths in `silkspool.yaml`:
   - `local`: relative to `hosts/<alias>/`
   - `remote`: absolute path on remote host
2. Ensure remote directory exists and is writable
3. For directories, ensure trailing slash matches intent
4. Check rsync availability on remote (used for directory sync)

## "DNS push failed" / DNS 推送失败

**Symptom**: `failed to push DNS records`

**Solutions**:
1. Verify `dns_gateway_host` in `silkspool.yaml` points to a valid host alias
2. Check `dns_gateway_ip` is set
3. Ensure the gateway host has dnsmasq or OpenClash configured
4. Verify SSH connection to gateway host works

## "failed to load manifest" / Bundle 加载失败

**Symptom**: `failed to load manifest for <bundle>` or `bundle <name> not found locally or in bundle_sources`

**Solutions**:
1. `dir` source：确认 `bundles/<name>/manifest.yaml`（或 `bundle.yaml`）存在，必要时 `make all`。
2. `git` source：确认 `commit` 是固定 7–40 位 sha；首次拉取需要网络，缓存位于 `.spool/cache/`。
3. `oci` source：确认 `digest` 固定且与 registry manifest 一致；见下方 OCI 排查。
4. 用 `spool plan <bundle> <host> --offline --json` 获取完整 schema/引用错误。

## "Service not found" / 服务未找到

**Symptom**: `service <alias> not found in host config`

**Solution**:
- Add the service to `hosts.<alias>.services[]` in `silkspool.yaml`:
  ```yaml
  services:
    - alias: "myapp"
      type: "docker"
      name: "sp-myapp"
  ```

## "Backup failed" / 备份失败

**Symptom**: `backup failed: volume <name> not found`

**Solutions**:
1. Ensure Docker volume exists on remote host
2. For `dir` backups, ensure directory path is correct
3. Check disk space on local backup directory (`~/silkspool_backups/`)

## Debug Mode / 调试模式

Enable verbose output:
```bash
spool -v <command> <args>
```

Check SSH connection manually:
```bash
ssh -i keys/id_silkspool -v user@host
```

## "spool init" fails on OpenWrt / iStoreOS

**Symptom**:

```text
tee: /etc/sudoers.d/root: No such file or directory
Error: SSH initialization failed: exit status 1
```

**Cause**:
- OpenWrt/iStoreOS 没有 `/etc/sudoers.d`；旧脚本无条件写入该目录。
- 目标用户是 `root` 时也不需要 sudoers。
- iStoreOS 使用 Dropbear，除 `~/.ssh/authorized_keys` 外通常还读取 `/etc/dropbear/authorized_keys`。

**Solution**:
- 升级到包含修复的 `spool`（root 跳过 sudoers；非 root 先 `mkdir -p /etc/sudoers.d`）。
- 新脚本会同时写入 `/root/.ssh/authorized_keys` 和 `/etc/dropbear/authorized_keys`。
- 已初始化过但仍提示 `Permission denied (publickey)` 时，在 iStoreOS 控制台确认公钥在：

```sh
cat /root/.ssh/authorized_keys
cat /etc/dropbear/authorized_keys
```

并把 `/opt/SilkSpool/keys/id_silkspool.pub` 的内容追加到缺少的那一个，然后：

```sh
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys /etc/dropbear/authorized_keys
```


## "unresolved input reference" / 输入未提供

**Symptom**: `unresolved input reference ${input.public_url}`

**Solution**:

在 `silkspool.yaml` 的目标 host 上提供输入：

```yaml
hosts:
  keeper:
    inputs:
      public_url: "https://bellkeeper.example.com"
```

或用 `spool plan ... --json` 查看具体缺失的 key。

## "cross-host endpoint ... needs MagicDNS or address"

**Cause**: 依赖 provider 与 consumer 不在同一主机，且 provider 没有 `magicdns`/`address`。

**Solution**:

```yaml
hosts:
  silkdata:
    address: "silkspool@192.168.7.231"
    magicdns: "silkdata"
```

优先 MagicDNS；没有 Headscale 时使用显式地址。不要在模板里写 IP。

## OCI 拉取 / cosign 失败

| 错误 | 处理 |
|---|---|
| `digest is required` | 给 `bundle_sources` 补 `digest: sha256:...`，或写 `ref@sha256:...` |
| `manifest digest mismatch` | `digest` 与 registry 内容不一致；重新获取 manifest digest |
| `OCI blob digest mismatch` | artifact layer 损坏或被替换；重新发布/拉取 |
| `unsupported OCI config media type` | 使用 Timoni/Spool 布局：config `application/vnd.timoni.config.v1+json` 或 empty config |
| `cosign binary not found` | 安装 cosign，或设置 `SPOOL_COSIGN_BIN` 指向可执行文件 |
| `cosign verification failed` | 无签名/签名不匹配/identity/issuer 不对；不会降级，必须修复签名或移除门禁 |

OCI 缓存可安全删除：`.spool/cache/bundles/<name>/`；下次 plan/apply 会重新拉取。

## "adopt: multiple compose projects found"

**Cause**: 目标主机有多个 compose project，未指定要纳管哪一个。

**Solution**:

```bash
spool adopt keeper --bundle <compose-project>
```

先 `spool adopt keeper --dry-run` 查看项目/容器/卷/网络。已有 manifest/state/lock 时加 `--force`。

## plan 有 diff（退出码 3）但不知道改了什么

```bash
spool plan knowledge-stack keeper --json | jq '.data.diff'
```

- 退出码 `3` 只表示 online plan 有 drift；`--offline` 永不返回 `3`。
- 首次部署也会显示 `deployed: false` 的 diff，这是正常的。
- `--locked` apply 前先跑一次 online plan，确认 lock 与当前 manifest 一致。

## 服务健康检查失败 / 自动回滚

- `components` 中 `optional: false` 的服务会参与 health gate；任一失败会在控制端在线时尽力自动回滚（不可逆迁移除外）。控制端退出或失联时不保证恢复。
- `optional: true` 只告警，不阻塞整栈。
- 查看远端 generation：`.spool-gen/current`、`.spool-gen/<n>/meta.yaml`。
- 手工恢复：`spool rollback <bundle> <host> [generation]`。
- `irreversible: true` 时停在 `needs_attention`，需人工确认后处理。
