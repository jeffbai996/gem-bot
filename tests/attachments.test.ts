import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { processAttachments, processYouTubeUrls, parseVttTranscript, type InputAttachment, type MediaPart, type InlinePart, type TextPart } from '../src/attachments.ts'
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

function isInline(p: MediaPart): p is InlinePart {
  return 'inlineData' in p
}

function isText(p: MediaPart): p is TextPart {
  return 'text' in p
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
    const p = result.parts[0]
    assert.ok(isInline(p), 'expected InlinePart')
    assert.equal(p.inlineData.mimeType, 'image/png')
    assert.equal(Buffer.from(p.inlineData.data, 'base64').toString('hex'), pngBytes.toString('hex'))
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
      url: `${srv.url}/app.exe`,
      name: 'app.exe',
      size: 1024,
      contentType: 'application/octet-stream'
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
    await fs.access(msgDir)
    await cleanup()
    srv.close()
    await assert.rejects(() => fs.access(msgDir))
  })
})

describe('parseVttTranscript', () => {
  test('strips WebVTT header and timestamps', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      '00:00:00.000 --> 00:00:03.000 align:start position:0%',
      'Hello world',
      '',
      '00:00:03.000 --> 00:00:06.000 align:start position:0%',
      'This is a test',
      ''
    ].join('\n')

    const out = parseVttTranscript(vtt)
    assert.equal(out, 'Hello world\nThis is a test')
  })

  test('strips inline timing tags and <c> spans', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:18.800 --> 00:00:21.790 align:start position:0%',
      'We\'re<00:00:19.039><c> no</c><00:00:19.359><c> strangers</c><00:00:19.840><c> to</c>',
      ''
    ].join('\n')

    const out = parseVttTranscript(vtt)
    assert.equal(out, "We're no strangers to")
  })

  test('collapses rolling-display duplicate lines', () => {
    // Real YouTube auto-caption pattern: each new cue repeats the previous
    // cue's tail as its first line, then adds new content on the second line.
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      'We\'re no strangers to',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'We\'re no strangers to',
      'love. You know the rules',
      '',
      '00:00:04.000 --> 00:00:06.000',
      'love. You know the rules',
      'and so do I',
      ''
    ].join('\n')

    const out = parseVttTranscript(vtt)
    const lines = out.split('\n')
    // Each unique line should appear exactly once — consecutive dupes collapsed
    assert.deepEqual(lines, [
      "We're no strangers to",
      'love. You know the rules',
      'and so do I'
    ])
  })

  test('handles empty / header-only vtt', () => {
    assert.equal(parseVttTranscript(''), '')
    assert.equal(parseVttTranscript('WEBVTT\n\n'), '')
    assert.equal(parseVttTranscript('WEBVTT\nKind: captions\nLanguage: en\n'), '')
  })

  test('decodes common html entities', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      'it&#39;s &amp; &quot;yo&quot;',
      ''
    ].join('\n')
    assert.equal(parseVttTranscript(vtt), `it's & "yo"`)
  })

  test('strips positioning cues (align:, position:) that live on cue line', () => {
    // These are already on the timestamp line which gets dropped, but guard
    // against a bare positioning token slipping through
    const vtt = [
      'WEBVTT',
      'NOTE this is a comment that should be dropped',
      '',
      '00:00:00.000 --> 00:00:02.000 align:start position:0%',
      'actual content',
      ''
    ].join('\n')
    assert.equal(parseVttTranscript(vtt), 'actual content')
  })
})

