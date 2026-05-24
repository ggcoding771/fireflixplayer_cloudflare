import { NextRequest, NextResponse } from 'next/server';

// ─── Cloudflare Pages Hybrid Proxy ─────────────────────────────────────────
//
// Adapted from the working Vercel version's hybrid proxy strategy.
//
// On Cloudflare Workers, fetch() auto-adds headers (Cdn-Loop, Cf-Worker, etc.)
// that SOME CDNs detect and block. However, many CDNs (like Castle CDNs:
// klwoc.com, toxcw.com, etc.) do NOT block these headers and work fine with
// direct fetch.
//
// ROUTING STRATEGY (matches Vercel version):
//
// 1. imgcdn.kim and other open CDNs → direct fetch + URL rewriting (fast)
//    - m3u8 playlists → proxied with URL rewriting
//    - Segments → direct CDN URLs when possible, proxied only if CDN requires Referer
//
// 2. freecdn*.top CDNs → HF proxy (bypasses Origin-header hotlink protection)
//    - These CDNs reject browser requests with cross-origin Origin headers
//    - HF server-side requests don't have browser Origin → CDN allows them
//    - HF rewrites ALL URLs through itself (free bandwidth)
//
// 3. subscdn.top (subtitles) → direct fetch (CORS handled by us, no Origin check)
//
// 4. Other CDNs (Castle, etc.) → direct fetch with Referer, fallback to HF proxy on 403

const HF_PROXY_BASE = 'https://epiccodergg-fireflix-api.hf.space';

