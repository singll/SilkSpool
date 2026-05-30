# Matrix 控制平面

> Matrix 仍然是 SilkSpool 的统一通知、命令和人机交互入口。
> **当前权威实施方案已迁移到 Bellkeeper 文档**：SilkSpool 这里只保留控制平面定位、部署边界与权威文档跳转。

---

## 角色定位

在 SilkSpool 总架构中，Matrix 的语义仍然是：

1. **通知出口**：让系统告警、日报、工作流结果统一回流到可读房间
2. **命令入口**：让用户从 Matrix 发起控制、查询与管理操作
3. **人机闭环**：让自动化系统的结果回到可确认、可追踪、可治理的交互界面

因此 Matrix 是：

- **控制平面**
- **通知与交互外壳**
- **自动化结果回流界面**

而不是知识主库存储层。

---

## 部署边界

当前长期目标架构中：

- **txhk**：承载 Matrix homeserver / 公网入口
- **keeper**：承载 Matrix Bot Platform 控制中心
- **Bellkeeper**：承载 Matrix 机器人基础设施的正式实现、治理、通知与命令平台

也就是说：

- Matrix 协议入口仍然在 `txhk`
- 真正的 bot runtime、通知网关、命令路由、治理与管理 API 以 Bellkeeper 为实施主体
- n8n 后续只作为被对接的编排层，而不再作为 Matrix runtime 的权威落点

---

## 实施现状

Matrix 基础设施已在 Bellkeeper 中完成大部分实现（完成度约 85%）。

### 已完成

| 组件 | 代码位置 | 说明 |
|------|---------|------|
| Matrix Gateway | `internal/matrix/gateway/` | mautrix 同步循环、自动加入、Redis 去重、Token 持久化 |
| Command Router | `internal/matrix/command/router.go` | 内置命令 + n8n webhook 转发 + 权限检查 |
| 权限引擎 | `internal/matrix/policy/` | owner/admin/member/guest 角色、权限模型、测试 |
| 通知网关 | `internal/matrix/notify/` + `internal/service/notification.go` | NATS 队列、频道路由、限速（20 msg/min） |
| Admin API | `internal/handler/matrix_admin.go` | 房间/频道/命令/角色/日志/统计 CRUD |
| 前端管理页面 | `web/src/pages/matrix/` | Dashboard/Rooms/Channels/Commands/Events/Notifications/Logs |
| Admin 管理命令 | `internal/matrix/command/handlers.go` | !health, !rooms, !commands |
| DirectMemosHandler | `internal/matrix/command/` | Memos + todo.txt 格式融合，部分命令已实现 |

### 未完成

| 事项 | 状态 | 说明 |
|------|------|------|
| Direct Memos 完善 | 部分完成 | 基础操作已支持，部分子命令仍是 stub |
| 命令从 DB 加载 | TODO | `command/router.go:37`，当前命令硬编码注册 |

### 参考文档

- Bellkeeper `doc/NEXT-PHASE-PLAN.md` — 规划阶段与完成度详情
- Bellkeeper `doc/API.md` — Matrix Admin API 接口参考
- Bellkeeper `doc/ARCHITECTURE.md` — 系统架构总览

---

## 与其他模块的关系

| 模块 | 当前语义 |
|------|----------|
| Matrix | 控制平面、通知与交互入口 |
| Bellkeeper | Matrix Bot Platform 的正式实现主体 |
| n8n | 编排与自动化执行后端 |
| RAG / Search | 问答与检索后端能力 |
| Memos | 待办与碎片笔记后端能力 |
| TrueNAS | 文件与数据存储平面 |

---

## 相关文档

- [../automation/README.md](../automation/README.md) — 自动化层总说明
- [../knowledge/README.md](../knowledge/README.md) — 问答与检索后端能力
- [../../architecture/infrastructure.md](../../architecture/infrastructure.md) — 主机分工与部署边界
