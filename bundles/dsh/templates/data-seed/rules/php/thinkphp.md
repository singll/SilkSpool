# ThinkPHP 审计先验
> **触发信号**: ThinkPHP, index.php?s=, 兼容模式路由, 多应用, 5.0.x, 5.1.x, method, __construct, 6.x 反序列化, League/Flysystem, app_debug, trace 页, runtime/log, nuclei, afrog, 版本指纹, ThinkPHP V5
> **适用**: 报错页/指纹认出 ThinkPHP 后选 payload 代际（5.0 与 5.1 不通用）、开 debug 泄露与日志直连下载 · **不适用**: 非 ThinkPHP 的 PHP 框架（Laravel/Composer gadget 走 deserialization） · 索引: rules/src/technique-index.md

## 入口点模式
- 兼容模式路由：index.php?s=/module/controller/action（5.x 历史 RCE 面）
- 多应用模式（6.x）：app 目录遍历 + 路由注释

## 特有攻击面
- 5.0.x/5.1.x 远程代码执行（method/__construct 过滤器链，payload 已模板化进 nuclei/afrog）
- 6.x 反序列化链（League/Flysystem 链为主）
- debug 模式：trace 页泄露（绝对路径/SQL/配置）、app_debug=true 指纹
- 数据库日志文件直连下载（runtime/log/）

## 验证要点
- 指纹先用 nuclei shiro-detect 类模板确认框架与版本段，再选 payload 代际（5.0 与 5.1 payload 不通用）
- 报错页含 "ThinkPHP V5.x" 字样=版本指纹直接可读
