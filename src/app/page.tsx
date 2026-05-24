'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, useCallback, useRef } from 'react';
import { EmbedPlayer } from '@/components/EmbedPlayer';
import { ArtPlayerWrapper } from '@/components/ArtPlayerWrapper';
import { ServerSelector } from './ServerSelector';
import IntroSkipOverlay from '@/components/IntroSkipOverlay';

// ─── Types for embed mode ─────────────────────────────────────────────────────

interface EmbedStreamSource {
  source: string
  label: string
  url: string
  language?: string
  quality?: string
}

interface EmbedStreamData {
  sources: EmbedStreamSource[]
  subtitles: Array<{ label: string; file: string; type: string }>
}

interface IntroDBSegment {
  start_sec: number
  end_sec: number
}

// ─── Embed Mode Player ────────────────────────────────────────────────────────

interface EmbedModePlayerProps {
  tmdbId: string;
  mediaType: 'movie' | 'tv';
  season: number;
  episode: number;
  imdbId: string | null;
  autoSkipIntro: boolean;
  autoSkipOutro: boolean;
  autoPlayNext: boolean;
}

function EmbedModePlayer({
  tmdbId,
  mediaType,
  season,
  episode,
  imdbId,
  autoSkipIntro,
  autoSkipOutro,
  autoPlayNext,
}: EmbedModePlayerProps) {
  const [streamData, setStreamData] = useState<EmbedStreamData | null>(null);
  const [sortedSources, setSortedSources] = useState<EmbedStreamSource[]>([]);
  const [currentSourceIndex, setCurrentSourceIndex] = useState(0);
  const [currentSource, setCurrentSource] = useState<EmbedStreamSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedSources, setFailedSources] = useState<Set<string>>(new Set());

  // IntroDB segments
  const [introSegment, setIntroSegment] = useState<IntroDBSegment | null>(null);
  const [recapSegment, setRecapSegment] = useState<IntroDBSegment | null>(null);
  const [outroSegment, setOutroSegment] = useState<IntroDBSegment | null>(null);

  // Player time tracking
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);

  // Current episode state (mutable for next episode navigation)
  const [currentSeason, setCurrentSeason] = useState(season);
  const [currentEpisode, setCurrentEpisode] = useState(episode);

  // Mutable settings state (initialized from URL params, can be updated via postMessage)
  const [autoSkipIntroState, setAutoSkipIntroState] = useState(autoSkipIntro);
  const [autoSkipOutroState, setAutoSkipOutroState] = useState(autoSkipOutro);
  const [autoPlayNextState, setAutoPlayNextState] = useState(autoPlayNext);

  // Refs
  const failedSourcesRef = useRef<Set<string>>(new Set());
  const sortedSourcesRef = useRef<EmbedStreamSource[]>([]);
  const currentSourceIndexRef = useRef(0);

  useEffect(() => { sortedSourcesRef.current = sortedSources }, [sortedSources]);
  useEffect(() => { currentSourceIndexRef.current = currentSourceIndex }, [currentSourceIndex]);
  useEffect(() => { failedSourcesRef.current = failedSources }, [failedSources]);

  // ─── Fetch stream data with retry for network hiccups ────────────────────────
  useEffect(() => {
    if (!tmdbId) return;
    let cancelled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [2000, 4000, 8000]; // exponential backoff

    const fetchStreams = async () => {
      setLoading(true);
      setError(null);
      setStreamData(null);
      setCurrentSource(null);
      setCurrentSourceIndex(0);
      setFailedSources(new Set());

      try {
        const params = new URLSearchParams({ id: tmdbId, type: mediaType });
        if (mediaType === 'tv') {
          params.set('season', currentSeason.toString());
          params.set('episode', currentEpisode.toString());
        }

        const response = await fetch(`/api/stream?${params}`);
        if (!response.ok || cancelled) throw new Error(`Stream API error: ${response.status}`);

        const data: EmbedStreamData = await response.json();
        if (cancelled) return;

        if (!data.sources || data.sources.length === 0) {
          // No sources — retry with backoff before giving up
          if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAYS[retryCount];
            retryCount++;
            console.log(`[EmbedPlayer] No sources, retry ${retryCount}/${MAX_RETRIES} in ${delay}ms`);
            setLoading(true);
            await new Promise(r => setTimeout(r, delay));
            if (!cancelled) fetchStreams();
            return;
          }
          setError('No streams available for this content');
          setLoading(false);
          return;
        }

        // Sort sources by priority: Moon(netmirror) → Castle → Atlas(vidrock) → Lyra(cinesu) → rest
        // Uses prefix matching so "netmirror_netflix" matches "netmirror", etc.
        const sorted = [...data.sources].sort((a, b) => {
          const priorityOrder = [
            'netmirror', 'castle', 'vidrock', 'cinesu',
            'dooflix', 'movieboxhindi', 'vidnest', 'allmovieland',
            'videasy', 'vidlink', 'flixhq', 'icefy',
            'meowtv', 'cinezo', 'vidzee', 'vidfun',
            'showbox', 'popr', 'vidking', 'vixsrc',
          ];
          const getPriority = (source: string) => {
            // Exact match first
            const exact = priorityOrder.indexOf(source);
            if (exact !== -1) return exact;
            // Prefix match: "netmirror_netflix" matches "netmirror"
            for (let i = 0; i < priorityOrder.length; i++) {
              if (source.startsWith(priorityOrder[i] + '_') || source.startsWith(priorityOrder[i])) {
                return i;
              }
            }
            return 999;
          };
          return getPriority(a.source) - getPriority(b.source);
        });

        setStreamData(data);
        setSortedSources(sorted);
        setCurrentSourceIndex(0);
        setCurrentSource(sorted[0]);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.error('[EmbedPlayer] Fetch error:', err);
          // Retry with backoff for network errors
          if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAYS[retryCount];
            retryCount++;
            console.log(`[EmbedPlayer] Fetch error, retry ${retryCount}/${MAX_RETRIES} in ${delay}ms`);
            setLoading(true);
            await new Promise(r => setTimeout(r, delay));
            if (!cancelled) fetchStreams();
            return;
          }
          setError('Failed to load stream data. Click retry.');
          setLoading(false);
        }
      }
    };

    fetchStreams();
    return () => { cancelled = true };
  }, [tmdbId, mediaType, currentSeason, currentEpisode]);

  // When imdbId is missing, segments are cleared via derived state
  const hasImdb = !!imdbId;

  // ─── Fetch IntroDB segments ───────────────────────────────────────────────
  useEffect(() => {
    if (!imdbId) return;

    let cancelled = false;

    const fetchIntroDB = async () => {
      try {
        const params = new URLSearchParams({ imdb_id: imdbId });
        if (mediaType === 'tv') {
          params.set('season', currentSeason.toString());
          params.set('episode', currentEpisode.toString());
        }

        const response = await fetch(`/api/introdb?${params}`);
        if (!response.ok || cancelled) return;

        const data = await response.json();
        if (cancelled) return;

        setIntroSegment(data.intro || null);
        setRecapSegment(data.recap || null);
        setOutroSegment(data.outro || null);
      } catch (err) {
        console.error('[EmbedPlayer] IntroDB fetch error:', err);
      }
    };

    fetchIntroDB();
    return () => { cancelled = true };
  }, [imdbId, mediaType, currentSeason, currentEpisode]);

  // Derived segment state — null when no imdbId
  const activeIntroSeg = hasImdb ? introSegment : null;
  const activeRecapSeg = hasImdb ? recapSegment : null;
  const activeOutroSeg = hasImdb ? outroSegment : null;

  // ─── Handle skip to time (from IntroSkipOverlay or parent postMessage) ───
  const handleSkipTo = useCallback((seconds: number) => {
    const videoEl = document.querySelector('.artvideo-player video') as HTMLVideoElement;
    if (videoEl) videoEl.currentTime = seconds;
  }, []);

  // ─── Listen for PLAYER_EVENT messages from ArtPlayerWrapper AND parent commands ──
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'object' || event.data === null) return;

      // Handle PLAYER_EVENT from ArtPlayerWrapper (time/duration updates)
      if (event.data.type === 'PLAYER_EVENT' && event.data.data) {
        const d = event.data.data;
        if (d?.currentTime !== undefined) setPlayerCurrentTime(Number(d.currentTime));
        if (d?.duration !== undefined && Number(d.duration) > 0) setPlayerDuration(Number(d.duration));
        return;
      }

      // Handle parent commands
      const { command, value } = event.data;
      if (command === 'seek' && typeof value === 'number') {
        const videoEl = document.querySelector('.artvideo-player video') as HTMLVideoElement;
        if (videoEl) videoEl.currentTime = value;
      } else if (command === 'setAutoSkipIntro' && typeof value === 'boolean') {
        setAutoSkipIntroState(value);
      } else if (command === 'setAutoSkipOutro' && typeof value === 'boolean') {
        setAutoSkipOutroState(value);
      } else if (command === 'setAutoPlayNext' && typeof value === 'boolean') {
        setAutoPlayNextState(value);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // ─── Handle HLS error — auto-fallback to next source ──────────────────────
  const handleHlsError = useCallback(() => {
    const currentId = currentSource?.source;
    if (!currentId) return;

    // Mark current source as failed
    setFailedSources(prev => {
      const next = new Set(prev);
      next.add(currentId);
      failedSourcesRef.current = next;
      return next;
    });

    // Try next available source automatically
    const currentIdx = sortedSourcesRef.current.findIndex(s => s.source === currentId);
    for (let i = currentIdx + 1; i < sortedSourcesRef.current.length; i++) {
      const nextSource = sortedSourcesRef.current[i];
      if (!failedSourcesRef.current.has(nextSource.source)) {
        console.log(`[EmbedPlayer] Auto-fallback: ${currentId} → ${nextSource.source}`);
        setCurrentSourceIndex(i);
        setCurrentSource(nextSource);
        return;
      }
    }

    // No more sources to try
    setError('Playback error. All servers failed. Click retry.');
  }, [currentSource?.source]);

  // ─── Handle next episode ──────────────────────────────────────────────────
  const handleNextEpisode = useCallback(() => {
    if (mediaType !== 'tv') return;

    // Report episode change to parent
    try {
      window.parent.postMessage({
        type: 'PLAYER_EVENT',
        data: {
          event: 'episodeChange',
          season: currentSeason,
          episode: currentEpisode + 1,
        },
      }, '*');
    } catch {
      // postMessage may fail in some contexts
    }

    // Simple next episode logic
    setCurrentEpisode(prev => prev + 1);
  }, [mediaType, currentSeason, currentEpisode]);

  // No source selector UI in embed mode — auto-fallback works silently

  return (
    <div className="h-dvh bg-black flex items-center justify-center">
      <div className="w-full">
        <div className="relative w-full bg-black" style={{ aspectRatio: '16/9' }}>
          {/* Player */}
          <div className="absolute inset-0" style={{ zIndex: 1 }}>
            <ArtPlayerWrapper
              url={currentSource?.url || null}
              qualities={[]}
              audioTracks={[]}
              onHlsError={handleHlsError}
              season={currentSeason}
              episode={currentEpisode}
            />
          </div>

          {/* No source selector in embed mode — auto-fallback works silently */}

          {/* IntroSkipOverlay */}
          <IntroSkipOverlay
            mediaType={mediaType}
            season={currentSeason}
            episode={currentEpisode}
            introSegment={activeIntroSeg}
            recapSegment={activeRecapSeg}
            outroSegment={activeOutroSeg}
            currentTime={playerCurrentTime}
            duration={playerDuration}
            autoSkipIntro={autoSkipIntroState}
            autoSkipOutro={autoSkipOutroState}
            autoPlayNext={autoPlayNextState}
            onSkipTo={handleSkipTo}
            onNextEpisode={handleNextEpisode}
          />

          {/* Loading overlay */}
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80" style={{ zIndex: 5 }}>
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <p className="text-sm text-zinc-400">Loading stream...</p>
              </div>
            </div>
          )}

          {/* Error overlay */}
          {error && !loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80" style={{ zIndex: 5 }}>
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm text-zinc-400">{error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    setFailedSources(new Set());
                    setCurrentSourceIndex(0);
                    setCurrentSource(sortedSources[0] || null);
                  }}
                  className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-sm rounded-md transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Standalone Mode Player (original EmbedPlayer with IntroSkipOverlay) ──────

