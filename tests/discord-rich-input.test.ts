import assert from 'node:assert/strict'
import test from 'node:test'
import { extractRichMedia, formatRichContext } from '../src/discord-rich-input.ts'

test('recovers live GIF embeds, stickers, forwards, and polls', () => {
  const message = {
    content: 'https://cdn.discordapp.com/expired/duck.gif',
    embeds: [{ thumbnail: { url: 'https://cdn.discordapp.com/x/duck.gif?old', proxyURL: 'https://media.discordapp.net/x/duck.gif?fresh', contentType: 'image/gif' } }],
    stickers: [{ id: '1', name: 'duckyo_buy', format: 4, url: 'https://cdn.discordapp.com/stickers/1.gif' }],
    messageSnapshots: [{ content: 'forwarded', attachments: [{ name: 'x.png', url: 'https://example.invalid/x.png', size: 2, contentType: 'image/png' }], embeds: [], stickers: [] }],
    poll: { question: { text: 'Dinner?' }, answers: [{ id: 1, text: 'Sushi', emoji: { name: '🍣' }, voteCount: 2 }], allowMultiselect: false },
  }
  const media = extractRichMedia(message)
  assert.ok(media.some(x => x.url.includes('?fresh')))
  assert.ok(media.some(x => x.name.includes('duckyo_buy')))
  assert.ok(media.some(x => x.name === 'x.png'))
  const text = formatRichContext(message)
  assert.match(text, /original author is unavailable/)
  assert.match(text, /Dinner\?/)
  assert.match(text, /🍣/)
})
