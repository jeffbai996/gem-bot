import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { GoogleGenAI } from '@google/genai'
import { extensionMime, extractLocalText, isLocallyExtractable, officeParserType } from './attachment-text.ts'
import { parseOffice } from 'officeparser'
import { animationContactSheet } from './animation-frames.ts'

const MAX_BYTES = 20 * 1024 * 1024
// Resolve yt-dlp path at call time (not module-load) so tests can override via env
function ytDlpPath(): string {
  return process.env.YT_DLP_PATH || path.join(os.homedir(), '.local', 'bin', 'yt-dlp')
}
const YT_URL_REGEX = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g
const YT_METADATA_TIMEOUT_MS = 30_000
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])
const ALLOWED_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-mov', 'video/avi', 'video/x-flv', 'video/mpg', 'video/mpeg', 'video/wmv', 'video/3gpp'])
const ALLOWED_AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/amr', 'audio/opus'])
const ALLOWED_DOC_MIMES = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/epub+zip',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.template.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.template.macroenabled.12',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/plain', 'text/html', 'text/css', 'text/javascript',
  'application/javascript', 'text/x-typescript', 'text/markdown',
  'text/csv', 'text/xml', 'application/rtf',
])
const DOCUMENT_EXTENSION_MIMES: Record<string, string> = {
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
}

// Single set used by request-time sanitization. Anything not here gets dropped
// before the request hits Gemini — prevents a `video/text/timestamp` style
// sub-track mime from sneaking through history-cache resurrection and tanking
// the whole turn with a 400.
export function isAllowedMime(mime: string): boolean {
  return ALLOWED_IMAGE_MIMES.has(mime)
    || ALLOWED_VIDEO_MIMES.has(mime)
    || ALLOWED_AUDIO_MIMES.has(mime)
    || ALLOWED_DOC_MIMES.has(mime)
}

export interface InputAttachment {
  url: string
  name: string
  size: number
  contentType: string | null
}

export interface InlinePart {
  inlineData: { mimeType: string; data: string }
}

interface FilePart {
  fileData: { mimeType: string; fileUri: string }
}

export interface TextPart {
  text: string
}

export type MediaPart = InlinePart | FilePart | TextPart

export interface LocalAttachment {
  path: string
  name: string
  mimeType: string
}

interface SkippedAttachment {
  name: string
  reason: 'too_large' | 'unsupported_type' | 'download_failed' | 'processing_timeout' | 'ytdlp_failed' | 'ytdlp_timeout'
}

export interface ProcessResult {
  parts: MediaPart[]
  localFiles: LocalAttachment[]
  skipped: SkippedAttachment[]
  // agy turns defer Gemini File API uploads. Call this only if agy fails and
  // the turn genuinely needs to fall back to the native API.
  prepareApiParts: () => Promise<MediaPart[]>
  cleanup: () => Promise<void>
}

export interface ProcessAttachmentOptions {
  keepLocalFiles?: boolean
}

function stateDir(): string {
  return process.env.DISCORD_STATE_DIR || path.join(os.homedir(), '.gemini', 'channels', 'discord')
}

// Cache to map original Discord Attachment URLs to Gemini File API URIs.
// This prevents redundant uploads of the same media within the bot's lifecycle.
export const uriCache = new Map<string, string>()

// Upload a local file via Gemini File API and poll until ACTIVE. Returns null
// if upload/poll fails. Used by processAttachments for user-uploaded
// video/audio. The new SDK exposes the file API on `client.files`; the legacy
// `GoogleAIFileManager` from @google/generative-ai/server is gone.
async function uploadAndWaitActive(
  localPath: string,
  mimeType: string,
  displayName: string,
  apiKey: string
): Promise<string | null> {
  const client = new GoogleGenAI({ apiKey })
  let file = await client.files.upload({
    file: localPath,
    config: { mimeType, displayName },
  })

  let retries = 0
  const MAX_RETRIES = 10
  while (file.state === 'PROCESSING' && retries < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, 2000))
    if (!file.name) break
    file = await client.files.get({ name: file.name })
    retries++
  }
  return file.state === 'ACTIVE' && file.uri ? file.uri : null
}