/** Check if a URL points to a freecdn CDN (e.g., s15.freecdn13.top) */
function isFreecdnCDN(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /freecdn\d*\.top/.test(hostname);
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
    const referer = searchParams.get('referer') || 'https://net52.cc/';
    const origin = searchParams.get('origin') || 'https://net52.cc';

    // ─── Route through HF proxy ONLY for freecdn URLs ────────────────────
    // freecdn*.top CDNs check Origin header and reject cross-origin browser requests.
    // HF proxy (server-side) doesn't send problematic Origin → CDN allows it.
    if (isFreecdnCDN(targetUrl)) {
      return await fetchThroughHFProxy(targetUrl, referer, origin);
    }

    // ─── Direct fetch for all other CDNs (Castle, imgcdn.kim, CineSu, etc.) ─
    // This matches the Vercel behavior where these CDNs are fetched directly.
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (referer) headers['Referer'] = referer;
    if (origin) headers['Origin'] = origin;

    let response = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(30000),
    });

    // ─── Fallback: If direct fetch fails with 403/4xx, try HF proxy ─────
    // Some CDNs might block CF Worker headers. Fall back gracefully.
    if (!response.ok && response.status >= 400 && response.status < 500) {
      console.log(`[Proxy] Direct fetch failed (${response.status}) for ${targetUrl.substring(0, 80)}, trying HF proxy fallback`);
      return await fetchThroughHFProxy(targetUrl, referer, origin);
    }

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
      // Rewrite URLs in m3u8 with hybrid routing (same as Vercel version)
      const rewrittenBody = await rewriteM3U8(body, targetUrl, referer, origin);

      return new NextResponse(rewrittenBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    } else if (isSubtitleContent(targetUrl, contentType)) {
      const body = await response.text();

      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/vtt',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    } else {
      // Binary content (video segments, init segments, etc.)
      let responseContentType = contentType || 'application/octet-stream';
      if (targetUrl.includes('.ts') || targetUrl.includes('.m4s') || targetUrl.includes('.jpg')) {
        responseContentType = 'video/mp2t';
      } else if (targetUrl.includes('.js')) {
        responseContentType = 'audio/aac';
      } else if (targetUrl.includes('.mp4') && !targetUrl.includes('.m3u8')) {
        responseContentType = 'video/mp4';
      }

      const contentLength = response.headers.get('content-length');
      const responseHeaders: Record<string, string> = {
        'Content-Type': responseContentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
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
    console.error(`[Proxy] Error fetching ${targetUrl}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Proxy fetch failed' },
      { status: 502 }
    );
  }
}

// ─── HF Proxy Fetch ────────────────────────────────────────────────────────

async function fetchThroughHFProxy(targetUrl: string, referer: string, origin: string): Promise<NextResponse> {
  const hfProxyUrl = `${HF_PROXY_BASE}/proxy?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;

  const response = await fetch(hfProxyUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Accept': '*/*',
    },
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
    // Rewrite HF proxy's URLs to our /api/proxy
    const rewritten = rewriteHFM3U8(body, targetUrl, referer, origin);

    return new NextResponse(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    });
  } else if (isSubtitleContent(targetUrl, contentType)) {
    const body = await response.text();
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

    const contentLength = response.headers.get('content-length');
    const responseHeaders: Record<string, string> = {
      'Content-Type': responseContentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    };
    if (contentLength) responseHeaders['Content-Length'] = contentLength;

    if (response.body) {
      return new NextResponse(response.body, { status: 200, headers: responseHeaders });
    }
    const arrayBuffer = await response.arrayBuffer();
    return new NextResponse(arrayBuffer, { status: 200, headers: responseHeaders });
  }
}

// ─── m3u8 Rewriting (Vercel-style hybrid) ──────────────────────────────────

/**
 * Rewrite m3u8 with hybrid routing (matches Vercel version):
 * - freecdn*.top URLs → HF proxy (bypasses Origin-header hotlink protection)
 * - Sub-playlists → local proxy (for URL rewriting + Referer)
 * - Subtitle segments → local proxy (CORS)
 * - Video segments on non-freecdn CDNs → direct URLs or local proxy (HEAD test)
 */
async function rewriteM3U8(content: string, baseUrl: string, referer: string, origin: string): Promise<string> {
  const lines = content.split('\n');
  const localProxyBase = '/api/proxy';

  // ─── Detect if any freecdn URLs exist in this playlist ────────────────
  let hasFreecdnUrls = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const resolved = resolveUrl(trimmed, baseUrl);
    if (isFreecdnCDN(resolved)) {
      hasFreecdnUrls = true;
      break;
    }

    // Check URI= attributes in tag lines
    if (trimmed.includes('URI="')) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const uriResolved = resolveUrl(uriMatch[1], baseUrl);
        if (isFreecdnCDN(uriResolved)) {
          hasFreecdnUrls = true;
          break;
        }
      }
    }
  }

  // For non-freecdn CDNs with Referer, test if segments need proxy
  let segmentNeedsProxy = false;
  if (referer && !hasFreecdnUrls) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const resolved = resolveUrl(trimmed, baseUrl);
      if (isM3U8Url(resolved) || isSubtitleSegment(resolved)) continue;

      // Found a video segment URL — test it WITHOUT Referer
      try {
        console.log(`[Proxy] Testing CDN Referer requirement: ${resolved.substring(0, 80)}...`);
        const testResp = await fetch(resolved, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        if (testResp.ok) {
          console.log(`[Proxy] CDN allows direct access (no Referer needed)`);
          segmentNeedsProxy = false;
        } else {
          console.log(`[Proxy] CDN requires Referer (got ${testResp.status}), segments will be proxied`);
          segmentNeedsProxy = true;
        }
      } catch {
        console.log(`[Proxy] CDN test failed, segments will be proxied`);
        segmentNeedsProxy = true;
      }
      break;
    }
  }

  // ─── Rewrite lines ───────────────────────────────────────────────────
  return lines.map(line => {
    const trimmed = line.trim();

    if (trimmed === '') return line;

    // Handle tag lines (with URI= attributes)
    if (trimmed.startsWith('#')) {
      if (trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          const resolved = resolveUrl(uri, baseUrl);

          // EXT-X-MAP init segments on non-proxied CDNs → direct
          if (trimmed.includes('#EXT-X-MAP') && !segmentNeedsProxy && !isFreecdnCDN(resolved)) {
            return `URI="${resolved}"`;
          }

          // freecdn URLs → HF proxy
          if (isFreecdnCDN(resolved)) {
            return `URI="${buildHFProxyUrl(resolved, referer, origin)}"`;
          }

          // All other URI= → local proxy (playlists, keys, subtitles)
          return `URI="${buildLocalProxyUrl(localProxyBase, resolved, referer, origin)}"`;
        });
      }
      return line;
    }

    // ─── URL line ─────────────────────────────────────────────────────
    const resolved = resolveUrl(trimmed, baseUrl);

    // freecdn URLs → HF proxy
    if (isFreecdnCDN(resolved)) {
      return buildHFProxyUrl(resolved, referer, origin);
    }

    // Sub-playlists on non-freecdn CDNs → local proxy (URL rewriting + Referer)
    if (isM3U8Url(resolved)) {
      return buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
    }

    // Subtitle segments → local proxy (CORS)
    if (isSubtitleSegment(resolved)) {
      return buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
    }

    // Video/audio segments on non-freecdn CDNs:
    // - If HEAD test failed → local proxy
    // - Otherwise → direct CDN URL (fastest!)
    if (segmentNeedsProxy) {
      return buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
    }

    // Direct CDN URL — no proxy needed, browser fetches directly
    return resolved;
  }).join('\n');
}

