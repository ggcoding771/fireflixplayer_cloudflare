import { NextRequest, NextResponse } from 'next/server';
import { getSourceById } from '@/lib/sources';
import { parseM3U8, detectCastleLanguages, generateFlagsFromLangs, type AudioTrack, type QualityLevel } from '@/lib/m3u8-parser';

export const runtime = 'edge';

// ─── Unlimited Cache API (FREE, no limits, edge-local) ─────────────────────────
// Replaced KV entirely — KV free plan (1K writes/day, 100K reads/day) gets exhausted
// with 600+ users. Cache API is free, unlimited, and even faster than KV.
//
// Strategy:
//   Read:  Cache API → memory fallback → Fetch fresh
//   Write: Cache API (always) + memory fallback (local dev)
//   TTL:   2 days — m3u8 master playlists are stable for 24-48+ hours
//   SWR:   If stale (>2 days old), serve cached instantly + refresh in background
//   Validation: If cached m3u8 URL returns error on playback, player auto-retries
//              with fresh request (HLS.js handles this natively)

// Fallback in-memory cache (used when Cache API is not available, e.g. local dev)
const memoryCache = new Map<string, { data: string; timestamp: number }>();
const MEMORY_CACHE_MAX = 200;
const CACHE_TTL = 2 * 24 * 60 * 60;     // 2 days — m3u8 URLs are stable this long
const CACHE_SWR = 1 * 24 * 60 * 60;     // Serve stale for 1 extra day while revalidating

// ─── L1: Cache API ──────────────────────────────────────────────────────────

function getCacheApi(): Cache | null {
  try {
    // @ts-expect-error — caches global available in CF Workers/Pages Functions
    if (typeof caches !== 'undefined' && caches.default) return caches.default;
  } catch { /* ignore */ }
  return null;
}

function cacheApiUrl(key: string): string {
  // Cache API requires a valid URL as key. Use a synthetic URL with the cache key.
  return `https://cache.fireflixplayer.internal/${key}`;
}

async function cacheApiGet(key: string): Promise<{ data: string; age: number } | null> {
  const cache = getCacheApi();
  if (!cache) return null;
  try {
    const req = new Request(cacheApiUrl(key));
    const resp = await cache.match(req);
    if (!resp) return null;
    const ts = resp.headers.get('X-Cache-Timestamp');
    const data = await resp.text();
    if (!ts || !data) return null;
    const age = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
    return { data, age };
  } catch {
    return null;
  }
}

async function cacheApiPut(key: string, data: string): Promise<void> {
  const cache = getCacheApi();
  if (!cache) return;
  try {
    const req = new Request(cacheApiUrl(key));
    const resp = new Response(data, {
      headers: {
        'X-Cache-Timestamp': Math.floor(Date.now() / 1000).toString(),
        'Cache-Control': 'public, max-age=259200', // 3 days — Cache API uses this for eviction
        'Content-Type': 'application/json',
      },
    });
    await cache.put(req, resp);
  } catch {
    // Cache API write failed — non-critical, memory cache has our back
  }
}

// ─── Unified cache helpers (Cache API only — unlimited & free) ────────────

/**
 * Read from cache: Cache API → memory fallback → null
 */
async function cacheGet(key: string): Promise<{ data: string; age: number; layer: string } | null> {
  // Try Cache API first (free, unlimited, edge-local, blazing fast)
  const cached = await cacheApiGet(key);
  if (cached) return { ...cached, layer: 'CacheAPI' };

  // Fallback to memory cache (local dev)
  const entry = memoryCache.get(key);
  if (entry) {
    const age = Math.floor((Date.now() - entry.timestamp) / 1000);
    return { data: entry.data, age, layer: 'Memory' };
  }

  return null;
}

/**
 * Write to Cache API + memory fallback.
 * Cache API is unlimited — no need to worry about write quotas!
 */
async function cachePut(key: string, data: string): Promise<void> {
  // Write to Cache API (free, unlimited — write as much as you want!)
  await cacheApiPut(key, data);
  // Also write to memory cache as fallback
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }
  memoryCache.set(key, { data, timestamp: Date.now() });
}

const MM_BASE = 'https://missourimonster-vyla.hf.space';
const SF_BASE = 'https://epiccodergg-streamforge-api.hf.space';
const HF_PROXY_BASE = 'https://epiccodergg-fireflix-api.hf.space';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StreamSource {
  source: string
  label: string
  url: string
  language?: string
  quality?: string
}

interface StreamSubtitle {
  label: string
  file: string
  type: string
  source?: string
  language?: string
}

interface StreamData {
  sources: StreamSource[]
  subtitles: StreamSubtitle[]
}

interface StreamResult {
  sourceId: string;
  sourceName: string;
  success: boolean;
  url: string | null;
  rawUrl: string | null;
  audioTracks: AudioTrack[];
  qualities: QualityLevel[];
  languageFlags: string;
  headers?: Record<string, string>;
  elapsedMs: number | null;
  error: string | null;
  needsProxy: boolean;
  subtitles?: Array<{
    label: string;
    url: string;
    type: 'vtt' | 'srt' | 'ass';
    language?: string;
    flagEmoji?: string;
  }>;
  multiStreams?: Array<{
    title: string;
    quality: string;
    language: string;
    url: string;
    type: string;
    audioTracks: AudioTrack[];
  }>;
}

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Check if a URL points to a Castle CDN (blocked by CF Workers).
 * Castle uses rotating CDN domains but always has /myhls_mps/ in the path.
 */
