export function chunk(text: string, limit: number = 2000, mode: 'length' | 'newline' = 'newline'): string[] {
  if (text.length <= limit) return [text]
  
  const chunks: string[] = []
  let activeCodeLanguage: string | null = null
  let inCodeBlock = false
  
  while (text.length > 0) {
    if (text.length <= limit) {
      chunks.push(text)
      break
    }
    
    // We need to leave room to append "```\n" if we have to close an open block.
    // 4 characters for closing backticks + newline.
    const effectiveLimit = inCodeBlock ? limit - 4 : limit
    
    let splitAt = -1
    
    if (mode === 'newline') {
      const dbl = text.lastIndexOf('\n\n', effectiveLimit)
      if (dbl > effectiveLimit * 0.5) splitAt = dbl + 2
      
      if (splitAt === -1) {
        const sgl = text.lastIndexOf('\n', effectiveLimit)
        if (sgl > effectiveLimit * 0.5) splitAt = sgl + 1
      }
      
      if (splitAt === -1) {
        const sp = text.lastIndexOf(' ', effectiveLimit)
        if (sp > 0) splitAt = sp + 1
      }
    }
    
    if (splitAt === -1) splitAt = effectiveLimit
    
    let currentChunk = text.slice(0, splitAt)
    let nextChunkStart = text.slice(splitAt)

    // Analyze backticks in the current chunk to update state
    const backtickRegex = /```(.*?)(\n|$)/g
    let match
    while ((match = backtickRegex.exec(currentChunk)) !== null) {
      inCodeBlock = !inCodeBlock
      if (inCodeBlock) {
        activeCodeLanguage = match[1].trim()
      } else {
        activeCodeLanguage = null
      }
    }

    // If a block is still open at the split point, properly close and reopen it
    if (inCodeBlock) {
      // Don't leave hanging partial code block syntax if it was right at the split
      if (!currentChunk.endsWith('\n')) currentChunk += '\n'
      currentChunk += '```'
      
      const langPrefix = activeCodeLanguage ? activeCodeLanguage : ''
      nextChunkStart = '```' + langPrefix + '\n' + nextChunkStart
    }

    chunks.push(currentChunk)
    text = nextChunkStart
  }
  
  return chunks
}