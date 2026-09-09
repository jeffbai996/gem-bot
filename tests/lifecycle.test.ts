import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLifecycle } from '../src/reactions/lifecycle.ts'

test('received settles before thinking removes it, even with an empty cache', async () => {
  const events: string[] = []
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const message: any = {
    id: 'message', channelId: 'channel',
    client: { user: { id: 'bot' }, rest: { delete: async (route: string) => { events.push('remove:' + decodeURIComponent(route.split('/').at(-2)!)) } } },
    reactions: { cache: new Map() },
    react: async (emoji: string) => { if (emoji === '👀') await pending; events.push('add:' + emoji) },
  }
  const received = applyLifecycle(message, 'received')
  const thinking = applyLifecycle(message, 'thinking')
  await Promise.resolve()
  assert.deepEqual(events, [])
  release()
  await Promise.all([received, thinking])
  assert.deepEqual(events, ['add:👀', 'remove:👀', 'remove:📎', 'add:🤔'])
})

test('cleanup only uses the bot-owned reaction endpoint', async () => {
  const routes: string[] = []
  const message: any = { id:'second', channelId:'channel', client: { user: { id:'bot' }, rest: { delete: async (route: string) => { routes.push(route) } } }, react: async () => {} }
  await applyLifecycle(message, 'replied')
  assert.ok(routes.length > 0)
  assert.ok(routes.every(route => route.endsWith('/@me')))
})
