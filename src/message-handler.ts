import type { CommandHandler } from './command-handler'
import type { UserStateManager } from './user-state'
import type { AgentRegistry } from './agent-registry'
import type { SessionManager } from './session-manager'
import type { BotManager } from './bot-manager'
import { createLogger } from './logger'
import { normalizeUserId } from './single-user'

const log = createLogger('message-handler')
import type { AgentMedia, ChatEntry } from './types'

/**
 * Fallback filename when the Agent omits one. The SDK routes `{file, fileName}`
 * by extension (image/video), so a missing extension silently degrades media to
 * a generic file — append one based on the declared media type/format.
 */
export function fallbackFileName(media: AgentMedia): string {
  const byType: Record<string, string> = {
    image: 'image.png',
    video: 'video.mp4',
    voice: media.format === 'silk' ? 'voice.silk' : 'voice.wav',
  }
  const fallback = byType[media.type?.toLowerCase() ?? ''] || 'file.bin'
  const fileName = media.fileName?.trim()
  if (!fileName) return fallback
  return /\.\w+$/.test(fileName) ? fileName : `${fileName}${fallback.slice(fallback.lastIndexOf('.'))}`
}

/** Send one media part (image/video/file/voice) to WeChat, with an optional caption. */
function sendMediaReply(
  raw: unknown,
  media: AgentMedia,
  caption = '',
  botManager: BotManager,
): Promise<void> {
  const mediaType = (media.type || 'file').toLowerCase()
  log.info({ mediaType, bytes: media.data.length, fileName: media.fileName }, '回发媒体给微信')
  if (mediaType === 'image') {
    return botManager.sendReply(raw, { image: media.data, caption })
  }
  if (mediaType === 'video') {
    return botManager.sendReply(raw, { video: media.data, caption })
  }
  // file / voice / unknown — send as generic file with a usable extension.
  return botManager.sendReply(raw, {
    file: { data: media.data, fileName: fallbackFileName(media) },
    caption,
  })
}

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

        let downloadedMedia: Awaited<ReturnType<BotManager['download']>> = null
        if (msg.hasMedia) {
          try {
            downloadedMedia = await botManager.download(msg)
            if (!downloadedMedia?.data?.length) {
              await reply('文件下载为空，请重试。')
              return
            }
            log.info(
              {
                type: downloadedMedia.type,
                bytes: downloadedMedia.data.length,
                fileName: downloadedMedia.fileName,
                format: downloadedMedia.format,
              },
              '媒体下载成功',
            )
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
            type: downloadedMedia?.type || type,
            media: downloadedMedia ? {
              type: downloadedMedia.type,
              data: downloadedMedia.data,
              fileName: downloadedMedia.fileName,
              format: downloadedMedia.format,
            } : null,
          },
          session: {
            userId,
            agentId: currentAgentId,
            history: previousHistory,
          },
        }

        const response = await agentRegistry.invoke(currentAgentId, agentPayload, async (intermediateText, intermediateMedia) => {
          if (intermediateMedia) {
            await sendMediaReply(raw, intermediateMedia, intermediateText, botManager)
          } else if (intermediateText.trim()) {
            await reply(intermediateText)
          }
        })
        log.info(
          { agentId: currentAgentId, textLen: response.reply.text?.length ?? 0, hasMedia: !!response.reply.media },
          'Agent 调用完成',
        )

        const assistantEntry: ChatEntry = {
          role: 'assistant',
          content: response.reply.text,
          timestamp: Date.now(),
        }
        await sessionManager.append(userId, currentAgentId, assistantEntry)

        if (response.reply.media) {
          await sendMediaReply(raw, response.reply.media, response.reply.text, botManager)
        } else if (response.reply.text) {
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
