# 本地操作规则

## 禁止操作

- **禁止 `docker compose down -v` 或 `--volumes` 操作 n8n** — `prod-n8n` volume 包含所有工作流、凭证、API Key，删除不可恢复
- **n8n 重启仅使用 `docker stop sp-n8n && docker start sp-n8n`**，绝不可 `up -d --force-recreate`
- **禁止直接 SSH 手动操作远程 Docker** — 必须使用 PATH 中的 `spool exec`

## n8n 数据保护

| 资源 | 保护方式 |
|------|---------|
| `prod-n8n` volume | 保存 n8n 用户目录；业务数据库为 prod PostgreSQL，`docker compose down` 不删除，但 `--volumes` 会 |
| `N8N_ENCRYPTION_KEY` | 写入 `hosts/prod/.env`，通过 compose environment 注入 |
| API Key | 存储在 n8n PostgreSQL 中，容器重建后只要 volume 在就保留 |
