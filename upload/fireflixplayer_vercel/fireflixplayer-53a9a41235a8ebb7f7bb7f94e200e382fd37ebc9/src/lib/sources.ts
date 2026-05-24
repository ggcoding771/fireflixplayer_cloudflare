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

// All sources ordered by quality and reliability
// NetMirror and Castle are top priority due to multi-language support and quality
export const SOURCES: SourceConfig[] = [
  // === Top Priority: Multi-language StreamForge Sources ===
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
  {
    id: 'sf-dooflix',
    name: 'Venus',
    apiOrigin: 'streamforge',
    apiSourceKey: 'dooflix',
    languageFlags: '🇮🇳🇺🇸',
    languages: ['hi', 'en', 'multi'],
    order: 3,
    reliability: 'high',
  },
  {
    id: 'sf-vidnest',
    name: 'Neptune',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidnest',
    languageFlags: '🇫🇷🇺🇸🇰🇷',
    languages: ['fr', 'en', 'ko', 'multi'],
    order: 4,
    reliability: 'medium',
  },
  {
    id: 'sf-movieboxhindi',
    name: 'Aurora',
    apiOrigin: 'streamforge',
    apiSourceKey: 'movieboxhindi',
    languageFlags: '🇮🇳🇺🇸',
    languages: ['hi', 'en'],
    order: 5,
    reliability: 'high',
  },
  {
    id: 'sf-allmovieland',
    name: 'Saturn',
    apiOrigin: 'streamforge',
    apiSourceKey: 'allmovieland',
    languageFlags: '🇮🇳🇺🇸',
    languages: ['hi', 'ta', 'te', 'en', 'multi'],
    order: 6,
    reliability: 'medium',
  },

  // === MissouriMonster Sources (English, fast) ===
  {
    id: 'mm-cinesu',
    name: 'Orion',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'cinesu',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 7,
    reliability: 'high',
  },
  {
    id: 'mm-meowtv',
    name: 'Comet',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'meowtv',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 8,
    reliability: 'high',
  },
  {
    id: 'mm-vidlink',
    name: 'Nova',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'vidlink',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 9,
    reliability: 'high',
  },
  {
    id: 'mm-flixhq',
    name: 'Eclipse',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'flixhq',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 10,
    reliability: 'high',
  },
  {
    id: 'mm-vidrock',
    name: 'Titan',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'vidrock',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 11,
    reliability: 'high',
  },
  {
    id: 'mm-icefy',
    name: 'Glacier',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'icefy',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 12,
    reliability: 'medium',
  },
  {
    id: 'mm-fsharetv',
    name: 'Pulsar',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'fsharetv',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 13,
    reliability: 'medium',
  },
  {
    id: 'mm-vidzee',
    name: 'Zenith',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'vidzee',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 14,
    reliability: 'medium',
  },
  {
    id: 'mm-vidfun',
    name: 'Spark',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'vidfun',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 15,
    reliability: 'medium',
  },
  {
    id: 'mm-cinezo',
    name: 'Nebula',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'cinezo',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 16,
    reliability: 'low',
  },
  {
    id: 'mm-videasy',
    name: 'Drift',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'videasy',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 17,
    reliability: 'low',
  },
  {
    id: 'mm-vixsrc',
    name: 'Phantom',
    apiOrigin: 'missourimonster',
    apiSourceKey: 'vixsrc',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 18,
    reliability: 'low',
    note: 'Cloudflare-blocked from datacenter IPs',
  },

  // === Lower Priority StreamForge Sources ===
  {
    id: 'sf-cinesu',
    name: 'Lyra',
    apiOrigin: 'streamforge',
    apiSourceKey: 'cinesu',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 19,
    reliability: 'high',
  },
  {
    id: 'sf-vidrock',
    name: 'Atlas',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidrock',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 20,
    reliability: 'high',
  },
  {
    id: 'sf-videasy',
    name: 'Cosmos',
    apiOrigin: 'streamforge',
    apiSourceKey: 'videasy',
    languageFlags: '🇺🇸',
    languages: ['en', 'multi'],
    order: 21,
    reliability: 'medium',
  },
  {
    id: 'sf-vixsrc',
    name: 'Shadow',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vixsrc',
    languageFlags: '🇺🇸🇮🇹',
    languages: ['en', 'it', 'multi'],
    order: 22,
    reliability: 'low',
    note: 'Cloudflare-blocked from datacenter IPs',
  },
  {
    id: 'sf-vidsrc',
    name: 'Echo',
    apiOrigin: 'streamforge',
    apiSourceKey: 'vidsrc',
    languageFlags: '🇺🇸',
    languages: ['en'],
    order: 23,
    reliability: 'low',
    note: 'Cloudflare-blocked from datacenter IPs',
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
