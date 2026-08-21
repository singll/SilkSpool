// ==============================================================================
// SilkSecAgent 本地向量嵌入模块（@huggingface/transformers，multilingual-e5-small）
// 不是 dsh 插件——由 experience-hub 通过 file:// 绝对路径可选加载（见 SEC_EMBEDDINGS）。
// 模型缓存到 $SEC_DATA_DIR/models（首次加载自动下载 ~120MB）
// ==============================================================================

import * as path from 'node:path'

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
process.env.HF_HOME = process.env.HF_HOME || path.join(DATA_DIR, 'models')

let extractorPromise = null

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers').then((m) =>
      m.pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })
    )
  }
  return extractorPromise
}

// 返回 384 维向量（均值池化 + L2 归一化由模型管线完成）
export async function embed(text) {
  const ex = await getExtractor()
  const out = await ex(`query: ${String(text).slice(0, 512)}`, { pooling: 'mean', normalize: true })
  return Array.from(out.data)
}

export async function embedPassage(text) {
  const ex = await getExtractor()
  const out = await ex(`passage: ${String(text).slice(0, 512)}`, { pooling: 'mean', normalize: true })
  return Array.from(out.data)
}

export function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}
