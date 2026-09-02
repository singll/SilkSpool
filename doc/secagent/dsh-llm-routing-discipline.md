# SilkSecAgent LLM 路由纪律

> 生效日期：2026-09-02  
> 适用范围：csai / SilkSecAgent（DSH）全部会话、任务、headless worker

## 核心纪律

1. **默认 LLM 路由必须经 Bellkeeper `/api/llm/v1`**  
   `settings.yaml` 的 `agent-default-model` 必须为：
   ```yaml
   agent-default-model:
     provider: bellkeeper
     model: pool-secagent
   ```
   禁止把 `opencode-go`、`deepseek`、`sensenova` 等上游供应商设为默认。

2. **Bellkeeper 是额度、熔断、粘性、模型组的唯一调度者**  
   DSH 不再自行决定具体上游渠道。`pool-secagent` 模型组已在 Bellkeeper 配置为：
   `sensenova glm-5.2 → sensenova deepseek-v4-flash → deepseek 官方 → opencode-go 兜底`。

3. **应急直连仅作为网关完全不可用时的手动回退**  
   `deepseek`、`opencode-go` 保留在 `llm-pi-ai.providers` 中，但仅在 Bellkeeper 宕机或运维明确授权时切换。

4. **任务级模型覆盖不得绕过 Bellkeeper**  
   看板/代码创建的 `provider/model` 覆盖仍应指向 `bellkeeper` 路由内的模型或模型组；禁止指向直连供应商。

## 变更管控

- `bundles/dsh/templates/settings.yaml` 是真相源模板。
- `spool bundle dsh setup` 会把它覆盖到 `/opt/silkspool/dsh/data/settings.yaml`。
- 任何默认路由变更必须同时修改：
  1. `bundles/dsh/templates/settings.yaml`
  2. `bundles/dsh/templates/data-seed/scripts/data-quality.py` 的 `check_settings` 期望
  3. 本纪律文档
- 手动在 runtime 改 `settings.yaml` 会在下一次 setup 被覆盖；data-quality 每日/每周也会报警。

## 为什么曾被切断

2026-08-31 左右，runtime `settings.yaml` 的 `agent-default-model` 被从 `sensenova` 改为 `opencode-go`，导致 DSH 绕开 Bellkeeper 直接走已耗尽额度的 OpenCode Go 套餐。推测原因：

- Web UI Models 页或某次 `settings.replace` 写回旧值；
- 没有版本化/审计 `settings.yaml`；
- data-quality 未校验默认 provider。

本次修复通过“模板受控 + data-quality critical 检查 + 文档纪律”防止复发。

## 相关文件

- 模板：`bundles/dsh/templates/settings.yaml`
- 校验：`bundles/dsh/templates/data-seed/scripts/data-quality.py`
- 安装：`bundles/dsh/templates/setup.sh`（覆盖 settings.yaml）
- Bellkeeper 网关：`internal/handler/llm_proxy.go`、`config/bellkeeper.yaml`
- DSH 任务级覆盖：`bundles/dsh/templates/dsh-plugin-sec-suite.*`
