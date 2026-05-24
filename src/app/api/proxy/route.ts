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
// 1. m3u8 playlists → HF proxy (which rewrites all URLs to go through itself)
//    - The HF proxy returns m3u8 with relative URLs like /proxy?url=...
//    - Browser resolves these to https://epiccodergg-fireflix-api.hf.space/proxy?url=...
//    - This means segments go DIRECTLY through HF (free bandwidth, no CF headers)
//    - We pass through the m3u8 as-is from HF (no need to rewrite)
//
// 2. Video/audio segments → fetched directly from HF proxy by the browser
//    - Our proxy is NOT in the path for segments (HF handles them directly)
//
// 3. For non-m3u8 content (subtitles, etc.) → proxy through HF and return

const HF_PROXY_BASE = 'https://epiccodergg-fireflix-api.hf.space';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return NextResponse.json({ error: 'url parameter is required' }, { status: 400 });
  }

  try {
    // ─── Route through HF proxy to avoid CF header blocking ────────────
    const referer = searchParams.get('referer') || '';
    const origin = searchParams.get('origin') || '';

    // Use net52.cc as default Referer/Origin for NetMirror/castle CDNs
    const netMirrorOrigin = 'https://net52.cc';
    const netMirrorReferer = 'https://net52.cc/';

    const effectiveReferer = referer || netMirrorReferer;
    const effectiveOrigin = origin || netMirrorOrigin;

    // Build HF proxy URL
    let hfProxyUrl = `${HF_PROXY_BASE}/proxy?url=${encodeURIComponent(targetUrl)}`;
    hfProxyUrl += `&referer=${encodeURIComponent(effectiveReferer)}`;
    hfProxyUrl += `&origin=${encodeURIComponent(effectiveOrigin)}`;

    // Forward the request to HF proxy
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

    // Determine if this is a text-based playlist
    const isPlaylist = isM3U8Content(targetUrl, contentType);

    if (isPlaylist) {
      // Pass through the HF proxy's m3u8 as-is.
      // The HF proxy already rewrites all segment URLs to go through itself
      // (relative URLs like /proxy?url=... resolve to the HF domain in the browser).
      // This means segments flow through HF directly — no CF header issues!
      const body = await response.text();

      return new NextResponse(body, {
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
