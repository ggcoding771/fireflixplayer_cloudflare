// Source configuration for streaming APIs
// Based on testing with Venom (912649) and Squid Game S1E1 (93405)
// Updated: brought back Castle (Pluto), added VidApi direct provider

export type ApiOrigin = 'missourimonster' | 'streamforge' | 'direct';

export interface SourceConfig {
  id: string;           // Unique ID across all APIs
  name: string;         // Display name
  apiOrigin: ApiOrigin; // Which API this source belongs to
  apiSourceKey: string; // The source key used in API calls (or provider ID for 'direct')
  languageFlags: string; // Flag emojis like 🇺🇸🇮🇳
  languages: string[];   // Language codes this source typically provides
  order: number;        // Lower = shown higher (based on quality and reliability)
  reliability: 'high' | 'medium' | 'low' | 'broken';
  note?: string;        // Any special notes
}

// Language code to flag emoji mapping
export const LANG_FLAGS: Record<string, string> = {
  en: '🇺🇸', eng: '🇺🇸', english: '🇺🇸',
  hi: '🇮🇳', hin: '🇮🇳', hindi: '🇮🇳',
  ta: '🇮🇳', tam: '🇮🇳', tamil: '🇮🇳',
  te: '🇮🇳', tel: '🇮🇳', telugu: '🇮🇳',
  ko: '🇰🇷', kor: '🇰🇷', korean: '🇰🇷',
  fr: '🇫🇷', fra: '🇫🇷', french: '🇫🇷',
  es: '🇪🇸', spa: '🇪🇸', spanish: '🇪🇸',
  it: '🇮🇹', ita: '🇮🇹', italian: '🇮🇹',
  de: '🇩🇪', deu: '🇩🇪', ger: '🇩🇪', german: '🇩🇪',
  ja: '🇯🇵', jpn: '🇯🇵', japanese: '🇯🇵',
  zh: '🇨🇳', chi: '🇨🇳', chinese: '🇨🇳',
  pt: '🇧🇷', por: '🇧🇷', portuguese: '🇧🇷',
  ar: '🇸🇦', ara: '🇸🇦', arabic: '🇸🇦',
  ru: '🇷🇺', rus: '🇷🇺', russian: '🇷🇺',
  th: '🇹🇭', tha: '🇹🇭', thai: '🇹🇭',
  vi: '🇻🇳', vie: '🇻🇳', vietnamese: '🇻🇳',
  id: '🇮🇩', ind: '🇮🇩', indonesian: '🇮🇩',
  ms: '🇲🇾', malay: '🇲🇾',
  tl: '🇵🇭', fil: '🇵🇭',
  bn: '🇧🇩', bengali: '🇧🇩',
  ur: '🇵🇰', urdu: '🇵🇰',
  pl: '🇵🇱', pol: '🇵🇱', polish: '🇵🇱',
  ro: '🇷🇴', ron: '🇷🇴', romanian: '🇷🇴',
  cs: '🇨🇿', ces: '🇨🇿', czech: '🇨🇿',
  hu: '🇭🇺', hun: '🇭🇺', hungarian: '🇭🇺',
  tr: '🇹🇷', tur: '🇹🇷', turkish: '🇹🇷',
  uk: '🇺🇦', ukr: '🇺🇦', ukrainian: '🇺🇦',
  he: '🇮🇱', heb: '🇮🇱', hebrew: '🇮🇱',
  hr: '🇭🇷', hrv: '🇭🇷', croatian: '🇭🇷',
  el: '🇬🇷', ell: '🇬🇷', greek: '🇬🇷',
  fi: '🇫🇮', fin: '🇫🇮', finnish: '🇫🇮',
  da: '🇩🇰', dan: '🇩🇰', danish: '🇩🇰',
  sv: '🇸🇪', swe: '🇸🇪', swedish: '🇸🇪',
  no: '🇳🇴', nor: '🇳🇴', norwegian: '🇳🇴',
  nl: '🇳🇱', nld: '🇳🇱', dutch: '🇳🇱',
  multi: '🌍', Multi: '🌍',
  und: '❓',  // Undetermined/Unknown language
};

// All sources ordered by m3u8 response speed and playback quality
// Tested against TMDB ID 912649 (Venom: The Last Dance) — March 2025
//
// WORKING: Moon (netmirror), Pluto (castle), Atlas (vidrock), Neptune (vidnest partial), Titan (mm-vidrock)
// DIRECT:  VidApi — returns m3u8 URLs but CDN may be CF-blocked; works for some content
//
// Sources from cinepro-org/core that were tested but are Cloudflare-blocked from datacenter IPs:
//   CineSu (404), Icefy (500/429), Peachify (CF challenge), Popr (CF challenge),
//   StreamMafia (auth required), VidZee/Tulnex (complex encryption, upstream CF-blocked),
//   Fmovies4U (disabled), AnyEmbed (disabled/unstable), FshareTV (needs IMDb ID)
// These cannot be used from CF Workers without residential proxy infrastructure.

// All sources now come from StreamForge API v14 (epiccodergg-streamforge-api.hf.space).
// v14 added 8 Vyla-SDK-ported scrapers; the dead missourimonster-vyla Space and the
// direct VidApi provider (same backend as PlayBox) were removed.
// NOTE: vidfast / vidup / lookmovie / lmscript exist in the API but their upstream
// sites 403 both HF Spaces and Cloudflare Worker egress — they are NOT listed here.

