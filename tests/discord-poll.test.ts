import assert from 'node:assert/strict'; import test from 'node:test'
import { buildPoll } from '../src/discord-poll.ts'
test('builds emoji-labelled native polls', () => assert.deepEqual(buildPoll('Dinner?', '🍣 Sushi | 🌮 Tacos', 4, true), { question: { text: 'Dinner?' }, answers: [{ text: 'Sushi', emoji: '🍣' }, { text: 'Tacos', emoji: '🌮' }], duration: 4, allowMultiselect: true }))
