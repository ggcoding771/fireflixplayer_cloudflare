// Source configuration for both streaming APIs
// Based on testing with Venom (912649) and Squid Game S1E1 (93405)

export type ApiOrigin = 'missourimonster' | 'streamforge';

export interface SourceConfig {
  id: string;           // Unique ID across both APIs
  name: string;         // Display name
  apiOrigin: ApiOrigin; // Which API this source belongs to
  apiSourceKey: string; // The source key used in API calls
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
// Only sources that work from CF Workers are included.
// Order: NetMirror (Moon) → Atlas → Neptune → Titan
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
  // === 2. Atlas — Fast English ===
  {
    id: 'sf-vidrock',
    name: 'Atlas',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidrock',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 2,
    reliability: 'high',
  },
  // === 3. Neptune — Partially working, multi-language ===
  {
    id: 'sf-vidnest',
    name: 'Neptune',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidnest',
    languageFlags: '🇫🇷🇺🇸🇰🇷',
    languages: ['fr', 'en', 'ko', 'multi'],
    order: 3,
    reliability: 'medium',
    note: 'Partially working — some content unavailable',
  },
  // === 4. Titan (MM vidrock) — Working via MissouriMonster ===
  {
    id: 'mm-vidrock',
    name: 'Titan',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'vidrock',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 4,
    reliability: 'high',
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
