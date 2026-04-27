import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import type { AddressInfo } from 'net'
import { fetchUrlTool } from '../../src/tools/fetch-url.ts'

let server: http.Server
let baseUrl: string

before(async () => {
  process.env.FETCH_URL_TESTING_ALLOW_PRIVATE = '1'
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    if (url.pathname === '/article') {
      res.setHeader('Content-Type', 'text/html')
      res.end(`<html><head><title>Test Article</title></head><body><article><h1>Hi</h1><p>Body of article. ${'word '.repeat(40)}</p></article></body></html>`)
    } else if (url.pathname === '/text') {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello plain text')
    } else if (url.pathname === '/json') {
      res.setHeader('Content-Type', 'application/json')
      res.end('{"foo":"bar"}')
    } else if (url.pathname === '/404') {
      res.statusCode = 404
      res.end('not found')
    } else if (url.pathname === '/redirect') {
      res.statusCode = 302
      res.setHeader('Location', '/article')
      res.end()
    } else if (url.pathname === '/big') {
      res.setHeader('Content-Type', 'text/plain')
      const chunk = Buffer.alloc(1024 * 1024, 'x')
      let sent = 0
      const send = () => {
        if (sent >= 10) { res.end(); return }
        sent++
        res.write(chunk, send)
      }
      send()
    } else {
      res.statusCode = 500
      res.end()
    }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => {
  server.close()
  delete process.env.FETCH_URL_TESTING_ALLOW_PRIVATE
})

describe('fetchUrlTool', () => {
  test('declaration shape', () => {
    assert.equal(fetchUrlTool.name, 'fetch_url')
    assert.deepEqual(fetchUrlTool.declaration.parameters?.required, ['url'])
  })

  test('extracts HTML article with title', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/article` }, {} as any)
    assert.match(out, /Test Article/)
    assert.match(out, /Body of article/)
  })

  test('plain text body returned', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/text` }, {} as any)
    assert.match(out, /hello plain text/)
  })

  test('JSON pretty-printed', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/json` }, {} as any)
    assert.match(out, /"foo": "bar"/)
  })

  test('404 returns HTTP error string', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/404` }, {} as any)
    assert.match(out, /HTTP 404/)
  })

  test('follows redirect', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/redirect` }, {} as any)
    assert.match(out, /Body of article/)
  })

  test('oversized response returns size error', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/big` }, {} as any)
    assert.match(out, /5MB/)
  })

  test('invalid URL returns error string', async () => {
    const out = await fetchUrlTool.execute({ url: 'not a url' }, {} as any)
    assert.match(out, /invalid URL/i)
  })

  test('non-http scheme returns error string', async () => {
    const out = await fetchUrlTool.execute({ url: 'ftp://example.com' }, {} as any)
    assert.match(out, /scheme/i)
  })

  test('private IP rejected when not in test mode', async () => {
    delete process.env.FETCH_URL_TESTING_ALLOW_PRIVATE
    try {
      const out = await fetchUrlTool.execute({ url: `${baseUrl}/text` }, {} as any)
      assert.match(out, /private network/i)
    } finally {
      process.env.FETCH_URL_TESTING_ALLOW_PRIVATE = '1'
    }
  })

  test('respects maxChars cap', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/article`, maxChars: 50 }, {} as any)
    assert.match(out, /\[truncated/)
  })
})