// Strip WebVTT markup down to plain text. Auto-captions contain rolling-display
// redundancy where each cue re-prints the tail of the previous cue — collapse that.
export function parseVttTranscript(vtt: string): string {
  const rawLines = vtt.split(/\r?\n/)
  const textLines: string[] = []

  for (const line of rawLines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed === 'WEBVTT' || trimmed.startsWith('WEBVTT ')) continue
    if (/^(Kind|Language|Region):/i.test(trimmed)) continue
    // NOTE introduces a comment; STYLE and REGION introduce block headers. Drop the line — we lose
    // follow-up lines of multi-line NOTE blocks, but for transcript cleanup that's acceptable.
    if (/^(NOTE|STYLE|REGION)(\s|$|:)/i.test(trimmed)) continue
    // Cue timing line: "00:00:00.000 --> 00:00:00.000 align:start position:0%"
    if (/-->/.test(trimmed)) continue
    // Strip inline timing <00:00:00.000> and <c>...</c> span tags, plus generic tags
    const cleaned = trimmed
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
      .replace(/<\/?c[^>]*>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) continue
    textLines.push(cleaned)
  }

  // Collapse rolling-display overlap. YouTube auto-caption pattern: cue N's
  // first text line duplicates cue N-1's last line. Walk pairs: if current line
  // equals the previously emitted line, drop it. Also skip pure bracket markers
  // like "[Music]" only when they duplicate adjacent content.
  const collapsed: string[] = []
  for (const line of textLines) {
    const last = collapsed[collapsed.length - 1]
    if (last === line) continue
    collapsed.push(line)
  }

  return collapsed.join('\n')
}

interface YtMetadataOk {
  ok: true
  id: string
  title: string
  transcriptPath: string | null
}
interface YtMetadataErr {
  ok: false
  error: 'timeout' | 'failed'
}

// Fetch title + auto-generated subtitles in a single yt-dlp invocation.
// --write-auto-subs covers auto-captions; --write-subs covers creator uploads.
// "en.*" matches en, en-US, en-orig, etc.
function runYtDlpTranscript(url: string, outDir: string, timeoutMs: number): Promise<YtMetadataOk | YtMetadataErr> {
  return new Promise(resolve => {
    // --print implies --simulate, which suppresses subtitle file writes. We need
    // both the metadata print AND the .vtt side-effect, so --no-simulate is required.
    const args = [
      '--no-playlist',
      '--skip-download',
      '--no-simulate',
      '--write-auto-subs',
      '--write-subs',
      '--sub-format', 'vtt',
      '--sub-langs', 'en,en-orig',
      '-o', path.join(outDir, '%(id)s.%(ext)s'),
      '--print', '%(id)s\t%(title)s',
      '--no-warnings',
      url
    ]
    const proc = spawn(ytDlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    const killer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ ok: false, error: 'timeout' })
    }, timeoutMs)
    proc.on('exit', async code => {
      clearTimeout(killer)
      if (code !== 0) {
        resolve({ ok: false, error: 'failed' })
        return
      }
      const firstLine = stdout.split('\n').find(l => l.includes('\t'))
      if (!firstLine) {
        resolve({ ok: false, error: 'failed' })
        return
      }
      const [id, ...titleParts] = firstLine.split('\t')
      const title = titleParts.join('\t').trim()
      const transcriptPath = await findTranscriptFile(outDir, id).catch(() => null)
      resolve({ ok: true, id, title, transcriptPath })
    })
    proc.on('error', () => {
      clearTimeout(killer)
      resolve({ ok: false, error: 'failed' })
    })
  })
}

