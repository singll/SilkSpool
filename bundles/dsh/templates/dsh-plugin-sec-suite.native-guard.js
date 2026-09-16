// 原生工具不能绕过 SilkSecAgent 的 Scope/exec 网关或直接改写域拥有的数据。
import * as fs from 'node:fs'
import * as path from 'node:path'

const UNGOVERNED_NETWORK_TOOLS = new Set(['bash', 'web_fetch'])
const FILE_WRITERS = new Set(['write', 'edit'])
const RUN_CONTROL_FILES = new Set(['meta.json', 'model-patch.yml', 'worker-session.json', 'worker.log', 'cmd.txt', 'proposal.json', 'stdout.log', 'stderr.log'])

function inside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

// realpath 最长已有祖先，防已有目录/文件软链把一次工作区写入转到域库或配置。
function physical(filename) {
  let existing = path.resolve(filename)
  const suffix = []
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing))
    const parent = path.dirname(existing)
    if (parent === existing) throw new Error('路径没有可解析的祖先')
    existing = parent
  }
  return path.join(fs.realpathSync(existing), ...suffix)
}

export function installNativeToolGuard(ctx, { baseDir, dataDir }) {
  if (typeof ctx.tools.guard !== 'function') {
    throw new Error('此候选需要 DSH 的 tools.guard，拒绝在不支持强制工具守卫的运行时加载')
  }
  ctx.inject(['systemPrompt'], child => child.systemPrompt.section({
    name: 'silksec-scope-policy', order: 95,
    text: 'SilkSecAgent 授权纪律：项目交互必须先经 Scope 检查，并使用 exec_run_cli 的已登记工具接受预算、风险与出口控制。'
      + '原生 bash/web_fetch 不执行项目交互；公共情报检索用 web_search。工作区不等于授权，禁止通过其他工具绕过拒绝。'
      + '本地文件使用 read/glob/grep/write/edit，原生写入限当前工作区；平台配置和领域数据必须使用对应域动词。',
  }))
  return ctx.tools.guard((execution) => {
    const name = execution.name
    if (UNGOVERNED_NETWORK_TOOLS.has(name)) {
      return 'E_SCOPE_NATIVE_TOOL: 此原生工具不能执行 SilkSecAgent 项目交互；请用 exec_run_cli 的已登记工具，公共情报使用 web_search，本地文件用 read/glob/grep/write/edit。'
    }
    if (!FILE_WRITERS.has(name)) return
    const cwd = execution.agent?.session?.header?.cwd
    const args = execution.arguments
    const filename = args?.file_path ?? args?.path
    return workspaceWriteRefusal({ cwd, filename, baseDir, dataDir })
  })
}

// 浏览器截图与原生 write/edit 共用同一物理路径边界。
export function workspaceWriteRefusal({ cwd, filename, baseDir, dataDir }) {
  if (!cwd || typeof filename !== 'string' || !filename) {
    return 'E_SCOPE_FILE_WRITE: 缺少可核实的工作区或文件路径，拒绝原生写入。'
  }
  try {
    const protectedRoot = physical(baseDir)
    const resultsRoot = physical(path.join(dataDir, 'results'))
    const workspace = physical(cwd)
    const target = physical(path.resolve(cwd, filename))
    if (!inside(target, workspace)) return 'E_SCOPE_FILE_WRITE: 只能写当前工作区；领域状态请使用对应域动词。'
    if (inside(target, protectedRoot)) {
      const runRelative = path.relative(resultsRoot, workspace)
      const ownRun = /^w[a-z0-9]+$/.test(runRelative)
      if (!ownRun || !inside(target, workspace) || RUN_CONTROL_FILES.has(path.relative(workspace, target))) {
        return 'E_SCOPE_FILE_WRITE: 平台配置、域数据和执行控制文件禁止原生改写；请使用对应域动词。'
      }
    }
  } catch {
    return 'E_SCOPE_FILE_WRITE: 无法验证文件的实际归属，拒绝写入。'
  }
}
