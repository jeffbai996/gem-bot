export function chunk(text: string, limit: number = 2000, mode: 'length' | 'newline' = 'newline'): string[] {
  if (text.length <= limit) return [text]
  
  const chunks: string[] = []
  
  while (text.length > 0) {
    if (text.length <= limit) {
      chunks.push(text)
      break
    }
    
    let splitAt = -1
    
    if (mode === 'newline') {
      // Prefer paragraph break (double newline) if > 50% through
      const dbl = text.lastIndexOf('\n\n', limit)
      if (dbl > limit * 0.5) splitAt = dbl + 2
      
      // Then line break
      if (splitAt === -1) {
        const sgl = text.lastIndexOf('\n', limit)
        if (sgl > limit * 0.5) splitAt = sgl + 1
      }
      
      // Then space
      if (splitAt === -1) {
        const sp = text.lastIndexOf(' ', limit)
        if (sp > 0) splitAt = sp + 1
      }
    }
    
    // Hard cut if no suitable breakpoint
    if (splitAt === -1) splitAt = limit
    
    chunks.push(text.slice(0, splitAt))
    text = text.slice(splitAt)
  }
  
  return chunks
}