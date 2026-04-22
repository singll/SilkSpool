# 本地操作规则

## 禁止操作

- **禁止 `docker compose down -v` 或 `--volumes` 操作 n8n** — `kp-n8n-data` volume 包含所有工作流、凭证、API Key，删除不可恢复
- **n8n 重启仅使用 `docker stop sp-n8n && docker start sp-n8n`**，绝不可 `up -d --force-recreate`
- **禁止直接 SSH 手动操作远程 Docker** — 必须使用 `./spool.sh exec`

## n8n 数据保护

| 资源 | 保护方式 |
|------|---------|
| `kp-n8n-data` volume | 包含 SQLite 数据库，`docker compose down` 不删除，但 `--volumes` 会 |
| `N8N_ENCRYPTION_KEY` | 写入 `hosts/keeper/.env`，通过 compose environment 注入 |
| API Key | 存储在 n8n SQLite 中，容器重建后只要 volume 在就保留 |
