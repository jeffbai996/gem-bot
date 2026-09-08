import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import type { AddressInfo } from 'net'
import { fetchUrlTool, makeFetchUrlTool } from '../../src/tools/fetch-url.ts'
import { isPrivateIp } from '../../src/tools/fetch-url-internal.ts'

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
    } else if (url.pathname === '/host') {
      res.setHeader('Content-Type', 'text/plain')
      res.end(req.headers.host)
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

  test('rejects the complete Tailscale CGNAT range', () => {
    assert.equal(isPrivateIp('100.63.255.255'), false)
    assert.equal(isPrivateIp('100.64.0.0'), true)
    assert.equal(isPrivateIp('100.100.1.2'), true)
    assert.equal(isPrivateIp('100.127.255.255'), true)
    assert.equal(isPrivateIp('100.128.0.0'), false)
    assert.equal(isPrivateIp('::ffff:100.100.1.2'), true)
  })

  test('rejects mixed public and private DNS answers before connecting', async () => {
    delete process.env.FETCH_URL_TESTING_ALLOW_PRIVATE
    try {
      const tool = makeFetchUrlTool({
        lookup: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      })
      const out = await tool.execute({ url: 'http://mixed.example/' }, {} as any)
      assert.match(out, /private network/i)
    } finally {
      process.env.FETCH_URL_TESTING_ALLOW_PRIVATE = '1'
    }
  })

  test('pins the validated DNS answer and preserves the original Host', async () => {
    let lookups = 0
    const tool = makeFetchUrlTool({
      lookup: async () => {
        lookups++
        return lookups === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '10.0.0.1', family: 4 }]
      },
    })
    const port = (server.address() as AddressInfo).port
    const out = await tool.execute(
      { url: `http://rebinding.example:${port}/host` },
      {} as any,
    )

    assert.match(out, new RegExp(`rebinding\\.example:${port}`))
    assert.equal(lookups, 1, 'the socket must use the pinned answer, not DNS again')
  })

  test('respects maxChars cap', async () => {
    const out = await fetchUrlTool.execute({ url: `${baseUrl}/article`, maxChars: 50 }, {} as any)
    assert.match(out, /\[truncated/)
  })
})
