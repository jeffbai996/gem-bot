import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { GoogleAIFileManager } from '@google/generative-ai/server'

const MAX_BYTES = 20 * 1024 * 1024
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const ALLOWED_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-mov'])

export interface InputAttachment {
  url: string
  name: string
  size: number
  contentType: string | null
}

export interface InlinePart {
  inlineData: { mimeType: string; data: string }
}

export interface FilePart {
  fileData: { mimeType: string; fileUri: string }
}

export interface SkippedAttachment {
  name: string
  reason: 'too_large' | 'unsupported_type' | 'download_failed' | 'processing_timeout'
}

export interface ProcessResult {
  parts: Array<InlinePart | FilePart>
  skipped: SkippedAttachment[]
  cleanup: () => Promise<void>
}

function stateDir(): string {
  return process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
}

export async function processAttachments(messageId: string, inputs: InputAttachment[], apiKey: string): Promise<ProcessResult> {
  const parts: Array<InlinePart | FilePart> = []
  const skipped: SkippedAttachment[] = []
  const msgDir = path.join(stateDir(), 'inbox', messageId)

  if (inputs.length === 0) {
    return { parts, skipped, cleanup: async () => {} }
  }

  await fs.mkdir(msgDir, { recursive: true })

  for (const att of inputs) {
    const mime = att.contentType ?? ''
    const isImage = ALLOWED_IMAGE_MIMES.has(mime)
    const isVideo = ALLOWED_VIDEO_MIMES.has(mime)

    if (!isImage && !isVideo) {
      skipped.push({ name: att.name, reason: 'unsupported_type' })
      continue
    }

    // Check declared size before downloading — skip early to avoid fetching huge files
    if (att.size > MAX_BYTES) {
      skipped.push({ name: att.name, reason: 'too_large' })
      continue
    }

    try {
      const res = await fetch(att.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const buf = Buffer.from(await res.arrayBuffer())

      // Also check actual downloaded size in case declared size was wrong
      if (buf.length > MAX_BYTES) {
        skipped.push({ name: att.name, reason: 'too_large' })
        continue
      }

      const localPath = path.join(msgDir, att.name)
      await fs.writeFile(localPath, buf)

      if (isImage) {
        parts.push({ inlineData: { mimeType: mime, data: buf.toString('base64') } })
      } else {
        // Video: upload via File API, poll for ACTIVE, then delete local file
        const fileManager = new GoogleAIFileManager(apiKey)
        const uploadResult = await fileManager.uploadFile(localPath, { mimeType: mime, displayName: att.name })

        // Delete local file immediately — don't need it after upload
        fs.rm(localPath, { force: true }).catch(() => {})

        // Poll for ACTIVE state — Gemini may need time to process the video
        let file = uploadResult.file
        let retries = 0
        const MAX_RETRIES = 10
        while (file.state === 'PROCESSING' && retries < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 2000))
          const refreshed = await fileManager.getFile(file.name)
          file = refreshed
          retries++
        }

        if (file.state !== 'ACTIVE') {
          skipped.push({ name: att.name, reason: 'processing_timeout' })
          continue
        }

        parts.push({ fileData: { mimeType: mime, fileUri: file.uri } })
      }
    } catch {
      skipped.push({ name: att.name, reason: 'download_failed' })
    }
  }

  return {
    parts,
    skipped,
    cleanup: async () => {
      await fs.rm(msgDir, { recursive: true, force: true })
    }
  }
}
