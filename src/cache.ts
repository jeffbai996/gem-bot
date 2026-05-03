// Gemini context-cache manager for the stable system-prompt prefix.
//
// Caches `persona + RESPONSE_FORMAT_BASE + thinking-mode addendum + summary +
// pinned facts + tools + toolConfig` server-side via `client.caches.create`.
// Per-call we pass `cachedContent: name` instead of re-sending the prefix; only
// the volatile contents (history tail + user message) flow on the wire. Cached
// input bills at ~10% of normal rate (per Gemini pricing for 2.5/3.x
// models — earlier docs that said 25% were wrong; verified 2026-05-02
// against the official rate card), plus a per-hour storage fee.
//
// Rolling-summary behavior: the persona builder folds the channel's running
// summary into the system prompt before we see it. When the summarizer rolls
// up new messages, the systemText hash changes, so getOrCreate falls through
// to a fresh cache; the old cache ages out via TTL. No explicit invalidation
// needed — the hash IS the cache key.
//
// Design choices:
//   - Keyed by (model, hash(systemText), hash(toolsAndConfig)). Thinking mode
//     and the summary are baked into systemText, so different per-channel
//     configurations get separate caches. Same persona+summary across two
//     channels collapses into one shared cache — efficient.
//   - In-process map, no persistence. SDK reconstructs the cache on restart.
//     Storage fee runs while cache is alive; rare gemma restarts mean low
//     overhead. Could add explicit cleanup later if it becomes a cost issue.
//   - Fail-open: any error during create returns null; the caller falls back
//     to the uncached path. Better to pay full price than break a turn.
//   - Min token check: skip caching when systemText is below the model's
//     minimum (1024 for Flash, 4096 for Pro). Below the floor, the API
//     400s on cache create.

import type { GoogleGenAI } from '@google/genai'
import { createHash } from 'crypto'

const CACHE_MIN_TOKENS: Record<string, number> = {
  'gemini-2.0-flash': 1024,
  'gemini-2.0-flash-lite': 1024,
  'gemini-2.5-flash': 1024,
  'gemini-3-flash-preview': 1024,
  'gemini-2.5-pro': 4096,
  'gemini-3-pro-preview': 4096,
  'gemini-3.1-pro-preview': 4096,
}

// Bumped from the Google default of 1h. Multi-hour group chats are the
// dominant gemma pattern (humans + bots talking on and off across an
// evening); a 2-hour TTL keeps the cache warm through the typical session
// without paying meaningful extra storage. The first message after the TTL
// expires pays full price; everything in-window saves ~75%.
const CACHE_DEFAULT_TTL_SEC = 7200

interface CacheKey {
  model: string
  systemHash: string
  toolsHash: string
}

export interface CachedRef {
  name: string  // e.g. "cachedContents/abc123"
  model: string
  systemHash: string  // first 12 chars of sha1(systemText)
  systemText: string
  // Token counts for introspection / /gemini cache info. systemTokens is the
  // estimate that gated min-size; cachedTokens is what the API actually billed
  // (filled from the first response that returned a cache hit, lazy).
  systemTokens: number
  cachedTokens: number | null
  ttlSec: number
  createdAt: number       // unix ms when cache was created
  lastUsedAt: number      // unix ms — touched on each getOrCreate hit
  hitCount: number        // # of getOrCreate calls that returned an existing entry
}

export class GeminiCacheManager {
  private cacheByKey: Map<string, CachedRef> = new Map()

  private static keyString(k: CacheKey): string {
    return `${k.model}|${k.systemHash}|${k.toolsHash}`
  }

  private static hash(s: string): string {
    return createHash('sha1').update(s).digest('hex').slice(0, 12)
  }

  static estimateTokens(text: string): number {
    // Rough char/4 estimate. Avoids a synchronous countTokens() round-trip
    // on the hot path. Off by ~10-15% for English; close enough for the
    // floor check.
    return Math.ceil(text.length / 4)
  }

  static defaultTtlSec(): number {
    return CACHE_DEFAULT_TTL_SEC
  }

  // Returns the cached content `name` if a cache is available + reusable.
  // Creates one on first miss. Returns null if caching is unsupported for
  // the model, the prefix is below the minimum size, or the API call failed.
  async getOrCreate(
    client: GoogleGenAI,
    model: string,
    systemText: string,
    tools: any[],
    toolConfig: any,
    ttlSec: number = CACHE_DEFAULT_TTL_SEC,
  ): Promise<string | null> {
    const minTokens = CACHE_MIN_TOKENS[model]
    if (!minTokens) return null  // unknown model — don't try
    const sysTokens = GeminiCacheManager.estimateTokens(systemText)
    if (sysTokens < minTokens) return null

    const key: CacheKey = {
      model,
      systemHash: GeminiCacheManager.hash(systemText),
      toolsHash: GeminiCacheManager.hash(JSON.stringify(tools ?? []) + JSON.stringify(toolConfig ?? {})),
    }
    const keyStr = GeminiCacheManager.keyString(key)
    const cached = this.cacheByKey.get(keyStr)
    if (cached) {
      // Hit — bump usage stats. Don't refresh createdAt; the cache's TTL is
      // wall-clock from the API's perspective.
      cached.lastUsedAt = Date.now()
      cached.hitCount += 1
      return cached.name
    }

    try {
      const created = await client.caches.create({
        model,
        config: {
          systemInstruction: { role: 'system', parts: [{ text: systemText }] },
          tools,
          toolConfig,
          ttl: `${ttlSec}s`,
          displayName: `gemma-${model}-${key.systemHash}-${key.toolsHash}`,
        } as any,
      })
      const name = (created as any)?.name
      if (typeof name !== 'string' || !name) return null
      const ref: CachedRef = {
        name,
        model,
        systemHash: key.systemHash,
        systemText,
        systemTokens: sysTokens,
        cachedTokens: null,
        ttlSec,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        hitCount: 0,
      }
      this.cacheByKey.set(keyStr, ref)
      console.error(`[gemini cache] created model=${model} system=${key.systemHash} tools=${key.toolsHash} ttl=${ttlSec}s name=${name}`)
      return name
    } catch (e: any) {
      console.error(`[gemini cache] create failed (fail-open):`, e?.message ?? e)
      return null
    }
  }

  // Backfill the actual cached-token count from a usageMetadata observation.
  // gemma calls this from respond() with the most recent cachedContentTokenCount
  // so /gemini cache info shows the real billed size, not just the estimate.
  recordCachedTokens(cacheName: string, cachedTokens: number): void {
    if (cachedTokens <= 0) return
    for (const ref of this.cacheByKey.values()) {
      if (ref.name === cacheName) {
        ref.cachedTokens = cachedTokens
        return
      }
    }
  }

  // List all live entries for introspection. Returned in most-recent-first
  // order so /gemini cache info shows what's actually warm at the top.
  list(): CachedRef[] {
    return [...this.cacheByKey.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  // Drop all cached refs. Used when persona reloads or when /gemini clear
  // wants to nuke any in-flight cache for a channel — safer than tracking
  // per-channel cache lineage when the persona is global anyway.
  clear(): void {
    this.cacheByKey.clear()
  }
}
