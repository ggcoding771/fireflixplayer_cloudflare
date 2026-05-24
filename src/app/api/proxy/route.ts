import { NextRequest, NextResponse } from 'next/server';

// ─── Cloudflare Pages Proxy ────────────────────────────────────────────────
//
// CRITICAL: Cloudflare Workers automatically add headers to all outgoing
// fetch() calls: Cdn-Loop, Cf-Worker, Cf-Ew-Via, Cf-Ray, Cf-Visitor.
// Most CDNs detect these headers and return 403 (bot/scraper detection).
//
// SOLUTION: Route ALL proxied content through the HF proxy, which runs on
// HuggingFace Spaces (not Cloudflare) and doesn't add these headers.
//
// ROUTING STRATEGY:
// 1. ALL requests go through HF proxy to avoid CF header blocking
// 2. For m3u8 playlists: fetch through HF proxy, then REWRITE all URLs
//    in the m3u8 to go through our /api/proxy (not HF proxy's relative URLs)
// 3. For segments: fetch through HF proxy and stream through
// 4. For subtitles: fetch through HF proxy and return
//
// KEY FIX: The HF proxy rewrites m3u8 URLs to relative paths like /proxy?url=...
// When served from our /api/proxy, these resolve to fireflixplayer.pages.dev/proxy
// which doesn't exist. We must rewrite them to /api/proxy?url=...

const HF_PROXY_BASE = 'https://epiccodergg-fireflix-api.hf.space';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return NextResponse.json({ error: 'url parameter is required' }, { status: 400 });
  }

  try {
    const referer = searchParams.get('referer') || 'https://net52.cc/';
    const origin = searchParams.get('origin') || 'https://net52.cc';

    // Build HF proxy URL
    let hfProxyUrl = `${HF_PROXY_BASE}/proxy?url=${encodeURIComponent(targetUrl)}`;
    hfProxyUrl += `&referer=${encodeURIComponent(referer)}`;
    hfProxyUrl += `&origin=${encodeURIComponent(origin)}`;

    // Forward the request to HF proxy
    const response = await fetch(hfProxyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error(`[Proxy] HF proxy returned ${response.status} for ${targetUrl}`);
      return NextResponse.json(
        { error: `Upstream returned ${response.status}` },
        { status: response.status }
      );
    }

    const contentType = response.headers.get('content-type') || '';

    // Determine if this is a text-based playlist
    const isPlaylist = isM3U8Content(targetUrl, contentType);

    if (isPlaylist) {
      const body = await response.text();

      // ─── CRITICAL: Rewrite m3u8 URLs ────────────────────────────────────
      // The HF proxy returns m3u8 with URLs pointing to itself (relative or absolute).
      // We must rewrite ALL URLs to go through our /api/proxy so that:
      // - Sub-playlists get further rewriting
      // - Segments get proxied through HF (avoiding CF headers)
      // - Subtitles get CORS headers
      const rewritten = rewriteM3U8(body, targetUrl, referer, origin);

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
      // Binary content (video segments, init segments, etc.)
      let responseContentType = contentType || 'application/octet-stream';
      if (targetUrl.includes('.ts') || targetUrl.includes('.m4s') || targetUrl.includes('.jpg')) {
        responseContentType = 'video/mp2t';
      } else if (targetUrl.includes('.mp4') && !targetUrl.includes('.m3u8')) {
        responseContentType = 'video/mp4';
      } else if (targetUrl.includes('.vtt')) {
        responseContentType = 'text/vtt';
      } else if (targetUrl.includes('.srt')) {
        responseContentType = 'text/plain';
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

// ─── m3u8 Rewriting ────────────────────────────────────────────────────────

/**
 * Rewrite all URLs in an m3u8 playlist to go through our /api/proxy.
 * Handles:
 * - Absolute HF proxy URLs: https://epiccodergg-fireflix-api.hf.space/proxy?url=...
 * - Relative HF proxy URLs: /proxy?url=...
 * - Absolute CDN URLs: https://cdn.example.com/...
 * - Relative URLs: segment.ts, subdir/playlist.m3u8, etc.
 */
function rewriteM3U8(content: string, baseUrl: string, referer: string, origin: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXT-X-KEY:') || trimmed.startsWith('#EXT-X-MAP:')) {
      // Tags with URI= attribute (encryption keys, init segments)
      result.push(rewriteUriAttribute(line, baseUrl, referer, origin));
    } else if (trimmed.startsWith('#EXT-X-MEDIA:')) {
      // Audio/subtitle media tags with URI attribute
      result.push(rewriteUriAttribute(line, baseUrl, referer, origin));
    } else if (trimmed.startsWith('#')) {
      // Other tags — pass through
      result.push(line);
    } else if (trimmed === '') {
      result.push(line);
    } else {
      // URL line (segment, sub-playlist, etc.)
      result.push(rewriteUrl(trimmed, baseUrl, referer, origin));
    }
  }

  return result.join('\n');
}

/**
 * Rewrite URI="..." attributes in m3u8 tags
 */
function rewriteUriAttribute(line: string, baseUrl: string, referer: string, origin: string): string {
  return line.replace(/URI="([^"]+)"/g, (match, url) => {
    const rewritten = rewriteUrl(url, baseUrl, referer, origin);
    return `URI="${rewritten}"`;
  });
}

