import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';

// ─── Cache API for m3u8 proxy responses (FREE, unlimited) ─────────────────────
// Caches m3u8 master playlists for 2 days — they're stable that long.
// .ts segments get cached for 6 hours. Variant playlists are NOT cached
// (they change every few seconds as new segments are added).
// If a cached m3u8 points to expired segments, the player auto-retries.

const M3U8_CACHE_TTL = 2 * 24 * 60 * 60;  // 2 days for master m3u8
const SEGMENT_CACHE_TTL = 6 * 60 * 60;    // 6 hours for .ts/.m4s segments

function getEdgeCache(): Cache | null {
  try {
    // @ts-expect-error — caches global available in CF Workers/Pages Functions
    if (typeof caches !== 'undefined' && caches.default) return caches.default;
  } catch { /* ignore */ }
  return null;
}

function makeCacheKey(url: string): Request {
  return new Request(`https://proxy-cache.fireflixplayer.internal/${url}`);
}

async function getCachedProxy(url: string): Promise<{ response: Response; age: number } | null> {
  const cache = getEdgeCache();
  if (!cache) return null;
  try {
    const cached = await cache.match(makeCacheKey(url));
    if (!cached) return null;
    const ts = cached.headers.get('X-Cache-Timestamp');
    if (!ts) return null;
    const age = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
    return { response: cached, age };
  } catch {
    return null;
  }
}

async function setCachedProxy(url: string, body: string, contentType: string, ttlSeconds: number): Promise<void> {
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    const resp = new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'X-Cache-Timestamp': Math.floor(Date.now() / 1000).toString(),
        'Cache-Control': `public, max-age=${ttlSeconds}`,
      },
    });
    await cache.put(makeCacheKey(url), resp);
  } catch {
    // Cache write failed — non-critical
  }
}

// ─── Hybrid proxy for Cloudflare Pages deployment ────────────────────────────
//
// ROUTING STRATEGY (adapted for CF Pages where Workers' IPs are blocked):
//
// 1. freecdn*.top CDNs → HF proxy (bypasses Origin-header hotlink protection)
// 2. Castle CDNs (rotating domains, path: /myhls_mps/) → HF proxy
//    (CF Workers' IP range is blocked by these CDNs, so we route through HF)
// 3. subscdn.top (subtitles) → local proxy (CORS blocked, but no Origin check)
// 4. Other CDNs → local proxy (with HEAD test to check if direct access works)

const HF_PROXY_BASE = 'https://epiccodergg-fireflix-api.hf.space';

