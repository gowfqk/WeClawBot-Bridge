import type { CommandHandler } from './command-handler'
import type { UserStateManager } from './user-state'
import type { AgentRegistry } from './agent-registry'
import type { SessionManager } from './session-manager'
import type { BotManager } from './bot-manager'
import type { OutboundLog } from './outbound-log'
import { createLogger } from './logger'
import { normalizeUserId } from './single-user'

const log = createLogger('message-handler')
import type { AgentMedia, ChatEntry, SendContent } from './types'

/** 本轮完全没有任何内容可发时的占位回复，避免用户无限等待。 */
const EMPTY_REPLY_HINT = '本轮没有生成回复内容，请重试或换个说法。'

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

/**
 * Map an Agent media part onto the gateway send payload. The SDK routes
 * `{file, fileName}` by extension, so file/voice keep an extension that
 * `fallbackFileName()` guarantees.
 */
export function toSendContent(media: AgentMedia, caption = ''): SendContent {
  const mediaType = (media.type || 'file').toLowerCase()
  if (mediaType === 'image') return { image: media.data, caption }
  if (mediaType === 'video') return { video: media.data, caption }
  return { file: { data: media.data, fileName: fallbackFileName(media) }, caption }
}

export interface MessageHandlerContext {
  commandHandler: CommandHandler
  userState: UserStateManager
  agentRegistry: AgentRegistry
  sessionManager: SessionManager
  botManager: BotManager
  outboundLog: OutboundLog
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
    const { commandHandler, userState, agentRegistry, sessionManager, botManager, outboundLog } = ctx
    const { userId: senderId, text, type, raw } = msg
    // 单用户设计：真实微信 senderId 只用于回消息/typing；业务状态和会话统一归到 default。
    const userId = normalizeUserId(senderId)

    // delivered / pendingContent 用来回答两个问题：这一轮到底发出去了没有，
    // 以及失败时没送达的到底是哪段内容。
    let delivered = false
    let pendingContent: SendContent | undefined

    const deliver = async (content: SendContent): Promise<void> => {
      pendingContent = content
      await botManager.sendReply(raw, content)
      delivered = true
      pendingContent = undefined
    }

    const reply = (replyText: string) => deliver({ text: replyText })

    const deliverMedia = (media: AgentMedia, caption = '') => {
      log.info({ mediaType: media.type, bytes: media.data.length, fileName: media.fileName }, '回发媒体给微信')
      return deliver(toSendContent(media, caption))
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
        // 打字指示器只是体验增强：没有 typing ticket 或上下文时不能拖垮整轮对话。
        await botManager.sendTyping(senderId).catch((err) => {
          log.warn({ err: (err as Error).message }, '打字指示器未送达')
        })

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
            await deliverMedia(intermediateMedia, intermediateText)
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
          await deliverMedia(response.reply.media, response.reply.text)
        } else if (response.reply.text) {
          await reply(response.reply.text)
        } else if (!delivered) {
          // 既没有最终内容也没有中间结果 —— 用户会一直等。先记账，再给占位回复。
          await outboundLog.record({
            source: 'reply',
            userId: senderId,
            content: {},
            status: 'failed',
            error: `Agent ${currentAgentId} 本轮没有产出回复内容`,
            ruleId: `agent:${currentAgentId}`,
            trigger: text,
          })
          await reply(EMPTY_REPLY_HINT)
        }
      })
    } catch (err) {
      const error = err as Error
      log.error({ err: error.message, senderId }, 'Message handler error')
      await outboundLog.record({
        source: 'reply',
        userId: senderId,
        content: pendingContent ?? {},
        status: 'failed',
        error: error.message,
        trigger: text,
      })
      try {
        await botManager.sendReply(raw, { text: '服务繁忙，请稍后再试。' })
      } catch (fallbackErr) {
        // 连兜底提示都发不出去 = 这一整轮对用户彻底丢失，只剩记录和日志。
        log.error({ err: (fallbackErr as Error).message, senderId }, '兜底提示同样未能送达微信')
      }
      throw error
    }
  }
}
