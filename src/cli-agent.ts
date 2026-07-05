import { spawn, ChildProcess } from 'node:child_process'
import type { AgentConfig, AgentPayload, AgentResponse } from './types'

const DEFAULT_SENTINEL = '__WCBOT_END__'

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
        env: { ...process.env, ...(config.headers || {}), ...(config.cliEnv || {}) },
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
      env: { ...process.env, ...(config.headers || {}) },
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
