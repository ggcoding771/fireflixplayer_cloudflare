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

export const SOURCES: SourceConfig[] = [
  // === 1. NetMirror (Moon) — Top priority, multi-language ===
  {
    id: 'sf-netmirror',
    name: 'Moon',
    apiOrigin: 'streamforge',
    apiSourceKey: 'netmirror',
    languageFlags: '🌍',
    languages: ['en', 'hi', 'ta', 'te', 'es', 'fr', 'de', 'ja', 'ko', 'ar', 'ru', 'th', 'vi', 'id', 'it', 'pt', 'pl', 'tr', 'uk', 'multi'],
    order: 1,
    reliability: 'high',
  },
  // === 2. Castle (Pluto) — Second priority, multi-language ===
  // CONFIRMED WORKING for Venom (912649) — was wrongly removed, now restored
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
  // === 3. Atlas — Fast English ===
  {
    id: 'sf-vidrock',
    name: 'Atlas',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidrock',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 3,
    reliability: 'high',
  },
  // === 4. Neptune — Partially working, multi-language ===
  {
    id: 'sf-vidnest',
    name: 'Neptune',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidnest',
    languageFlags: '🇫🇷🇺🇸🇰🇷',
    languages: ['fr', 'en', 'ko', 'multi'],
    order: 4,
    reliability: 'medium',
    note: 'Partially working — purstream works, klikxxi times out',
  },
  // === 5. Titan (MM vidrock) — Working via local proxy ===
  {
    id: 'mm-vidrock',
    name: 'Titan',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'vidrock',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 5,
    reliability: 'high',
    note: 'Slow (~12s) but reliable — raw URL through local proxy with vidrock.ru headers',
  },
  // === 6. VidApi (Vega) — Direct provider, multiple m3u8 URLs ===
  // Returns multiple m3u8 URLs from CF-protected CDNs. Routed through HF proxy.
  // CDN domains (creativeautomationlab.site, tmstrd.justhd.tv) block datacenter IPs.
  {
    id: 'direct-vidapi',
    name: 'Vega',
    apiOrigin: 'direct',
    apiSourceKey: 'vidapi',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 6,
    reliability: 'medium',
    note: 'VidApi CDNs are CF-protected — routed through HF proxy',
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
