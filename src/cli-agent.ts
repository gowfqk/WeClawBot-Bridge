import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { AgentConfig, AgentPayload, AgentResponse } from './types'
import { createLogger } from './logger'

const log = createLogger('cli-agent')

const DEFAULT_SENTINEL = '__WCBOT_END__'

/** 允许的 CLI 命令白名单（可扩展） */
const ALLOWED_COMMANDS = new Set([
  'claude', 'codex', 'opencode', 'python3', 'python', 'node', 'bash', 'sh', 'git', 'curl', 'make',
])

/** 验证 CLI 命令是否在白名单中 */
function validateCliCommand(command: string): string | null {
  // 提取命令基础名（去除路径前缀）
  const baseName = path.basename(command)
  if (ALLOWED_COMMANDS.has(baseName)) return null
  return `CLI 命令 "${baseName}" 不在允许列表中。允许的命令：${Array.from(ALLOWED_COMMANDS).join(', ')}`
}

/** 验证工作目录是否在安全范围内 */
function validateWorkDir(workDir: string): string | null {
  const resolved = path.resolve(workDir)
  // 禁止根目录和常见敏感目录
  const blocked = ['/etc', '/root', '/var', '/usr', '/bin', '/sbin', '/sys', '/proc', '/dev', '/boot']
  for (const dir of blocked) {
    if (resolved === dir || resolved.startsWith(dir + '/')) {
      return `工作目录 "${workDir}" 位于受限路径内，请使用项目目录`
    }
  }
  // 禁止路径穿越
  if (resolved.includes('..')) {
    return `工作目录 "${workDir}" 包含路径穿越，请使用绝对路径`
  }
  return null
}