function isCastleCDN(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const path = new URL(url).pathname.toLowerCase();
    const castleDomains = [
      'imgcdn.kim', 'mlnou.com', 'hcovw.com', 'toxcw.com', 'fdwoc.com', 'txoxc.com', 'hsxco.com',
    ];
    const isKnownDomain = castleDomains.some(d => hostname === d || hostname.endsWith('.' + d));
    const isCastlePath = path.includes('/myhls_mps/') || path.includes('/hls_mps/');
    return isKnownDomain || isCastlePath;
  } catch {
    return false;
  }
}

/**
 * Check if a URL points to a freecdn CDN
 */
function isFreecdnCDN(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /freecdn\d*\.top/.test(hostname);
  } catch {
    return false;
  }
}


function buildProxyUrl(directUrl: string, headers?: Record<string, string>): string {
  // Castle and freecdn CDNs block CF Workers' IPs — route through HF proxy
  if (isCastleCDN(directUrl) || isFreecdnCDN(directUrl)) {
    return buildHFProxyUrl(directUrl, headers);
  }

  // Other CDNs: use local proxy
  const params = new URLSearchParams({ url: directUrl });
  if (headers?.Referer) params.set('referer', headers.Referer);
  if (headers?.Origin) params.set('origin', headers.Origin);
  else if (headers?.Referer) {
    try {
      const origin = new URL(headers.Referer).origin;
      params.set('origin', origin);
    } catch { /* ignore */ }
  }
  return `/api/proxy?${params.toString()}`;
}

/**
 * Build a proxy URL through HuggingFace Space for freecdn CDN URLs.
 *
 * NOTE: This is now only used for the per-source mode where NetMirror streams
 * are directly constructed. In the main flow, the local /api/proxy handles
 * hybrid routing — detecting freecdn*.top URLs in m3u8 playlists and routing
 * them through HF automatically. imgcdn.kim URLs go through local proxy (fast).
 *
 * The HF /proxy endpoint rewrites ALL URLs (m3u8 + segments) to go through itself,
 * so bandwidth flows through HF (free tier, no explicit BW limit).
 */
function buildHFProxyUrl(directUrl: string, headers?: Record<string, string>): string {
  const params = new URLSearchParams({ url: directUrl });
  // For NetMirror CDN, the correct origin/referer is net52.cc
  const netMirrorOrigin = 'https://net52.cc';
  const netMirrorReferer = 'https://net52.cc/';

  if (headers?.Referer) {
    params.set('referer', headers.Referer);
  } else {
    params.set('referer', netMirrorReferer);
  }
  if (headers?.Origin) {
    params.set('origin', headers.Origin);
  } else {
    params.set('origin', netMirrorOrigin);
  }

  return `${HF_PROXY_BASE}/proxy?${params.toString()}`;
}

function detectLanguageFromUrl(url: string, title?: string): string | null {
  const combined = `${url} ${(title || '')}`.toLowerCase();

  if (combined.includes('_hin') || combined.includes('hindi')) return 'Hindi';
  if (combined.includes('_tam') || combined.includes('tamil')) return 'Tamil';
  if (combined.includes('_tel') || combined.includes('telugu')) return 'Telugu';
  if (combined.includes('_kan') || combined.includes('kannada')) return 'Kannada';
  if (combined.includes('_mal') || combined.includes('malayalam')) return 'Malayalam';
  if (combined.includes('_ben') || combined.includes('bengali')) return 'Bengali';
  if (combined.includes('_kor') || combined.includes('korean')) return 'Korean';
  if (combined.includes('_fra') || combined.includes('french') || combined.includes('_vf')) return 'French';
  if (combined.includes('_spa') || combined.includes('spanish')) return 'Spanish';
  if (combined.includes('_ita') || combined.includes('italian')) return 'Italian';
  if (combined.includes('_ger') || combined.includes('german')) return 'German';
  if (combined.includes('_jpn') || combined.includes('japanese')) return 'Japanese';
  if (combined.includes('_chi') || combined.includes('chinese') || combined.includes('_mandarin')) return 'Chinese';
  if (combined.includes('_tha') || combined.includes('thai')) return 'Thai';
  if (combined.includes('_ara') || combined.includes('arabic')) return 'Arabic';
  if (combined.includes('_rus') || combined.includes('russian')) return 'Russian';
  if (combined.includes('_por') || combined.includes('portuguese')) return 'Portuguese';
  if (combined.includes('_eng') || combined.includes('_en_') || combined.includes('english')) return 'English';
  if (combined.includes('multi') || combined.includes('dual')) return 'Multi';

  return null;
}

function detectLanguageFromTitle(title: string, url: string): string {
  const detected = detectLanguageFromUrl(url, title);
  return detected || 'English';
}

function parseQuality(qualityStr: string): string {
  if (!qualityStr) return 'Auto'
  const q = qualityStr.toLowerCase().trim()

  if (q.includes('2160') || q.includes('4k')) return '4K'
  if (q.includes('1080')) return '1080p'
  if (q.includes('720')) return '720p'
  if (q.includes('480')) return '480p'
  if (q.includes('360')) return '360p'

  const resMatch = q.match(/(\d+)x(\d+)/)
  if (resMatch) {
    const height = parseInt(resMatch[2])
    if (height >= 2160) return '4K'
    if (height >= 1080) return '1080p'
    if (height >= 720) return '720p'
    if (height >= 480) return '480p'
    return '360p'
  }

  if (/\d{3,4}p/.test(q)) return q.match(/(\d{3,4}p)/)?.[1] || 'Auto'
  if (q === 'auto') return 'Auto'
  if (['english', 'hindi', 'tamil', 'telugu', 'french', 'korean', 'multi'].includes(q)) return 'Auto'

  return 'Auto'
}

