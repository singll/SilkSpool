# 案例：Java 应用入口直接反序列化用户字节、预认证 RCE（严重）

> 来源: https://foxglovesecurity.com/2015/11/06/what-do-weblogic-websphere-jboss-jenkins-opennms-and-your-application-have-in-common-this-vulnerability/ · CWE: 502 · 首发年份: 2015
> 关联: rules/techniques/deserialization-test.md · VC 卡: 无

## 模式（什么形状的目标会有这洞）
应用把序列化对象当传输格式：登录前的握手口、监控端口、JMS 消息、RMI 通道直接对用户数据做对象反序列化，而 classpath 里躺着带利用链的通用集合库。入口信号：请求体以 Java 序列化魔数（aced 0005）开头、二进制端口对公网开放。原研究一次命中多款主流中间件与运维平台——这是生态级通病。

## 打法（案例里实际打通的路径）
先指纹：握手口响应是否回序列化对象、监控/管理端口是否裸奔对公网。确认入口后按 deserialization-test 模块选利用链构造载荷，从"确认触发反序列化"到"命令执行"分步验证（打什么、怎么对照看模块，不在此展开）。注意这是预认证面——全程不需要任何账号。

## 出什么算成
无需认证让目标执行指定无害命令（回显、外带、可观测延迟任一证据）。

## 假点（什么样不算）
入口只收 JSON/XML（非原生序列化格式）；依赖版本已去掉利用链；命令在沙箱/低权容器里执行且拿不到外带证据——如实降级，不写 RCE。

## 为什么值钱（severity 依据）
预认证 RCE 且一次命中一大片中间件/企业应用（原研究实测多款产品全线中招），赏金天花板级。
