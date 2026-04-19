import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { GoogleAIFileManager } from '@google/generative-ai/server'

const MAX_BYTES = 20 * 1024 * 1024
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])
const ALLOWED_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-mov', 'video/avi', 'video/x-flv', 'video/mpg', 'video/mpeg', 'video/wmv', 'video/3gpp'])
const ALLOWED_AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/amr', 'audio/opus'])
const ALLOWED_DOC_MIMES = new Set(['application/pdf', 'text/plain', 'text/html', 'text/css', 'text/javascript', 'application/javascript', 'text/x-typescript', 'text/markdown', 'text/csv', 'text/xml', 'application/rtf'])

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

// Cache to map original Discord Attachment URLs to Gemini File API URIs.
// This prevents redundant uploads of the same media within the bot's lifecycle.
export const uriCache = new Map<string, string>()

export async function processAttachments(messageId: string, inputs: InputAttachment[], apiKey: string): Promise<ProcessResult> {
  const parts: Array<InlinePart | FilePart> = []
  const skipped: SkippedAttachment[] = []
  const msgDir = path.join(stateDir(), 'inbox', messageId)

  if (inputs.length === 0) {
    return { parts, skipped, cleanup: async () => {} }
  }

  await fs.mkdir(msgDir, { recursive: true })

  const processPromises = inputs.map(async (att) => {
    const mime = att.contentType ?? ''
    const isImage = ALLOWED_IMAGE_MIMES.has(mime)
    const isVideo = ALLOWED_VIDEO_MIMES.has(mime)
    const isAudio = ALLOWED_AUDIO_MIMES.has(mime)
    const isDoc = ALLOWED_DOC_MIMES.has(mime)

    if (!isImage && !isVideo && !isAudio && !isDoc) {
      skipped.push({ name: att.name, reason: 'unsupported_type' })
      return
    }

    if (att.size > MAX_BYTES) {
      skipped.push({ name: att.name, reason: 'too_large' })
      return
    }

    // Check URI Cache first for media that uses the File API
    if ((isVideo || isAudio) && uriCache.has(att.url)) {
      parts.push({ fileData: { mimeType: mime, fileUri: uriCache.get(att.url)! } })
      return
    }

    try {
      const res = await fetch(att.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const buf = Buffer.from(await res.arrayBuffer())

      if (buf.length > MAX_BYTES) {
        skipped.push({ name: att.name, reason: 'too_large' })
        return
      }

      const localPath = path.join(msgDir, att.name)
      await fs.writeFile(localPath, buf)

      if (isImage || isDoc) {
        parts.push({ inlineData: { mimeType: mime, data: buf.toString('base64') } })
      } else {
        const fileManager = new GoogleAIFileManager(apiKey)
        const uploadResult = await fileManager.uploadFile(localPath, { mimeType: mime, displayName: att.name })

        fs.rm(localPath, { force: true }).catch(() => {})

        let file = uploadResult.file
        let retries = 0
        const MAX_RETRIES = 10
        while (file.state === 'PROCESSING' && retries < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 2000))
          file = await fileManager.getFile(file.name)
          retries++
        }

        if (file.state !== 'ACTIVE') {
          skipped.push({ name: att.name, reason: 'processing_timeout' })
          return
        }

        uriCache.set(att.url, file.uri)
        parts.push({ fileData: { mimeType: mime, fileUri: file.uri } })
      }
    } catch {
      skipped.push({ name: att.name, reason: 'download_failed' })
    }
  })

  await Promise.allSettled(processPromises)

  return {
    parts,
    skipped,
    cleanup: async () => {
      await fs.rm(msgDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

