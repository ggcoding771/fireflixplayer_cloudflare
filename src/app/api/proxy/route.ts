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

/** Check if a URL points to a VidApi CDN (CF-protected) */
function isVidApiCDN(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const vidApiDomains = [
      'creativeautomationlab.site',
      'tmstrd.justhd.tv',
      'justhd.tv',
    ];
    return vidApiDomains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * Fetch a URL while following 3xx redirects MANUALLY, re-issuing the SAME
 * headers (including Range) on every hop.
 *
 * WHY: the Workers runtime's automatic redirect-following drops the `Range`
 * header across hops. Direct-file CDNs with a redirect chain (Lyra's
 * abrtech.top → 2× 324902.ir.cdn.ir) then answer a seek request with
 * 200 + the FULL file from byte 0 — the <video> element cannot seek and
 * restarts buffering: the "can't jump in time" bug. curl -L preserves Range
 * across redirects (verified 206); this replicates that behavior.
 * Max 5 hops; redirects that point at non-http(s) targets abort the chain.
 */
async function fetchFollowingRedirects(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 30000
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) {
        try { await res.body?.cancel(); } catch { /* already closed */ }
        let next: string;
        try {
          next = new URL(loc, current).toString();
        } catch {
          return res; // unparseable location — surface the redirect as-is
        }
        if (!next.startsWith('http://') && !next.startsWith('https://')) {
          return new Response(null, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
        }
        current = next;
        continue;
      }
    }
    return res;
  }
  return new Response(null, { status: 508, headers: { 'Access-Control-Allow-Origin': '*' } });
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
    // HF /proxy_range-wrapped URLs are master playlists (StreamForge wraps
    // masters; variants/segments inside get rewritten to absolute URLs).
    const isMasterM3U8 = isM3U8Content(targetUrl, '') || targetUrl.includes('/proxy_range');
    const isSegment = targetUrl.includes('.ts') || targetUrl.includes('.m4s');

    if ((isMasterM3U8 || isSegment) && !request.headers.get('range')) {
      const cached = await getCachedProxy(targetUrl);
      if (cached) {
        const maxAge = isMasterM3U8 ? M3U8_CACHE_TTL : SEGMENT_CACHE_TTL;
        console.log(`[Proxy] Cache HIT: ${isMasterM3U8 ? 'm3u8' : 'segment'} (age: ${cached.age}s, maxAge: ${maxAge}s)`);
        // Serve cached instantly — if stale, refresh in background
        if (cached.age > maxAge) {
          refreshProxyInBackground(targetUrl, referer, origin, isMasterM3U8);
        }
        // Masters are cached RAW — re-run the rewrite on every hit so the
        // served playlist is identical to the MISS path. Without this, a
        // cache-hit master keeps its relative #EXT-X-MEDIA URIs, which hls.js
        // resolves against /api/proxy (→ pages.dev/index-a1.m3u8 → 404 →
        // audioTrackLoadError loop on every multi-audio server).
        if (isMasterM3U8) {
          try {
            const rawBody = await cached.response.text();
            if (rawBody.includes('#EXTM3U')) {
              const rewritten = await rewriteM3U8(rawBody, targetUrl, searchParams);
              return new Response(rewritten, {
                status: 200,
                headers: {
                  'Content-Type': 'application/vnd.apple.mpegurl',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-cache',
                  'X-Cache': 'HIT',
                },
              });
            }
          } catch {
            // fall through to re-fetch below
          }
        }
        const respHeaders = new Headers(cached.response.headers);
        respHeaders.delete('X-Cache-Timestamp');
        respHeaders.set('X-Cache', 'HIT');
        return new Response(cached.response.body, { status: 200, headers: respHeaders });
      }
    }

    const headers: Record<string, string> = {
      'User-Agent': searchParams.get('ua') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (referer) headers['Referer'] = referer;
    if (origin) headers['Origin'] = origin;

    // Forward the client's Range header so direct-file playback (MP4/MKV via
    // <video>) can seek and stream progressively instead of downloading the
    // whole file. The upstream's 206/Content-Range is passed back faithfully.
    const clientRange = request.headers.get('range');
    if (clientRange) headers['Range'] = clientRange;

    // Manual redirect following: keeps Range (and every other header) on every
    // hop — the runtime's auto-follow drops Range, which broke seeking on any
    // CDN that 302s before serving bytes (Lyra's abrtech → cdn.ir chain).
    const response = await fetchFollowingRedirects(targetUrl, headers);

    if (!response.ok) {
      // Pass upstream errors through faithfully — hls.js and the <video>
      // element both react correctly to real status codes (4xx/5xx), which
      // lets the per-source error UI blame the right server.
      return new NextResponse(null, {
        status: response.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const isPlaylist = isM3U8Content(targetUrl, contentType);

    if (isPlaylist) {
      const body = await response.text();

      // GARBAGE GUARD: upstreams (and the HF /proxy_range relay) answer a
      // playlist URL with an HTML error page when their origin is down — and
      // wrap every line of it as proxy URLs, serving 200 + mpegurl. hls.js
      // then "parses" the error page forever = the infinite-spinner bug.
      // Anything without the #EXTM3U signature is NOT a playlist: fail with
      // 502 so the player blames the server immediately and moves on.
      if (!body.includes('#EXTM3U')) {
        console.warn(`[Proxy] Playlist URL returned non-m3u8 body (${body.slice(0, 80).replace(/\s+/g, ' ')}…) — returning 502`);
        return new NextResponse(null, {
          status: 502,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      // Cache MASTER playlists for 2 days — detected by #EXT-X-STREAM-INF.
      // NEVER cache media playlists (segment lists): castle-family streams are
      // live sliding-window playlists — a 2-day-cached segment list would stall
      // playback after the cached window. Masters are static and safe.
      if (body.includes('#EXT-X-STREAM-INF')) {
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
      } else if (targetUrl.includes('.mkv')) {
        // MKV — Chrome/Edge/Firefox play video/x-matroska natively
        responseContentType = 'video/x-matroska';
      } else if (targetUrl.includes('.mp4') && !targetUrl.includes('.m3u8')) {
        responseContentType = 'video/mp4';
      } else if (contentType.includes('octet-stream') && (targetUrl.includes('/media/') || response.headers.get('accept-ranges'))) {
        // Signed direct-file CDNs (fsharetv/vqcdn family) serve generic
        // octet-stream for MP4s — give the browser a video type so it commits
        // to playback instead of treating it as a download.
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
      // Range support: pass through 206 + Content-Range/Accept-Ranges so the
      // <video> element can seek in direct-file streams (MP4/MKV).
      if (response.status === 206) {
        if (response.headers.get('content-range')) {
          responseHeaders['Content-Range'] = response.headers.get('content-range') as string;
        }
        responseHeaders['Accept-Ranges'] = 'bytes';
      } else if (response.headers.get('accept-ranges')) {
        responseHeaders['Accept-Ranges'] = response.headers.get('accept-ranges') as string;
      }

      // Preserve 206 (Partial Content) — the <video> element requires the
      // real status + Content-Range to seek correctly in direct-file streams.
      const outStatus = response.status === 206 ? 206 : 200;

      if (response.body) {
        return new NextResponse(response.body, {
          status: outStatus,
          headers: responseHeaders,
        });
      }

      const arrayBuffer = await response.arrayBuffer();
      return new NextResponse(arrayBuffer, {
        status: outStatus,
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
        if (isM3U8 && body.includes('#EXT-X-STREAM-INF')) {
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

/**
 * If `url` is an HF Space /proxy_range (or /proxy) wrapper, extract the Space
 * origin, the inner upstream URL and its ref/ua params.
 *
 * WHY: masters served through a Space proxy keep #EXT-X-MEDIA URI attributes
 * (audio tracks!) RELATIVE — the Space only rewrites plain variant/segment
 * lines to absolute /proxy_range URLs. Resolving a relative URI against the
 * PROXY url produces https://<space>/index-a1.m3u8 → 404 → hls.js
 * audioTrackLoadError retry loop → the video never starts even though the
 * master and languages are perfectly healthy (Comet's exact symptom). The
 * correct base is the INNER upstream URL, and the resolved URL must flow
 * back through the SAME Space so asn-stamped tokens (acek-cdn's asn=14618)
 * keep matching the Space's egress.
 */
function parseSpaceProxyUrl(url: string): { spaceOrigin: string; inner: string; ref: string; ua: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('.hf.space')) return null;
    if (u.pathname !== '/proxy_range' && u.pathname !== '/proxy') return null;
    const inner = u.searchParams.get('u') || u.searchParams.get('url');
    if (!inner || !/^https?:\/\//i.test(inner)) return null;
    return {
      spaceOrigin: u.origin,
      inner,
      ref: u.searchParams.get('ref') || '',
      ua: u.searchParams.get('ua') || '',
    };
  } catch {
    return null;
  }
}

async function rewriteM3U8(content: string, baseUrl: string, searchParams: URLSearchParams): Promise<string> {
  const lines = content.split('\n');
  const referer = searchParams.get('referer') || '';
  const origin = searchParams.get('origin') || '';
  const ua = searchParams.get('ua') || '';
  const localProxyBase = '/api/proxy';

  const spaceProxy = parseSpaceProxyUrl(baseUrl);
  if (spaceProxy) {
    console.log(`[Proxy] Space-proxied playlist — relative refs resolve against inner URL (${spaceProxy.inner.slice(0, 80)})`);
  }

  // Route an inner-upstream URL back through the SAME Space (asn-stamped
  // tokens validate only from the Space's egress) and then the local proxy.
  const wrapSpaceInner = (absInner: string): string => {
    const p = new URLSearchParams({ u: absInner });
    if (spaceProxy!.ref) p.set('ref', spaceProxy!.ref);
    if (spaceProxy!.ua) p.set('ua', spaceProxy!.ua);
    const spaceRange = `${spaceProxy!.spaceOrigin}/proxy_range?${p.toString()}`;
    return buildLocalProxyUrl(localProxyBase, spaceRange, referer, origin, ua);
  };

  // Detect Castle/freecdn/VidApi URLs
  let hasCastleUrls = false;
  let hasFreecdnUrls = false;
  let hasVidApiUrls = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const resolved = spaceProxy && !/^https?:\/\//i.test(trimmed)
      ? resolveUrl(trimmed, spaceProxy.inner)
      : resolveUrl(trimmed, baseUrl);
    if (isFreecdnCDN(resolved)) hasFreecdnUrls = true;
    if (isCastleCDN(resolved)) hasCastleUrls = true;
    if (isVidApiCDN(resolved)) hasVidApiUrls = true;

    if (trimmed.includes('URI="')) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const uriResolved = spaceProxy && !/^https?:\/\//i.test(uriMatch[1])
          ? resolveUrl(uriMatch[1], spaceProxy.inner)
          : resolveUrl(uriMatch[1], baseUrl);
        if (isFreecdnCDN(uriResolved)) hasFreecdnUrls = true;
        if (isCastleCDN(uriResolved)) hasCastleUrls = true;
        if (isVidApiCDN(uriResolved)) hasVidApiUrls = true;
      }
    }
  }

  if (hasFreecdnUrls) console.log(`[Proxy] Detected freecdn CDN URLs — routing through HF proxy`);
  if (hasCastleUrls) console.log(`[Proxy] Detected Castle CDN URLs — routing through HF proxy (CF Workers blocked)`);
  if (hasVidApiUrls) console.log(`[Proxy] Detected VidApi CDN URLs — routing through HF proxy (CF-protected)`);

  return lines.map(line => {
    const trimmed = line.trim();
    if (trimmed === '') return line;

    if (trimmed.startsWith('#')) {
      if (trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          // Relative URI inside a Space-proxied master (audio track!) —
          // resolve against the INNER url, route via the same Space.
          if (spaceProxy && !/^https?:\/\//i.test(uri)) {
            return `URI="${wrapSpaceInner(resolveUrl(uri, spaceProxy.inner))}"`;
          }

          const resolved = resolveUrl(uri, baseUrl);

          if (isFreecdnCDN(resolved) || isCastleCDN(resolved) || isVidApiCDN(resolved)) {
            return `URI="${buildHFProxyUrl(resolved, referer, origin)}"`;
          }

          return `URI="${buildLocalProxyUrl(localProxyBase, resolved, referer, origin, ua)}"`;
        });
      }
      return line;
    }

    // Relative variant/segment line inside a Space-proxied playlist — same
    // inner-URL treatment (defensive: the Space rewrites plain lines today,
    // but a raw playlist from it would resolve against the wrong base too).
    if (spaceProxy && !/^https?:\/\//i.test(trimmed)) {
      return wrapSpaceInner(resolveUrl(trimmed, spaceProxy.inner));
    }

    const resolved = resolveUrl(trimmed, baseUrl);

    // freecdn, Castle, and VidApi URLs → HF proxy
    if (isFreecdnCDN(resolved) || isCastleCDN(resolved) || isVidApiCDN(resolved)) {
      return buildHFProxyUrl(resolved, referer, origin);
    }

    // Sub-playlists → local proxy
    if (isM3U8Url(resolved)) {
      return buildLocalProxyUrl(localProxyBase, resolved, referer, origin, ua);
    }

    // Subtitle segments → local proxy
    if (isSubtitleSegment(resolved)) {
      return buildLocalProxyUrl(localProxyBase, resolved, referer, origin, ua);
    }

    // Other segments → local proxy
    return buildLocalProxyUrl(localProxyBase, resolved, referer, origin, ua);
  }).join('\n');
}

function buildLocalProxyUrl(proxyBase: string, resolvedUrl: string, referer: string, origin: string, ua?: string): string {
  let url = `${proxyBase}?url=${encodeURIComponent(resolvedUrl)}`;
  if (referer) url += `&referer=${encodeURIComponent(referer)}`;
  if (origin) url += `&origin=${encodeURIComponent(origin)}`;
  if (ua) url += `&ua=${encodeURIComponent(ua)}`;
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
