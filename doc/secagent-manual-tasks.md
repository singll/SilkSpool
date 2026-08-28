# SilkSecAgent 人工待办清单（Human Action Required）

> 性质：Living Document。自动化体系无法自行完成、**必须人工执行**的事项统一登记在此。
> 每项含：待做什么、为什么、做完后如何接入系统。
> 新增待办一律追加到「待办事项」节；完成后移入「已完成」并记录接入结果。
> 关联：每日 handoff 的「阻塞与求助」段按解锁收益排序引用本文档编号。

## 待办事项

---

### H-001 OOB 带外域名 NS 委派

- **优先级**：P0（解锁盲 SSRF/盲注/盲 RCE/异步回调整类漏洞——没有 OOB 这类漏洞物理上不可测）
- **解锁收益**：VC-009 SSRF 及全部盲类卡片的 `BLOCKED(tool-missing)`
- **待做什么**：
  1. 选定一个域名作为 OOB 专用域，建议子域方案：`oob.singll.net`
  2. 在 DNS 服务商处添加两条记录：
     - `ns1.oob.singll.net` → A 记录 → `141.11.43.99`（csai 公网 IP）
     - `oob.singll.net` → NS 记录 → `ns1.oob.singll.net`
  3. 通知 agent 域名已生效
- **现状**：interactsh-server v1.3.1 已部署 `/opt/silkspool/dsh/oob/`，systemd unit 已备好（`interactsh.service.prepared`，当前域名为占位符 `OOB_DOMAIN_TBD`）
- **做完后如何接入**（agent 可代办，告知域名即可）：
  1. 把 unit 中 `OOB_DOMAIN_TBD` 替换为实际域名，安装为 `/etc/systemd/system/interactsh.service`
  2. `systemctl enable --now interactsh`，确认 53(DNS)/8088(HTTP) 端口监听
  3. 自我验证：向 `test-<random>.oob.singll.net` 发 DNS 查询，interactsh 日志出现记录即通
  4. 更新 VC-009 等卡片 `prerequisites.tools` 中的 oob 可用状态；attempts 台账中 `BLOCKED(tool-missing)` 的相关条目转 PENDING 重测
  5. 防火墙确认放行：53/udp、53/tcp、8088/tcp（8443/8025/8389 可选）

---

### H-002 SRC 测试账号注册（双项目成对凭据）

- **优先级**：P0（解锁全部 `BLOCKED(no-credential)`——越权 IDOR/业务逻辑/登录态面，当前高价值面全部卡在这里）
- **解锁收益**：VC-008 IDOR、VC-017 业务逻辑、全部登录态后 huntlist 条目（美团 carrier proxy/admin.erp/lbs 控制台/keeservice；字节 saiyan/live_console/火山 ark 等）
- **待做什么**（按可行性排序，每项目至少**成对 2 个账号**，测水平越权必需）：
  1. **美团 C 端主账号 ×2**（手机号注册）——unitivelogin SSO 一号通多子系统，乘数效应最大
  2. **字节/抖音 C 端账号 ×2** + **火山引擎个人试用账号 ×1-2**（送额度，解锁 ark/console 面）
  3. 可选：美团开放平台开发者、Keeta 海外站（邮箱即可）、coze/Trae 开发者账号
- **红线**：仅用自行注册/官方试用账号；绝不使用拖库/暗网凭据；测试只操作自建数据
- **做完后如何接入**：
  1. 凭据存入 DSH credentials 表（程序界面或凭据库，**不写明文进任何台账/报告**）
  2. 告知 agent 哪些系统已有凭据：agent 更新 scope.yml rules 关联 + 记录 `cred:<system>` 黑板指针
  3. agent 用 shared-browser profile 完成首次人工登录（扫码/短信验证需人配合一次），之后会话由 profile 持久化 + xray 7777 代理链自动维持
  4. attempts 台账中相关 `BLOCKED(no-credential)` 条目批量转 PENDING，按优先级队列消化
  5. 越权测试启用 authz_diff 双账号差分（VC-008 卡规程）

---

### H-003 存量 findings 回填 vuln_type

- **优先级**：P2（数据质量，不阻塞挖掘）
- **待做什么**：确认允许 agent 批量回填（美团 187 条 + 字节 89 条中 273 条缺 vuln_type 字段）
- **做完后如何接入**：agent 按 CWE 分类批量回填，info 级带类型、有确认价值的补 CWE；回填后 findings 统计口径生效

---

## 已完成

（暂无）

---

## 登记规范（新增待办时遵守）

1. 每条含：编号（H-xxx 递增）、优先级、解锁收益（关联哪些 BLOCKED/卡片）、待做步骤、做完后接入方法
2. 「做完后如何接入」必须具体到可执行步骤——让拿到结果的人（或 agent）能零思考完成接入
3. handoff「阻塞与求助」段引用本文档编号，不重复展开细节