// ─── Per-source fetch functions (for existing EmbedPlayer) ────────────────────

function detectLanguagesFromM3u8(m3u8Content: string): string[] {
  const langs: string[] = [];
  const lines = m3u8Content.split('\n');

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      const langMatch = line.match(/LANGUAGE="([^"]+)"/);
      if (langMatch && langMatch[1]) {
        langs.push(langMatch[1]);
      }
    }
  }

  return langs;
}

function langNameToCode(name: string): string {
  const map: Record<string, string> = {
    Hindi: 'hi', Tamil: 'ta', Telugu: 'te', Kannada: 'kn', Malayalam: 'ml',
    Bengali: 'bn', Korean: 'ko', French: 'fr', Spanish: 'es', Italian: 'it',
    German: 'de', Japanese: 'ja', Chinese: 'zh', Thai: 'th', Arabic: 'ar',
    Russian: 'ru', Portuguese: 'pt', English: 'en', Multi: 'multi',
  };
  return map[name] || name.toLowerCase();
}

function getFlagForLangCode(lang: string): string {
  const map: Record<string, string> = {
    en: '🇺🇸', hi: '🇮🇳', ta: '🇮🇳', te: '🇮🇳', kn: '🇮🇳', ml: '🇮🇳',
    ko: '🇰🇷', fr: '🇫🇷', es: '🇪🇸', it: '🇮🇹', de: '🇩🇪', ja: '🇯🇵',
    zh: '🇨🇳', th: '🇹🇭', ar: '🇸🇦', ru: '🇷🇺', pt: '🇧🇷', bn: '🇧🇩',
    multi: '🌍',
  };
  return map[lang] || '🌍';
}

function detectLanguageFromLabel(label: string): string {
  const l = label.toLowerCase().replace(/\d+$/, '').trim();
  const map: Record<string, string> = {
    arabic: 'ar', bulgarian: 'bg', croatian: 'hr', czech: 'cs',
    danish: 'da', german: 'de', greek: 'el', english: 'en',
    spanish: 'es', finnish: 'fi', french: 'fr', hebrew: 'he',
    hungarian: 'hu', indonesian: 'id', italian: 'it', japanese: 'ja',
    korean: 'ko', norwegian: 'nb', dutch: 'nl', polish: 'pl',
    portuguese: 'pt', romanian: 'ro', russian: 'ru', swedish: 'sv',
    thai: 'th', turkish: 'tr', vietnamese: 'vi', chinese: 'zh',
    hindi: 'hi', tamil: 'ta', telugu: 'te', kannada: 'kn',
    malayalam: 'ml', bengali: 'bn', ukrainian: 'uk', urdu: 'ur',
  };
  return map[l] || l.substring(0, 2).toLowerCase();
}

