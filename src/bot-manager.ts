import { WeChatBot, type Storage, type DownloadedMedia } from '@wechatbot/wechatbot'
import type { BotStatus, SendContent as GatewaySendContent } from './types'
import { createLogger } from './logger'

// Mirrors @wechatbot/wechatbot's STORAGE_KEYS (dist/storage/interface.js).
// Not imported directly: the project's tsconfig "moduleResolution": "node"
// cannot resolve the SDK's "./storage" package.json subpath export.
const SDK_STORAGE_KEYS = {
  CREDENTIALS: 'credentials',
  CURSOR: 'cursor',
  CONTEXT_TOKENS: 'context_tokens',
  TYPING_TICKETS: 'typing_tickets',
} as const

const log = createLogger('bot-manager')

export type MessageHandler = (msg: {
  userId: string
  text: string
  type: string
  hasMedia: boolean
  raw: unknown
}) => Promise<void>

export class BotManager {
  private bot: WeChatBot
  private status: BotStatus = { loggedIn: false, polling: false }
  private currentQrUrl: string | undefined
  private lastActiveUser: string | undefined  // 最近发消息的真实用户
  private loginPromise: Promise<unknown> | null = null
  private qrCallback: ((url: string) => void) | undefined
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private pollerHealthTimer: ReturnType<typeof setInterval> | null = null
  private readonly KEEPALIVE_INTERVAL = 4 * 60 * 60 * 1000 // 4 小时
  private readonly POLLER_HEALTH_INTERVAL = 60 * 1000 // 1 分钟检查一次

  constructor(storage: Storage, botAgent?: string) {
    this.bot = new WeChatBot({
      storage,
      botAgent: botAgent || 'WeChatAgentGateway/1.0',
      logLevel: 'info',
    })

    // SDK 内部已在 setupPollerEvents 中处理 session:expired：
    //   clearAll → login({force:true}) → session:restored → resetCursor
    // 因此 Bridge 只需要更新状态，不需要重复登录。
    this.bot.on('session:expired', () => {
      log.warn('Session expired — SDK will auto-reconnect with QR if needed')
      this.status = { loggedIn: false, polling: false }
    })

    this.bot.on('login', (creds) => {
      log.info({ accountId: creds.accountId }, 'Bot logged in event received')
      this.status = {
        loggedIn: true,
        accountId: creds.accountId,
        currentUser: (creds as unknown as Record<string, unknown>).userId as string,
        polling: true,  // SDK's poller auto-starts; don't call start() again
      }
      this.startKeepalive()
    })

    this.bot.on('session:restored', (creds) => {
      this.status = {
        loggedIn: true,
        accountId: creds.accountId,
        currentUser: (creds as unknown as Record<string, unknown>).userId as string,
        polling: true,  // SDK resumes poller automatically after re-login
      }
      this.startKeepalive()
    })
  }

  async login(onQrUrl?: (url: string) => void, force?: boolean): Promise<void> {
    if (onQrUrl) this.qrCallback = onQrUrl

    if (force) {
      // The SDK's qrLogin() reads the OLD stored credential's token and sends
      // it to the server as a "known local token" when requesting a fresh QR
      // code (even though we pass force:true to skip the credential-reuse
      // shortcut). If a prior binding's token is still present, the server
      // recognizes it and responds with `binded_redirect`, causing the SDK to
      // silently return the OLD credentials instead of completing the new
      // scan — this is exactly why "重新绑定" appeared to do nothing after the
      // first successful bind. Mirror what the SDK's own session:expired
      // handler does: clear stored credentials before requesting a new QR.
      await this.clearStoredCredentials()
      this.status = { loggedIn: false, polling: false }
      this.currentQrUrl = undefined
    }

    // 默认优先恢复 Storage 中已有的微信凭证。仅管理面板明确传入
    // force=true 时才跳过凭证并重新扫码；进程重启时 status 尚未恢复，
    // 不能用它来决定 force，否则会让每次部署都丢失绑定。
    // The SDK swallows constructor-level loginCallbacks; every login() call
    // must explicitly provide its own callback object.
    this.loginPromise = this.bot.login({
      force: force === true,
      callbacks: {
        onQrUrl: (url: string) => {
          this.currentQrUrl = url
          this.qrCallback?.(url)
        },
        onScanned: () => {
          // QR was scanned — status will transition within the SDK.
        },
        onExpired: () => {
          // The SDK's outer qrLogin loop already handles up to
          // MAX_QR_REFRESH_COUNT refreshes; do not initiate another
          // login() call here or two concurrent polling loops will
          // exhaust retries and time out.
          this.currentQrUrl = undefined
        },
      },
    })
    await this.loginPromise
  }

  /** 清空 SDK 存储中的凭据、游标、上下文令牌和打字票据。不会影响 Bridge 自己的
   *  会话历史、Agent 配置等数据，这些都是独立存储的。 */
  private async clearStoredCredentials(): Promise<void> {
    await Promise.all([
      this.bot.storage.delete(SDK_STORAGE_KEYS.CREDENTIALS),
      this.bot.storage.delete(SDK_STORAGE_KEYS.CURSOR),
      this.bot.storage.delete(SDK_STORAGE_KEYS.CONTEXT_TOKENS),
      this.bot.storage.delete(SDK_STORAGE_KEYS.TYPING_TICKETS),
    ])
  }