/**
 * Rewrite a single URL to go through our /api/proxy
 */
function rewriteUrl(url: string, baseUrl: string, referer: string, origin: string): string {
  // Case 1: Absolute HF proxy URL
  // https://epiccodergg-fireflix-api.hf.space/proxy?url=...&referer=...&origin=...
  if (url.startsWith(HF_PROXY_BASE + '/proxy')) {
    try {
      const urlObj = new URL(url);
      const originalUrl = urlObj.searchParams.get('url');
      const hfReferer = urlObj.searchParams.get('referer') || referer;
      const hfOrigin = urlObj.searchParams.get('origin') || origin;
      if (originalUrl) {
        return buildLocalProxyUrl(originalUrl, hfReferer, hfOrigin);
      }
    } catch {
      // Fall through
    }
  }

  // Case 2: Relative HF proxy URL
  // /proxy?url=...&referer=...&origin=...
  if (url.startsWith('/proxy?') || url.startsWith('/proxy/')) {
    try {
      const urlObj = new URL(url, HF_PROXY_BASE);
      const originalUrl = urlObj.searchParams.get('url');
      const hfReferer = urlObj.searchParams.get('referer') || referer;
      const hfOrigin = urlObj.searchParams.get('origin') || origin;
      if (originalUrl) {
        return buildLocalProxyUrl(originalUrl, hfReferer, hfOrigin);
      }
    } catch {
      // Fall through
    }
  }

  // Case 3: Absolute CDN URL (http:// or https://)
  if (url.startsWith('http://') || url.startsWith('https://')) {
    // Determine the appropriate referer/origin based on the CDN
    const effectiveReferer = referer;
    const effectiveOrigin = origin;
    return buildLocalProxyUrl(url, effectiveReferer, effectiveOrigin);
  }

  // Case 4: Relative URL — resolve against the base URL (the m3u8's URL)
  try {
    const resolved = new URL(url, baseUrl).href;
    return buildLocalProxyUrl(resolved, referer, origin);
  } catch {
    // Can't resolve, return as-is
    console.warn(`[Proxy] Could not resolve relative URL: ${url} against ${baseUrl}`);
    return url;
  }
}

/**
 * Build a local proxy URL: /api/proxy?url=...&referer=...&origin=...
 */
function buildLocalProxyUrl(url: string, referer: string, origin: string): string {
  const params = new URLSearchParams({ url });
  if (referer) params.set('referer', referer);
  if (origin) params.set('origin', origin);
  return `/api/proxy?${params.toString()}`;
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