/**
 * Rewrite HF proxy m3u8 — convert HF proxy URLs to our /api/proxy URLs.
 * Used when content comes through HF proxy (for freecdn CDNs).
 */
function rewriteHFM3U8(content: string, baseUrl: string, referer: string, origin: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
      result.push(trimmed.replace(/URI="([^"]+)"/g, (_match: string, url: string) => {
        const rewritten = rewriteHFUrl(url, baseUrl, referer, origin);
        return `URI="${rewritten}"`;
      }));
    } else if (trimmed.startsWith('#') || trimmed === '') {
      result.push(line);
    } else {
      result.push(rewriteHFUrl(trimmed, baseUrl, referer, origin));
    }
  }

  return result.join('\n');
}

/**
 * Rewrite a single URL from HF proxy format to our /api/proxy format.
 */
function rewriteHFUrl(url: string, baseUrl: string, referer: string, origin: string): string {
  // Absolute HF proxy URL
  if (url.startsWith(HF_PROXY_BASE + '/proxy')) {
    try {
      const urlObj = new URL(url);
      const originalUrl = urlObj.searchParams.get('url');
      const hfReferer = urlObj.searchParams.get('referer') || referer;
      const hfOrigin = urlObj.searchParams.get('origin') || origin;
      if (originalUrl) {
        if (isFreecdnCDN(originalUrl)) {
          return buildHFProxyUrl(originalUrl, hfReferer, hfOrigin);
        }
        return buildLocalProxyUrl('/api/proxy', originalUrl, hfReferer, hfOrigin);
      }
    } catch { /* fall through */ }
  }

  // Relative HF proxy URL
  if (url.startsWith('/proxy?') || url.startsWith('/proxy/')) {
    try {
      const urlObj = new URL(url, HF_PROXY_BASE);
      const originalUrl = urlObj.searchParams.get('url');
      const hfReferer = urlObj.searchParams.get('referer') || referer;
      const hfOrigin = urlObj.searchParams.get('origin') || origin;
      if (originalUrl) {
        if (isFreecdnCDN(originalUrl)) {
          return buildHFProxyUrl(originalUrl, hfReferer, hfOrigin);
        }
        return buildLocalProxyUrl('/api/proxy', originalUrl, hfReferer, hfOrigin);
      }
    } catch { /* fall through */ }
  }

  // Absolute CDN URL
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (isFreecdnCDN(url)) {
      return buildHFProxyUrl(url, referer, origin);
    }
    return buildLocalProxyUrl('/api/proxy', url, referer, origin);
  }

  // Relative URL — resolve against base
  try {
    const resolved = new URL(url, baseUrl).href;
    if (isFreecdnCDN(resolved)) {
      return buildHFProxyUrl(resolved, referer, origin);
    }
    return buildLocalProxyUrl('/api/proxy', resolved, referer, origin);
  } catch {
    return url;
  }
}

// ─── URL Helper Functions ──────────────────────────────────────────────────

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

function isM3U8Content(url: string, contentType: string): boolean {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
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
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    if (path.endsWith('.vtt') || path.endsWith('.srt')) return true;
  } catch {
    if (url.includes('.vtt') || url.includes('.srt')) return true;
  }
  return false;
}

function isM3U8Url(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return true;
  } catch {
    if (url.includes('.m3u8') || url.includes('.m3u')) return true;
  }
  return false;
}

function isSubtitleSegment(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    if (path.endsWith('.vtt') || path.endsWith('.srt')) return true;
  } catch {
    if (url.includes('.vtt') || url.includes('.srt')) return true;
  }
  return false;
}
