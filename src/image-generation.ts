import { GoogleGenAI } from '@google/genai'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { MediaPart } from './attachments.ts'

export async function editImages(
  apiKey: string,
  prompt: string,
  parts: MediaPart[],
  client: GoogleGenAI = new GoogleGenAI({ apiKey }),
  signal?: AbortSignal,
): Promise<string[]> {
  const images = parts.filter(part =>
    'inlineData' in part && part.inlineData.mimeType.startsWith('image/')
  )
  const response = await client.models.generateContent({
    model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    contents: [{ role: 'user', parts: [...images, { text: prompt }] }],
    config: { responseModalities: ['TEXT', 'IMAGE'], abortSignal: signal, httpOptions: { timeout: 300_000 } },
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
  fallbackFrom?: string
}

export async function generateImage(
  apiKey: string,
  prompt: string,
  aspectRatio?: string,
  modelOrClient?: string | GoogleGenAI,
  maybeClient?: GoogleGenAI,
): Promise<ImageGenResult> {
  const startTime = Date.now()

  let client: GoogleGenAI
  if (modelOrClient && typeof modelOrClient === 'object') {
    client = modelOrClient
  } else {
    client = maybeClient || new GoogleGenAI({ apiKey })
  }

  const outputFiles: string[] = []
  let promptTokens: number | undefined
  let responseTokens: number | undefined

  const modelLabel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image'
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

  const elapsedMs = Date.now() - startTime
  const elapsedSec = (elapsedMs / 1000).toFixed(1)

  const baseImageCost = Math.max(1, outputFiles.length) * 0.030
  const tokenCost = ((promptTokens ?? 0) * 0.10 + (responseTokens ?? 0) * 0.40) / 1_000_000
  const cost = baseImageCost + tokenCost
  const costStr = `$${cost.toFixed(3)}`

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

// Discord caps a message at 2000 characters, and a resolved image prompt can be
// long, so the quote has to be bounded or the reply fails to send and the
// generated image is lost after it has already been paid for.
const QUOTED_PROMPT_MAX = 1_500

/** The prompt as a Discord blockquote, bounded so the message can be sent. */
export function quoteImagePrompt(prompt: string): string {
  const clean = prompt.trim()
  const shown = clean.length > QUOTED_PROMPT_MAX
    ? clean.slice(0, QUOTED_PROMPT_MAX - 1) + '…'
    : clean
  return shown.split('\n').map(line => `> ${line}`).join('\n')
}
