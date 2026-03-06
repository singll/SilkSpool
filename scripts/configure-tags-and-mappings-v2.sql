-- ============================================
-- SilkSpool 多数据集路由配置脚本 v2
-- 功能：创建两层标签体系 + DatasetMapping
-- 日期：2026-03-06
-- ============================================

-- ============================================
-- 第一部分：创建一级标签（4个领域）
-- ============================================

INSERT INTO tags (name, description, color, created_at, updated_at) VALUES
('security', '网络安全', '#F56C6C', NOW(), NOW()),
('ai', '人工智能', '#409EFF', NOW(), NOW()),
('programming', '编程开发', '#67C23A', NOW(), NOW()),
('general', '综合资讯', '#909399', NOW(), NOW())
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 第二部分：创建二级标签 - Security细分（5个）
-- ============================================

INSERT INTO tags (name, description, color, created_at, updated_at) VALUES
('security-web', 'Web安全、XSS、SQL注入', '#F56C6C', NOW(), NOW()),
('security-network', '网络安全、防火墙、入侵检测', '#F56C6C', NOW(), NOW()),
('security-vulnerability', '漏洞情报、CVE、补丁', '#F56C6C', NOW(), NOW()),
('security-tool', '安全工具、扫描器、渗透工具', '#F56C6C', NOW(), NOW()),
('security-pentest', '渗透测试、红队、攻防', '#F56C6C', NOW(), NOW())
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 第三部分：创建二级标签 - AI细分（5个）
-- ============================================

INSERT INTO tags (name, description, color, created_at, updated_at) VALUES
('ai-nlp', '自然语言处理、LLM、文本生成', '#409EFF', NOW(), NOW()),
('ai-cv', '计算机视觉、图像识别', '#409EFF', NOW(), NOW()),
('ai-ml', '机器学习、模型训练、算法', '#409EFF', NOW(), NOW()),
('ai-paper', '学术论文、研究成果', '#409EFF', NOW(), NOW()),
('ai-tool', 'AI工具、框架、平台', '#409EFF', NOW(), NOW())
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 第四部分：创建二级标签 - Programming细分（8个）
-- ============================================

INSERT INTO tags (name, description, color, created_at, updated_at) VALUES
('programming-python', 'Python语言和生态', '#67C23A', NOW(), NOW()),
('programming-go', 'Go语言和生态', '#67C23A', NOW(), NOW()),
('programming-rust', 'Rust语言和生态', '#67C23A', NOW(), NOW()),
('programming-javascript', 'JavaScript/TypeScript/Node.js', '#67C23A', NOW(), NOW()),
('programming-dotnet', '.NET/C#/ASP.NET Core', '#67C23A', NOW(), NOW()),
('programming-web', 'Web开发、前端、后端', '#67C23A', NOW(), NOW()),
('programming-system', '系统编程、操作系统、底层', '#67C23A', NOW(), NOW()),
('programming-data', '数据工程、数据库、大数据', '#67C23A', NOW(), NOW())
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 第五部分：创建DatasetMapping（4个）
-- ============================================

INSERT INTO dataset_mappings (name, display_name, dataset_id, description, is_default, is_active, parser_id, created_at, updated_at) VALUES
('security-mapping', '网络安全映射', 'security-tech', '网络安全知识库', false, true, 'naive', NOW(), NOW()),
('ai-mapping', '人工智能映射', 'ai-tech', '人工智能知识库', false, true, 'naive', NOW(), NOW()),
('programming-mapping', '编程开发映射', 'programming', '编程开发知识库', false, true, 'naive', NOW(), NOW()),
('default-mapping', '默认映射', 'daily-digest', '综合资讯', true, true, 'naive', NOW(), NOW())
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 第六部分：关联一级标签到DatasetMapping
-- ============================================

-- 关联 security 标签到 security-mapping
INSERT INTO dataset_mapping_tags (dataset_mapping_id, tag_id)
SELECT dm.id, t.id FROM dataset_mappings dm, tags t
WHERE dm.name = 'security-mapping' AND t.name = 'security'
ON CONFLICT DO NOTHING;

-- 关联 ai 标签到 ai-mapping
INSERT INTO dataset_mapping_tags (dataset_mapping_id, tag_id)
SELECT dm.id, t.id FROM dataset_mappings dm, tags t
WHERE dm.name = 'ai-mapping' AND t.name = 'ai'
ON CONFLICT DO NOTHING;

-- 关联 programming 标签到 programming-mapping
INSERT INTO dataset_mapping_tags (dataset_mapping_id, tag_id)
SELECT dm.id, t.id FROM dataset_mappings dm, tags t
WHERE dm.name = 'programming-mapping' AND t.name = 'programming'
ON CONFLICT DO NOTHING;

-- ============================================
-- 验证查询（可选执行）
-- ============================================

-- 查看所有标签
-- SELECT name, description, color FROM tags ORDER BY name;

-- 查看DatasetMapping配置
-- SELECT dm.name, dm.dataset_id, dm.is_default, array_agg(t.name) as tags
-- FROM dataset_mappings dm
-- LEFT JOIN dataset_mapping_tags dmt ON dm.id = dmt.dataset_mapping_id
-- LEFT JOIN tags t ON dmt.tag_id = t.id
-- GROUP BY dm.id
-- ORDER BY dm.name;
