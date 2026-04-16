import { describe, test, beforeEach } from 'bun:test'
import assert from 'node:assert/strict'
import { processAttachments, type InputAttachment } from '../src/attachments.ts'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import http from 'http'

const testDir = path.join(os.tmpdir(), `gemma-attachments-test-${process.pid}`)

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string, close: () => void }> {
  return new Promise(resolve => {
    const srv = http.createServer(handler)
    srv.listen(0, () => {
      const port = (srv.address() as any).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close() })
    })
  })
}

describe('processAttachments', () => {
  beforeEach(async () => {
    process.env.DISCORD_STATE_DIR = testDir
    await fs.rm(testDir, { recursive: true, force: true })
    await fs.mkdir(testDir, { recursive: true })
  })

  test('downloads and inlines a PNG', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const srv = await startServer((_, res) => { res.writeHead(200); res.end(pngBytes) })
    const input: InputAttachment[] = [{
      url: `${srv.url}/chart.png`,
      name: 'chart.png',
      size: pngBytes.length,
      contentType: 'image/png'
    }]
    const result = await processAttachments('msg1', input, 'test-api-key')
    srv.close()

    assert.equal(result.parts.length, 1)
    assert.equal(result.parts[0].inlineData.mimeType, 'image/png')
    assert.equal(Buffer.from(result.parts[0].inlineData.data, 'base64').toString('hex'), pngBytes.toString('hex'))
    assert.equal(result.skipped.length, 0)
  })

  test('skips oversized file', async () => {
    const srv = await startServer((_, res) => { res.writeHead(200); res.end('x') })
    const input: InputAttachment[] = [{
      url: `${srv.url}/huge.png`,
      name: 'huge.png',
      size: 25 * 1024 * 1024,
      contentType: 'image/png'
    }]
    const result = await processAttachments('msg2', input, 'test-api-key')
    srv.close()

    assert.equal(result.parts.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'too_large')
  })

  test('skips unsupported mime', async () => {
    const srv = await startServer((_, res) => { res.writeHead(200); res.end('x') })
    const input: InputAttachment[] = [{
      url: `${srv.url}/doc.pdf`,
      name: 'doc.pdf',
      size: 1024,
      contentType: 'application/pdf'
    }]
    const result = await processAttachments('msg3', input, 'test-api-key')
    srv.close()

    assert.equal(result.parts.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'unsupported_type')
  })

  test('cleanup removes message inbox dir', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const srv = await startServer((_, res) => { res.writeHead(200); res.end(pngBytes) })
    const input: InputAttachment[] = [{
      url: `${srv.url}/a.png`,
      name: 'a.png',
      size: pngBytes.length,
      contentType: 'image/png'
    }]
    const { cleanup } = await processAttachments('msg4', input, 'test-api-key')
    const msgDir = path.join(testDir, 'inbox', 'msg4')
    await fs.access(msgDir)  // exists
    await cleanup()
    srv.close()
    await assert.rejects(() => fs.access(msgDir))
  })
})