  /** 主动解绑：停止轮询、清空凭据，不自动重新扫码。
   *  与 login(force=true) 的区别：这里不会紧接着发起新的登录流程，
   *  适合用户只想解除绑定、暂时不绑新账号的场景。 */
  async unbind(): Promise<void> {
    log.info('Unbinding WeChat account, clearing stored credentials')
    this.stopKeepalive()
    this.stopPollerHealthCheck()
    try {
      this.bot.stop()
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Error stopping poller during unbind')
    }
    await this.clearStoredCredentials()
    this.status = { loggedIn: false, polling: false }
    this.currentQrUrl = undefined
    this.lastActiveUser = undefined
  }

  async loginAndStart(
    onQrUrl?: (url: string) => void,
    maxRetries: number = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.login(onQrUrl)
        log.info('Bot logged in, ensuring message polling is started...')
        await this.start()
        return
      } catch (err) {
        const error = err as Error
        log.error({ attempt, maxRetries, err: error.message }, 'Login attempt failed')
        if (attempt >= maxRetries) {
          log.error('All login attempts exhausted')
          throw err
        }
        log.info('Retrying in 5 seconds...')
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  async start(): Promise<void> {
    if (this.bot.isRunning) return
    this.bot.start().catch((err) => {
      log.error({ err }, 'Poller crashed')
      this.status.polling = false
    })
  }

  // ===== 心跳保活 =====

  /** 启动定期心跳，防止微信 token 48 小时不活动失效
   *  使用 sendTyping 而非发送消息，避免打扰用户 */
  startKeepalive(): void {
    if (this.keepaliveTimer) return
    this.keepaliveTimer = setInterval(() => {
      if (!this.status.loggedIn) return
      // 优先发给最近的真实用户，没有则发给 bot 自己（最低保障）
      const user = this.lastActiveUser || this.status.currentUser
      if (!user) return
      this.bot.sendTyping(user).then(() => {
        log.info({ user }, 'Keepalive typing sent')
      }).catch((err) => {
        log.error({ err }, 'Keepalive typing failed')
      })
    }, this.KEEPALIVE_INTERVAL)
    log.info({ intervalHours: this.KEEPALIVE_INTERVAL / 3600000 }, 'Keepalive started')
  }

  /** 停止心跳 */
  stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  // ===== Poller 健康检查 =====

  /** 定期检查消息轮询状态，崩溃后自动恢复。
   *  微信 SDK 的 poller 内部有重试循环（指数退避 1s→10s），
   *  不会因网络抖动崩溃；只有不可恢复错误才会退出 poller。
   *  此检查作为最后保险，确保 polling 不会永久停止。 */
  startPollerHealthCheck(): void {
    if (this.pollerHealthTimer) return
    this.pollerHealthTimer = setInterval(() => {
      if (this.status.loggedIn && !this.status.polling) {
        log.warn('Poller health check: polling stopped while logged in — restarting')
        this.start().catch((err) => {
          log.error({ err }, 'Poller health restart failed')
        })
      }
    }, this.POLLER_HEALTH_INTERVAL)
    log.info({ intervalSecs: this.POLLER_HEALTH_INTERVAL / 1000 }, 'Poller health check started')
  }

  stopPollerHealthCheck(): void {
    if (this.pollerHealthTimer) {
      clearInterval(this.pollerHealthTimer)
      this.pollerHealthTimer = null
    }
  }

  async stop(): Promise<void> {
    this.stopKeepalive()
    this.stopPollerHealthCheck()
    this.status.polling = false
    this.bot.stop()
  }

  getStatus(): BotStatus {
    return { ...this.status, qrUrl: this.currentQrUrl }
  }

  get isRunning(): boolean {
    return this.bot.isRunning
  }

  onMessage(handler: MessageHandler): void {
    this.bot.on('message', async (msg) => {
      const hasMedia = msg.images.length > 0
        || msg.files.length > 0
        || msg.videos.length > 0
        || msg.voices.length > 0

      // 记录最近的真实用户，供 keepalive 使用
      if (msg.userId) this.lastActiveUser = msg.userId

      await handler({
        userId: msg.userId,
        text: msg.text || '',
        type: msg.type,
        hasMedia,
        raw: msg,
      })
    })
  }

  async sendReply(raw: unknown, content: GatewaySendContent): Promise<void> {
    const incomingMsg = raw as Parameters<WeChatBot['reply']>[0]
    if (content.text) {
      await this.bot.reply(incomingMsg, { text: content.text })
    } else if (content.image) {
      await this.bot.reply(incomingMsg, { image: content.image, caption: content.caption })
    } else if (content.file) {
      await this.bot.reply(incomingMsg, { file: content.file.data, fileName: content.file.fileName, caption: content.caption })
    } else if (content.video) {
      await this.bot.reply(incomingMsg, { video: content.video, caption: content.caption })
    }
  }

  async send(userId: string, content: GatewaySendContent): Promise<void> {
    if (content.text) {
      await this.bot.send(userId, { text: content.text })
    } else if (content.image) {
      await this.bot.send(userId, { image: content.image, caption: content.caption })
    } else if (content.file) {
      await this.bot.send(userId, { file: content.file.data, fileName: content.file.fileName, caption: content.caption })
    } else if (content.video) {
      await this.bot.send(userId, { video: content.video, caption: content.caption })
    }
  }

  async download(msg: { raw: unknown }): Promise<DownloadedMedia | null> {
    const incomingMsg = msg.raw as Parameters<WeChatBot['download']>[0]
    return this.bot.download(incomingMsg)
  }

  async sendTyping(userId: string): Promise<void> {
    await this.bot.sendTyping(userId)
  }
}
