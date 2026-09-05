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

// Server order — updated Sep 2026 (v15) after the live round: every source
// re-tested through the production chain, two new servers added (Meteor/Nova
// from the CNCVerse + ZETIC7Z/Anshu78780/streamly research round), and the
// order re-cut per the user's requests (Comet 2nd, Sirius in the working
// block, Atlas demoted below the working block):
//
//   VERIFIED WORKING (user-tested + chain-verified):
//     Aries (vegamovies)  — direct MKV from R2/hubcloud, multi-audio Hindi/English
//     Pluto (castle)      — multi-language m3u8 (OST/Hindi/…)
//     Neptune (meowtv)    — castle-CDN family, multi
//     Vega (playbox)      — multi-quality m3u8
//     Sirius (hexa)       — works; CF-challenge is flaky per-request
//     Meteor (NEW)        — Showbox/FebBox hls.shegu.net, multi CDN + audio
//     Nova (NEW)          — Yamie vidrift VOD, browser-direct, movies only
//   THROTTLED (works cold, stalls hot — rides the booster):
//     Comet (movies4u)    — 4 languages; acek-cdn per-IP-aggregate throttle
//                           on the Space's single egress (user keeps it #2)
//   MEDIUM:
//     Orion (movix)       — browser-direct (residential IPs pass the challenge)
//     Titan (fsonic)      — direct MP4, movies only
//   DEMOTED:
//     Atlas (vidrock)     — ngcorp.dad Cdn-Loop → Space proxy routing
//     Lyra (persianstremio) — x265/10bit MKVs undecodable; H.264-filtered
//     Moon (netmirror)    — Alibaba CDN 426-blocks all our egress

