#!/usr/bin/env python3
"""
Add batch parsing nodes to RSS workflow
"""
import json
import sys

def add_batch_parsing_nodes(workflow):
    """Add batch parsing nodes after '推送文章到Ingest'"""

    # New nodes to add
    new_nodes = [
        {
            "parameters": {
                "jsCode": """// Extract document IDs from successful upload responses
const results = $input.all();
const documents = [];

for (const item of results) {
  const d = item.json;

  // Only process successful uploads
  if (d.success === true && d.uploadResult) {
    const uploadData = d.uploadResult.data;
    const datasetId = d.uploadResult.dataset_id;

    if (!uploadData || !datasetId) continue;

    // Extract document ID from RAGFlow response
    // Response can be: {"id": "xxx"} or [{"id": "xxx"}]
    let docId = null;

    if (typeof uploadData === 'object' && uploadData.id) {
      docId = uploadData.id;
    } else if (Array.isArray(uploadData) && uploadData.length > 0 && uploadData[0].id) {
      docId = uploadData[0].id;
    }

    if (docId) {
      documents.push({
        document_id: docId,
        dataset_id: datasetId,
        title: d.title || 'Untitled',
        url: d.url || ''
      });
    }
  }
}

return [{ json: { documents, count: documents.length } }];"""
            },
            "id": "a1b2c3d4-0001-4000-a000-000000000016",
            "name": "提取文档ID",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1440, 300]
        },
        {
            "parameters": {
                "conditions": {
                    "options": {
                        "caseSensitive": True,
                        "leftValue": "",
                        "typeValidation": "strict"
                    },
                    "conditions": [
                        {
                            "id": "condition-has-docs",
                            "leftValue": "={{ $json.count }}",
                            "rightValue": 0,
                            "operator": {
                                "type": "number",
                                "operation": "gt"
                            }
                        }
                    ],
                    "combinator": "and"
                },
                "options": {}
            },
            "id": "a1b2c3d4-0001-4000-a000-000000000017",
            "name": "有文档需解析?",
            "type": "n8n-nodes-base.if",
            "typeVersion": 2,
            "position": [1560, 300]
        },
        {
            "parameters": {
                "jsCode": """// Group document IDs by dataset_id
const input = $input.first().json;
const documents = input.documents || [];

const grouped = {};
for (const doc of documents) {
  const datasetId = doc.dataset_id;
  if (!grouped[datasetId]) {
    grouped[datasetId] = {
      dataset_id: datasetId,
      document_ids: [],
      titles: []
    };
  }
  grouped[datasetId].document_ids.push(doc.document_id);
  grouped[datasetId].titles.push(doc.title);
}

// Convert to array for iteration
const result = Object.values(grouped);
return result.map(g => ({ json: g }));"""
            },
            "id": "a1b2c3d4-0001-4000-a000-000000000018",
            "name": "按Dataset分组",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1680, 200]
        },
        {
            "parameters": {
                "method": "POST",
                "url": "={{ $env.RAGFLOW_API_URL }}/api/v1/datasets/{{ $json.dataset_id }}/documents/parse",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {
                            "name": "Authorization",
                            "value": "=Bearer {{ $env.RAGFLOW_API_KEY }}"
                        },
                        {
                            "name": "Content-Type",
                            "value": "application/json"
                        }
                    ]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify({ document_ids: $json.document_ids }) }}",
                "options": {
                    "timeout": 30000
                }
            },
            "id": "a1b2c3d4-0001-4000-a000-000000000019",
            "name": "批量解析文档",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1800, 200],
            "continueOnFail": True
        }
    ]

    # Add new nodes
    workflow['nodes'].extend(new_nodes)

    # Update "汇总统计" node
    for node in workflow['nodes']:
        if node['name'] == '汇总统计':
            node['position'] = [1920, 300]
            node['parameters']['jsCode'] = """const now = new Date();
const hour = now.getHours();
let period = '早间';
if (hour >= 11 && hour < 15) period = '午间';
else if (hour >= 17) period = '晚间';

let sourceCount = 0;
try { sourceCount = $('提取RSS源').all().length; } catch(e) {}

// Get article results from "推送文章到Ingest"
const articleResults = $('推送文章到Ingest').all();
let total = articleResults.length;
let success = 0;
let duplicate = 0;
let failed = 0;
for (const r of articleResults) {
  const d = r.json;
  if (d.error) {
    failed++;
  } else if (d.success === false && d.status === 'duplicate') {
    duplicate++;
  } else if (d.success === true) {
    success++;
  } else {
    success++;
  }
}

// Get parsing results
let parseSuccess = 0;
let parseFailed = 0;
let parseTotal = 0;
try {
  const parseResults = $('批量解析文档').all();
  const groupResults = $('按Dataset分组').all();

  for (const r of parseResults) {
    const d = r.json;
    // Find corresponding group to get document count
    const group = groupResults.find(g => g.json.dataset_id === d.dataset_id);
    const docCount = group ? group.json.document_ids.length : 0;
    parseTotal += docCount;

    if (d.error || (d.code && d.code !== 0)) {
      parseFailed += docCount;
    } else {
      parseSuccess += docCount;
    }
  }
} catch(e) {
  // No parsing results, skip
}

const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const timeStr = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

let summary = `📰 ${period}RSS定时采集已完成\\n⏰ ${dateStr} ${timeStr}\\n📊 RSS源: ${sourceCount} 个 | 文章: ${total} 篇`;
summary += `\\n✅ 入库: ${success} | ⏩ 已存在: ${duplicate} | ❌ 失败: ${failed}`;

if (parseTotal > 0) {
  summary += `\\n🔄 解析: ${parseSuccess}/${parseTotal} 成功`;
  if (parseFailed > 0) {
    summary += ` | ⚠️ ${parseFailed} 失败`;
  }
}

return [{ json: { summary, timestamp: now.toISOString() } }];"""
            break

    # Update "发送采集通知" position
    for node in workflow['nodes']:
        if node['name'] == '发送采集通知':
            node['position'] = [2160, 300]
            break

    # Update connections
    # 推送文章到Ingest → 提取文档ID
    workflow['connections']['推送文章到Ingest'] = {
        "main": [[{"node": "提取文档ID", "type": "main", "index": 0}]]
    }

    # 提取文档ID → 有文档需解析?
    workflow['connections']['提取文档ID'] = {
        "main": [[{"node": "有文档需解析?", "type": "main", "index": 0}]]
    }

    # 有文档需解析? → (true) 按Dataset分组, (false) 汇总统计
    workflow['connections']['有文档需解析?'] = {
        "main": [
            [{"node": "按Dataset分组", "type": "main", "index": 0}],
            [{"node": "汇总统计", "type": "main", "index": 0}]
        ]
    }

    # 按Dataset分组 → 批量解析文档
    workflow['connections']['按Dataset分组'] = {
        "main": [[{"node": "批量解析文档", "type": "main", "index": 0}]]
    }

    # 批量解析文档 → 汇总统计
    workflow['connections']['批量解析文档'] = {
        "main": [[{"node": "汇总统计", "type": "main", "index": 0}]]
    }

    return workflow


def main():
    input_file = '/home/ubuntu/SilkSpool/hosts/keeper/n8n-workflows/04-rss-fetch.json'

    with open(input_file, 'r', encoding='utf-8') as f:
        workflow = json.load(f)

    workflow = add_batch_parsing_nodes(workflow)

    with open(input_file, 'w', encoding='utf-8') as f:
        json.dump(workflow, f, ensure_ascii=False, indent=2)

    print(f"✅ Updated {input_file}")
    print("Added nodes:")
    print("  - 提取文档ID")
    print("  - 有文档需解析?")
    print("  - 按Dataset分组")
    print("  - 批量解析文档")
    print("Updated nodes:")
    print("  - 汇总统计 (added parsing statistics)")
    print("  - 发送采集通知 (adjusted position)")


if __name__ == '__main__':
    main()
