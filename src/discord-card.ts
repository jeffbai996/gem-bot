const DISCORD_LIMIT = 2_000

export function formatCodeCard(header: string, rows: readonly string[] | string): string {
  let body = (Array.isArray(rows) ? rows.join('\n') : rows) as string
  body = body.replaceAll('```', '′′′')
  const bodyLimit = Math.max(1, DISCORD_LIMIT - header.length - '\n```\n\n```'.length)
  if (body.length > bodyLimit) body = body.slice(0, bodyLimit - 1).trimEnd() + '…'
  return `${header}\n\`\`\`\n${body}\n\`\`\``
}

const SKIP_REASON_LABELS: Record<string, string> = {
  too_large: 'too large',
  unsupported_type: 'unsupported file type',
  download_failed: 'download failed',
  processing_timeout: 'processing timed out',
  ytdlp_failed: 'YouTube import failed',
  ytdlp_timeout: 'YouTube import timed out',
}

export function formatSkippedAttachments(
  skipped: Array<{ name: string, reason: string }>,
  duringFallback = false,
): string {
  const title = duringFallback
    ? '📎 **Some files couldn’t survive API fallback**'
    : '📎 **Some files weren’t attached**'
  const pad = Math.max(...skipped.map(({ name }) => name.length), 4)
  const rows = skipped.map(({ name, reason }) =>
    `${name.padEnd(pad)} : ${SKIP_REASON_LABELS[reason] ?? reason.replaceAll('_', ' ')}`)
  return formatCodeCard(title, rows)
}
