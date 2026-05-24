---
Task ID: 1
Agent: Main Agent
Task: Build embed video player with ArtPlayer, dual API source support, auto-play, language detection, and quality selection

Work Log:
- Tested both APIs (MissouriMonster and StreamForge) with Venom (912649) and Squid Game S1E1 (93405)
- Identified all source names, response formats, language capabilities, and CORS requirements
- Installed artplayer and hls.js packages
- Created source configuration (src/lib/sources.ts) with 23 sources ordered by speed, with language flags
- Created m3u8 parser (src/lib/m3u8-parser.ts) for audio track and quality detection
- Created backend API routes: /api/sources, /api/stream, /api/proxy
- Created ArtPlayerWrapper component with HLS.js integration, quality switching, audio track selection
- Created ServerSelector component with dropdown menu and slide-left track sub-menu
- Created EmbedPlayer component with auto-play state machine (sequential try, red cross, interrupt/resume)
- Created main page with query param routing (?movie=ID or ?tv=ID&s=1&e=1)
- Added CORS proxy for StreamForge sources that lack CORS headers
- All lint checks pass

Stage Summary:
- Full embed player system functional with dual API support
- Auto-play tries sources from fastest to slowest
- Language flags displayed beside source names
- Castle-style multi-stream sources show track sub-menu
- Quality switching available via ArtPlayer controls
- Proxy handles CORS for StreamForge direct URLs
- Audio track switching for multi-language m3u8 streams

---
Task ID: 2
Agent: Main Agent
Task: Fix quality selector (only showing Auto), audio tracks not visible in settings, ServerSelector not showing multiStreams for unfetched sources, and Castle language detection

Work Log:
- Fixed ArtPlayer quality selector: removed duplicate placeholder settings from constructor, now only adds quality levels dynamically from HLS.js MANIFEST_PARSED event
- Fixed audio track selector: added audio tracks in ArtPlayer settings panel when detected from HLS manifest (even single tracks shown for identification)
- Added bitrate info to quality labels (e.g., "1080p (4500k)")
- Added onManifestParsed callback to ArtPlayerWrapper to propagate HLS-detected tracks back to parent
- Fixed ServerSelector: added fetchSource prop, now fetches source on click if not yet fetched, then shows multiStreams panel if available
- Added loading state indicator (Loader2 spinner) for sources being fetched in dropdown
- Fixed Castle and all StreamForge language detection: unified detectLanguageFromUrl() function that checks URL and title patterns for language codes
- Fixed stream.language in multiStreams to use URL-detected language instead of API's incorrect "English" label
- For sources with multiple sub-streams, now builds audioTracks from detected sub-stream languages when m3u8 doesn't have explicit audio track tags
- Added more language patterns to detection: Kannada, Malayalam, Bengali, Chinese, Thai, Arabic, Russian, Portuguese
- Added detectLanguagesFromM3u8() helper to verify audio tracks from m3u8 content
- Updated EmbedPlayer to pass fetchSource to ServerSelector and handle onManifestParsed callback

Stage Summary:
- Quality selector now shows all available HLS quality levels (Auto + 360p/480p/720p/1080p etc.)
- Audio tracks appear in ArtPlayer settings when detected from HLS manifest
- ServerSelector fetches sources on click and shows multiStreams (e.g., NetMirror's 5 languages)
- Castle/NetMirror/multi-language sources properly detect language from URL patterns, not incorrect API labels
- Audio track flag indicator visible on ArtPlayer control bar