export const SOURCES: SourceConfig[] = [
  // === 1. Aries (VegaMovies) — user-verified best; direct multi-audio MKV ===
  {
    id: 'sf-vegamovies',
    name: 'Aries',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vegamovies',
    languageFlags: '🇮🇳',
    languages: ['hi', 'en', 'multi'],
    order: 1,
    reliability: 'high',
    note: 'hubcloud R2/hub2 direct MKV (Hindi-English dual audio). TV episode files now name-verified upstream (S01E01 no longer resolves to S05E01 files).',
  },
  // === 2. Comet (Movies4u) — user-requested #2; 4 languages (see throttle note) ===
  {
    id: 'sf-movies4u',
    name: 'Comet',
    apiOrigin: 'streamforge',
    apiSourceKey: 'movies4u',
    languageFlags: '🇮🇳',
    languages: ['hi', 'en', 'ta', 'te', 'multi'],
    order: 2,
    reliability: 'medium',
    note: 'm4uplay/acek-cdn tokens are ASN-stamped by m4uplay.store and served via the Space proxy (4 languages: hi/ta/te/en). Sep 2026: acek-cdn now throttles the Space\u2019s single shared egress IP per-IP-aggregate — cold bursts ~600KB/s (works, languages+duration+start) then heats to <100KB/s → mid-playback stalls. 6-way parallel-range booster + 75s Worker timeout + patient hls.js ride it out; a 2nd AWS egress (HF PRO relay) would fully fix it. Title-specific 500/502 when their origin is down — fail-fast detects it.',
  },
  // === 3. Pluto (Castle) — multi-language m3u8 ===
  {
    id: 'sf-castle',
    name: 'Pluto',
    apiOrigin: 'streamforge',
    apiSourceKey: 'castle',
    languageFlags: '🇺🇸🇮🇳',
    languages: ['en', 'hi', 'ta', 'te', 'multi'],
    order: 3,
    reliability: 'high',
  },
  // === 4. Neptune (MeowTV) — castle-CDN family, multi-language ===
  {
    id: 'sf-meowtv',
    name: 'Neptune',
    apiOrigin: 'streamforge',
    apiSourceKey: 'meowtv',
    languageFlags: '🇮🇳🌍',
    languages: ['hi', 'en', 'ta', 'te', 'multi'],
    order: 4,
    reliability: 'high',
    note: 'api.meowtv.ru (hindiv3) — Castle-CDN streams, movie+TV',
  },
  // === 5. Vega (PlayBox) — multi-quality m3u8 ===
  {
    id: 'sf-playbox',
    name: 'Vega',
    apiOrigin: 'streamforge',
    apiSourceKey: 'playbox',
    languageFlags: '🇺🇸',
    languages: ['en', 'multi'],
    order: 5,
    reliability: 'high',
  },
  // === 6. Sirius (Hexa) — works, intermittent challenge ===
  {
    id: 'sf-hexa',
    name: 'Sirius',
    apiOrigin: 'streamforge',
    apiSourceKey: 'hexa',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 6,
    reliability: 'medium',
    note: 'dragonballzfans CDNs — upstream CF-challenge intermittently fails per-request; retrying usually works',
  },
  // === 7. Meteor (Showbox via TMDB-Embed-API) — NEW Sep 2026 ===
  {
    id: 'sf-stycanine',
    name: 'Meteor',
    apiOrigin: 'streamforge',
    apiSourceKey: 'stycanine',
    languageFlags: '🇺🇸',
    languages: ['en', 'multi'],
    order: 7,
    reliability: 'high',
    note: 'Showbox/FebBox hls.shegu.net streams (multi CDN nodes, multi-audio, movie+TV) via the public stycanine1 TMDB-Embed-API deployment which carries the FebBox cookies we lack. Verified: 18 streams for Venom in 4.4s; master+media+segment all 200 through the Space proxy.',
  },
  // === 8. Nova (Yamie) — NEW Sep 2026: browser-direct movie VOD ===
  {
    id: 'sf-yamie',
    name: 'Nova',
    apiOrigin: 'streamforge',
    apiSourceKey: 'yamie',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 8,
    reliability: 'high',
    note: 'media.vidrift.in literal per-TMDB VOD playlist (from ZETIC7Z/nexus3.0, their #2 ranked source). Playlist AND segments send Access-Control-Allow-Origin: * → browser-direct at residential speed, zero proxy load, 4MB/s+ measured. Movies only — no TV upstream.',
  },
  // === 9. Orion (Movix) — browser-direct (CDN challenges datacenter egress) ===
  {
    id: 'sf-movix',
    name: 'Orion',
    apiOrigin: 'streamforge',
    apiSourceKey: 'movix',
    languageFlags: '🇺🇸',
    languages: ['en', 'multi'],
    order: 9,
    reliability: 'medium',
    note: 'free.finepulfe.xyz 403-challenges CF/HF/datacenter egress but sends Access-Control-Allow-Origin: * — the raw m3u8 is served browser-direct so the user\u2019s residential IP fetches it.',
  },
  // === 10. Titan (Fsonic) — direct MP4, movies only ===
  {
    id: 'sf-fsonic',
    name: 'Titan',
    apiOrigin: 'streamforge',
    apiSourceKey: 'fsonic',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 10,
    reliability: 'medium',
    note: 'fsharetv.co direct MP4 — movies only',
  },
  // === 11. Atlas (VidRock) — demoted per user request (below the working block) ===
  {
    id: 'sf-vidrock',
    name: 'Atlas',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidrock',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 11,
    reliability: 'medium',
    note: 'ngcorp.dad / flamingo workers m3u8. ngcorp.dad is Cloudflare-proxied — CF Worker fetch → Cdn-Loop 503 (error 1102); now routed through the StreamForge Space proxy like castle/meowtv.',
  },
  // === 12. Moon (NetMirror) — CDN blocks every proxy egress we own ===
  {
    id: 'sf-netmirror',
    name: 'Moon',
    apiOrigin: 'streamforge',
    apiSourceKey: 'netmirror',
    languageFlags: '🌍',
    languages: ['en', 'hi', 'ta', 'te', 'es', 'fr', 'de', 'ja', 'ko', 'ar', 'ru', 'th', 'vi', 'id', 'it', 'pt', 'pl', 'tr', 'uk', 'multi'],
    order: 12,
    reliability: 'low',
    note: 'net27.cc now serves multi-audio MP4s from bcdnxw.hakunaymatata.com (Alibaba CDN). That CDN REQUIRES Referer "https://videodownloader.site/" (browsers cannot send it → 429) AND 426/427-blocks every proxy egress we own (CF Workers 427, HF Spaces 426, Vercel 426). Unfixable until a relay on an allowed network exists (e.g. Alibaba Cloud). Fail-fast reports it honestly in ~2s.',
  },
  // === 13. Lyra (PersianStremio) — demoted: mostly HEVC/x265 MKVs ===
  {
    id: 'sf-persianstremio',
    name: 'Lyra',
    apiOrigin: 'streamforge',
    apiSourceKey: 'persianstremio',
    languageFlags: '🌍',
    languages: ['multi', 'fa'],
    order: 13,
    reliability: 'low',
    note: 'Direct MKV dumps. Most entries are x265/HEVC 10-bit — browsers decode audio but not video (the "only audio" / dead 4K reports). Player filters to H.264-family files and the proxy now preserves Range across the CDN\u2019s 302 hops (seeking fixed). Upstream API itself 503s often.',
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
