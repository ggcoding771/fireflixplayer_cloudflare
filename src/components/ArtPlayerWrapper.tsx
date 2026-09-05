'use client';

import React, { useEffect, useRef, useCallback, useState } from 'react';
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { motion, AnimatePresence } from 'framer-motion';
import type { AudioTrack, QualityLevel } from '@/lib/m3u8-parser';

export interface SubtitleTrack {
  label: string;
  url: string;
  type: 'vtt' | 'srt' | 'ass';
  language?: string;
  flagEmoji?: string;
}

interface ArtPlayerWrapperProps {
  url: string | null;
  headers?: Record<string, string>;
  qualities: QualityLevel[];
  audioTracks: AudioTrack[];
  /** How to play `url`: 'hls' → hls.js manifest; 'native' → direct <video> file
   *  (MP4/MKV). 'auto' (default) = legacy heuristic (m3u8//api/proxy → hls). */
  playbackType?: 'auto' | 'hls' | 'native';
  desiredAudioLanguage?: string;
  onAudioTrackChange?: (track: AudioTrack) => void;
  onHlsError?: () => void;
  onManifestParsed?: (data: { qualities: QualityLevel[]; audioTracks: AudioTrack[]; subtitleTracks: SubtitleTrack[] }) => void;
  /** Called on every timeupdate with the current playback time (seconds) */
  onTimeUpdate?: (time: number) => void;
  /** External VTT/SRT subtitle URLs (e.g. from MissouriMonster) */
  externalSubtitles?: SubtitleTrack[];
  /** Season number for postMessage reporting */
  season?: number;
  /** Episode number for postMessage reporting */
  episode?: number;
}

/**
 * Find the index of an audio track matching a desired language.
 * Matches against HLS.js track properties: lang, name, language (case-insensitive).
 * Also checks common language code variants (e.g., "hi" matches "hin", "hindi").
 */
function findAudioTrackIndex(
  audioTracks: Array<{ lang?: string; name?: string; language?: string; default?: boolean }>,
  desiredLanguage: string
): number {
  if (!desiredLanguage || audioTracks.length === 0) return -1;

  const desired = desiredLanguage.toLowerCase();

  // 1. Exact match on lang or language
  for (let i = 0; i < audioTracks.length; i++) {
    const track = audioTracks[i];
    if (track.lang?.toLowerCase() === desired || track.language?.toLowerCase() === desired) {
      return i;
    }
  }

  // 2. Exact match on name
  for (let i = 0; i < audioTracks.length; i++) {
    const track = audioTracks[i];
    if (track.name?.toLowerCase() === desired) {
      return i;
    }
  }

  // 3. Partial/fuzzy match: desired contains or is contained in lang/name/language
  for (let i = 0; i < audioTracks.length; i++) {
    const track = audioTracks[i];
    const fields = [track.lang, track.name, track.language].filter(Boolean).map(f => f!.toLowerCase());
    for (const field of fields) {
      if (field.includes(desired) || desired.includes(field)) {
        return i;
      }
    }
  }

  // 4. Check known language code variants
  const variantMap: Record<string, string[]> = {
    hi: ['hin', 'hindi'],
    en: ['eng', 'english'],
    ko: ['kor', 'korean'],
    fr: ['fra', 'french'],
    es: ['spa', 'spanish'],
    de: ['deu', 'ger', 'german'],
    ja: ['jpn', 'japanese'],
    zh: ['chi', 'chinese'],
    ar: ['ara', 'arabic'],
    ru: ['rus', 'russian'],
    pt: ['por', 'portuguese'],
    ta: ['tam', 'tamil'],
    te: ['tel', 'telugu'],
    it: ['ita', 'italian'],
    th: ['tha', 'thai'],
    bn: ['ben', 'bengali'],
  };

  const variants = variantMap[desired] || [];
  for (const variant of variants) {
    for (let i = 0; i < audioTracks.length; i++) {
      const track = audioTracks[i];
      const fields = [track.lang, track.name, track.language].filter(Boolean).map(f => f!.toLowerCase());
      if (fields.some(f => f === variant)) {
        return i;
      }
    }
  }

  // Also try reverse: if desired is a long form, check if any track's code is a known short form
  for (const [shortCode, longForms] of Object.entries(variantMap)) {
    if (longForms.includes(desired)) {
      for (let i = 0; i < audioTracks.length; i++) {
        const track = audioTracks[i];
        const fields = [track.lang, track.name, track.language].filter(Boolean).map(f => f!.toLowerCase());
        if (fields.some(f => f === shortCode || f === longForms[0])) {
          return i;
        }
      }
    }
  }

  return -1;
}