// yt-dlp writes subtitles as "<id>.<lang>.vtt" where lang may be "en", "en-US",
// "en-orig", etc. Return the best match for English, or null if none exist.
async function findTranscriptFile(outDir: string, id: string): Promise<string | null> {
  const entries = await fs.readdir(outDir).catch(() => [] as string[])
  const matches = entries.filter(f => f.startsWith(`${id}.`) && f.endsWith('.vtt'))
  if (matches.length === 0) return null
  // Prefer plain "en.vtt", then "en-orig", then any other "en*" variant
  const preferred =
    matches.find(f => f === `${id}.en.vtt`) ||
    matches.find(f => f.includes('.en-orig.')) ||
    matches.find(f => /\.en[^.]*\.vtt$/.test(f)) ||
    matches[0]
  return path.join(outDir, preferred)
}

export async function processYouTubeUrls(messageId: string, content: string, _apiKey: string): Promise<ProcessResult> {
  const parts: MediaPart[] = []
  const localFiles: LocalAttachment[] = []
  const skipped: SkippedAttachment[] = []

  const videoIds = new Set<string>()
  const matches = [...content.matchAll(YT_URL_REGEX)]
  for (const m of matches) videoIds.add(m[1])

  if (videoIds.size === 0) {
    return { parts, localFiles, skipped, prepareApiParts: async () => parts, cleanup: async () => {} }
  }

  const ytDir = path.join(stateDir(), 'inbox', messageId, 'yt')
  await fs.mkdir(ytDir, { recursive: true })

  for (const id of videoIds) {
    const url = `https://www.youtube.com/watch?v=${id}`
    const result = await runYtDlpTranscript(url, ytDir, YT_METADATA_TIMEOUT_MS)
    if (!result.ok) {
      skipped.push({
        name: `youtube:${id}`,
        reason: result.error === 'timeout' ? 'ytdlp_timeout' : 'ytdlp_failed'
      })
      continue
    }

    if (result.transcriptPath) {
      const vtt = await fs.readFile(result.transcriptPath, 'utf8').catch(() => '')
      const transcript = parseVttTranscript(vtt).trim()
      if (transcript) {
        parts.push({
          text: `[youtube transcript v=${result.id}, title=${result.title}]:\n\n${transcript}`
        })
        continue
      }
    }

    // No transcript (or transcript parsed to empty) — emit title-only tag so
    // Gemma knows she cannot see the content and must ask instead of fabricate.
    parts.push({
      text: `[youtube v=${result.id}, title=${result.title}] — no transcript available. You cannot see or hear this video's content.`
    })
  }

  return {
    parts,
    localFiles,
    skipped,
    prepareApiParts: async () => parts,
    cleanup: async () => {
      await fs.rm(ytDir, { recursive: true, force: true })
    }
  }
}