describe('processYouTubeUrls', () => {
  beforeEach(async () => {
    process.env.DISCORD_STATE_DIR = testDir
    await fs.rm(testDir, { recursive: true, force: true })
    await fs.mkdir(testDir, { recursive: true })
  })

  test('no YouTube URLs in content → empty result', async () => {
    const result = await processYouTubeUrls('msg-noyt', 'just a regular message', 'test-api-key')
    assert.equal(result.parts.length, 0)
    assert.equal(result.skipped.length, 0)
  })

  test('falls back to title-only part when yt-dlp is a fake that only prints metadata', async () => {
    // Stub yt-dlp with a shell script that prints id/title but writes no .vtt.
    // This simulates a video with no captions available.
    const fakeBin = path.join(testDir, 'fake-ytdlp.sh')
    await fs.writeFile(fakeBin, '#!/bin/sh\necho "dQw4w9WgXcQ\tRick Astley - Never Gonna Give You Up"\nexit 0\n')
    await fs.chmod(fakeBin, 0o755)
    process.env.YT_DLP_PATH = fakeBin

    const result = await processYouTubeUrls('msg-yt1', 'check this https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'test-api-key')
    delete process.env.YT_DLP_PATH

    assert.equal(result.skipped.length, 0)
    assert.equal(result.parts.length, 1)
    const p = result.parts[0]
    assert.ok(isText(p), 'expected TextPart')
    assert.ok(p.text.includes('no transcript available'), `expected title-only marker, got: ${p.text}`)
    assert.ok(p.text.includes('dQw4w9WgXcQ'), 'expected video id in tag')
    assert.ok(p.text.includes('Rick Astley'), 'expected title in tag')

    await result.cleanup()
  })

  test('emits transcript part when yt-dlp fake writes a .vtt next to metadata', async () => {
    // Fake script: writes a minimal valid vtt to the output dir then prints metadata.
    // Output dir is passed via -o '<dir>/%(id)s.%(ext)s' — script parses argv.
    const fakeBin = path.join(testDir, 'fake-ytdlp-tx.sh')
    const script = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUTTMPL="$2"; shift 2;;
    *) shift;;
  esac
done
OUTDIR=$(dirname "$OUTTMPL")
mkdir -p "$OUTDIR"
cat > "$OUTDIR/abc12345678.en.vtt" <<EOF
WEBVTT

00:00:00.000 --> 00:00:03.000
hello from the fake video

00:00:03.000 --> 00:00:06.000
hello from the fake video
second line of content
EOF
echo "abc12345678	Fake Test Video"
exit 0
`
    await fs.writeFile(fakeBin, script)
    await fs.chmod(fakeBin, 0o755)
    process.env.YT_DLP_PATH = fakeBin

    const result = await processYouTubeUrls('msg-yt2', 'https://youtu.be/abc12345678', 'test-api-key')
    delete process.env.YT_DLP_PATH

    assert.equal(result.skipped.length, 0)
    assert.equal(result.parts.length, 1)
    const p = result.parts[0]
    assert.ok(isText(p), 'expected TextPart')
    assert.ok(p.text.includes('[youtube transcript v=abc12345678'), `expected transcript tag, got: ${p.text}`)
    assert.ok(p.text.includes('Fake Test Video'), 'expected title in tag')
    assert.ok(p.text.includes('hello from the fake video'), 'expected transcript body')
    assert.ok(p.text.includes('second line of content'), 'expected second line')
    // Confirm rolling-display dedupe: "hello from the fake video" should appear once
    const occurrences = p.text.split('hello from the fake video').length - 1
    assert.equal(occurrences, 1, 'expected dedupe of rolling-display repeat')

    await result.cleanup()
  })

  test('records skipped with ytdlp_failed when yt-dlp exits nonzero', async () => {
    const fakeBin = path.join(testDir, 'fake-ytdlp-fail.sh')
    await fs.writeFile(fakeBin, '#!/bin/sh\nexit 1\n')
    await fs.chmod(fakeBin, 0o755)
    process.env.YT_DLP_PATH = fakeBin

    const result = await processYouTubeUrls('msg-yt3', 'https://www.youtube.com/watch?v=zzzzzzzzzzz', 'test-api-key')
    delete process.env.YT_DLP_PATH

    assert.equal(result.parts.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'ytdlp_failed')
    assert.equal(result.skipped[0].name, 'youtube:zzzzzzzzzzz')

    await result.cleanup()
  })

  test('dedupes multiple links to the same video id', async () => {
    const fakeBin = path.join(testDir, 'fake-ytdlp-count.sh')
    const counter = path.join(testDir, 'call-count.txt')
    await fs.writeFile(fakeBin, `#!/bin/sh
echo "x" >> ${counter}
echo "sameidvideo\tTitle"
exit 0
`)
    await fs.chmod(fakeBin, 0o755)
    process.env.YT_DLP_PATH = fakeBin

    const msg = 'https://youtu.be/sameidvideo and also https://www.youtube.com/watch?v=sameidvideo again'
    const result = await processYouTubeUrls('msg-yt4', msg, 'test-api-key')
    delete process.env.YT_DLP_PATH

    const count = (await fs.readFile(counter, 'utf8')).trim().split('\n').length
    assert.equal(count, 1, 'yt-dlp should be invoked exactly once for duplicate links')
    assert.equal(result.parts.length, 1)

    await result.cleanup()
  })
})