export const SOURCES: SourceConfig[] = [
  // === 1. Moon (NetMirror) — Top priority, multi-language ===
  {
    id: 'sf-netmirror',
    name: 'Moon',
    apiOrigin: 'streamforge',
    apiSourceKey: 'netmirror',
    languageFlags: '🌍',
    languages: ['en', 'hi', 'ta', 'te', 'es', 'fr', 'de', 'ja', 'ko', 'ar', 'ru', 'th', 'vi', 'id', 'it', 'pt', 'pl', 'tr', 'uk', 'multi'],
    // Auto-play order demoted from 1 → 7.5: with the CDN egress-blocked the
    // fail-fast probe costs ~15s on every title when tried first; Pluto (2)
    // starts instantly. Still fully listed & manually selectable — the moment
    // net27 restores HLS (or the CDN unblocks CF egress), promote it back.
    order: 7.5,
    reliability: 'medium',
    note: 'net27.cc switched upstreams: old 30+ language HLS is dead (their /api/loffe fallback is broken server-side); now serves multi-audio MP4s from bcdnxw.hakunaymatata.com which 426/427-blocks HF+CF proxy egress (verified Sep 2026). Fail-fast probe marks it failed until their CDN unblocks or HLS returns. Some older titles genuinely missing (e.g. Venom 2018)',
  },
  // === 2. Pluto (Castle) — multi-language ===
  {
    id: 'sf-castle',
    name: 'Pluto',
    apiOrigin: 'streamforge',
    apiSourceKey: 'castle',
    languageFlags: '🇺🇸🇮🇳',
    languages: ['en', 'hi', 'ta', 'te', 'multi'],
    order: 2,
    reliability: 'high',
  },
  // === 3. Neptune (MeowTV) — castle-CDN family, multi-language (replaces dead vidnest) ===
  {
    id: 'sf-meowtv',
    name: 'Neptune',
    apiOrigin: 'streamforge',
    apiSourceKey: 'meowtv',
    languageFlags: '🇮🇳🌍',
    languages: ['hi', 'en', 'ta', 'te', 'multi'],
    order: 3,
    reliability: 'high',
    note: 'api.meowtv.ru (hindiv3) — Castle-CDN streams, movie+TV',
  },
  // === 4. Vega (PlayBox) — multi-quality m3u8 (was direct-vidapi, same backend API) ===
  {
    id: 'sf-playbox',
    name: 'Vega',
    apiOrigin: 'streamforge',
    apiSourceKey: 'playbox',
    languageFlags: '🇺🇸',
    languages: ['en', 'multi'],
    order: 4,
    reliability: 'high',
  },
  // === 5. Orion (Movix) — 1080p+ up to 1440p multi ===
  {
    id: 'sf-movix',
    name: 'Orion',
    apiOrigin: 'streamforge',
    apiSourceKey: 'movix',
    languageFlags: '🇺🇸',
    languages: ['en', 'multi'],
    order: 5,
    reliability: 'high',
  },
  // === 6. Atlas (VidRock) — multi-server movies + TV ===
  {
    id: 'sf-vidrock',
    name: 'Atlas',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidrock',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 6,
    reliability: 'high',
    note: 'ngcorp.dad / flamingo workers m3u8 — movies verified; some TV servers 403',
  },
  // === 7. Titan (Fsonic) — direct MP4 720/1080 (replaces dead mm-vidrock) ===
  {
    id: 'sf-fsonic',
    name: 'Titan',
    apiOrigin: 'streamforge',
    apiSourceKey: 'fsonic',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 7,
    reliability: 'medium',
    note: 'fsharetv.co direct MP4 — movies only',
  },
  // === 8. Comet (Movies4u) — Hindi/English acek-cdn + hubcloud ===
  {
    id: 'sf-movies4u',
    name: 'Comet',
    apiOrigin: 'streamforge',
    apiSourceKey: 'movies4u',
    languageFlags: '🇮🇳',
    languages: ['hi', 'en', 'multi'],
    order: 8,
    reliability: 'medium',
    note: 'm4uplay/acek-cdn: tokens are ASN-stamped by m4uplay.store (AWS 14618 = the StreamForge Space) and served via the Space proxy — works when the acek origin is healthy (4 languages: hi/ta/te/en), 500/502 when their origin is down (title-specific); fail-fast detects it',
  },
  // === 9. Lyra (PersianStremio) — direct MKV up to 4K ===
  {
    id: 'sf-persianstremio',
    name: 'Lyra',
    apiOrigin: 'streamforge',
    apiSourceKey: 'persianstremio',
    languageFlags: '🌍',
    languages: ['multi', 'fa'],
    order: 9,
    reliability: 'high',
  },
  // === 10. Sirius (Hexa) — intermittent ===
  {
    id: 'sf-hexa',
    name: 'Sirius',
    apiOrigin: 'streamforge',
    apiSourceKey: 'hexa',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 10,
    reliability: 'low',
    note: 'dragonballzfans CDNs — intermittent availability',
  },
  // === 11. Aries (VegaMovies) — Hindi multi-host MKV up to 4K ===
  {
    id: 'sf-vegamovies',
    name: 'Aries',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vegamovies',
    languageFlags: '🇮🇳',
    languages: ['hi', 'en', 'multi'],
    order: 11,
    reliability: 'medium',
  },
];

// Get ordered source list
export function getOrderedSources(): SourceConfig[] {
  return [...SOURCES].sort((a, b) => a.order - b.order);
}

// Get source by ID
export function getSourceById(id: string): SourceConfig | undefined {
  return SOURCES.find(s => s.id === id);
}