async function fetchMissouriMonster(
  sourceKey: string,
  tmdbId: string,
  type: string,
  season?: string,
  episode?: string
): Promise<StreamResult> {
  const startTime = Date.now();
  let url: string;

  if (type === 'tv' && season && episode) {
    url = `${MM_BASE}/api/test/${tmdbId}?season=${season}&episode=${episode}&source=${sourceKey}`;
  } else {
    url = `${MM_BASE}/api/test/${tmdbId}?source=${sourceKey}`;
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    const elapsedMs = Date.now() - startTime;

    if (data.ok && data.url) {
      let audioTracks: AudioTrack[] = [];
      let qualities: QualityLevel[] = [];
      let subtitles: StreamResult['subtitles'] = [];

      try {
        const m3u8Response = await fetch(data.url, { signal: AbortSignal.timeout(10000) });
        if (m3u8Response.ok) {
          const m3u8Content = await m3u8Response.text();
          if (m3u8Content.includes('#EXTM3U')) {
            const parsed = parseM3U8(m3u8Content, data.url);
            audioTracks = parsed.audioTracks;
            qualities = parsed.qualities;
          }
        }
      } catch {
        // m3u8 fetch failed, continue without track info
      }

      if (audioTracks.length === 0) {
        audioTracks = [{ language: 'en', name: 'English', default: true, uri: null, flagEmoji: '🇺🇸' }];
      }

      // Fetch subtitles from MissouriMonster combined API
      try {
        let subUrl: string;
        if (type === 'tv' && season && episode) {
          subUrl = `${MM_BASE}/api/tv?id=${encodeURIComponent(tmdbId)}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`;
        } else {
          subUrl = `${MM_BASE}/api/movie?id=${encodeURIComponent(tmdbId)}`;
        }
        const subResponse = await fetch(subUrl, { signal: AbortSignal.timeout(8000) });
        if (subResponse.ok) {
          const subData = await subResponse.json();
          const rawSubs: StreamSubtitle[] = subData.subtitles || [];
          subtitles = rawSubs
            .filter((s: StreamSubtitle) => s.file && (s.type === 'vtt' || s.type === 'srt'))
            .map((s: StreamSubtitle) => {
              const langCode = s.language || detectLanguageFromLabel(s.label);
              return {
                label: s.label,
                url: s.file,
                type: (s.type === 'srt' ? 'srt' : 'vtt') as 'vtt' | 'srt' | 'ass',
                language: langCode,
                flagEmoji: getFlagForLangCode(langCode),
              };
            });
        }
      } catch {
        // subtitle fetch failed, continue without
      }

      return {
        sourceId: `mm-${sourceKey}`,
        sourceName: data.source || sourceKey,
        success: true,
        url: data.url,
        rawUrl: data.raw_url,
        audioTracks,
        qualities,
        languageFlags: generateFlagsFromLangs(audioTracks.map(t => t.language)),
        elapsedMs,
        error: null,
        needsProxy: false,
        subtitles: subtitles && subtitles.length > 0 ? subtitles : undefined,
      };
    }

    return {
      sourceId: `mm-${sourceKey}`,
      sourceName: sourceKey,
      success: false,
      url: null,
      rawUrl: null,
      audioTracks: [],
      qualities: [],
      languageFlags: '',
      elapsedMs,
      error: data.error || 'No stream found',
      needsProxy: false,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    return {
      sourceId: `mm-${sourceKey}`,
      sourceName: sourceKey,
      success: false,
      url: null,
      rawUrl: null,
      audioTracks: [],
      qualities: [],
      languageFlags: '',
      elapsedMs,
      error: err instanceof Error ? err.message : 'Fetch failed',
      needsProxy: false,
    };
  }
}

async function fetchStreamForge(
  sourceKey: string,
  tmdbId: string,
  type: string,
  season?: string,
  episode?: string
): Promise<StreamResult> {
  const startTime = Date.now();
  let url: string;

  if (type === 'tv' && season && episode) {
    url = `${SF_BASE}/tv/${tmdbId}/${season}/${episode}/${sourceKey}`;
  } else {
    url = `${SF_BASE}/movie/${tmdbId}/${sourceKey}`;
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    const elapsedMs = Date.now() - startTime;

    if (data.success && data.results && data.results.length > 0) {
      const m3u8Results = data.results.filter(
        (r: { type: string }) => r.type === 'm3u8' || r.type === 'direct'
      );
      if (m3u8Results.length === 0) {
        return {
          sourceId: `sf-${sourceKey}`,
          sourceName: sourceKey,
          success: false,
          url: null,
          rawUrl: null,
          audioTracks: [],
          qualities: [],
          languageFlags: '',
          elapsedMs,
          error: 'No m3u8 streams found',
          needsProxy: true,
        };
      }

      let filteredResults = m3u8Results;
      if (sourceKey === 'vidnest') {
        const multiOnly = m3u8Results.filter(
          (r: { language?: string }) => (r.language || '').toLowerCase() === 'multi'
        );
        if (multiOnly.length > 0) {
          filteredResults = multiOnly;
        }
      }

      // NetMirror: multiple results (Netflix/PV/HS) are different services for same content.
      // Parse ALL m3u8s and combine audio tracks into one deduplicated language list.
      const isNetMirror = sourceKey === 'netmirror';

      const multiStream = filteredResults.find(
        (r: { language?: string }) => (r.language || '').toLowerCase() === 'multi'
      );
      const englishStream = filteredResults.find((r: { url?: string; language?: string }) => {
        const urlStr = (r.url || '').toLowerCase();
        const lang = (r.language || '').toLowerCase();
        const detectedLang = detectLanguageFromUrl(r.url || '', r.title);
        return lang === 'english' || urlStr.includes('_eng_') || urlStr.includes('_eng.') || detectedLang === 'English';
      });
      const primary = multiStream || englishStream || filteredResults[0];
      const primaryUrl = primary.url;

      const headers: Record<string, string> = {};
      if (primary.headers) {
        Object.assign(headers, primary.headers);
      }

      let audioTracks: AudioTrack[] = [];
      let qualities: QualityLevel[] = [];
      let multiStreams: Array<{
        title: string;
        quality: string;
        language: string;
        url: string;
        type: string;
        audioTrackIndex?: number;
        audioTracks: AudioTrack[];
      }> | undefined;

      if (isNetMirror) {
        // ── NetMirror: Parse ALL m3u8s (Netflix/PV/HS) and combine languages ──
        // Each service may have a different set of audio tracks. We parse all of them
        // and merge into one deduplicated list: e.g. Netflix has EN/FR/ES/DE,
        // PrimeVideo has HI/EN/TA/ML → combined: EN,FR,ES,DE,HI,TA,ML
        const combinedTracks = new Map<string, {
          track: AudioTrack;
          m3u8Url: string;
          m3u8Headers: Record<string, string>;
        }>();

        const parsePromises = filteredResults.map(async (
          r: { title?: string; url?: string; language?: string; quality?: string; type?: string; headers?: Record<string, string> }
        ) => {
          const resultUrl = r.url || '';
          const resultHeaders: Record<string, string> = {};
          if (r.headers) Object.assign(resultHeaders, r.headers);

          try {
            const fetchHeaders: Record<string, string> = {};
            if (resultHeaders.Referer) fetchHeaders['Referer'] = resultHeaders.Referer;
            if (resultHeaders['User-Agent']) fetchHeaders['User-Agent'] = resultHeaders['User-Agent'];

            const m3u8Response = await fetch(resultUrl, {
              headers: Object.keys(fetchHeaders).length > 0 ? fetchHeaders : undefined,
              signal: AbortSignal.timeout(10000),
            });
            if (m3u8Response.ok) {
              const m3u8Content = await m3u8Response.text();
              if (m3u8Content.includes('#EXTM3U')) {
                const parsed = parseM3U8(m3u8Content, resultUrl);
                return { parsed, m3u8Url: resultUrl, m3u8Headers: resultHeaders };
              }
            }
          } catch {
            // m3u8 fetch failed for this service, skip
          }
          return null;
        });

        const parseResults = await Promise.allSettled(parsePromises);

        for (const settled of parseResults) {
          if (settled.status === 'fulfilled' && settled.value) {
            const { parsed, m3u8Url, m3u8Headers } = settled.value;
            // Collect qualities from first successful parse
            if (qualities.length === 0) qualities = parsed.qualities;
            // Add unique audio tracks (deduplicated by language code)
            for (const track of parsed.audioTracks) {
              const key = track.language.toLowerCase();
              if (!combinedTracks.has(key)) {
                combinedTracks.set(key, { track, m3u8Url, m3u8Headers });
              }
            }
          }
        }

        audioTracks = Array.from(combinedTracks.values()).map(v => v.track);

        // Build multiStreams from combined deduplicated tracks
        if (combinedTracks.size > 1) {
          multiStreams = Array.from(combinedTracks.entries()).map(
            ([_langKey, { track, m3u8Url, m3u8Headers }]) => ({
              title: track.name,
              quality: primary.quality || 'Auto',
              language: track.name,
              url: buildHFProxyUrl(m3u8Url, m3u8Headers),
              type: primary.type || 'm3u8',
              audioTrackIndex: undefined,
              audioTracks: [track],
            })
          );
        }
      } else {
        // ── Non-NetMirror: Parse only primary m3u8 ──
        try {
          const fetchHeaders: Record<string, string> = {};
          if (headers.Referer) fetchHeaders['Referer'] = headers.Referer;
          if (headers['User-Agent']) fetchHeaders['User-Agent'] = headers['User-Agent'];

          const m3u8Response = await fetch(primaryUrl, {
            headers: Object.keys(fetchHeaders).length > 0 ? fetchHeaders : undefined,
            signal: AbortSignal.timeout(10000),
          });
          if (m3u8Response.ok) {
            const m3u8Content = await m3u8Response.text();
            if (m3u8Content.includes('#EXTM3U')) {
              const parsed = parseM3U8(m3u8Content, primaryUrl);
              audioTracks = parsed.audioTracks;
              qualities = parsed.qualities;
            }
          }
        } catch {
          // m3u8 fetch failed, continue without track info
        }

        // Build multiStreams from API results
        let apiMultiStreams = filteredResults.map(
          (r: { title?: string; url?: string; language?: string; quality?: string; type?: string }) => {
            const streamUrl = r.url || '';
            const detectedLang = detectLanguageFromUrl(streamUrl, r.title);
            const languageName = detectedLang || r.language || 'Unknown';
            const langCode = langNameToCode(languageName);

            return {
              title: r.title || '',
              quality: r.quality || 'Auto',
              language: languageName,
              url: streamUrl,
              type: r.type || 'm3u8',
              audioTrackIndex: undefined as number | undefined,
              audioTracks: [{
                language: langCode,
                name: languageName,
                default: langCode === 'en',
                uri: null,
                flagEmoji: getFlagForLangCode(langCode),
              }] as AudioTrack[],
            };
          }
        );

        // Single result with multiple audio tracks: expand by m3u8 audio tracks
        if (filteredResults.length === 1 && audioTracks.length > 1) {
          const singleStream = filteredResults[0];
          const proxyedUrl = buildProxyUrl(singleStream.url, headers);
          apiMultiStreams = audioTracks.map((track, idx) => ({
            title: track.name,
            quality: singleStream.quality || 'Auto',
            language: track.name,
            url: proxyedUrl,
            type: singleStream.type || 'm3u8',
            audioTrackIndex: idx,
            audioTracks: [track],
          }));
        }

        // Multiple API results: combine deduplicated languages
        if (apiMultiStreams.length > 1 && filteredResults.length > 1) {
          const allLangs = new Map<string, AudioTrack>();
          for (const stream of apiMultiStreams) {
            const track = stream.audioTracks[0];
            if (track && !allLangs.has(track.language.toLowerCase())) {
              allLangs.set(track.language.toLowerCase(), track);
            }
          }
          if (allLangs.size > 1) {
            audioTracks = Array.from(allLangs.values());
          }
        }

        if (apiMultiStreams.length > 1) {
          multiStreams = apiMultiStreams;
        }
      }

      // Fallback: ensure at least one audio track
      if (audioTracks.length === 0) {
        const detectedLang = detectLanguageFromUrl(primaryUrl, primary.title);
        if (detectedLang) {
          const langCode = langNameToCode(detectedLang);
          audioTracks = [{
            language: langCode,
            name: detectedLang,
            default: true,
            uri: null,
            flagEmoji: getFlagForLangCode(langCode),
          }];
        } else if (primary.language) {
          const lang = primary.language;
          audioTracks = [{
            language: lang.toLowerCase(),
            name: lang,
            default: true,
            uri: null,
            flagEmoji: lang === 'Multi' ? '🌍' : getFlagForLangCode(lang.toLowerCase()),
          }];
        } else {
          audioTracks = [{ language: 'en', name: 'English', default: true, uri: null, flagEmoji: '🇺🇸' }];
        }
      }

      // NetMirror: use local /api/proxy (it auto-routes freecdn*.top through HF)
      // The local proxy detects freecdn URLs in m3u8 and routes them through HF proxy,
      // while imgcdn.kim URLs go through local proxy (fast). Best of both worlds.
      // Other sources: also use local /api/proxy
      const playableUrl = buildProxyUrl(primaryUrl, headers);

      if (multiStreams && multiStreams.length > 1) {
        for (const stream of multiStreams) {
          // All streams use local /api/proxy — it auto-routes freecdn through HF
          // NetMirror multiStreams built with buildHFProxyUrl above need to switch
          if (isNetMirror) {
            // Replace HF proxy URLs with local proxy URLs for the main entry
            // The local proxy will detect freecdn URLs and route them through HF
            if (stream.url.startsWith(HF_PROXY_BASE)) {
              // Extract the original URL from the HF proxy URL
              const hfUrlMatch = stream.url.match(/[?&]url=([^&]+)/);
              if (hfUrlMatch) {
                const originalUrl = decodeURIComponent(hfUrlMatch[1]);
                stream.url = buildProxyUrl(originalUrl, headers);
              }
            } else if (!stream.url.startsWith('/api/proxy')) {
              stream.url = buildProxyUrl(stream.url, headers);
            }
          } else {
            if (!stream.url.startsWith('/api/proxy')) {
              stream.url = buildProxyUrl(stream.url, headers);
            }
          }
        }
      }

      return {
        sourceId: `sf-${sourceKey}`,
        sourceName: sourceKey,
        success: true,
        url: playableUrl,
        rawUrl: primaryUrl,
        audioTracks,
        qualities,
        languageFlags: generateFlagsFromLangs(audioTracks.map(t => t.language)),
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        elapsedMs,
        error: null,
        needsProxy: true,
        multiStreams: multiStreams && multiStreams.length > 1 ? multiStreams : undefined,
      };
    }

    return {
      sourceId: `sf-${sourceKey}`,
      sourceName: sourceKey,
      success: false,
      url: null,
      rawUrl: null,
      audioTracks: [],
      qualities: [],
      languageFlags: '',
      elapsedMs,
      error: data.errors ? data.errors.join(', ') : 'No streams found',
      needsProxy: true,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    return {
      sourceId: `sf-${sourceKey}`,
      sourceName: sourceKey,
      success: false,
      url: null,
      rawUrl: null,
      audioTracks: [],
      qualities: [],
      languageFlags: '',
      elapsedMs,
      error: err instanceof Error ? err.message : 'Fetch failed',
      needsProxy: true,
    };
  }
}

// ─── Combined mode: Fetch all sources from both APIs ──────────────────────────

async function fetchMissourimonsterCombined(type: string, tmdbId: string, season: string, episode: string, externalSignal?: AbortSignal): Promise<StreamData | null> {
  try {
    let url: string
    if (type === 'tv') {
      url = `${MM_BASE}/api/tv?id=${encodeURIComponent(tmdbId)}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`
    } else {
      url = `${MM_BASE}/api/movie?id=${encodeURIComponent(tmdbId)}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)
    // Also abort if the external signal (from fetchWithTimeout) fires
    if (externalSignal) {
      if (externalSignal.aborted) { controller.abort() }
      else { externalSignal.addEventListener('abort', () => controller.abort(), { once: true }) }
    }

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'FireFlix/2.0',
      },
      cache: 'no-store',
    })

    clearTimeout(timeout)
    if (!response.ok) return null

    const data = await response.json()
    return data
  } catch (error) {
    console.error('[Stream API] missourimonster combined error:', error)
    return null
  }
}

async function fetchStreamForgeCombined(type: string, tmdbId: string, season: string, episode: string, externalSignal?: AbortSignal): Promise<StreamData | null> {
  try {
    let url: string
    if (type === 'tv') {
      url = `${SF_BASE}/tv/${encodeURIComponent(tmdbId)}/${encodeURIComponent(season)}/${encodeURIComponent(episode)}`
    } else {
      url = `${SF_BASE}/movie/${encodeURIComponent(tmdbId)}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    // Also abort if the external signal (from fetchWithTimeout) fires
    if (externalSignal) {
      if (externalSignal.aborted) { controller.abort() }
      else { externalSignal.addEventListener('abort', () => controller.abort(), { once: true }) }
    }

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'FireFlix/2.0',
      },
    })

    clearTimeout(timeout)
    if (!response.ok) return null

    const data = await response.json()
    if (!data.success || !data.results) return null

    // Convert StreamForge format to unified format
    const sources: StreamSource[] = data.results.map((r: any) => {
      if (r.type && r.type !== 'm3u8') return null

      const sourceBase = r.source?.split('/')[0].toLowerCase() || 'unknown'
      const sourceSub = r.source?.split('/')[1]?.toLowerCase() || ''
      const sourceId = sourceSub && sourceSub !== sourceBase
        ? `${sourceBase}_${sourceSub}`
        : sourceBase

      let language = r.language || detectLanguageFromTitle(r.title || '', r.url || '')

      if (sourceBase === 'castle') {
        language = detectLanguageFromTitle(r.title || '', r.url || '')
      }

      const quality = parseQuality(r.quality || r.title || '')

      // Build proxy URL for StreamForge sources
      // ALL sources use local /api/proxy — it auto-routes freecdn*.top through HF
      // imgcdn.kim (fast) stays local, freecdn*.top goes through HF
      const headers: Record<string, string> = {}
      if (r.headers) Object.assign(headers, r.headers)
      const playableUrl = buildProxyUrl(r.url, headers)

      return {
        source: sourceId,
        label: r.source || sourceBase,
        url: playableUrl,
        language,
        quality,
      }
    }).filter((s: any) => s !== null)

    return {
      sources,
      subtitles: [],
    }
  } catch (error) {
    console.error('[Stream API] StreamForge combined error:', error)
    return null
  }
}

