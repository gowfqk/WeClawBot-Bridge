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
import pino from 'pino'

async function main(): Promise<void> {
  const config = loadConfig()

  const rawStorage = config.storageDir
    ? new FileStorage(config.storageDir, 'gateway')
    : new MemoryStorage()

  const botStorage = config.encryptionKey
    ? new EncryptedStorage(rawStorage, config.encryptionKey)
    : rawStorage

  const logger = pino({ level: config.logLevel })

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
    logger,
  )

  const server = http.createServer(app)

  server.listen(config.port, () => {
    console.log(`Gateway server listening on port ${config.port}`)
    console.log(`Agents loaded: ${agentRegistry.listAll().length}`)
  })

  botManager.loginAndStart((url) => {
    console.log(`QR Code URL: ${url}`)
    console.log('Scan the QR code with WeChat to login')
  }).then(() => {
    botStatus.set(1)
  }).catch((err) => {
    console.error('Failed to login after retries:', err.message)
    console.log('Use POST /api/bot/login to try again manually')
  })

  notificationService.startScheduler()

  const shutdown = async () => {
    console.log('Shutting down...')
    notificationService.stopScheduler()
    agentRegistry.closeAllCliSessions()
    await botManager.stop()
    server.close()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
