-- 插入网络安全领域 RSS 源
INSERT INTO rss_feeds (name, url, category, description, is_active, fetch_interval_minutes, created_at, updated_at)
VALUES
  ('FreeBuf - 网络安全', '/freebuf/index', '网络安全', '国内领先的网络安全行业门户', true, 60, NOW(), NOW()),
  ('安全客 - 最新', '/aqk/index', '网络安全', '安全客最新文章', true, 60, NOW(), NOW()),
  ('Hacker News', '/hackernews/newest', '网络安全', 'Hacker News 最新技术资讯', true, 60, NOW(), NOW()),
  ('The Hacker News', '/thehackernews/posts', '网络安全', '国际知名网络安全新闻网站', true, 60, NOW(), NOW()),
  ('Krebs on Security', '/krebsonsecurity/blog', '网络安全', 'Brian Krebs 的安全博客', true, 60, NOW(), NOW()),
  ('Bleeping Computer', '/bleepingcomputer/news/security', '网络安全', '安全新闻和漏洞分析', true, 60, NOW(), NOW())
ON CONFLICT (url) DO NOTHING;

-- 插入人工智能领域 RSS 源
INSERT INTO rss_feeds (name, url, category, description, is_active, fetch_interval_minutes, created_at, updated_at)
VALUES
  ('机器之心', '/jiqizhixin/index', '人工智能', '专业的人工智能媒体和产业服务平台', true, 60, NOW(), NOW()),
  ('量子位', '/qbitai/index', '人工智能', '关注人工智能和前沿科技', true, 60, NOW(), NOW()),
  ('AI 科技评论', '/leiphone/ai', '人工智能', '雷锋网 AI 科技评论', true, 60, NOW(), NOW()),
  ('Hugging Face Papers', '/huggingface/daily-papers', '人工智能', '每日精选 AI 论文', true, 60, NOW(), NOW()),
  ('OpenAI Blog', '/openai/blog', '人工智能', 'OpenAI 官方博客', true, 60, NOW(), NOW()),
  ('Anthropic News', '/anthropic/news', '人工智能', 'Anthropic 官方新闻', true, 60, NOW(), NOW())
ON CONFLICT (url) DO NOTHING;

-- 插入 .NET 编程领域 RSS 源
INSERT INTO rss_feeds (name, url, category, description, is_active, fetch_interval_minutes, created_at, updated_at)
VALUES
  ('.NET Blog', '/dotnet/blog', '.NET', '微软 .NET 官方博客', true, 60, NOW(), NOW()),
  ('C# Digest', '/csharpdigest/index', '.NET', 'C# 技术文章精选', true, 60, NOW(), NOW()),
  ('Scott Hanselman', '/scotthanselman/blog', '.NET', '微软 .NET 技术专家博客', true, 60, NOW(), NOW()),
  ('Andrew Lock', '/andrewlock/blog', '.NET', '.NET Core 深度技术博客', true, 60, NOW(), NOW())
ON CONFLICT (url) DO NOTHING;