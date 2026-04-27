import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { validateUrl, isPrivateIp, extractContent, truncate } from '../../src/tools/fetch-url-internal.ts'

describe('validateUrl', () => {
  test('accepts http and https', () => {
    assert.equal(validateUrl('http://example.com').url.protocol, 'http:')
    assert.equal(validateUrl('https://example.com').url.protocol, 'https:')
  })
  test('rejects ftp', () => { assert.throws(() => validateUrl('ftp://example.com'), /scheme/) })
  test('rejects file', () => { assert.throws(() => validateUrl('file:///etc/passwd'), /scheme/) })
  test('rejects javascript', () => { assert.throws(() => validateUrl('javascript:alert(1)'), /scheme/) })
  test('rejects malformed', () => { assert.throws(() => validateUrl('not a url'), /invalid/i) })
})

describe('isPrivateIp', () => {
  test('IPv4 private ranges', () => {
    assert.equal(isPrivateIp('10.0.0.1'), true)
    assert.equal(isPrivateIp('10.255.255.255'), true)
    assert.equal(isPrivateIp('172.16.0.1'), true)
    assert.equal(isPrivateIp('172.31.255.255'), true)
    assert.equal(isPrivateIp('192.168.1.1'), true)
    assert.equal(isPrivateIp('127.0.0.1'), true)
    assert.equal(isPrivateIp('169.254.1.1'), true)
    assert.equal(isPrivateIp('0.0.0.0'), true)
  })
  test('IPv4 public', () => {
    assert.equal(isPrivateIp('8.8.8.8'), false)
    assert.equal(isPrivateIp('172.32.0.1'), false)
    assert.equal(isPrivateIp('172.15.255.255'), false)
    assert.equal(isPrivateIp('1.1.1.1'), false)
  })
  test('IPv6 private', () => {
    assert.equal(isPrivateIp('::1'), true)
    assert.equal(isPrivateIp('fc00::1'), true)
    assert.equal(isPrivateIp('fd00::1'), true)
    assert.equal(isPrivateIp('fe80::1'), true)
  })
  test('IPv6 public', () => {
    assert.equal(isPrivateIp('2606:4700:4700::1111'), false)
  })
  test('IPv4-mapped IPv6 falls through to IPv4 check', () => {
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true)
    assert.equal(isPrivateIp('::ffff:8.8.8.8'), false)
  })
})

describe('extractContent', () => {
  test('HTML article extraction', () => {
    const html = `<html><head><title>Test</title></head><body><article><h1>Hello</h1><p>This is the article body with enough content to look like a real article. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></article></body></html>`
    const out = extractContent(Buffer.from(html, 'utf8'), 'text/html', 'https://example.com')
    assert.equal(out.contentType, 'html')
    assert.match(out.body, /article body/)
  })
  test('plain text passes through', () => {
    const out = extractContent(Buffer.from('hello world\n'), 'text/plain', 'https://x')
    assert.equal(out.contentType, 'text')
    assert.equal(out.body.trim(), 'hello world')
  })
  test('markdown passes through', () => {
    const out = extractContent(Buffer.from('# Hi\n\nbody'), 'text/markdown', 'https://x')
    assert.equal(out.contentType, 'markdown')
    assert.match(out.body, /# Hi/)
  })
  test('JSON pretty-prints', () => {
    const out = extractContent(Buffer.from('{"a":1,"b":[2,3]}'), 'application/json', 'https://x')
    assert.equal(out.contentType, 'json')
    assert.match(out.body, /"a": 1/)
  })
  test('unsupported content-type', () => {
    const out = extractContent(Buffer.from('binary'), 'application/octet-stream', 'https://x')
    assert.equal(out.contentType, 'unsupported')
    assert.match(out.body, /unsupported/i)
  })
})

describe('truncate', () => {
  test('under cap unchanged', () => {
    assert.equal(truncate('hello', 100), 'hello')
  })
  test('over cap appends note', () => {
    const long = 'x'.repeat(200)
    const out = truncate(long, 50)
    assert.ok(out.startsWith('xxxxx'))
    assert.match(out, /\[truncated/)
  })
  test('exactly at cap unchanged', () => {
    const exactly = 'x'.repeat(50)
    assert.equal(truncate(exactly, 50), exactly)
  })
})
