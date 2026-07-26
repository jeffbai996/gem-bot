import assert from 'node:assert/strict'
import test from 'node:test'

import { ChannelTurnRunner } from '../src/channel-turns.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

test('coalesces queued messages in FIFO order after a quiet window', async () => {
  const first = deferred()
  const seen: string[][] = []
  const runner = new ChannelTurnRunner<string>(async (_channelId, batch) => {
    seen.push(batch)
    if (batch[0] === 'A') await first.promise
  }, () => false, 20)

  const leader = runner.submit('channel', 'A')
  assert.equal(await runner.submit('channel', 'B'), 'queued')
  first.resolve()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(await runner.submit('channel', 'C'), 'queued')
  await leader

  assert.deepEqual(seen, [['A'], ['B', 'C']])
})
