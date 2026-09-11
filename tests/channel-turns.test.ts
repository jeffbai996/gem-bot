import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { frameSteeredMessages } from '../src/steer-context.ts'

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

test('a failed active batch still drains queued messages FIFO', async () => {
  const first = deferred()
  const seen: string[][] = []
  const runner = new ChannelTurnRunner<string>(async (_channelId, batch) => {
    seen.push(batch)
    if (batch[0] === 'A') {
      await first.promise
      throw new Error('fake turn failure')
    }
  })

  const leader = runner.submit('channel', 'A')
  await runner.submit('channel', 'B')
  await runner.submit('channel', 'C')
  first.resolve()
  await assert.rejects(leader, /fake turn failure/)
  assert.deepEqual(seen, [['A'], ['B', 'C']])
})

test('guidance waits for active work, drains automatically, and stays channel-local', async () => {
  const tool = deferred()
  const events: string[] = []
  const runner = new ChannelTurnRunner<string>(async (channel, batch) => {
    if (batch[0] === 'original') {
      events.push('tool started')
      await tool.promise
      events.push('tool completed')
    } else {
      events.push(channel + ':' + frameSteeredMessages(batch))
    }
  })
  const turn = runner.submit('main', 'original')
  assert.equal(await runner.submit('main', 'adjust the output'), 'queued')
  await runner.submit('other', 'independent')
  assert.equal(events.length, 2)
  assert.ok(events[1].startsWith('other:'))
  tool.resolve()
  await turn
  assert.equal(events[2], 'tool completed')
  assert.match(events[3], /main:\[Steering context:/)
  assert.match(events[3], /adjust the output/)
  await runner.waitForIdle()
})

test('isIdle reflects running work synchronously', async () => {
  const work = deferred()
  const runner = new ChannelTurnRunner<string>(async () => work.promise)

  assert.equal(runner.isIdle(), true)
  const turn = runner.submit('channel', 'work')
  assert.equal(runner.isIdle(), false)
  work.resolve()
  await turn
  assert.equal(runner.isIdle(), true)
})

test('Discord queues silently and frames even a single queued steer', async () => {
  const source = await readFile(new URL('../src/gemma.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /queueMarker|FAST_FORWARD_REACTION|activeTurns\.deferStopFor/)
  assert.match(source, /batch\.length === 1 && !batch\[0\]\.steered/)
  assert.match(source, /\.\.\.carrierItem\.opts, combinedText: combined/)
})
