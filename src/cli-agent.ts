import { spawn, ChildProcess } from 'node:child_process'
import type { AgentConfig, AgentPayload, AgentResponse } from './types'

interface CliSession {
  process: ChildProcess
  buffer: string
  pendingResolve: ((value: string) => void) | null
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
        env: { ...process.env, ...(config.headers || {}) },
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          resolve({
            reply: { text: `命令执行失败 (exit code ${code}): ${stderr.slice(0, 200)}` },
          })
          return
        }
        resolve({
          reply: { text: stdout.trim() || stderr.trim() || '无输出' },
        })
      })

      child.on('error', (err) => {
        resolve({
          reply: { text: `无法启动命令: ${err.message}` },
        })
      })

      child.stdin?.write(input)
      child.stdin?.end()
    })
  }

  private async invokePersistent(config: AgentConfig, payload: AgentPayload): Promise<AgentResponse> {
    let session = this.persistentSessions.get(config.id)

    if (!session) {
      session = this.createPersistentSession(config)
      this.persistentSessions.set(config.id, session)
    }

    session.lastActive = Date.now()

    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        session!.pendingResolve = null
        resolve({ reply: { text: '请求超时，请重试。' } })
      }, config.timeout || 30000)

      session!.pendingResolve = (output: string) => {
        clearTimeout(timer)
        resolve({ reply: { text: output } })
      }

      try {
        session!.process.stdin?.write(payload.message.text + '\n')
      } catch (err) {
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

    const child = spawn(command, args, {
      cwd: config.cliWorkDir || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.headers || {}) },
    })

    const session: CliSession = {
      process: child,
      buffer: '',
      pendingResolve: null,
      lastActive: Date.now(),
    }

    let outputBuffer = ''

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      outputBuffer += text

      // 检测输出结束：遇到空行或特定标记时触发回调
      if (text.includes('\n\n') || text.trim().endsWith('>') || text.trim().endsWith('$')) {
        if (session.pendingResolve) {
          const result = outputBuffer.trim()
          outputBuffer = ''
          session.pendingResolve(result)
          session.pendingResolve = null
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      if (session.pendingResolve) {
        session.pendingResolve(text.trim())
        session.pendingResolve = null
      }
    })

    child.on('close', () => {
      this.persistentSessions.delete(config.id)
    })

    child.on('error', () => {
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
    for (const [id, session] of this.persistentSessions) {
      session.process.kill()
    }
    this.persistentSessions.clear()
  }
}
