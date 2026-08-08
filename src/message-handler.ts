import type { CommandHandler } from './command-handler'
import type { UserStateManager } from './user-state'
import type { AgentRegistry } from './agent-registry'
import type { SessionManager } from './session-manager'
import type { BotManager } from './bot-manager'
import { createLogger } from './logger'
import { normalizeUserId } from './single-user'

const log = createLogger('message-handler')
import type { ChatEntry } from './types'

export interface MessageHandlerContext {
  commandHandler: CommandHandler
  userState: UserStateManager
  agentRegistry: AgentRegistry
  sessionManager: SessionManager
  botManager: BotManager
}

export function createMessageHandler(ctx: MessageHandlerContext) {
  const sessionQueues = new Map<string, Promise<void>>()

  const enqueueSessionMessage = async (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = sessionQueues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    sessionQueues.set(key, current)

    try {
      await current
    } finally {
      if (sessionQueues.get(key) === current) sessionQueues.delete(key)
    }
  }

  return async (msg: {
    userId: string
    text: string
    type: string
    hasMedia: boolean
    raw: unknown
  }): Promise<void> => {
    const { commandHandler, userState, agentRegistry, sessionManager, botManager } = ctx
    const { userId: senderId, text, type, raw } = msg
    // 单用户设计：真实微信 senderId 只用于回消息/typing；业务状态和会话统一归到 default。
    const userId = normalizeUserId(senderId)

    const reply = async (text: string) => {
      await botManager.sendReply(raw, { text })
    }

    try {
      const result = commandHandler.parse(text)

      if (result.type === 'help') {
        await reply(commandHandler.getHelpMessage())
        return
      }

      if (result.type === 'agents') {
        await reply(commandHandler.getAgentsMessage())
        return
      }

      if (result.type === 'status') {
        const agents = agentRegistry.listAll()
        await reply(commandHandler.getStatusMessage(agentRegistry, agents))
        return
      }

      if (result.type === 'clear') {
        const agentId = await userState.getCurrentAgent(userId)
        if (agentId) {
          await sessionManager.clear(userId, agentId)
          await reply('当前 Agent 的会话历史已清空。')
        } else {
          await reply('请先选择一个 Agent。')
        }
        return
      }

      if (result.type === 'switch' && result.targetAgentId) {
        const agent = agentRegistry.get(result.targetAgentId)
        if (!agent) {
          await reply('未知的 Agent，发送 #agents 查看可用列表。')
          return
        }
        await userState.switchAgent(userId, result.targetAgentId)
        await reply(`已切换到${agent.name} Agent，会话历史已保留。`)
        return
      }

      if (result.type === 'unknown') {
        await reply('未知的 Agent，发送 #agents 查看可用列表。')
        return
      }

      const currentAgentId = await userState.getCurrentAgent(userId)
      if (!currentAgentId) {
        await reply('请先选择一个 Agent。发送 #agents 查看可用列表。')
        return
      }

      await enqueueSessionMessage(`${userId}:${currentAgentId}`, async () => {
        await botManager.sendTyping(senderId)

        const session = await sessionManager.getOrCreate(userId, currentAgentId)
        const previousHistory = [...session.history]

        let mediaBuffer: Buffer | undefined
        if (msg.hasMedia) {
          try {
            mediaBuffer = await botManager.download(msg)
          } catch {
            await reply('无法处理该文件，请重试。')
            return
          }
        }

        const userEntry: ChatEntry = {
          role: 'user',
          content: text,
          timestamp: Date.now(),
        }
        await sessionManager.append(userId, currentAgentId, userEntry)

        // history 只传之前的消息，当前消息由 agent 自己追加。
        const agentPayload = {
          message: {
            text,
            type,
            media: mediaBuffer || null,
          },
          session: {
            userId,
            agentId: currentAgentId,
            history: previousHistory,
          },
        }

        const response = await agentRegistry.invoke(currentAgentId, agentPayload, async (intermediateText) => {
          if (intermediateText.trim()) await reply(intermediateText)
        })

        const assistantEntry: ChatEntry = {
          role: 'assistant',
          content: response.reply.text,
          timestamp: Date.now(),
        }
        await sessionManager.append(userId, currentAgentId, assistantEntry)

        if (response.reply.media) {
          await botManager.sendReply(raw, {
            file: {
              data: response.reply.media.data,
              fileName: response.reply.media.fileName || 'file',
            },
            caption: response.reply.text,
          })
        } else {
          await reply(response.reply.text)
        }
      })
    } catch (err) {
      const error = err as Error
      log.error({ err: error.message }, 'Message handler error')
      try {
        await reply('服务繁忙，请稍后再试。')
      } catch {
        // sendReply already has context_token from incoming msg, should not fail
      }
      throw error
    }
  }
}