function buildCachedResponse(data: any, cacheStatus: string, age: string): NextResponse {
  return NextResponse.json(data, {
    headers: {
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=3600',
      'X-Cache': cacheStatus,
      'X-Cache-Age': age,
      'Vary': 'Accept-Encoding',
    },
  })
}

function buildNoCacheResponse(data: any, status: number): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Cache': 'MISS',
    },
  })
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
  return await _GET(request)
  } catch (err) {
    console.error('[Stream API] Unhandled error in GET handler:', err)
    return NextResponse.json(
      { error: 'Streams are loading. Please try again in a moment.', sources: [], subtitles: [] },
      { status: 504, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}

async function _GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const nocache = searchParams.get('nocache') === '1'

  // ─── Mode 1: Per-source fetch (existing EmbedPlayer mode) ────────────────
  const sourceId = searchParams.get('sourceId')
  const tmdbIdParam = searchParams.get('tmdbId')

  if (sourceId && tmdbIdParam) {
    const type = searchParams.get('type') || 'movie'
    const season = searchParams.get('season') || '1'
    const episode = searchParams.get('episode') || '1'

    const sourceConfig = getSourceById(sourceId)
    if (!sourceConfig) {
      return NextResponse.json(
        { error: `Unknown source: ${sourceId}` },
        { status: 400 }
      )
    }

    const sourceCacheKey = `src:${sourceId}:${type}:${tmdbIdParam}:${season}:${episode}`

    // Check cache: Cache API → memory → Fetch (unless nocache=1)
    if (!nocache) {
      const cached = await cacheGet(sourceCacheKey)
      if (cached) {
        const result = JSON.parse(cached.data) as StreamResult
        if (result.success) {
          console.log(`[Stream API] Per-source ${cached.layer} HIT: ${sourceCacheKey} (age: ${cached.age}s)`)
          // Stale-while-revalidate: if >2 days old, refresh in background (still serve cached)
          if (cached.age > CACHE_TTL) {
            refreshSourceInBackground(sourceConfig, tmdbIdParam, type, season, episode, sourceCacheKey)
          }
          return buildCachedResponse(result, `HIT-${cached.layer}`, cached.age.toString())
        }
      }
    }

    // Cache miss or nocache — fetch fresh
    console.log(`[Stream API] Per-source ${nocache ? 'NOCACHE' : 'MISS'}: ${sourceCacheKey}`)
    let result: StreamResult

    if (sourceConfig.apiOrigin === 'missourimonster') {
      result = await fetchMissouriMonster(sourceConfig.apiSourceKey, tmdbIdParam, type, season, episode)
    } else {
      result = await fetchStreamForge(sourceConfig.apiSourceKey, tmdbIdParam, type, season, episode)
    }

    // Cache successful results (Cache API — unlimited, free!)
    if (result.success) {
      await cachePut(sourceCacheKey, JSON.stringify(result))
      console.log(`[Stream API] Cached per-source: ${sourceCacheKey}`)
    }

    return NextResponse.json(result, {
      headers: { 'X-Cache': nocache ? 'NOCACHE' : 'MISS' },
    })
  }

  // ─── Mode 2: Combined fetch (embed mode) ─────────────────────────────────
  const id = searchParams.get('id')
  const type = searchParams.get('type')

  if (!id || !type) {
    return buildNoCacheResponse(
      { error: 'Provide sourceId+tmdbId (per-source) or id+type (combined)', sources: [], subtitles: [] },
      400
    )
  }

  const season = searchParams.get('season') || '1'
  const episode = searchParams.get('episode') || '1'
  const cacheKey = `cmb:${type}:${id}:${season}:${episode}`

  // Check cache: Cache API → memory → Fetch (unless nocache=1)
  if (!nocache) {
    const cached = await cacheGet(cacheKey)
    if (cached) {
      const cachedData = JSON.parse(cached.data) as StreamData
      if (cachedData.sources && cachedData.sources.length > 0) {
        console.log(`[Stream API] Combined ${cached.layer} HIT: ${cacheKey} (age: ${cached.age}s)`)
        // Stale-while-revalidate: if >2 days old, refresh in background (still serve cached)
        if (cached.age > CACHE_TTL) {
          refreshCombinedInBackground(type, id, season, episode, cacheKey)
        }
        return buildCachedResponse(cachedData, `HIT-${cached.layer}`, cached.age.toString())
      }
    }
  }

  // Cache miss or nocache — fetch from BOTH APIs in parallel
  console.log(`[Stream API] Combined ${nocache ? 'NOCACHE' : 'MISS'}: ${cacheKey} — fetching from both APIs`)

  // AbortController-based timeout: actually cancels the fetch when timer fires
  // so background requests don't keep consuming Worker resources.
  const fetchWithTimeout = async <T>(
    fetchFn: (signal: AbortSignal) => Promise<T | null>,
    ms: number,
    label: string
  ): Promise<T | null> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      console.log(`[Stream API] ${label} timed out after ${ms}ms — aborting fetch`)
      controller.abort()
    }, ms)
    try {
      const result = await fetchFn(controller.signal)
      clearTimeout(timer)
      return result
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.log(`[Stream API] ${label} fetch aborted after ${ms}ms timeout`)
        return null
      }
      console.error(`[Stream API] ${label} fetch error:`, err)
      return null
    }
  }

  // Warm-up ping: send a quick HEAD request to both HF Spaces to wake them
  // from cold starts. We don't block on the result — this helps the NEXT request
  // succeed faster.
  const warmUpPing = (url: string, label: string) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    fetch(url, { method: 'HEAD', signal: controller.signal, cache: 'no-store' })
      .then(() => clearTimeout(timer))
      .catch(() => { clearTimeout(timer) })
    console.log(`[Stream API] Warm-up ping sent to ${label}`)
  }
  warmUpPing(MM_BASE, 'missourimonster')
  warmUpPing(SF_BASE, 'StreamForge')

  const [mmData, sfData] = await Promise.all([
    fetchWithTimeout((signal) => fetchMissourimonsterCombined(type, id, season, episode, signal), 12000, 'missourimonster'),
    fetchWithTimeout((signal) => fetchStreamForgeCombined(type, id, season, episode, signal), 15000, 'StreamForge'),
  ])

  // Merge sources — StreamForge FIRST, then missourimonster
  const mmSources: StreamSource[] = (mmData?.sources || []).map((s: StreamSource) => ({
    ...s,
    language: s.language || undefined,
    quality: s.quality || undefined,
  }))

  const sfSources: StreamSource[] = sfData?.sources || []
  const subtitles: StreamSubtitle[] = [
    ...(mmData?.subtitles || []),
    ...(sfData?.subtitles || []),
  ]

  // Deduplicate subtitles
  const seenSubs = new Set<string>()
  const dedupedSubs = subtitles.filter(sub => {
    const key = sub.label.toLowerCase().replace(/\d+/g, '').trim()
    if (seenSubs.has(key)) return false
    seenSubs.add(key)
    return true
  })

  // Merge: StreamForge first, then missourimonster — deduplicate by URL
  const seenUrls = new Set<string>()
  const allSources: StreamSource[] = []

  for (const s of sfSources) {
    const urlKey = s.url.toLowerCase().trim()
    if (!seenUrls.has(urlKey)) {
      seenUrls.add(urlKey)
      allSources.push(s)
    }
  }

  for (const s of mmSources) {
    const urlKey = s.url.toLowerCase().trim()
    if (!seenUrls.has(urlKey)) {
      seenUrls.add(urlKey)
      allSources.push(s)
    }
  }

  console.log(`[Stream API] Merged: ${sfSources.length} StreamForge + ${mmSources.length} missourimonster = ${allSources.length} total`)

  if (allSources.length === 0) {
    return buildNoCacheResponse(
      { error: 'Streams are loading. Please try again in a moment.', sources: [], subtitles: [] },
      504
    )
  }

  const mergedData: StreamData = {
    sources: allSources,
    subtitles: dedupedSubs,
  }

  // Save to Cache API (unlimited, free!)
  await cachePut(cacheKey, JSON.stringify(mergedData))
  console.log(`[Stream API] Cached combined: ${cacheKey} (${allSources.length} sources)`)

  return buildCachedResponse(mergedData, nocache ? 'NOCACHE' : 'MISS', '0')
} // end _GET

