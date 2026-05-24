// m3u8 parser utility
// Parses HLS master playlists for quality levels and audio tracks

export interface AudioTrack {
  language: string;   // Language code (en, hi, ko, fr, etc.)
  name: string;       // Display name
  default: boolean;   // Is this the default track?
  uri: string | null; // URI of the audio stream (null = inline)
  flagEmoji: string;  // Flag emoji for the language
}

export interface QualityLevel {
  bandwidth: number;
  resolution: string;   // e.g., "1920x800"
  width: number;
  height: number;
  name: string;         // Quality name from stream
  uri: string;
}

export interface ParsedM3U8 {
  audioTracks: AudioTrack[];
  qualities: QualityLevel[];
}

// Language code to flag emoji (ISO 639-1, 639-2/T, 639-2/B codes)
const LANG_FLAG_MAP: Record<string, string> = {
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
  ca: '🏴', catalan: '🏴',
  gl: '🏴', galician: '🏴',
  eu: '🏴', basque: '🏴',
  multi: '🌍',
  und: '❓',  // Undetermined/Unknown
};

function getFlagEmoji(lang: string): string {
  if (!lang) return '🌍';
  const lower = lang.toLowerCase().replace(/[^a-z]/g, '');
  return LANG_FLAG_MAP[lower] || LANG_FLAG_MAP[lang] || '🌍';
}

// Parse an attribute string like: TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English"
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match KEY=VALUE or KEY="VALUE"
  const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return attrs;
}

// Parse a master m3u8 playlist
export function parseM3U8(content: string, baseUrl?: string): ParsedM3U8 {
  const audioTracks: AudioTrack[] = [];
  const qualities: QualityLevel[] = [];
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  let currentStreamInf: Record<string, string> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse audio tracks: #EXT-X-MEDIA:TYPE=AUDIO,...
    if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      const attrString = line.substring('#EXT-X-MEDIA:'.length);
      const attrs = parseAttributes(attrString);

      const lang = attrs['LANGUAGE'] || attrs['NAME'] || 'unknown';
      const name = attrs['NAME'] || lang;
      const isDefault = attrs['DEFAULT'] === 'YES';
      const uri = attrs['URI'] || null;

      // Resolve relative URIs
      const resolvedUri = uri && baseUrl ? resolveUrl(uri, baseUrl) : uri;

      audioTracks.push({
        language: lang,
        name,
        default: isDefault,
        uri: resolvedUri,
        flagEmoji: getFlagEmoji(lang),
      });
    }

    // Parse stream info: #EXT-X-STREAM-INF:BANDWIDTH=...,RESOLUTION=...
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrString = line.substring('#EXT-X-STREAM-INF:'.length);
      currentStreamInf = parseAttributes(attrString);
    }

    // The line after #EXT-X-STREAM-INF is the URI
    if (currentStreamInf && !line.startsWith('#')) {
      const uri = baseUrl ? resolveUrl(line, baseUrl) : line;
      const resolution = currentStreamInf['RESOLUTION'] || '';
      const [widthStr, heightStr] = resolution.split('x');
      const width = parseInt(widthStr) || 0;
      const height = parseInt(heightStr) || 0;
      const bandwidth = parseInt(currentStreamInf['BANDWIDTH']) || 0;
      const name = currentStreamInf['NAME'] || `${height}p`;

      qualities.push({
        bandwidth,
        resolution,
        width,
        height,
        name,
        uri,
      });

      currentStreamInf = null;
    }
  }

  // Sort qualities: highest first
  qualities.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);

  // Deduplicate audio tracks by language
  const seenLangs = new Set<string>();
  const uniqueTracks: AudioTrack[] = [];
  for (const track of audioTracks) {
    const key = track.language.toLowerCase();
    if (!seenLangs.has(key)) {
      seenLangs.add(key);
      uniqueTracks.push(track);
    }
  }

  return {
    audioTracks: uniqueTracks,
    qualities,
  };
}

// Resolve a possibly relative URL against a base URL
function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  try {
    const base = new URL(baseUrl);
    if (url.startsWith('/')) {
      return `${base.origin}${url}`;
    }
    // Relative path
    const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
    return `${base.origin}${basePath}${url}`;
  } catch {
    return url;
  }
}

// Extract language info from StreamForge Castle-style results
// Castle returns multiple streams with language in the URL/title
export function detectCastleLanguages(results: Array<{ title?: string; url?: string; language?: string }>): string[] {
  const langs = new Set<string>();

  for (const result of results) {
    // Check explicit language field
    if (result.language) {
      langs.add(result.language.toLowerCase());
    }

    // Check URL for language hints (Castle style: Venom3_Hindi_720, Venom3_ENG_720, etc.)
    const url = result.url || '';
    const title = result.title || '';
    const combined = `${url} ${title}`.toLowerCase();

    if (combined.includes('hindi') || combined.includes('_hin')) langs.add('hi');
    if (combined.includes('tamil') || combined.includes('_tam') || combined.includes('_tel')) langs.add('ta');
    if (combined.includes('telugu') || combined.includes('_tel')) langs.add('te');
    if (combined.includes('korean') || combined.includes('_kor') || combined.includes('_ko')) langs.add('ko');
    if (combined.includes('french') || combined.includes('_fra') || combined.includes('vf')) langs.add('fr');
    if (combined.includes('english') || combined.includes('_eng') || combined.includes('_en')) langs.add('en');
    if (combined.includes('multi')) langs.add('multi');
  }

  return Array.from(langs);
}

// Generate flag emojis string from detected language codes
export function generateFlagsFromLangs(languages: string[]): string {
  const flags = languages.map(l => getFlagEmoji(l));
  // Deduplicate
  return [...new Set(flags)].join('');
}
