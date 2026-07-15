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

interface CliSession {
  process: ChildProcess
  pendingResolve: ((value: string) => void) | null
  outputBuffer: string
  sentinel: string
  lastActive: number
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

    if (!session || !session.process.pid) {
      this.persistentSessions.delete(config.id)
      session = this.createPersistentSession(config)
      this.persistentSessions.set(config.id, session)
    }

    session.lastActive = Date.now()

    return new Promise<AgentResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (session!.pendingResolve) {
          session!.pendingResolve = null
          resolve({ reply: { text: '请求超时，请重试。' } })
        }
      }, config.timeout || 30000)

      session!.pendingResolve = (output: string) => {
        clearTimeout(timer)
        resolve({ reply: { text: output } })
      }

      try {
        // 写入用户消息，然后写入哨兵命令，确保能精准检测到输出结束
        // 对 sentinel 做 shell 转义，防止注入
        const escapedSentinel = session!.sentinel.replace(/[^a-zA-Z0-9_]/g, '_')
        session!.process.stdin?.write(payload.message.text + '\n')
        session!.process.stdin?.write(`echo ${escapedSentinel}\n`)
      } catch {
        clearTimeout(timer)
        session!.pendingResolve = null
        this.persistentSessions.delete(config.id)
        resolve({ reply: { text: '会话已断开，请重新发送消息。' } })
      }
    })
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
      pendingResolve: null,
      outputBuffer: '',
      sentinel,
      lastActive: Date.now(),
    }

    child.stdout?.on('data', (data: Buffer) => {
      session.outputBuffer += data.toString()

      // 当输出中出现哨兵字符串时，说明本轮回复已结束
      const sentinelIndex = session.outputBuffer.indexOf(sentinel)
      if (sentinelIndex !== -1 && session.pendingResolve) {
        const result = session.outputBuffer.slice(0, sentinelIndex).trim()
        session.outputBuffer = session.outputBuffer.slice(sentinelIndex + sentinel.length)
        const resolve = session.pendingResolve
        session.pendingResolve = null
        resolve(result || '（无输出）')
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (session.pendingResolve) {
        const resolve = session.pendingResolve
        session.pendingResolve = null
        resolve(text)
      }
    })

    child.on('close', () => {
      if (session.pendingResolve) {
        const resolve = session.pendingResolve
        session.pendingResolve = null
        resolve(session.outputBuffer.trim() || '进程已退出。')
      }
      this.persistentSessions.delete(config.id)
    })

    child.on('error', (err) => {
      if (session.pendingResolve) {
        const resolve = session.pendingResolve
        session.pendingResolve = null
        resolve(`进程错误: ${err.message}`)
      }
      this.persistentSessions.delete(config.id)
    })

    return session
  }

  closeSession(agentId: string): void {
    const session = this.persistentSessions.get(agentId)
    if (session) {
      session.process.kill()
      this.persistentSessions.delete(agentId)
    }
  }

  closeAll(): void {
    for (const [, session] of this.persistentSessions) {
      session.process.kill()
    }
    this.persistentSessions.clear()
  }
}
