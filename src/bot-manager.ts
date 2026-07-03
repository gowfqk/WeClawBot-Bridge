import { WeChatBot, type Storage } from '@wechatbot/wechatbot'
import type { BotStatus, SendContent as GatewaySendContent } from './types'

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
  private isStarted: boolean = false
  private loginPromise: Promise<unknown> | null = null

  constructor(storage: Storage, botAgent?: string) {
    this.bot = new WeChatBot({
      storage,
      botAgent: botAgent || 'WeChatAgentGateway/1.0',
      logLevel: 'info',
    })

    this.bot.on('login', (creds) => {
      this.status = {
        loggedIn: true,
        accountId: creds.accountId,
        currentUser: (creds as unknown as Record<string, unknown>).userId as string,
        polling: false,
      }
    })

    this.bot.on('session:expired', () => {
      this.status = { loggedIn: false, polling: false }
      this.isStarted = false
    })

    this.bot.on('session:restored', (creds) => {
      this.status = {
        loggedIn: true,
        accountId: creds.accountId,
        currentUser: (creds as unknown as Record<string, unknown>).userId as string,
        polling: false,
      }
    })
  }

  async login(onQrUrl?: (url: string) => void): Promise<void> {
    this.loginPromise = this.bot.login({
      callbacks: {
        onQrUrl: (url: string) => {
          this.currentQrUrl = url
          onQrUrl?.(url)
        },
        onScanned: () => {},
        onExpired: () => {
          this.currentQrUrl = undefined
        },
      },
    })
    await this.loginPromise
  }

  async loginAndStart(
    onQrUrl?: (url: string) => void,
    maxRetries: number = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.login(onQrUrl)
        console.log('Bot logged in, starting message polling...')
        this.isStarted = true
        this.status.polling = true
        this.bot.start().catch((err) => {
          console.error('Poller crashed:', (err as Error).message)
          this.status.polling = false
          this.isStarted = false
        })
        return
      } catch (err) {
        const error = err as Error
        console.error(`Login attempt ${attempt}/${maxRetries} failed: ${error.message}`)
        if (attempt >= maxRetries) {
          console.error('All login attempts exhausted')
          throw err
        }
        console.log(`Retrying in 5 seconds...`)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  async start(): Promise<void> {
    if (this.isStarted) return
    this.isStarted = true
    this.status.polling = true
    this.bot.start().catch((err) => {
      console.error('Poller crashed:', (err as Error).message)
      this.status.polling = false
      this.isStarted = false
    })
  }

  async stop(): Promise<void> {
    this.isStarted = false
    this.status.polling = false
    this.bot.stop()
  }

  getStatus(): BotStatus {
    return { ...this.status, qrUrl: this.currentQrUrl }
  }

  get isRunning(): boolean {
    return this.isStarted
  }

  onMessage(handler: MessageHandler): void {
    this.bot.on('message', async (msg) => {
      const hasMedia = msg.images.length > 0
        || msg.files.length > 0
        || msg.videos.length > 0
        || msg.voices.length > 0

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

  async download(msg: { raw: unknown }): Promise<Buffer | undefined> {
    const incomingMsg = msg.raw as Parameters<WeChatBot['download']>[0]
    const media = await this.bot.download(incomingMsg)
    return media?.data
  }

  async sendTyping(userId: string): Promise<void> {
    await this.bot.sendTyping(userId)
  }
}
