import { NextRequest, NextResponse } from 'next/server';

// ─── Hybrid proxy: local for most CDNs, HF for freecdn hotlink protection ────
//
// ROUTING STRATEGY:
//
// 1. imgcdn.kim and other open CDNs → local proxy (URL rewriting only, fast)
//    - m3u8 playlists → proxied (URL rewriting)
//    - Segments → DIRECT CDN URLs
//    - Bandwidth: ~55-70 KB on Vercel ✅
//
// 2. freecdn*.top CDNs → HF proxy (bypasses Origin-header hotlink protection)
//    - freecdn CDNs reject browser requests with cross-origin headers
//    - HF server-side requests don't have browser Origin → CDN allows them
//    - HF rewrites ALL URLs (m3u8 + segments) through itself (free bandwidth)
//    - We detect freecdn*.top URLs in m3u8 playlists and route them to HF
//
// 3. subscdn.top (subtitles) → local proxy (CORS blocked, but no Origin check)
//
// This hybrid approach means imgcdn.kim (fast) serves the main m3u8 instantly,
// and only freecdn*.top sub-playlists/segments go through HF (slower but needed).

// HF proxy base URL for freecdn hotlink-protected CDNs
const HF_PROXY_BASE = 'https://epiccodergg-fireflix-api.hf.space';

/** Check if a URL points to a freecdn CDN (e.g., s15.freecdn13.top, s24.freecdn3.top) */
function isFreecdnCDN(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Match patterns like: s15.freecdn13.top, freecdn3.top, s24.freecdn31.top, etc.
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
    // Build headers from query params
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    // Custom headers from query
    const referer = searchParams.get('referer');
    const origin = searchParams.get('origin');
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

    // Determine if this is a text-based playlist that needs URL rewriting
    const isPlaylist = isM3U8Content(targetUrl, contentType);

    if (isPlaylist) {
      const body = await response.text();
      const rewrittenBody = await rewriteM3U8(body, targetUrl, searchParams);

      return new NextResponse(rewrittenBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    } else if (isSubtitleContent(targetUrl, contentType)) {
      // Subtitle content (VTT/SRT): return raw text
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
      // This should RARELY be hit — segments are resolved to direct URLs or HF proxy URLs.
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Proxy fetch failed' },
      { status: 502 }
    );
  }
}

/**
 * Check if the response is an m3u8 playlist
 */
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

/**
 * Check if the response is subtitle content
 */
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

/**
 * Check if a URL is an m3u8 playlist
 */
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

/**
 * Check if a URL is a subtitle segment file (VTT/SRT)
 */
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

/**
 * Rewrite m3u8 playlist content.
 *
 * HYBRID ROUTING STRATEGY:
 *
 * When a NetMirror m3u8 (e.g., on imgcdn.kim) contains URLs pointing to
 * freecdn*.top CDNs, we route those through the HF proxy (bypasses hotlink
 * protection). URLs on other CDNs (imgcdn.kim, etc.) stay on local proxy.
 *
 * - freecdn*.top URLs → HF proxy (needed: CDN checks Origin header)
 * - subscdn.top URLs → local proxy (CORS blocked, but no Origin check)
 * - Other CDN URLs → local proxy or direct (no special handling needed)
 */
async function rewriteM3U8(content: string, baseUrl: string, searchParams: URLSearchParams): Promise<string> {
  const lines = content.split('\n');
  const referer = searchParams.get('referer') || '';
  const origin = searchParams.get('origin') || '';
  const localProxyBase = '/api/proxy';

  // ─── Detect if any freecdn URLs exist in this playlist ────────────────
  let hasFreecdnUrls = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Check URL lines
    const resolved = resolveUrl(trimmed, baseUrl);
    if (isFreecdnCDN(resolved)) {
      hasFreecdnUrls = true;
      console.log(`[Proxy] Detected freecdn CDN URL — will route through HF proxy: ${resolved.substring(0, 80)}...`);
      break;
    }

    // Check URI= attributes in tag lines
    if (trimmed.includes('URI="')) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const uriResolved = resolveUrl(uriMatch[1], baseUrl);
        if (isFreecdnCDN(uriResolved)) {
          hasFreecdnUrls = true;
          console.log(`[Proxy] Detected freecdn CDN in URI — will route through HF proxy`);
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
        console.log(`[Proxy] Testing unknown CDN Referer requirement: ${resolved.substring(0, 80)}...`);
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
            const hfUrl = buildHFProxyUrl(resolved, referer, origin);
            return `URI="${hfUrl}"`;
          }

          // All other URI= → local proxy (playlists, keys, subtitles)
          const proxyUrl = buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
          return `URI="${proxyUrl}"`;
        });
      }
      return line;
    }

    // ─── URL line ─────────────────────────────────────────────────────
    const resolved = resolveUrl(trimmed, baseUrl);

    // freecdn URLs → HF proxy (bypasses Origin-header hotlink protection)
    if (isFreecdnCDN(resolved)) {
      const hfUrl = buildHFProxyUrl(resolved, referer, origin);
      return hfUrl;
    }

    // Sub-playlists on non-freecdn CDNs → local proxy (URL rewriting + Referer)
    if (isM3U8Url(resolved)) {
      const proxyUrl = buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
      return proxyUrl;
    }

    // Subtitle segments → local proxy (subscdn.top blocks CORS)
    if (isSubtitleSegment(resolved)) {
      const proxyUrl = buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
      return proxyUrl;
    }

    // Video/audio segments on non-freecdn CDNs:
    // - If HEAD test failed → local proxy
    // - Otherwise → direct CDN URL
    if (segmentNeedsProxy) {
      const proxyUrl = buildLocalProxyUrl(localProxyBase, resolved, referer, origin);
      return proxyUrl;
    }

    return resolved;
  }).join('\n');
}

/**
 * Build a URL through our local /api/proxy
 */
function buildLocalProxyUrl(proxyBase: string, resolvedUrl: string, referer: string, origin: string): string {
  let url = `${proxyBase}?url=${encodeURIComponent(resolvedUrl)}`;
  if (referer) url += `&referer=${encodeURIComponent(referer)}`;
  if (origin) url += `&origin=${encodeURIComponent(origin)}`;
  return url;
}

/**
 * Build a URL through the HuggingFace proxy for freecdn CDNs.
 *
 * The HF proxy rewrites ALL URLs (m3u8 + segments) to go through itself,
 * so bandwidth flows through HF (free tier). This is needed because
 * freecdn CDNs check the Origin header and reject browser cross-origin requests.
 * HF server-side requests don't include a problematic Origin → CDN allows them.
 */
function buildHFProxyUrl(resolvedUrl: string, referer: string, origin: string): string {
  // Use net52.cc as default Referer/Origin for NetMirror CDN
  const netMirrorOrigin = 'https://net52.cc';
  const netMirrorReferer = 'https://net52.cc/';

  const effectiveReferer = referer || netMirrorReferer;
  const effectiveOrigin = origin || netMirrorOrigin;

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
