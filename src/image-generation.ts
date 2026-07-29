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
