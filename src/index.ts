import http from 'node:http'
import { loadConfig, loadAgentsFromStorage } from './config'
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

  if (!config.encryptionKey) {
    logger.warn('⚠️  ENCRYPTION_KEY 未设置！敏感数据（微信凭证、API Key）将以明文存储。强烈建议设置 ENCRYPTION_KEY 环境变量。')
    logger.warn('   生成方法：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  }

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

  // 优先从 Storage 加载 Agent（跨部署持久化，覆盖文件中的默认值）
  await loadAgentsFromStorage(rawStorage)
  const storageAgents = config.agents
  if (storageAgents.length > 0) {
    // 清除文件加载的，用 Storage 中的覆盖
    for (const agent of agentRegistry.listAll()) {
      agentRegistry.unregister(agent.id)
    }
    for (const agent of storageAgents) {
      agentRegistry.register(agent)
    }
  }

  commandHandler.updateAgents(agentRegistry.listAll())

  // 首次启动时将文件中的 Agent 同步到 Storage（确保跨部署持久化）
  if (agentRegistry.listAll().length > 0) {
    const { saveAgents } = await import('./config')
    await saveAgents(agentRegistry.listAll(), config.defaultAgentId, rawStorage)
  }

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
    // 清理 rate-limit 定时器，防止内存泄漏
    const appWithDestroy = app as unknown as Record<string, unknown>
    if (typeof appWithDestroy.destroy === 'function') {
      (appWithDestroy.destroy as () => void)()
    }
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