export async function processAttachments(
  messageId: string,
  inputs: InputAttachment[],
  apiKey: string,
  options: ProcessAttachmentOptions = {},
): Promise<ProcessResult> {
  const parts: MediaPart[] = []
  const localFiles: LocalAttachment[] = []
  const skipped: SkippedAttachment[] = []
  const deferredApiMedia: Array<{
    localPath: string
    mimeType: string
    name: string
    url: string
  }> = []
  const msgDir = path.join(stateDir(), 'inbox', messageId)

  if (inputs.length === 0) {
    return { parts, localFiles, skipped, prepareApiParts: async () => parts, cleanup: async () => {} }
  }

  await fs.mkdir(msgDir, { recursive: true })

  const processPromises = inputs.map(async (att, index) => {
    const declaredMime = att.contentType?.split(';')[0].trim().toLowerCase() ?? ''
    const mime = declaredMime && declaredMime !== 'application/octet-stream'
      ? declaredMime
      : (DOCUMENT_EXTENSION_MIMES[path.extname(att.name).toLowerCase()] ?? extensionMime(att.name) ?? declaredMime)
    const localOfficeType = officeParserType(att.name)
    const isLocalText = isLocallyExtractable(att.name, mime)
    const isImage = ALLOWED_IMAGE_MIMES.has(mime)
    const isVideo = ALLOWED_VIDEO_MIMES.has(mime)
    const isAudio = ALLOWED_AUDIO_MIMES.has(mime)
    const isDoc = ALLOWED_DOC_MIMES.has(mime)

    if (!isImage && !isVideo && !isAudio && !isDoc && !isLocalText && !localOfficeType) {
      skipped.push({ name: att.name, reason: 'unsupported_type' })
      return
    }

    if (att.size > MAX_BYTES) {
      skipped.push({ name: att.name, reason: 'too_large' })
      return
    }

    // The API path can reuse a remote File API URI without downloading again.
    // agy needs an actual local file for view_file, so keep going when requested.
    if (!options.keepLocalFiles && (isVideo || isAudio) && uriCache.has(att.url)) {
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

      // Discord filenames are user input. Keep them recognizable while forcing
      // the write beneath this message's inbox directory. Animated GIFs become
      // a six-frame PNG first so both Gemini API and agy see motion rather than
      // depending on provider-specific GIF behavior.
      const safeName = path.basename(att.name) || 'attachment'
      const sampled = mime === 'image/gif'
        ? await animationContactSheet(buf, path.extname(safeName) || '.gif', path.join(msgDir, `animation-${index}`))
        : null
      const effectiveBuffer = sampled?.bytes ?? buf
      const effectiveMime = sampled ? 'image/png' : mime
      const effectiveName = sampled ? `${att.name} (sampled animation frames)` : att.name
      const localPath = sampled?.path ?? path.join(msgDir, `${index}-${safeName}`)
      if (!sampled) await fs.writeFile(localPath, buf)
      if (options.keepLocalFiles) {
        localFiles.push({ path: localPath, name: effectiveName, mimeType: effectiveMime })
      }

      if (localOfficeType) {
        const ast = await parseOffice(buf, { fileType: localOfficeType as any })
        parts.push({ text: `[attached document: ${att.name}]\n${ast.toText().trim().slice(0, 400_000)}` })
      } else if (isLocalText) {
        const text = extractLocalText(buf, att.name)
        parts.push({ text: `[attached file: ${att.name}]\n${text}` })
      } else if (isImage || isDoc) {
        parts.push({ inlineData: { mimeType: effectiveMime, data: effectiveBuffer.toString('base64') } })
      } else if (uriCache.has(att.url)) {
        parts.push({ fileData: { mimeType: mime, fileUri: uriCache.get(att.url)! } })
      } else if (options.keepLocalFiles) {
        // Do not touch the metered API merely because media exists. The agy
        // path reads this local file directly; upload only if agy actually
        // fails and gemma.ts invokes prepareApiParts().
        deferredApiMedia.push({
          localPath,
          mimeType: mime,
          name: att.name,
          url: att.url,
        })
      } else {
        const uri = await uploadAndWaitActive(localPath, mime, att.name, apiKey)
        if (!uri) {
          skipped.push({ name: att.name, reason: 'processing_timeout' })
          return
        }
        uriCache.set(att.url, uri)
        parts.push({ fileData: { mimeType: mime, fileUri: uri } })
      }
    } catch {
      skipped.push({ name: att.name, reason: 'download_failed' })
    }
  })

  await Promise.allSettled(processPromises)

  let apiPartsPrepared = false
  const prepareApiParts = async (): Promise<MediaPart[]> => {
    if (apiPartsPrepared) return parts
    apiPartsPrepared = true
    await Promise.allSettled(deferredApiMedia.map(async media => {
      const cached = uriCache.get(media.url)
      if (cached) {
        parts.push({ fileData: { mimeType: media.mimeType, fileUri: cached } })
        return
      }
      const uri = await uploadAndWaitActive(media.localPath, media.mimeType, media.name, apiKey)
      if (!uri) {
        skipped.push({ name: media.name, reason: 'processing_timeout' })
        return
      }
      uriCache.set(media.url, uri)
      parts.push({ fileData: { mimeType: media.mimeType, fileUri: uri } })
    }))
    return parts
  }

  return {
    parts,
    localFiles,
    skipped,
    prepareApiParts,
    cleanup: async () => {
      await fs.rm(msgDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
