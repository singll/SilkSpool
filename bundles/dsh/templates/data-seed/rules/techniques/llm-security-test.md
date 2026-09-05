# llm-security-test（禁开越狱教材）
> **触发信号**: LLM, 越狱, 聊天口, 工具, 数据, SSRF 闭环, 禁开, SRC 开场, 默认不写, 对话口工具真执行, agent-tool-exec, 未授权读, 助手历史, 他人任务, idor, 提示词
> **适用**: 想对聊天口做提示词/越狱测试前判断是否值得开 · **不适用**: 只越狱聊天没有工具/数据/SSRF 闭环想交报告（工具真执行走 agent-tool-exec，读历史走 idor） · 索引: rules/src/technique-index.md

> **SRC 开场勿开本篇。** 只越狱聊天、没有工具/数据/SSRF 闭环 → 默认不写。对话口工具真执行见 `agent-tool-exec-test.md`。未授权读助手历史见 `idor-test.md`「助手历史未授权读他人任务」。