export function ArtPlayerWrapper({
  url,
  headers: _headers,
  qualities: _qualities,
  audioTracks: _audioTracks,
  playbackType = 'auto',
  desiredAudioLanguage,
  onAudioTrackChange,
  onHlsError,
  onManifestParsed,
  onTimeUpdate,
  externalSubtitles,
  season,
  episode,
}: ArtPlayerWrapperProps) {
  const artRef = useRef<HTMLDivElement>(null);
  const artInstanceRef = useRef<Artplayer | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const prevUrlRef = useRef<string | null>(null);
  const prevPlaybackTypeRef = useRef<'auto' | 'hls' | 'native'>('auto');
  const errorNotifiedRef = useRef(false);
  const manifestParsedRef = useRef(false);

  // ─── Double-tap seek state ─────────────────────────────────────────────
  const tapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapCountRef = useRef(0);
  const tapZoneRef = useRef<'left' | 'right' | null>(null);
  const [seekIndicator, setSeekIndicator] = useState<{ direction: 'left' | 'right'; seconds: number } | null>(null);

  // ─── Long-press speed state ────────────────────────────────────────────
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressActiveRef = useRef(false);
  const [speedIndicator, setSpeedIndicator] = useState<number | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const savedPlaybackRateRef = useRef<number>(1);

  // ─── Refs for callback props ───────────────────────────────────────────
  const onAudioTrackChangeRef = useRef(onAudioTrackChange);
  useEffect(() => {
    onAudioTrackChangeRef.current = onAudioTrackChange;
  }, [onAudioTrackChange]);

  const onHlsErrorRef = useRef(onHlsError);
  useEffect(() => {
    onHlsErrorRef.current = onHlsError;
  }, [onHlsError]);

  const onManifestParsedRef = useRef(onManifestParsed);
  useEffect(() => {
    onManifestParsedRef.current = onManifestParsed;
  }, [onManifestParsed]);

  const desiredAudioLanguageRef = useRef(desiredAudioLanguage);
  useEffect(() => {
    desiredAudioLanguageRef.current = desiredAudioLanguage;
  }, [desiredAudioLanguage]);

  const externalSubtitlesRef = useRef(externalSubtitles);
  useEffect(() => {
    externalSubtitlesRef.current = externalSubtitles;
  }, [externalSubtitles]);

  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
  }, [onTimeUpdate]);

  const seasonRef = useRef(season);
  useEffect(() => { seasonRef.current = season }, [season]);
  const episodeRef = useRef(episode);
  useEffect(() => { episodeRef.current = episode }, [episode]);

  const applyDesiredAudioLanguage = useCallback(() => {
    const hls = hlsRef.current;
    if (!hls || !desiredAudioLanguage) return;

    const audioTracks = hls.audioTracks;
    if (!audioTracks || audioTracks.length === 0) return;

    const idx = findAudioTrackIndex(audioTracks, desiredAudioLanguage);
    if (idx >= 0 && hls.audioTrack !== idx) {
      hls.audioTrack = idx;
    }
  }, [desiredAudioLanguage]);

  // Apply desired audio language when it changes and the player is already loaded
  useEffect(() => {
    if (manifestParsedRef.current && desiredAudioLanguage) {
      applyDesiredAudioLanguage();
    }
  }, [desiredAudioLanguage, applyDesiredAudioLanguage]);

  // ─── Touch gesture handlers ────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;

    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };

    // Start long-press timer (500ms)
    longPressTimerRef.current = setTimeout(() => {
      const art = artInstanceRef.current;
      if (!art) return;

      // Check finger hasn't moved more than 10px
      if (touchStartPosRef.current) {
        const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
        const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
        if (dx > 10 || dy > 10) return;
      }

      // Activate 2x speed
      longPressActiveRef.current = true;
      savedPlaybackRateRef.current = art.playbackRate;
      art.playbackRate = 2;
      setSpeedIndicator(2);
    }, 500);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch || !touchStartPosRef.current) return;

    const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);

    // If finger moved more than 10px, cancel long press
    if (dx > 10 || dy > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      // If long press was active, restore speed
      if (longPressActiveRef.current) {
        longPressActiveRef.current = false;
        const art = artInstanceRef.current;
        if (art) {
          art.playbackRate = savedPlaybackRateRef.current;
        }
        setSpeedIndicator(null);
      }
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const art = artInstanceRef.current;

    // Clear long-press timer
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // If long press was active, restore speed
    if (longPressActiveRef.current) {
      longPressActiveRef.current = false;
      if (art) {
        art.playbackRate = savedPlaybackRateRef.current;
      }
      setSpeedIndicator(null);
      return; // Don't process as tap
    }

    // Double-tap detection for seek
    if (!art || !art.duration) return;

    const touch = e.changedTouches[0];
    if (!touch) return;

    const rect = artRef.current?.getBoundingClientRect();
    if (!rect) return;

    const relX = touch.clientX - rect.left;
    const width = rect.width;
    const zone: 'left' | 'right' = relX < width / 3 ? 'left' : relX > (width * 2) / 3 ? 'right' : 'middle';

    if (zone === 'middle') {
      // Middle third — reset tap tracking (let ArtPlayer handle controls)
      tapCountRef.current = 0;
      tapZoneRef.current = null;
      return;
    }

    const now = Date.now();

    // Check if this is a double-tap in the same zone
    if (
      tapCountRef.current === 1 &&
      tapZoneRef.current === zone &&
      tapTimeoutRef.current
    ) {
      // Double-tap detected!
      clearTimeout(tapTimeoutRef.current);
      tapTimeoutRef.current = null;
      tapCountRef.current = 0;
      tapZoneRef.current = null;

      // Seek
      const seekSeconds = 10;
      if (zone === 'left') {
        art.currentTime = Math.max(0, art.currentTime - seekSeconds);
        setSeekIndicator({ direction: 'left', seconds: seekSeconds });
      } else {
        art.currentTime = Math.min(art.duration, art.currentTime + seekSeconds);
        setSeekIndicator({ direction: 'right', seconds: seekSeconds });
      }

      // Auto-hide indicator after 800ms
      setTimeout(() => setSeekIndicator(null), 800);
    } else {
      // First tap — start timeout window (300ms)
      tapCountRef.current = 1;
      tapZoneRef.current = zone;

      if (tapTimeoutRef.current) clearTimeout(tapTimeoutRef.current);
      tapTimeoutRef.current = setTimeout(() => {
        tapCountRef.current = 0;
        tapZoneRef.current = null;
        tapTimeoutRef.current = null;
      }, 300);
    }
  }, []);

  // Instance generation counter. Every initPlayer() call bumps it; async
  // callbacks (stall timers, retry backoffs) from older instances check it
  // and no-op. Without this, switching servers while a source is still
  // loading leaves the OLD source's stall timer armed — when it later fires
  // it calls notifyError() and wrongly marks the NEW (healthy, possibly
  // playing) source as failed, blanking the player with a false error.
  const playerGenRef = useRef(0);

  const initPlayer = useCallback(() => {
    if (!artRef.current) return;

    // Invalidate all timers/callbacks belonging to the previous instance
    const gen = ++playerGenRef.current;
    const isStale = () => gen !== playerGenRef.current;

    // Destroy previous instances
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (artInstanceRef.current) {
      artInstanceRef.current.destroy(false);
      artInstanceRef.current = null;
    }

    errorNotifiedRef.current = false;
    manifestParsedRef.current = false;

    const art = new Artplayer({
      container: artRef.current,
      url: '',
      volume: 1,
      autoplay: true,
      autoSize: false,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      theme: '#e50914',
      setting: true,
      hotkey: true,
      pip: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      autoPlayback: false,
      airplay: true,
      settings: [],
    });

    artInstanceRef.current = art;

    // ─── PostMessage progress reporting ─────────────────────────────────
    art.on('video:timeupdate', () => {
      if (art.duration > 0) {
        // Report current time to parent via onTimeUpdate callback
        onTimeUpdateRef.current?.(art.currentTime);

        try {
          window.parent.postMessage({
            type: 'PLAYER_EVENT',
            data: {
              currentTime: art.currentTime,
              duration: art.duration,
              season: seasonRef.current,
              episode: episodeRef.current,
            },
          }, '*');
        } catch {
          // postMessage may fail in some contexts
        }
      }
    });

    // ─── Seeked event ───────────────────────────────────────────────────────
    art.on('video:seeked', () => {
      // Seek completed
    });

    if (!url) return;

    // Playback mode: the backend tells us how to play the stream. Direct
    // files (MP4/MKV from Titan/Lyra/Aries) MUST go through the native
    // <video> element — hls.js can never start on a raw file (it spins
    // forever retrying a manifest that will never parse).
    const forceNative = playbackType === 'native';
    const isHls = !forceNative && (url.includes('.m3u8') || url.includes('/api/proxy') || playbackType === 'hls');

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        // ── Bank-while-cool buffer policy ────────────────────────────────
        // acek-cdn (Comet) throttles the Space's egress per-IP-aggregate:
        // cold burst ~600KB/s, sustained-hot ~50-90KB/s vs ~211KB/s needed
        // for 720p. A 90s forward buffer banks ~2 minutes of video while the
        // IP is cool, then drains through the hot windows while hls.js's
        // patient loader (45s/8 retries) keeps catching up in bursts.
        maxBufferLength: 90,
        maxMaxBufferLength: 120,
        maxBufferSize: 90 * 1000 * 1000,
        startLevel: -1,
        enableWorker: true,
        lowLatencyMode: false,
        startFragPrefetch: true,
        enableSubtitles: true,
        // ── Slow-origin tolerance ──────────────────────────────────────────
        // The Space-proxy chain serves some CDNs' segments at ~400-500KB/s
        // PER CONNECTION (acek-cdn throttles via the token's sp=500 param).
        // A 5MB video segment then takes 11-13s — hls.js's DEFAULT 20s
        // fragLoadingTimeOut is one congested fetch away from declaring a
        // fatal fragLoadTimeout, which after retries surfaces as
        // "X isn't responding" even though the stream was playing fine.
        // Give the loader enough rope: 45s per attempt + 8 retries, and
        // longer level/manifest budgets for cold-cache playlist loads.
        fragLoadingTimeOut: 45000,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 1000,
        fragLoadingMaxRetryTimeout: 64000,
        levelLoadingTimeOut: 30000,
        levelLoadingMaxRetry: 6,
        manifestLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;

      hls.loadSource(url);
      hls.attachMedia(art.video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        manifestParsedRef.current = true;

        // Auto-play once manifest is parsed
        art.video.play().catch(() => {
          // Autoplay blocked
        });

        // Apply desired audio language if specified
        const currentDesiredLang = desiredAudioLanguageRef.current;
        if (currentDesiredLang && data.audioTracks && data.audioTracks.length > 0) {
          const idx = findAudioTrackIndex(data.audioTracks, currentDesiredLang);
          if (idx >= 0) {
            hls.audioTrack = idx;
          }
        }

        // --- Quality selector ---
        if (data.levels && data.levels.length > 0) {
          const sortedLevels = [...data.levels].sort(
            (a, b) => (b.height || 0) - (a.height || 0)
          );

          const qualityOptions = [
            { html: 'Auto', value: -1, default: true },
            ...sortedLevels.map((level, sortedIndex) => {
              const originalIndex = data.levels.indexOf(level);
              const label = level.height
                ? `${level.height}p${level.bitrate ? ` (${Math.round(level.bitrate / 1000)}k)` : ''}`
                : `Level ${sortedIndex}`;
              return {
                html: label,
                value: originalIndex,
                default: false,
              };
            }),
          ];

          art.setting.add({
            html: 'Quality',
            width: 200,
            selector: qualityOptions,
            onSelect: (item: { html: string; value: number }) => {
              hls.currentLevel = item.value;
              return item.html;
            },
          });
        }

        // --- Audio track selector ---
        if (data.audioTracks && data.audioTracks.length > 0) {
          let defaultTrackIndex = 0;
          const defaultTrack = data.audioTracks.find((t: { default?: boolean }) => t.default);
          if (defaultTrack) {
            defaultTrackIndex = data.audioTracks.indexOf(defaultTrack);
          }

          if (currentDesiredLang) {
            const desiredIdx = findAudioTrackIndex(data.audioTracks, currentDesiredLang);
            if (desiredIdx >= 0) {
              defaultTrackIndex = desiredIdx;
            }
          }

          const audioOptions = data.audioTracks.map((track: { lang?: string; name?: string; default?: boolean; language?: string }, index: number) => {
            const langCode = track.lang || track.language || '';
            const displayName = track.name || langCode || `Track ${index + 1}`;
            const flag = getFlagForLang(langCode);
            const isDefault = index === defaultTrackIndex;
            return {
              html: `${flag} ${displayName}`,
              value: index,
              default: isDefault,
            };
          });

          art.setting.add({
            html: 'Audio',
            width: 220,
            selector: audioOptions,
            onSelect: (item: { html: string; value: number }) => {
              hls.audioTrack = item.value;
              const track = data.audioTracks[item.value];
              if (track) {
                onAudioTrackChangeRef.current?.({
                  language: track.lang || track.language || '',
                  name: track.name || track.lang || track.language || '',
                  default: track.default || false,
                  uri: null,
                  flagEmoji: getFlagForLang(track.lang || track.language || ''),
                });
              }
              return item.html;
            },
          });

          const activeTrack = data.audioTracks[defaultTrackIndex] || data.audioTracks[0];
          const activeFlag = getFlagForLang(activeTrack?.lang || activeTrack?.language || '');
          art.controls.add({
            position: 'right',
            html: `<span data-audio-flag="true" style="font-size:11px;padding:0 4px;opacity:0.7;cursor:pointer">${activeFlag}</span>`,
            click: () => {
              art.setting.toggle();
            },
          });
        }

        // --- Subtitle track selector ---
        // Strategy: Use ArtPlayer's built-in subtitle overlay (sleek, well-formatted).
        // When a subtitle is selected, set hls.subtitleTrack and art.subtitleShow = true.
        // The textTrack.mode stays 'showing' (ArtPlayer needs this to detect cues).
        // Native ::cue rendering is suppressed via CSS (display: none) so only
        // ArtPlayer's overlay is visible — no double rendering.
        const allSubtitleOptions: Array<{ html: string; value: number | string; default: boolean }> = [
          { html: 'Off', value: -1, default: true },
        ];

        // HLS embedded subtitles
        if (data.subtitleTracks && data.subtitleTracks.length > 0) {
          data.subtitleTracks.forEach((track: { lang?: string; name?: string; language?: string; default?: boolean }, index: number) => {
            const langCode = track.lang || track.language || '';
            const displayName = track.name || langCode || `Sub ${index + 1}`;
            const flag = getFlagForLang(langCode);
            allSubtitleOptions.push({
              html: `${flag} ${displayName}`,
              value: `hls-${index}`,
              default: false,
            });
          });
        }

        // External VTT subtitles (from MissouriMonster)
        const extSubs = externalSubtitlesRef.current || [];
        if (extSubs.length > 0) {
          extSubs.forEach((sub, index) => {
            const flag = sub.flagEmoji || getFlagForLang(sub.language || '');
            allSubtitleOptions.push({
              html: `${flag} ${sub.label}`,
              value: `ext-${index}`,
              default: false,
            });
          });
        }

        if (allSubtitleOptions.length > 1) {
          art.setting.add({
            html: 'Subtitles',
            width: 220,
            selector: allSubtitleOptions,
            onSelect: (item: { html: string; value: number | string }) => {
              const val = item.value;

              // Turn off subtitles
              if (val === -1) {
                hls.subtitleTrack = -1;
                const existingTrack = art.video.querySelector('track[data-ext-sub]');
                if (existingTrack) existingTrack.remove();
                art.subtitleShow = false;
                return 'Off';
              }

              // HLS embedded subtitle
              if (typeof val === 'string' && val.startsWith('hls-')) {
                const idx = parseInt(val.replace('hls-', ''));

                // Remove external track if switching to HLS
                const existingTrack = art.video.querySelector('track[data-ext-sub]');
                if (existingTrack) existingTrack.remove();

                // Tell HLS.js to load this subtitle track.
                // HLS.js will set textTrack.mode = 'showing' which ArtPlayer needs
                // to detect cues and render its overlay. Native ::cue rendering is
                // hidden via CSS.
                hls.subtitleTrack = idx;
                art.subtitleShow = true;

                return item.html;
              }

              // External VTT subtitle
              if (typeof val === 'string' && val.startsWith('ext-')) {
                const idx = parseInt(val.replace('ext-', ''));
                const sub = extSubs[idx];
                if (!sub) return 'Off';

                // Disable HLS subtitle
                hls.subtitleTrack = -1;

                // Remove previous external track
                const existingTrack = art.video.querySelector('track[data-ext-sub]');
                if (existingTrack) existingTrack.remove();

                // Add new track element — mode defaults to 'showing' for the
                // default track, which ArtPlayer needs to detect cues
                const trackEl = document.createElement('track');
                trackEl.setAttribute('kind', 'subtitles');
                trackEl.setAttribute('label', sub.label);
                trackEl.setAttribute('src', sub.url);
                trackEl.setAttribute('srcLang', sub.language || '');
                trackEl.setAttribute('data-ext-sub', 'true');
                trackEl.setAttribute('default', '');
                art.video.appendChild(trackEl);

                // Ensure the new track is in 'showing' mode and others are disabled
                const ensureTrackMode = () => {
                  for (let i = 0; i < art.video.textTracks.length; i++) {
                    const t = art.video.textTracks[i];
                    if (t.kind === 'subtitles' || t.kind === 'captions') {
                      if (t.label === sub.label || t.language === (sub.language || '')) {
                        t.mode = 'showing'; // ArtPlayer needs this
                      } else {
                        t.mode = 'disabled';
                      }
                    }
                  }
                };
                ensureTrackMode();
                setTimeout(ensureTrackMode, 100);
                setTimeout(ensureTrackMode, 500);

                art.subtitleShow = true;

                return item.html;
              }

              return item.html;
            },
          });

          // Add CC indicator in control bar
          art.controls.add({
            position: 'right',
            html: `<span data-sub-flag="true" style="font-size:11px;padding:0 4px;opacity:0.5;cursor:pointer">CC</span>`,
            click: () => {
              art.setting.toggle();
            },
          });
        }

        // Notify parent about parsed manifest data
        const parsedQualities: QualityLevel[] = (data.levels || []).map((level, idx) => ({
          bandwidth: level.bitrate || 0,
          resolution: level.width && level.height ? `${level.width}x${level.height}` : '',
          width: level.width || 0,
          height: level.height || 0,
          name: level.height ? `${level.height}p` : `Level ${idx}`,
          uri: level.url?.[0] || '',
        }));

        const parsedAudioTracks: AudioTrack[] = (data.audioTracks || []).map((track: { lang?: string; name?: string; default?: boolean; language?: string }, idx: number) => ({
          language: track.lang || track.language || '',
          name: track.name || track.lang || track.language || `Track ${idx + 1}`,
          default: track.default || false,
          uri: null,
          flagEmoji: getFlagForLang(track.lang || track.language || ''),
        }));

        const parsedSubtitleTracks: SubtitleTrack[] = (data.subtitleTracks || []).map((track: { lang?: string; name?: string; language?: string }, idx: number) => ({
          label: track.name || track.lang || track.language || `Sub ${idx + 1}`,
          url: '',
          type: 'vtt' as const,
          language: track.lang || track.language || '',
          flagEmoji: getFlagForLang(track.lang || track.language || ''),
        }));

        onManifestParsedRef.current?.({
          qualities: parsedQualities,
          audioTracks: parsedAudioTracks,
          subtitleTracks: parsedSubtitleTracks,
        });
      });

      // Listen for audio track switches to update the control bar flag
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
        const track = hls.audioTracks?.[data.id];
        if (track) {
          const flag = getFlagForLang(track.lang || track.language || '');
          const flagEl = artRef.current?.querySelector('[data-audio-flag]');
          if (flagEl) {
            flagEl.textContent = flag;
          }
        }
      });

      // Listen for subtitle track switches to update CC indicator
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_event, data) => {
        const ccEl = artRef.current?.querySelector('[data-sub-flag]');
        if (ccEl) {
          if (data.id >= 0) {
            const track = hls.subtitleTracks?.[data.id];
            const lang = track?.lang || track?.language || '';
            const flag = getFlagForLang(lang);
            ccEl.textContent = flag;
            (ccEl as HTMLElement).style.opacity = '0.9';
          } else {
            ccEl.textContent = 'CC';
            (ccEl as HTMLElement).style.opacity = '0.5';
          }
        }
      });

      // Stall detection
      let stallTimeout: ReturnType<typeof setTimeout> | null = null;
      let hasStartedPlaying = false;

      hls.on(Hls.Events.FRAG_LOADED, () => {
        hasStartedPlaying = true;
        if (stallTimeout) {
          clearTimeout(stallTimeout);
          stallTimeout = null;
        }
      });

      // Data arrived in the video element (readyState >= HAVE_CURRENT_DATA)
      // — the stream is NOT stuck even if playback hasn't started yet
      // (autoplay may be blocked waiting for user interaction).
      const clearStallIfDataReady = () => {
        if (stallTimeout && art.video.readyState >= 2) {
          hasStartedPlaying = true;
          clearTimeout(stallTimeout);
          stallTimeout = null;
        }
      };
      art.on('video:loadeddata', clearStallIfDataReady);
      art.on('video:canplay', clearStallIfDataReady);

      art.on('video:playing', () => {
        hasStartedPlaying = true;
        if (stallTimeout) {
          clearTimeout(stallTimeout);
          stallTimeout = null;
        }
      });

      // HLS error handling — aggressive recovery for transient errors
      // Don't reject the source just because of a brief network blip.
      // Only give up if we can't recover after many attempts.
      let recoveryAttempts = 0;
      const MAX_NETWORK_RECOVERY = 7;  // Slow-CDN windows can last minutes; each startLoad() re-arms hls.js's own retry cycle
      const MAX_MEDIA_RECOVERY = 3;    // Media errors are usually more serious

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;

        console.warn(`[HLS] Fatal error (type: ${data.type}, attempt: ${recoveryAttempts + 1}):`, data.details);

        const maxAttempts = data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? MAX_NETWORK_RECOVERY
          : MAX_MEDIA_RECOVERY;

        if (recoveryAttempts < maxAttempts) {
          recoveryAttempts++;
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          const backoffMs = Math.min(1000 * Math.pow(2, recoveryAttempts - 1), 16000);

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Network error — retry with backoff
              console.log(`[HLS] Retrying network load in ${backoffMs}ms...`);
              setTimeout(() => {
                // Never act on behalf of a destroyed instance — the user may
                // have already switched to a different source/server.
                if (isStale() || errorNotifiedRef.current) return;
                hls.startLoad();
              }, backoffMs);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log(`[HLS] Attempting media error recovery...`);
              hls.recoverMediaError();
              break;
            default:
              notifyError();
              break;
          }
        } else {
          console.warn(`[HLS] Max recovery attempts (${maxAttempts}) reached, giving up on this source`);
          notifyError();
        }
      });

      // Stall timeout — only for initial load, not mid-playback hiccups.
      // 35s budget: first-load of large playlists through the edge proxy can be
      // slow on a cold cache (upstream fetch + 458KB playlist). If the video
      // already has data (readyState >= 2) or any buffered range, the stream is
      // fine — it's just paused waiting for the user (autoplay blocked).
      stallTimeout = setTimeout(() => {
        // Orphaned timer from a previous source — the user switched servers
        // before this one finished loading. Never blame the current source.
        if (isStale()) return;
        const vid = art.video;
        const hasData = vid.readyState >= 2 || vid.buffered.length > 0;
        if (!hasStartedPlaying && !hasData) {
          console.warn('[HLS] Stream stuck after 35s, skipping...');
          notifyError();
        }
      }, 35000);

    } else if (isHls && art.video.canPlayType('application/vnd.apple.mpegurl')) {
      art.video.src = url;
    } else if (!isHls) {
      // ── Direct file (MP4/MKV) — native <video> playback via the proxy ──
      // The proxy forwards Range and returns 206/Content-Range, so seeking
      // and progressive streaming work like a normal file server.
      art.url = url;

      let nativeStallTimeout: ReturnType<typeof setTimeout> | null = null;
      let nativeStarted = false;

      const clearNativeStall = () => {
        nativeStarted = true;
        if (nativeStallTimeout) {
          clearTimeout(nativeStallTimeout);
          nativeStallTimeout = null;
        }
      };
      art.on('video:loadeddata', clearNativeStall);
      art.on('video:canplay', clearNativeStall);
      art.on('video:playing', clearNativeStall);

      // Safety net: if a "direct" URL is actually an HLS playlist (mislabeled
      // upstream), the <video> element errors before any data arrives — retry
      // once with hls.js before declaring the source dead.
      let hlsFallbackTried = false;
      const tryHlsFallback = () => {
        if (hlsFallbackTried || isStale()) return;
        hlsFallbackTried = true;
        if (!Hls.isSupported()) {
          notifyError();
          return;
        }
        console.log('[Player] Direct file failed before data — retrying as HLS...');
        const fhls = new Hls({
          maxBufferLength: 90,
          maxMaxBufferLength: 120,
          maxBufferSize: 90 * 1000 * 1000,
          startLevel: -1,
          enableWorker: true,
          lowLatencyMode: false,
        });
        hlsRef.current = fhls;
        fhls.loadSource(url);
        fhls.attachMedia(art.video);
        fhls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (isStale()) return;
          art.video.play().catch(() => { /* autoplay blocked */ });
        });
        fhls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal || isStale()) return;
          notifyError();
        });
      };

      art.on('video:error', () => {
        if (isStale()) return;
        const vid = art.video;
        const hasData = vid.readyState >= 2 || vid.buffered.length > 0;
        if (!hasData && !hlsFallbackTried) {
          tryHlsFallback();
        } else {
          notifyError();
        }
      });

      // Stall timeout — same 35s budget as the HLS path: if the file never
      // delivers any data (dead CDN, hanging connection), blame this source
      // instead of spinning forever.
      nativeStallTimeout = setTimeout(() => {
        if (isStale()) return;
        const vid = art.video;
        const hasData = vid.readyState >= 2 || vid.buffered.length > 0;
        if (!nativeStarted && !hasData) {
          console.warn('[Player] Direct file stuck after 35s, skipping...');
          notifyError();
        }
      }, 35000);
    }
  }, [url, playbackType, desiredAudioLanguage, applyDesiredAudioLanguage]);

  function notifyError() {
    if (errorNotifiedRef.current) return;
    errorNotifiedRef.current = true;
    onHlsErrorRef.current?.();
  }

  useEffect(() => {
    if (url !== prevUrlRef.current || playbackType !== prevPlaybackTypeRef.current) {
      prevUrlRef.current = url;
      prevPlaybackTypeRef.current = playbackType;
      initPlayer();
    }
  }, [url, playbackType, initPlayer]);

  // ─── Listen for parent postMessage commands ─────────────────────────────
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const art = artInstanceRef.current;
      if (!art) return;

      if (typeof event.data !== 'object' || event.data === null) return;
      const { command, value } = event.data;

      if (command === 'seek' && typeof value === 'number') {
        art.currentTime = value;
      } else if (command === 'setPlaybackRate' && typeof value === 'number') {
        art.playbackRate = value;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    return () => {
      // Kill any orphaned timers from the last instance before unmounting
      playerGenRef.current++;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (artInstanceRef.current) {
        artInstanceRef.current.destroy(false);
        artInstanceRef.current = null;
      }
      if (tapTimeoutRef.current) {
        clearTimeout(tapTimeoutRef.current);
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  return (
    <div
      className="relative"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* ─── CSS to suppress native ::cue rendering ─────────────────────── */}
      {/* ArtPlayer renders subtitles in its own sleek overlay (.art-subtitle).
          The browser also renders subtitles natively via ::cue pseudo-element
          when textTrack.mode = 'showing'. We need 'showing' mode so ArtPlayer
          can detect cues, but we must hide the native rendering to prevent
          double subtitles. display:none on ::cue completely hides the native
          rendering while keeping the cue data accessible to ArtPlayer. */}
      <style dangerouslySetInnerHTML={{ __html: `
        video::cue {
          display: none !important;
        }
      ` }} />

      <div
        ref={artRef}
        style={{
          width: '100%',
          aspectRatio: '16/9',
          maxHeight: '100vh',
          background: '#000',
        }}
      />

      {/* ─── Double-tap seek visual indicator ─────────────────────────────── */}
      <AnimatePresence>
        {seekIndicator && (
          <motion.div
            key={`seek-${seekIndicator.direction}-${Date.now()}`}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2 }}
            className={`absolute top-1/2 -translate-y-1/2 z-30 pointer-events-none
              ${seekIndicator.direction === 'left' ? 'left-[15%]' : 'right-[15%]'}`}
          >
            <div className="flex flex-col items-center gap-1">
              {/* Ripple effect */}
              <motion.div
                className="absolute w-16 h-16 rounded-full bg-white/10"
                initial={{ scale: 0.5, opacity: 0.6 }}
                animate={{ scale: 2.5, opacity: 0 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              />
              <div className="relative flex items-center justify-center w-12 h-12 rounded-full bg-black/40 backdrop-blur-sm">
                {seekIndicator.direction === 'left' ? (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 4v6h6" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                )}
              </div>
              <span className="text-white text-xs font-medium bg-black/50 px-2 py-0.5 rounded">
                {seekIndicator.direction === 'left' ? '-' : '+'}{seekIndicator.seconds}s
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Hold-to-2x speed indicator ───────────────────────────────────── */}
      <AnimatePresence>
        {speedIndicator !== null && (
          <motion.div
            key="speed-indicator"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none"
          >
            <div className="flex flex-col items-center gap-1">
              <motion.div
                className="absolute w-20 h-20 rounded-full bg-white/5"
                initial={{ scale: 0.5, opacity: 0.4 }}
                animate={{ scale: 1.5, opacity: 0 }}
                transition={{ duration: 0.5, repeat: Infinity, ease: 'easeOut' }}
              />
              <div className="relative flex items-center justify-center w-14 h-14 rounded-full bg-black/50 backdrop-blur-sm border border-white/20">
                <span className="text-white text-lg font-bold">{speedIndicator}x</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function getFlagForLang(lang: string): string {
  if (!lang) return '🌍';
  const flags: Record<string, string> = {
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
    kn: '🇮🇳', kan: '🇮🇳', kannada: '🇮🇳',
    ml: '🇮🇳', mal: '🇮🇳', malayalam: '🇮🇳',
    multi: '🌍',
    und: '❓',
  };
  return flags[lang.toLowerCase()] || '🌍';
}
