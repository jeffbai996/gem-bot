import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { editImages, isImageEditRequest } from '../src/image-generation.ts'

const image = { inlineData: { mimeType: 'image/png', data: Buffer.from('source').toString('base64') } }

test('recognizes an edit instruction only when an image is attached', () => {
  assert.equal(isImageEditRequest('turn this into a watercolor', [image]), true)
  assert.equal(isImageEditRequest('what is in this image?', [image]), false)
  assert.equal(isImageEditRequest('turn this into a watercolor', [{ text: 'no image' }]), false)
})

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