/** 验证 CLI 参数安全性 */
function validateCliArgs(args: string[]): string | null {
  for (const arg of args) {
    // 禁止命令替换和管道
    if (/[`$]|(\|\|)|(&&)/.test(arg)) {
      return `CLI 参数包含不安全字符：${arg}`
    }
  }
  return null
}

/** 持久会话中等待 stdin/stdout 往返的单个请求 */
interface PendingCliRequest {
  text: string
  resolve: (value: string) => void
  timeoutMs: number
  /** 从请求真正写入 stdin 后才开始计时，排队等待时间不计入 Agent 执行超时 */
  timer: ReturnType<typeof setTimeout> | null
}

/** 同一 Agent 同一时刻最多排队等待的请求数，超过直接拒绝避免无限积压 */
const MAX_PERSISTENT_QUEUE = 20

interface CliSession {
  process: ChildProcess
  outputBuffer: string
  stderrBuffer: string
  sentinel: string
  lastActive: number
  /** 排队中尚未写入 stdin 的请求（FIFO） */
  queue: PendingCliRequest[]
  /** 已写入 stdin、正在等待 sentinel 的请求，同时最多一个 */
  active: PendingCliRequest | null
}

export class CliAgentAdapter {
  private persistentSessions: Map<string, CliSession> = new Map()

  async invoke(config: AgentConfig, payload: AgentPayload): Promise<AgentResponse> {
    // 安全校验：验证 CLI 命令、工作目录和参数
    const command = config.cliCommand || config.id
    const cmdError = validateCliCommand(command)
    if (cmdError) {
      log.warn({ command, agentId: config.id }, cmdError)
      return { reply: { text: `安全限制：${cmdError}` } }
    }

    if (config.cliWorkDir) {
      const dirError = validateWorkDir(config.cliWorkDir)
      if (dirError) {
        log.warn({ workDir: config.cliWorkDir, agentId: config.id }, dirError)
        return { reply: { text: `安全限制：${dirError}` } }
      }
    }

    if (config.cliArgs) {
      const argsError = validateCliArgs(config.cliArgs)
      if (argsError) {
        log.warn({ args: config.cliArgs, agentId: config.id }, argsError)
        return { reply: { text: `安全限制：${argsError}` } }
      }
    }

    const mode = config.cliMode || 'oneshot'
    if (mode === 'persistent') {
      return this.invokePersistent(config, payload)
    }
    return this.invokeOneshot(config, payload)
  }

  private async invokeOneshot(config: AgentConfig, payload: AgentPayload): Promise<AgentResponse> {
    const command = config.cliCommand || config.id
    const args = config.cliArgs || []
    const input = payload.message.text

    return new Promise<AgentResponse>((resolve) => {
      const child = spawn(command, args, {
        cwd: config.cliWorkDir || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: config.timeout || 30000,
        env: { ...process.env, ...(config.cliEnv || {}) },
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          resolve({ reply: { text: `命令执行失败 (exit code ${code}): ${stderr.slice(0, 200)}` } })
          return
        }
        resolve({ reply: { text: stdout.trim() || stderr.trim() || '无输出' } })
      })

      child.on('error', (err) => {
        resolve({ reply: { text: `无法启动命令: ${err.message}` } })
      })

      child.stdin?.write(input)
      child.stdin?.end()
    })
  }

  private async invokePersistent(config: AgentConfig, payload: AgentPayload): Promise<AgentResponse> {
    let session = this.persistentSessions.get(config.id)

    // exitCode !== null 或 killed 才能可靠地说明进程已结束；pid 在进程退出后仍保留，不能用作判活依据。
    if (!session || session.process.exitCode !== null || session.process.killed) {
      this.persistentSessions.delete(config.id)
      session = this.createPersistentSession(config)
      this.persistentSessions.set(config.id, session)
    }

    session.lastActive = Date.now()
    const activeSession = session

    if (activeSession.queue.length >= MAX_PERSISTENT_QUEUE) {
      return { reply: { text: 'Agent 正忙，排队请求过多，请稍后再试。' } }
    }

    return new Promise<AgentResponse>((resolve) => {
      const request: PendingCliRequest = {
        text: payload.message.text,
        resolve: (output: string) => resolve({ reply: { text: output } }),
        timeoutMs: config.timeout || 30000,
        timer: null,
      }

      // 排队，不直接写 stdin：同一会话同时只允许一个请求在途，避免多个
      // pending 请求争抢同一输出流导致响应错位。
      activeSession.queue.push(request)
      this.dispatchNext(config.id, activeSession)
    })
  }

  /** 将队列头部请求写入 stdin（仅当当前无 active 请求时） */
  private dispatchNext(agentId: string, session: CliSession): void {
    if (session.active) return
    const next = session.queue.shift()
    if (!next) return
    session.active = next
    session.stderrBuffer = ''
    next.timer = setTimeout(() => this.handleTimeout(agentId, session, next), next.timeoutMs)

    try {
      // 对 sentinel 做 shell 转义，防止注入
      const escapedSentinel = session.sentinel.replace(/[^a-zA-Z0-9_]/g, '_')
      if (!session.process.stdin?.writable) throw new Error('stdin is not writable')
      session.process.stdin.write(next.text + '\n')
      session.process.stdin.write(`echo ${escapedSentinel}\n`)
    } catch {
      session.active = null
      if (next.timer) clearTimeout(next.timer)
      next.resolve('会话已断开，请重新发送消息。')
      this.terminateSession(agentId, session, '会话已断开，请重新发送消息。')
    }
  }

  /** 请求超时：子进程可能仍在执行该命令，之后才迟到输出/哨兵，会与后续
   * 请求的输出混淆。无法再信任该会话的输出帧界限，直接重置整个会话，
   * 下次请求重新创建进程。 */
  private handleTimeout(agentId: string, session: CliSession, request: PendingCliRequest): void {
    if (session.active !== request) return // 已通过 sentinel/close/error 处理完毕
    session.active = null
    request.resolve('请求超时，请重试。')
    log.warn({ agentId }, 'CLI persistent 请求超时，重置会话以避免后续请求读到迟到输出')
    this.terminateSession(agentId, session, '会话已重置（上一请求超时），请重新发送消息。')
  }

  /** 终止会话：拒绝所有仍排队中的请求，杀死子进程并从映射中移除（若仍为当前会话） */
  private terminateSession(agentId: string, session: CliSession, message: string): void {
    for (const req of session.queue) {
      if (req.timer) clearTimeout(req.timer)
      req.resolve(message)
    }
    session.queue = []
    if (this.persistentSessions.get(agentId) === session) {
      this.persistentSessions.delete(agentId)
    }
    try { session.process.kill() } catch {}
  }

  /** 进程自行退出/报错时：同时处理 active 与排队中的所有请求，不重复 kill 已结束的进程 */
  private failAllPending(session: CliSession, message: string): void {
    if (session.active) {
      if (session.active.timer) clearTimeout(session.active.timer)
      session.active.resolve(message)
      session.active = null
    }
    for (const req of session.queue) {
      if (req.timer) clearTimeout(req.timer)
      req.resolve(message)
    }
    session.queue = []
  }

  private createPersistentSession(config: AgentConfig): CliSession {
    const command = config.cliCommand || config.id
    const args = config.cliArgs || []
    const sentinel = config.cliSentinel || DEFAULT_SENTINEL

    const child = spawn(command, args, {
      cwd: config.cliWorkDir || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.cliEnv || {}) },
    })

    const session: CliSession = {
      process: child,
      outputBuffer: '',
      stderrBuffer: '',
      sentinel,
      lastActive: Date.now(),
      queue: [],
      active: null,
    }

    child.stdout?.on('data', (data: Buffer) => {
      session.outputBuffer += data.toString()

      // 当输出中出现哨兵字符串时，说明本轮回复已结束
      const sentinelIndex = session.outputBuffer.indexOf(sentinel)
      if (sentinelIndex !== -1 && session.active) {
        const result = session.outputBuffer.slice(0, sentinelIndex).trim()
        session.outputBuffer = session.outputBuffer.slice(sentinelIndex + sentinel.length)
        const req = session.active
        session.active = null
        if (req.timer) clearTimeout(req.timer)
        req.resolve(result || session.stderrBuffer.trim() || '（无输出）')
        this.dispatchNext(config.id, session)
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      // stderr 不代表请求结束；不少 CLI 会把进度和诊断写到 stderr。
      // 等 stdout sentinel 到达后，仅在 stdout 为空时用 stderr 作为回复。
      if (session.active) session.stderrBuffer += data.toString()
    })

    child.on('close', () => {
      const message = session.outputBuffer.trim() || session.stderrBuffer.trim() || '进程已退出。'
      this.failAllPending(session, message)
      if (this.persistentSessions.get(config.id) === session) {
        this.persistentSessions.delete(config.id)
      }
    })

    child.on('error', (err) => {
      this.failAllPending(session, `进程错误: ${err.message}`)
      if (this.persistentSessions.get(config.id) === session) {
        this.persistentSessions.delete(config.id)
      }
    })

    return session
  }

  closeSession(agentId: string): void {
    const session = this.persistentSessions.get(agentId)
    if (session) {
      this.failAllPending(session, '会话已关闭。')
      session.process.kill()
      this.persistentSessions.delete(agentId)
    }
  }

  closeAll(): void {
    for (const [, session] of this.persistentSessions) {
      this.failAllPending(session, '会话已关闭。')
      session.process.kill()
    }
    this.persistentSessions.clear()
  }
}
