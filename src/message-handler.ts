import type { CommandHandler } from './command-handler'
import type { UserStateManager } from './user-state'
import type { AgentRegistry } from './agent-registry'
import type { SessionManager } from './session-manager'
import type { BotManager } from './bot-manager'
import type { ChatEntry } from './types'

export interface MessageHandlerContext {
  commandHandler: CommandHandler
  userState: UserStateManager
  agentRegistry: AgentRegistry
  sessionManager: SessionManager
  botManager: BotManager
}

export function createMessageHandler(ctx: MessageHandlerContext) {
  return async (msg: {
    userId: string
    text: string
    type: string
    hasMedia: boolean
    raw: unknown
  }): Promise<void> => {
    const { commandHandler, userState, agentRegistry, sessionManager, botManager } = ctx
    const { userId, text, type, raw } = msg

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
        const status = botManager.getStatus()
        await reply(commandHandler.getStatusMessage(status.loggedIn, status.accountId))
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

      await botManager.sendTyping(userId)

      const session = await sessionManager.getOrCreate(userId, currentAgentId)

      let mediaBuffer: Buffer | undefined
      if (msg.hasMedia) {
        try {
          mediaBuffer = await botManager.download(msg)
        } catch {
          await reply('无法处理该文件，请重试。')
          return
        }
      }

      // 构建 agent payload：history 只传之前的，当前消息由 agent 自己追加
      const agentPayload = {
        message: {
          text,
          type,
          media: mediaBuffer || null,
        },
        session: {
          userId,
          agentId: currentAgentId,
          history: session.history,
        },
      }

      const response = await agentRegistry.invoke(currentAgentId, agentPayload)

      // 去重：避免重复追加相同内容
      const lastEntry = session.history[session.history.length - 1]
      if (!lastEntry || lastEntry.content !== text || lastEntry.role !== 'user') {
        const userEntry: ChatEntry = {
          role: 'user',
          content: text,
          timestamp: Date.now(),
        }
        await sessionManager.append(userId, currentAgentId, userEntry)
      }

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
    } catch (err) {
      const error = err as Error
      console.error('Message handler error:', error.message)
      try {
        await reply('服务繁忙，请稍后再试。')
      } catch {
        // sendReply already has context_token from incoming msg, should not fail
      }
      throw error
    }
  }
}
