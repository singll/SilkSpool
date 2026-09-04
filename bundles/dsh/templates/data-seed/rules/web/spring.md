# Spring / Spring Boot 审计先验（语言框架规则·末段漏洞判定另见具体漏洞卡）

## 入口点模式
- 控制器注解族：@RequestMapping/@GetMapping/@PostMapping + 类级路径前缀拼接；@RestControllerAdvice 不改路由
- 隐式入口：/actuator/*（env/heapdump/refresh/gateway/routes 是重灾区）、/error 页、Spring Cloud Gateway 路由表
- 路径匹配差异：antMatchers 与 mvcMatchers 对尾斜杠/分号路径/大小写处理不同——鉴权配置用 antMatchers 而控制器容忍变体 = 绕过高发点

## 特有攻击面
- SpEL 注入：@Value/@PreAuthorize 拼接用户输入、Spring4Shell（CVE-2022-22965，JDK9+ + WAR 部署 + 特定绑定）
- Jackson/Fastjson 反序列化：@RequestBody 多态类型（@type/enableDefaultTyping）
- Actuator：heapdump 直下（内存里常有密钥/会话）、env 脱敏绕过（/actuator/env 老版本）、gateway POST /actuator/gateway/routes 加恶意路由 = RCE
- JSP/Thymeleaf SSTI：模板名拼接用户输入
- 鉴权顺序：Filter 链 vs Interceptor vs @PreAuthorize 的执行顺序错位；permitAll 通配过宽

## 验证要点
- 403 是 WAF 还是 Spring Security？看响应头/错误体指纹，别误判
- actuator 存在 ≠ 可用：逐个端点试，看 management.endpoints.web.exposure.include 配置痕迹
