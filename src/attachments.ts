import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const MAX_BYTES = 20 * 1024 * 1024
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface InputAttachment {
  url: string
  name: string
  size: number
  contentType: string | null
}

export interface InlinePart {
  inlineData: { mimeType: string; data: string }
}

export interface SkippedAttachment {
  name: string
  reason: 'too_large' | 'unsupported_type' | 'download_failed'
}

export interface ProcessResult {
  parts: InlinePart[]
  skipped: SkippedAttachment[]
  cleanup: () => Promise<void>
}

function stateDir(): string {
  return process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
}

export async function processAttachments(messageId: string, inputs: InputAttachment[]): Promise<ProcessResult> {
  const parts: InlinePart[] = []
  const skipped: SkippedAttachment[] = []
  const msgDir = path.join(stateDir(), 'inbox', messageId)

  if (inputs.length === 0) {
    return { parts, skipped, cleanup: async () => {} }
  }

  await fs.mkdir(msgDir, { recursive: true })

  for (const att of inputs) {
    const mime = att.contentType ?? ''

    if (!ALLOWED_IMAGE_MIMES.has(mime)) {
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

      await fs.writeFile(path.join(msgDir, att.name), buf)
      parts.push({ inlineData: { mimeType: mime, data: buf.toString('base64') } })
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