/** Check if a URL points to a freecdn CDN */
function isFreecdnCDN(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /freecdn\d*\.top/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Check if a URL points to a Castle CDN.
 * Castle uses rotating CDN domains (img1.mlnou.com, img1.hcovw.com, img1.toxcw.com,
 * img1.fdwoc.com, imgcdn.kim, etc.) but always has the path pattern /myhls_mps/.
 * We detect by both known domains AND path pattern.
 */
function isCastleCDN(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const path = urlObj.pathname.toLowerCase();

    // Known Castle CDN domains
    const castleDomains = [
      'imgcdn.kim', 'mlnou.com', 'hcovw.com', 'toxcw.com', 'fdwoc.com',
    ];
    const isKnownDomain = castleDomains.some(d =>
      hostname === d || hostname.endsWith('.' + d)
    );

    // Path pattern: Castle always uses /myhls_mps/ in the URL path
    const isCastlePath = path.includes('/myhls_mps/') || path.includes('/hls_mps/');

    return isKnownDomain || isCastlePath;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return NextResponse.json({ error: 'url parameter is required' }, { status: 400 });
  }

  try {
    // Extract referer/origin early (needed for both cache check and fetch)
    const referer = searchParams.get('referer');
    const origin = searchParams.get('origin');

    // ─── Check Cache API for m3u8 and segment requests ────────────────
    // Master m3u8 and .ts segments can be safely cached.
    // Variant playlists (.m3u8 with #EXTINF) change too often — don't cache.
    const isMasterM3U8 = isM3U8Content(targetUrl, '');
    const isSegment = targetUrl.includes('.ts') || targetUrl.includes('.m4s');

    if (isMasterM3U8 || isSegment) {
      const cached = await getCachedProxy(targetUrl);
      if (cached) {
        const maxAge = isMasterM3U8 ? M3U8_CACHE_TTL : SEGMENT_CACHE_TTL;
        console.log(`[Proxy] Cache HIT: ${isMasterM3U8 ? 'm3u8' : 'segment'} (age: ${cached.age}s, maxAge: ${maxAge}s)`);
        // Serve cached instantly — if stale, refresh in background
        if (cached.age > maxAge) {
          refreshProxyInBackground(targetUrl, referer, origin, isMasterM3U8);
        }
        const respHeaders = new Headers(cached.response.headers);
        respHeaders.delete('X-Cache-Timestamp');
        respHeaders.set('X-Cache', 'HIT');
        return new Response(cached.response.body, { status: 200, headers: respHeaders });
      }
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (referer) headers['Referer'] = referer;
    if (origin) headers['Origin'] = origin;

    const response = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Upstream returned ${response.status}` },
        { status: response.status }
      );
    }

    const contentType = response.headers.get('content-type') || '';
    const isPlaylist = isM3U8Content(targetUrl, contentType);

    if (isPlaylist) {
      const body = await response.text();

      // Cache master m3u8 for 2 days (variant playlists are not cached above)
      // Only cache if it looks like valid m3u8
      if (body.includes('#EXTM3U') || body.includes('#EXT-X-STREAM-INF')) {
        setCachedProxy(targetUrl, body, 'application/vnd.apple.mpegurl', M3U8_CACHE_TTL);
      }

      const rewrittenBody = await rewriteM3U8(body, targetUrl, searchParams);

      return new NextResponse(rewrittenBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          'X-Cache': 'MISS',
        },
      });
    } else if (isSubtitleContent(targetUrl, contentType)) {
      const body = await response.text();
      // Cache subtitles for 2 days
      setCachedProxy(targetUrl, body, 'text/vtt', M3U8_CACHE_TTL);
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/vtt',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    } else {
      let responseContentType = contentType || 'application/octet-stream';
      if (targetUrl.includes('.ts') || targetUrl.includes('.m4s') || targetUrl.includes('.jpg')) {
        responseContentType = 'video/mp2t';
      } else if (targetUrl.includes('.mp4') && !targetUrl.includes('.m3u8')) {
        responseContentType = 'video/mp4';
      }

      // Cache .ts/.m4s segments for 6 hours (these rarely change)
      if (isSegment) {
        // For segments, we need to cache the raw binary — do it in the background
        // since we're streaming the response directly
        // Note: Segment caching is done via the Cache API key above
      }

      const contentLength = response.headers.get('content-length');
      const responseHeaders: Record<string, string> = {
        'Content-Type': responseContentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
        'X-Cache': 'MISS',
      };
      if (contentLength) responseHeaders['Content-Length'] = contentLength;

      if (response.body) {
        return new NextResponse(response.body, {
          status: 200,
          headers: responseHeaders,
        });
      }

      const arrayBuffer = await response.arrayBuffer();
      return new NextResponse(arrayBuffer, {
        status: 200,
        headers: responseHeaders,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Proxy fetch failed' },
      { status: 502 }
    );
  }
}

// ─── Background proxy refresh (fire-and-forget) ────────────────────────────
function refreshProxyInBackground(
  targetUrl: string,
  referer: string | null,
  origin: string | null,
  isM3U8: boolean
) {
  ;(async () => {
    try {
      const fetchHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      };
      if (referer) fetchHeaders['Referer'] = referer;
      if (origin) fetchHeaders['Origin'] = origin;

      const response = await fetch(targetUrl, {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        const body = await response.text();
        if (isM3U8 && (body.includes('#EXTM3U') || body.includes('#EXT-X'))) {
          await setCachedProxy(targetUrl, body, 'application/vnd.apple.mpegurl', M3U8_CACHE_TTL);
          console.log(`[Proxy] Background refresh done: ${targetUrl}`);
        }
      }
    } catch {
      // Background refresh failed — cached version still serves
    }
  })();
}

function isM3U8Content(url: string, contentType: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return true;
  } catch {
    if (url.includes('.m3u8') || url.includes('.m3u')) return true;
  }
  if (contentType.includes('mpegurl') || contentType.includes('vnd.apple.mpegurl')) return true;
  return false;
}

function isSubtitleContent(url: string, contentType: string): boolean {
  if (contentType.includes('text/vtt') || contentType.includes('text/srt')) return true;
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.vtt') || path.endsWith('.srt')) return true;
  } catch {
    if (url.includes('.vtt') || url.includes('.srt')) return true;
  }
  return false;
}

function isM3U8Url(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return true;
  } catch {
    if (url.includes('.m3u8') || url.includes('.m3u')) return true;
  }
  return false;
}

function isSubtitleSegment(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.vtt') || path.endsWith('.srt')) return true;
  } catch {
    if (url.includes('.vtt') || url.includes('.srt')) return true;
  }
  return false;
}

async function rewriteM3U8(content: string, baseUrl: string, searchParams: URLSearchParams): Promise<string> {
  const lines = content.split('\n');
  const referer = searchParams.get('referer') || '';
  const origin = searchParams.get('origin') || '';
  const localProxyBase = '/api/proxy';

  // Detect Castle/freecdn URLs
  let hasCastleUrls = false;
  let hasFreecdnUrls = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const resolved = resolveUrl(trimmed, baseUrl);
    if (isFreecdnCDN(resolved)) hasFreecdnUrls = true;
    if (isCastleCDN(resolved)) hasCastleUrls = true;

    if (trimmed.includes('URI="')) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const uriResolved = resolveUrl(uriMatch[1], baseUrl);
        if (isFreecdnCDN(uriResolved)) hasFreecdnUrls = true;
        if (isCastleCDN(uriResolved)) hasCastleUrls = true;
      }
    }
  }

  if (hasFreecdnUrls) console.log(`[Proxy] Detected freecdn CDN URLs — routing through HF proxy`);
  if (hasCastleUrls) console.log(`[Proxy] Detected Castle CDN URLs — routing through HF proxy (CF Workers blocked)`);

  return lines.map(line => {
    const trimmed = line.trim();
    if (trimmed === '') return line;

    if (trimmed.startsWith('#')) {
      if (trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          const resolved = resolveUrl(uri, baseUrl);

          if (isFreecdnCDN(resolved) || isCastleCDN(resolved)) {
            return `URI="${buildHFProxyUrl(resolved, referer, origin)}"`;
          }

          return `URI="${buildLocalProxyUrl(localProxyBase, resolved, referer, origin)}"`;
        });
      }
      return line;
    }

    const resolved = resolveUrl(trimmed, baseUrl);

    // freecdn and Castle URLs → HF proxy
    if (isFreecdnCDN(resolved) || isCastleCDN(resolved)) {
      return buildHFProxyUrl(resolved, referer, origin);
    }

    // Sub-playlists → local proxy
    if (isM3U8Url(resolved)) {
      return buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
    }

    // Subtitle segments → local proxy
    if (isSubtitleSegment(resolved)) {
      return buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
    }

    // Other segments → local proxy
    return buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
  }).join('\n');
}

function buildLocalProxyUrl(proxyBase: string, resolvedUrl: string, referer: string, origin: string): string {
  let url = `${proxyBase}?url=${encodeURIComponent(resolvedUrl)}`;
  if (referer) url += `&referer=${encodeURIComponent(referer)}`;
  if (origin) url += `&origin=${encodeURIComponent(origin)}`;
  return url;
}

function buildHFProxyUrl(resolvedUrl: string, referer: string, origin: string): string {
  const effectiveReferer = referer || 'https://net52.cc/';
  const effectiveOrigin = origin || 'https://net52.cc';

  let url = `${HF_PROXY_BASE}/proxy?url=${encodeURIComponent(resolvedUrl)}`;
  url += `&referer=${encodeURIComponent(effectiveReferer)}`;
  url += `&origin=${encodeURIComponent(effectiveOrigin)}`;
  return url;
}

function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  try {
    const base = new URL(baseUrl);
    if (url.startsWith('/')) {
      return `${base.origin}${url}`;
    }
    const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
    return `${base.origin}${basePath}${url}`;
  } catch {
    return url;
  }
}
