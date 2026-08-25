import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTOMATIC_COMPACTION_STATUS,
  createCompactionObserver,
} from '../src/compaction-ui.ts'

test('automatic compaction uses the paper indicator and removes it afterward', async () => {
  const events: string[] = []
  const observer = createCompactionObserver(async content => {
    events.push(`send:${content}`)
    return { delete: async () => { events.push('delete') } }
  })

  await observer.onStart?.()
  await observer.onFinish?.('completed')

  assert.equal(AUTOMATIC_COMPACTION_STATUS, '📝 ✶ **Compacting context…**')
  assert.deepEqual(events, [`send:${AUTOMATIC_COMPACTION_STATUS}`, 'delete'])
})

test('automatic compaction cleanup is identical after provider failure', async () => {
  let deletes = 0
  const observer = createCompactionObserver(async () => ({
    delete: async () => { deletes++ },
  }))

  await observer.onStart?.()
  await observer.onFinish?.('failed')

  assert.equal(deletes, 1)
})
