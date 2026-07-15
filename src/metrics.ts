import { Counter, Histogram, Gauge, Registry } from 'prom-client'

const register = new Registry()

export const messageCounter = new Counter({
  name: 'gateway_messages_total',
  help: 'Total number of messages processed',
  labelNames: ['type', 'agent_id'],
  registers: [register],
})

export const switchCounter = new Counter({
  name: 'gateway_agent_switches_total',
  help: 'Total number of agent switches',
  labelNames: ['agent_id'],
  registers: [register],
})

export const messageDuration = new Histogram({
  name: 'gateway_message_duration_ms',
  help: 'Message processing duration in milliseconds',
  labelNames: ['agent_id'],
  buckets: [50, 100, 200, 500, 1000, 3000, 5000, 10000, 30000],
  registers: [register],
})

export const botStatus = new Gauge({
  name: 'gateway_bot_online',
  help: 'Bot online status (1 = online, 0 = offline)',
  registers: [register],
})

export function getMetrics(): Promise<string> {
  return register.metrics()
}
