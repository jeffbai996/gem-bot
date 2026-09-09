import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { editImages, generateImage } from '../src/image-generation.ts'

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

test('generates image using Imagen 3 with cost footer', async () => {
  let request: any
  const fake = {
    models: {
      generateImages: async (value: any) => {
        request = value
        return {
          generatedImages: [
            { image: { imageBytes: Buffer.from('imagen-art').toString('base64'), mimeType: 'image/jpeg' } },
          ],
        }
      },
    },
  }
  const result = await generateImage('unused', 'a cybernetic eagle', '16:9', 'imagen-3', fake as any)
  assert.equal(request.model, 'imagen-3.0-generate-002')
  assert.equal(request.prompt, 'a cybernetic eagle')
  assert.equal(request.config.aspectRatio, '16:9')
  assert.equal(await fs.readFile(result.files[0], 'utf8'), 'imagen-art')
  assert.match(result.footer, /imagen-3\.0-generate-002/)
  assert.match(result.footer, /\$0\.030/)
  await fs.unlink(result.files[0])
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

test('Imagen 3 falling back to flash when API returns 404', async () => {
  let contentRequest: any
  const fake = {
    models: {
      generateImages: async () => {
        const err: any = new Error('models/imagen-3.0-generate-002 is not found for API version v1beta, or is not supported for predict.')
        err.status = 'NOT_FOUND'
        throw err
      },
      generateContent: async (value: any) => {
        contentRequest = value
        return { candidates: [{ content: { parts: [
          { inlineData: { mimeType: 'image/png', data: Buffer.from('recovered-art').toString('base64') } },
        ] } }] }
      },
    },
  }
  const result = await generateImage('unused', 'a prompt that failed imagen', '1:1', 'imagen-3', fake as any)
  assert.equal(contentRequest.model, 'gemini-3.1-flash-image')
  assert.equal(await fs.readFile(result.files[0], 'utf8'), 'recovered-art')
  await fs.unlink(result.files[0])
})

