import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Sample motion into one six-frame PNG so every Gem engine sees the loop. */
export async function animationContactSheet(
  bytes: Buffer,
  sourceExtension: string,
  directory: string,
): Promise<{ bytes: Buffer; path: string }> {
  await mkdir(directory, { recursive: true })
  const extension = sourceExtension.startsWith('.') ? sourceExtension : `.${sourceExtension}`
  const input = path.join(directory, `animation${extension}`)
  const output = path.join(directory, 'animation-contact-sheet.png')
  await writeFile(input, bytes, { mode: 0o600 })
  await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', 'fps=3,scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=white@0,tile=3x2:padding=4:margin=4',
    '-frames:v', '1', output,
  ], { timeout: 20_000, maxBuffer: 1_000_000 })
  return { bytes: await readFile(output), path: output }
}