// ─── Background Refresh Functions ───────────────────────────────────────────
// These fire-and-forget functions refresh stale cache entries in the background
// without blocking the response. The user gets the cached data instantly.
// Background refresh writes to Cache API only (free, unlimited, no quotas!).

function refreshCombinedInBackground(type: string, id: string, season: string, episode: string, cacheKey: string) {
  // Fire and forget — don't await
  ;(async () => {
    try {
      console.log(`[Stream API] Background refresh: ${cacheKey}`)
      const [mmData, sfData] = await Promise.all([
        fetchMissourimonsterCombined(type, id, season, episode),
        fetchStreamForgeCombined(type, id, season, episode),
      ])

      const mmSources: StreamSource[] = (mmData?.sources || []).map((s: StreamSource) => ({
        ...s, language: s.language || undefined, quality: s.quality || undefined,
      }))
      const sfSources: StreamSource[] = sfData?.sources || []
      const subtitles: StreamSubtitle[] = [...(mmData?.subtitles || []), ...(sfData?.subtitles || [])]

      const seenSubs = new Set<string>()
      const dedupedSubs = subtitles.filter(sub => {
        const key = sub.label.toLowerCase().replace(/\d+/g, '').trim()
        if (seenSubs.has(key)) return false
        seenSubs.add(key)
        return true
      })

      const seenUrls = new Set<string>()
      const allSources: StreamSource[] = []
      for (const s of sfSources) {
        const urlKey = s.url.toLowerCase().trim()
        if (!seenUrls.has(urlKey)) { seenUrls.add(urlKey); allSources.push(s) }
      }
      for (const s of mmSources) {
        const urlKey = s.url.toLowerCase().trim()
        if (!seenUrls.has(urlKey)) { seenUrls.add(urlKey); allSources.push(s) }
      }

      if (allSources.length > 0) {
        const mergedData: StreamData = { sources: allSources, subtitles: dedupedSubs }
        await cacheApiPut(cacheKey, JSON.stringify(mergedData))
        console.log(`[Stream API] Background refresh done: ${cacheKey} (${allSources.length} sources)`)
      }
    } catch (e) {
      console.warn(`[Stream API] Background refresh failed: ${cacheKey}`, e)
    }
  })()
}

function refreshSourceInBackground(sourceConfig: any, tmdbId: string, type: string, season: string, episode: string, cacheKey: string) {
  ;(async () => {
    try {
      console.log(`[Stream API] Background refresh per-source: ${cacheKey}`)
      let result: StreamResult
      if (sourceConfig.apiOrigin === 'missourimonster') {
        result = await fetchMissouriMonster(sourceConfig.apiSourceKey, tmdbId, type, season, episode)
      } else {
        result = await fetchStreamForge(sourceConfig.apiSourceKey, tmdbId, type, season, episode)
      }
      if (result.success) {
        // Write to Cache API (unlimited, free — no quotas to worry about!)
        await cacheApiPut(cacheKey, JSON.stringify(result))
        console.log(`[Stream API] Background refresh done per-source: ${cacheKey}`)
      }
    } catch (e) {
      console.warn(`[Stream API] Background refresh failed per-source: ${cacheKey}`, e)
    }
  })()
}
