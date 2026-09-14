import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { editImages, generateImage, quoteImagePrompt } from '../src/image-generation.ts'

const image = { inlineData: { mimeType: 'image/png', data: Buffer.from('source').toString('base64') } }

test('forwards the reference image and writes generated image output', async () => {
  let request: any
  const fake = {
    models: {
      generateContent: async (value: any) => {
        request = value
        return { candidates: [{ content: { parts: [
          { text: 'done' },
          { inlineData: { mimeType: 'image/png', data: Buffer.from('result').toString('base64') } },
        ] } }] }
      },
    },
  }
  const files = await editImages('unused', 'add a hat', [image], fake as any)
  assert.equal(request.model, 'gemini-3.1-flash-image')
  assert.deepEqual(request.config.responseModalities, ['TEXT', 'IMAGE'])
  assert.deepEqual(request.contents[0].parts[0], image)
  assert.equal(request.contents[0].parts.at(-1).text, 'add a hat')
  assert.equal(await fs.readFile(files[0], 'utf8'), 'result')
  await fs.unlink(files[0])
})

test('generates image from prompt using flash with token & cost footer', async () => {
  let request: any
  const fake = {
    models: {
      generateContent: async (value: any) => {
        request = value
        return {
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 250 },
          candidates: [{ content: { parts: [
            { text: 'here is your image' },
            { inlineData: { mimeType: 'image/png', data: Buffer.from('generated-art').toString('base64') } },
          ] } }],
        }
      },
    },
  }
  const result = await generateImage('unused', 'a sunset over the mountains', '16:9', 'flash', fake as any)
  assert.equal(request.model, 'gemini-3.1-flash-image')
  assert.deepEqual(request.config.responseModalities, ['TEXT', 'IMAGE'])
  assert.equal(request.contents[0].parts[0].text, 'a sunset over the mountains (aspect ratio: 16:9)')
  assert.equal(await fs.readFile(result.files[0], 'utf8'), 'generated-art')
  assert.match(result.footer, /gemini-3\.1-flash-image/)
  assert.match(result.footer, /↑ 15 · ↓ 250/)
  assert.match(result.footer, /\$0\.030/)
  await fs.unlink(result.files[0])
})

test('backward compatibility: mock client with generateContent only falls back to flash', async () => {
  let request: any
  const fake = {
    models: {
      generateContent: async (value: any) => {
        request = value
        return { candidates: [{ content: { parts: [
          { text: 'fallback' },
          { inlineData: { mimeType: 'image/png', data: Buffer.from('fallback-art').toString('base64') } },
        ] } }] }
      },
    },
  }
  const files = await generateImage('unused', 'a dog playing fetch', '1:1', fake as any)
  assert.equal(request.model, 'gemini-3.1-flash-image')
  assert.equal(await fs.readFile(files[0], 'utf8'), 'fallback-art')
  await fs.unlink(files[0])
})

test('default model is flash when model parameter is omitted', async () => {
  let request: any
  const fake = {
    models: {
      generateContent: async (value: any) => {
        request = value
        return { candidates: [{ content: { parts: [
          { inlineData: { mimeType: 'image/png', data: Buffer.from('default-art').toString('base64') } },
        ] } }] }
      },
      generateImages: async () => {
        throw new Error('should not be called')
      },
    },
  }
  const result = await generateImage('unused', 'a test prompt', '1:1', undefined, fake as any)
  assert.equal(request.model, 'gemini-3.1-flash-image')
  assert.match(result.footer, /gemini-3\.1-flash-image/)
  await fs.unlink(result.files[0])
})

test('calculates cost dynamically with token variations', async () => {
  const fake = {
    models: {
      generateContent: async () => ({
        usageMetadata: { promptTokenCount: 100_000, candidatesTokenCount: 50_000 },
        candidates: [{ content: { parts: [
          { inlineData: { mimeType: 'image/png', data: Buffer.from('art').toString('base64') } },
        ] } }],
      }),
    },
  }
  const result = await generateImage('unused', 'heavy prompt', '1:1', 'flash', fake as any)
  // base $0.030 + 100k*0.10/1e6 ($0.010) + 50k*0.40/1e6 ($0.020) = $0.060
  assert.equal(result.costStr, '$0.060')
  assert.match(result.footer, /\$0\.060/)
  await fs.unlink(result.files[0])
})



test('a quoted image prompt stays inside Discord message limits', () => {
  // A resolved prompt can be long; a Discord message holds 2000 characters.
  // An over-long quote means the reply never sends and a generated image is
  // lost after it has already been paid for.
  const quoted = quoteImagePrompt('x'.repeat(4_000))
  assert.ok(quoted.length < 1_600, String(quoted.length))
  assert.ok(quoted.endsWith('…'))
  assert.equal(quoteImagePrompt('one\ntwo'), '> one\n> two')
})
