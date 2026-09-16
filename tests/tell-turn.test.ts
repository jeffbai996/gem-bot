import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TellTurnMarker, TELL_MARK, isTellPayload } from '../src/tell-turn.ts'

function dir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'tell-turn-'))
}

test('a relay payload carrying the mark is a tell, batched or not', () => {
  assert.equal(isTellPayload(`${TELL_MARK} One-off message from a sibling bot ...`), true)
  assert.equal(isTellPayload(`[owner] hi\n\n${TELL_MARK} folded into a batch`), true)
  assert.equal(isTellPayload('You chose option 1: proceed'), false)
})

test('the marker is live for exactly the turns that are running', () => {
  const marker = new TellTurnMarker(dir(), 60_000, () => 1_000_000)
  assert.equal(marker.active(), false)
  marker.arm('msg-1')
  assert.equal(marker.active(), true)
  marker.arm('msg-2')
  marker.disarm('msg-1')
  assert.equal(marker.active(), true)          // msg-2 still running
  marker.disarm('msg-2')
  assert.equal(marker.active(), false)
  assert.equal(existsSync(marker.file), false) // nothing running, no file
})

test('the file is what the relay CLI reads: turns with an until', () => {
  const marker = new TellTurnMarker(dir(), 60_000, () => 1_000_000)
  marker.arm('msg-1')
  assert.deepEqual(JSON.parse(readFileSync(marker.file, 'utf8')), { turns: { 'msg-1': (1_000_000 + 60_000) / 1000 } })
})

test('a crashed turn stops blocking after its safety window', () => {
  let now = 5_000
  const marker = new TellTurnMarker(dir(), 1_000, () => now)
  marker.arm('msg-1')
  now += 1_001
  assert.equal(marker.active(), false)
})

test('an unreadable marker is not active and disarm never throws', () => {
  const marker = new TellTurnMarker(path.join(dir(), 'missing'))
  assert.equal(marker.active(), false)
  marker.disarm('nope')
})

test('a restart clears turns a previous process recorded', () => {
  const marker = new TellTurnMarker(dir(), 60_000, () => 1_000_000)
  marker.arm('msg-1')
  assert.equal(marker.active(), true)
  marker.reset()
  assert.equal(marker.active(), false)
  assert.equal(existsSync(marker.file), false)
  marker.reset()   // idempotent; must not throw with nothing to clear
})
