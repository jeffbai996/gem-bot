import { GoogleGenAI } from '@google/genai'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { MediaPart } from './attachments.ts'

const EDIT_RE = /\b(?:edit|change|replace|remove|add|make|turn|transform|convert|restyle|recolor|put|give|swap)\b/i

export function isImageEditRequest(text: string, parts: MediaPart[]): boolean {
  return EDIT_RE.test(text) && parts.some(part =>
    'inlineData' in part && part.inlineData.mimeType.startsWith('image/')
  )
}

export async function editImages(
  apiKey: string,
  prompt: string,
  parts: MediaPart[],
  client: GoogleGenAI = new GoogleGenAI({ apiKey }),
): Promise<string[]> {
  const images = parts.filter(part =>
    'inlineData' in part && part.inlineData.mimeType.startsWith('image/')
  )
  const response = await client.models.generateContent({
    model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    contents: [{ role: 'user', parts: [...images, { text: prompt }] }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  })

  const output: string[] = []
  for (const [index, part] of (response.candidates?.[0]?.content?.parts ?? []).entries()) {
    const inline = (part as any).inlineData
    if (!inline?.data || !String(inline.mimeType ?? '').startsWith('image/')) continue
    const ext = inline.mimeType === 'image/jpeg' ? 'jpg' : 'png'
    const file = path.join(os.tmpdir(), `gem-image-${Date.now()}-${index}.${ext}`)
    await fs.writeFile(file, Buffer.from(inline.data, 'base64'))
    output.push(file)
  }
  if (output.length === 0) throw new Error('Gemini image model returned no image')
  return output
}

export interface ImageGenResult extends Array<string> {
  files: string[]
  footer: string
  model: string
  elapsedMs: number
  costStr: string
  tokens?: {
    promptTokens: number
    responseTokens: number
  }
}

export async function generateImage(
  apiKey: string,
  prompt: string,
  aspectRatio?: string,
  modelOrClient?: string | GoogleGenAI,
  maybeClient?: GoogleGenAI,
): Promise<ImageGenResult> {
  const startTime = Date.now()

  let modelChoice = 'imagen-3'
  let client: GoogleGenAI

  if (typeof modelOrClient === 'string') {
    modelChoice = modelOrClient
    client = maybeClient || new GoogleGenAI({ apiKey })
  } else if (modelOrClient && typeof modelOrClient === 'object') {
    client = modelOrClient
    if (typeof (client as any)?.models?.generateImages !== 'function' && typeof (client as any)?.models?.generateContent === 'function') {
      modelChoice = 'flash'
    }
  } else {
    client = maybeClient || new GoogleGenAI({ apiKey })
  }

  const isImagen = modelChoice === 'imagen-3' || modelChoice.startsWith('imagen')
  const ratio = aspectRatio || '1:1'
  const outputFiles: string[] = []
  let modelLabel = ''
  let promptTokens: number | undefined
  let responseTokens: number | undefined
  const costStr = '$0.030'

  if (isImagen) {
    modelLabel = process.env.IMAGEN_MODEL || 'imagen-3.0-generate-002'
    const response = await client.models.generateImages({
      model: modelLabel,
      prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: ratio,
        outputMimeType: 'image/jpeg',
      },
    })

    const generatedImages = response.generatedImages ?? []
    for (const [index, img] of generatedImages.entries()) {
      const b64 = img.image?.imageBytes
      if (!b64) continue
      const file = path.join(os.tmpdir(), `gem-image-${Date.now()}-${index}.jpg`)
      await fs.writeFile(file, Buffer.from(b64, 'base64'))
      outputFiles.push(file)
    }
    if (outputFiles.length === 0) {
      const rai = generatedImages[0]?.raiFilteredReason
      throw new Error(rai ? `Filtered by safety policy: ${rai}` : 'Imagen 3 returned no images')
    }
  } else {
    modelLabel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image'
    const textPrompt = aspectRatio ? `${prompt} (aspect ratio: ${aspectRatio})` : prompt
    const response = await client.models.generateContent({
      model: modelLabel,
      contents: [{ role: 'user', parts: [{ text: textPrompt }] }],
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    })

    for (const [index, part] of (response.candidates?.[0]?.content?.parts ?? []).entries()) {
      const inline = (part as any).inlineData
      if (!inline?.data || !String(inline.mimeType ?? '').startsWith('image/')) continue
      const ext = inline.mimeType === 'image/jpeg' ? 'jpg' : 'png'
      const file = path.join(os.tmpdir(), `gem-image-${Date.now()}-${index}.${ext}`)
      await fs.writeFile(file, Buffer.from(inline.data, 'base64'))
      outputFiles.push(file)
    }
    if (outputFiles.length === 0) throw new Error('Gemini image model returned no image')

    const u = response.usageMetadata
    if (u) {
      promptTokens = u.promptTokenCount
      responseTokens = u.candidatesTokenCount
    }
  }

  const elapsedMs = Date.now() - startTime
  const elapsedSec = (elapsedMs / 1000).toFixed(1)

  const tokenPart = promptTokens !== undefined && responseTokens !== undefined
    ? ` · ↑ ${promptTokens.toLocaleString('en-US')} · ↓ ${responseTokens.toLocaleString('en-US')}`
    : ''

  const footer = `\` ${modelLabel}${tokenPart} · ◷ ${elapsedSec}s · cost: ~${costStr} \``

  const result = Object.assign([...outputFiles], {
    files: outputFiles,
    footer,
    model: modelLabel,
    elapsedMs,
    costStr,
    tokens: promptTokens !== undefined && responseTokens !== undefined ? { promptTokens, responseTokens } : undefined,
  }) as ImageGenResult

  return result
}

