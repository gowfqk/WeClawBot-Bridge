import http from 'node:http'
import { loadConfig } from './config'
import { FileStorage, EncryptedStorage, MemoryStorage } from './storage'
import { UserStateManager } from './user-state'
import { CommandHandler } from './command-handler'
import { AgentRegistry } from './agent-registry'
import { SessionManager } from './session-manager'
import { BotManager } from './bot-manager'
import { NotificationService } from './notification'
import { createMessageHandler } from './message-handler'
import { createServer } from './server'
import { botStatus } from './metrics'
import { logger } from './logger'

async function main(): Promise<void> {
  const config = loadConfig()

  const rawStorage = config.storageDir
    ? new FileStorage(config.storageDir, 'gateway')
    : new MemoryStorage()

  const botStorage = config.encryptionKey
    ? new EncryptedStorage(rawStorage, config.encryptionKey)
    : rawStorage

  const userState = new UserStateManager(rawStorage, config.defaultAgentId)

  const commandHandler = new CommandHandler()

  const agentRegistry = new AgentRegistry()

  const sessionManager = new SessionManager(
    rawStorage,
    config.sessionMaxRounds,
    config.sessionExpireMs,
  )

  const botManager = new BotManager(botStorage, 'WeChatAgentGateway/1.0')

  const notificationService = new NotificationService(botManager, rawStorage)

  for (const agent of config.agents) {
    agentRegistry.register(agent)
  }
  commandHandler.updateAgents(agentRegistry.listAll())

  const messageHandler = createMessageHandler({
    commandHandler,
    userState,
    agentRegistry,
    sessionManager,
    botManager,
  })

  botManager.onMessage(messageHandler)

  const app = createServer(
    config,
    botManager,
    agentRegistry,
    commandHandler,
    notificationService,
    rawStorage,
    sessionManager,
    logger,
  )

  const server = http.createServer(app)

  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'Gateway server listening')
    logger.info({ count: agentRegistry.listAll().length }, 'Agents loaded')
  })

  botManager.loginAndStart((url) => {
    logger.info({ url }, 'QR Code URL generated — scan with WeChat to login')
  }).then(() => {
    botStatus.set(1)
    botManager.startKeepalive()
  }).catch((err) => {
    logger.error({ err }, 'Failed to login after retries')
    logger.info('Use POST /api/bot/login to try again manually')
  })

  notificationService.startScheduler()

  const shutdown = async () => {
    logger.info('Shutting down...')
    notificationService.stopScheduler()
    agentRegistry.closeAllCliSessions()
    await botManager.stop()

    // 优雅关闭：停止接受新连接，等待现有请求完成
    server.close(() => {
      logger.info('HTTP server closed')
      process.exit(0)
    })

    // 5 秒超时强制退出
    setTimeout(() => {
      logger.warn('Forced shutdown after timeout')
      process.exit(1)
    }, 5000).unref()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error')
  process.exit(1)
})