interface StandaloneModePlayerProps {
  tmdbId: string;
  type: 'movie' | 'tv';
  season?: string;
  episode?: string;
  imdbId?: string | null;
  autoSkipIntro: boolean;
  autoSkipOutro: boolean;
  autoPlayNext: boolean;
}

function StandaloneModePlayer({
  tmdbId,
  type,
  season,
  episode,
  imdbId,
  autoSkipIntro,
  autoSkipOutro,
  autoPlayNext,
}: StandaloneModePlayerProps) {
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [introSegment, setIntroSegment] = useState<IntroDBSegment | null>(null);
  const [recapSegment, setRecapSegment] = useState<IntroDBSegment | null>(null);
  const [outroSegment, setOutroSegment] = useState<IntroDBSegment | null>(null);
  const [currentSeason, setCurrentSeason] = useState(season ? parseInt(season) : 1);
  const [currentEpisode, setCurrentEpisode] = useState(episode ? parseInt(episode) : 1);

  // Mutable settings state (initialized from URL params, can be updated via postMessage)
  const [autoSkipIntroState, setAutoSkipIntroState] = useState(autoSkipIntro);
  const [autoSkipOutroState, setAutoSkipOutroState] = useState(autoSkipOutro);
  const [autoPlayNextState, setAutoPlayNextState] = useState(autoPlayNext);

  // Clear segments when imdbId is missing
  const clearedSegments = !imdbId;

  // Fetch IntroDB segments
  useEffect(() => {
    if (!imdbId) return;

    let cancelled = false;

    const fetchIntroDB = async () => {
      try {
        const params = new URLSearchParams({ imdb_id: imdbId });
        if (type === 'tv') {
          params.set('season', currentSeason.toString());
          params.set('episode', currentEpisode.toString());
        }
        const response = await fetch(`/api/introdb?${params}`);
        if (!response.ok || cancelled) return;
        const data = await response.json();
        if (cancelled) return;

        setIntroSegment(data.intro || null);
        setRecapSegment(data.recap || null);
        setOutroSegment(data.outro || null);
      } catch {
        // Silently fail
      }
    };

    fetchIntroDB();
    return () => { cancelled = true };
  }, [imdbId, type, currentSeason, currentEpisode]);

  // When imdbId is cleared, reset segments
  const introSeg = clearedSegments ? null : introSegment;
  const recapSeg = clearedSegments ? null : recapSegment;
  const outroSeg = clearedSegments ? null : outroSegment;

  const handleSkipTo = useCallback((seconds: number) => {
    const videoEl = document.querySelector('.artvideo-player video') as HTMLVideoElement;
    if (videoEl) videoEl.currentTime = seconds;
  }, []);

  // Listen for PLAYER_EVENT messages from ArtPlayerWrapper AND parent commands
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      let raw: any = null;
      if (typeof event.data === 'string') {
        try { raw = JSON.parse(event.data) } catch { return }
      } else if (typeof event.data === 'object' && event.data !== null) {
        raw = event.data
      } else { return }

      // Handle PLAYER_EVENT from ArtPlayerWrapper (time/duration updates)
      if (raw.type === 'PLAYER_EVENT' && raw.data) {
        if (raw.data.currentTime !== undefined) setPlayerCurrentTime(Number(raw.data.currentTime));
        if (raw.data.duration !== undefined && Number(raw.data.duration) > 0) setPlayerDuration(Number(raw.data.duration));
        return;
      }

      // Handle parent commands
      const { command, value } = raw;
      if (command === 'seek' && typeof value === 'number') {
        const videoEl = document.querySelector('.artvideo-player video') as HTMLVideoElement;
        if (videoEl) videoEl.currentTime = value;
      } else if (command === 'setAutoSkipIntro' && typeof value === 'boolean') {
        setAutoSkipIntroState(value);
      } else if (command === 'setAutoSkipOutro' && typeof value === 'boolean') {
        setAutoSkipOutroState(value);
      } else if (command === 'setAutoPlayNext' && typeof value === 'boolean') {
        setAutoPlayNextState(value);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleNextEpisode = useCallback(() => {
    if (type !== 'tv') return;

    // Report episode change to parent
    try {
      window.parent.postMessage({
        type: 'PLAYER_EVENT',
        data: {
          event: 'episodeChange',
          season: currentSeason,
          episode: currentEpisode + 1,
        },
      }, '*');
    } catch {
      // postMessage may fail in some contexts
    }

    setCurrentEpisode(prev => prev + 1);
  }, [type, currentSeason, currentEpisode]);

  return (
    <div className="h-dvh bg-black flex items-center justify-center">
      <div className="w-full relative">
        <EmbedPlayer
          tmdbId={tmdbId}
          type={type}
          season={currentSeason.toString()}
          episode={currentEpisode.toString()}
        />

        {/* IntroSkipOverlay for standalone mode */}
        {imdbId && (
          <IntroSkipOverlay
            mediaType={type}
            season={currentSeason}
            episode={currentEpisode}
            introSegment={introSeg}
            recapSegment={recapSeg}
            outroSegment={outroSeg}
            currentTime={playerCurrentTime}
            duration={playerDuration}
            autoSkipIntro={autoSkipIntroState}
            autoSkipOutro={autoSkipOutroState}
            autoPlayNext={autoPlayNextState}
            onSkipTo={handleSkipTo}
            onNextEpisode={handleNextEpisode}
          />
        )}
      </div>
    </div>
  );
}

// ─── Main Page Component ──────────────────────────────────────────────────────

function PlayerPage() {
  const searchParams = useSearchParams();

  // ─── Legacy params (standalone mode) ───────────────────────────────────────
  const movieId = searchParams.get('movie');
  const tvId = searchParams.get('tv');
  const legacySeason = searchParams.get('s') || searchParams.get('season');
  const legacyEpisode = searchParams.get('e') || searchParams.get('episode');

  // ─── Embed mode params ─────────────────────────────────────────────────────
  const tmdbIdParam = searchParams.get('tmdbId');
  const typeParam = searchParams.get('type') as 'movie' | 'tv' | null;
  const embedSeason = searchParams.get('season');
  const embedEpisode = searchParams.get('episode');
  const imdbIdParam = searchParams.get('imdbId');
  const autoSkipIntro = searchParams.get('autoskipintro') !== 'false'; // default true
  const autoSkipOutro = searchParams.get('autoskipoutro') !== 'false'; // default true
  const autoPlayNext = searchParams.get('autoplaynext') !== 'false'; // default true

  // ─── Resolve IMDB ID from TMDB (for embed mode) ───────────────────────────
  const [resolvedImdbId, setResolvedImdbId] = useState<string | null>(imdbIdParam);
  const [resolvingImdb, setResolvingImdb] = useState(false);

  useEffect(() => {
    if (imdbIdParam) {
      setResolvedImdbId(imdbIdParam);
      return;
    }

    if (!tmdbIdParam || !typeParam) {
      setResolvedImdbId(null);
      return;
    }

    let cancelled = false;
    setResolvingImdb(true);

    const fetchImdbId = async () => {
      try {
        const path = typeParam === 'tv' ? `/tv/${tmdbIdParam}` : `/movie/${tmdbIdParam}`;
        const response = await fetch(`/api/tmdb?path=${encodeURIComponent(path)}`);
        if (!response.ok || cancelled) return;

        const data = await response.json();
        if (cancelled) return;

        const imdbId = data.external_ids?.imdb_id || data.imdb_id || null;
        console.log('[PlayerPage] Resolved IMDB ID:', imdbId, 'for TMDB:', tmdbIdParam);
        setResolvedImdbId(imdbId);
      } catch (err) {
        console.error('[PlayerPage] Failed to resolve IMDB ID:', err);
      } finally {
        if (!cancelled) setResolvingImdb(false);
      }
    };

    fetchImdbId();
    return () => { cancelled = true };
  }, [tmdbIdParam, typeParam, imdbIdParam]);

  // ─── Determine mode ────────────────────────────────────────────────────────
  const isEmbedMode = !!(tmdbIdParam && typeParam);
  const isStandaloneMode = !!(movieId || tvId);

  // ─── Embed mode ────────────────────────────────────────────────────────────
  if (isEmbedMode) {
    const seasonNum = embedSeason ? parseInt(embedSeason) : 1;
    const episodeNum = embedEpisode ? parseInt(embedEpisode) : 1;

    return (
      <EmbedModePlayer
        tmdbId={tmdbIdParam}
        mediaType={typeParam}
        season={seasonNum}
        episode={episodeNum}
        imdbId={resolvedImdbId}
        autoSkipIntro={autoSkipIntro}
        autoSkipOutro={autoSkipOutro}
        autoPlayNext={autoPlayNext}
      />
    );
  }

  // ─── Standalone mode ───────────────────────────────────────────────────────
  if (isStandaloneMode) {
    const standaloneTmdbId = movieId || tvId || '';
    const standaloneType = movieId ? 'movie' : 'tv';

    return (
      <StandaloneModePlayer
        tmdbId={standaloneTmdbId}
        type={standaloneType as 'movie' | 'tv'}
        season={legacySeason || undefined}
        episode={legacyEpisode || undefined}
        imdbId={resolvedImdbId}
        autoSkipIntro={autoSkipIntro}
        autoSkipOutro={autoSkipOutro}
        autoPlayNext={autoPlayNext}
      />
    );
  }

  // ─── No content specified ──────────────────────────────────────────────────
  return (
    <div className="h-dvh bg-black flex items-center justify-center">
      <div className="text-center space-y-4">
        <p className="text-zinc-500 text-sm">No content specified</p>
        <p className="text-zinc-600 text-xs">
          Use <code className="text-zinc-400">?tmdbId=ID&type=movie</code> or{' '}
          <code className="text-zinc-400">?tmdbId=ID&type=tv&season=1&episode=1</code>
        </p>
        <p className="text-zinc-600 text-xs">
          Or legacy: <code className="text-zinc-400">?movie=ID</code> or{' '}
          <code className="text-zinc-400">?tv=ID&s=1&e=1</code>
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="h-dvh bg-black flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        </div>
      }
    >
      <PlayerPage />
    </Suspense>
  );
}
