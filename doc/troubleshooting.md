# Troubleshooting / 故障排除

Common problems and solutions.

## "Config File not found" / 配置文件未找到

**Symptom**: `failed to read config: Config File "silkspool" Not Found`

**Solution**:
- Run from BaseDir (where `spool` binary and `silkspool.yaml` are located)
- Or use `--config /path/to/silkspool.yaml`
- Or set `SILKSPOOL_CONFIG` environment variable

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

## "RDP gateway won't start" / RDP 网关无法启动

**Symptom**: RDP gateway container exits immediately

**Solution**:
- All environment variables must be set in `hosts/<host>/.env`:
  - `RDP_GATEWAY_TOKEN` — authentication token
  - `RDP_AGENT_URL` — agent endpoint
  - `RDP_AGENT_TOKEN` — shared secret with agent
- No fallback defaults; explicit configuration required

## "Bundle init failed" / Bundle 初始化失败

**Symptom**: `failed to load manifest for <bundle>`

**Solutions**:
1. Ensure bundle directory exists: `bundles/<name>/manifest.yaml`
2. Run `make all` to copy bundles to `out/bundles/`
3. Check manifest YAML syntax

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
