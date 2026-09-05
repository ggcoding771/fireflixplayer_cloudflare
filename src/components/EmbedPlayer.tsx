'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ArtPlayerWrapper } from './ArtPlayerWrapper';
import type { SubtitleTrack } from './ArtPlayerWrapper';
import { ServerSelector } from './ServerSelector';
import type { AudioTrack, QualityLevel } from '@/lib/m3u8-parser';

// ============ Types ============

export interface SourceInfo {
  id: string;
  name: string;
  apiOrigin: string;
  languageFlags: string;
  languages: string[];
  order: number;
  reliability: string;
  note?: string;
}

export interface SubStream {
  title: string;
  quality: string;
  language: string;
  url: string;
  type: string;
  audioTrackIndex?: number;
  audioTracks: AudioTrack[];
}

export interface SourceStatus {
  sourceId: string;
  status: 'pending' | 'loading' | 'success' | 'failed';
  streamUrl?: string | null;
  /** How the player should play streamUrl: 'm3u8' → hls.js, 'direct' → native <video> */
  streamType?: 'm3u8' | 'direct';
  audioTracks: AudioTrack[];
  qualities: QualityLevel[];
  subtitles: SubtitleTrack[];
  headers?: Record<string, string>;
  multiStreams?: SubStream[];
  error?: string | null;
}

interface EmbedPlayerProps {
  tmdbId: string;
  type: 'movie' | 'tv';
  season?: string;
  episode?: string;
}

// ============ Main Component ============

export function EmbedPlayer({ tmdbId, type, season, episode }: EmbedPlayerProps) {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sourceStatuses, setSourceStatuses] = useState<Record<string, SourceStatus>>({});
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [activeStreamUrl, setActiveStreamUrl] = useState<string | null>(null);
  const [activePlaybackType, setActivePlaybackType] = useState<'auto' | 'hls' | 'native'>('auto');
  const [activeHeaders, setActiveHeaders] = useState<Record<string, string> | undefined>();
  const [desiredAudioLanguage, setDesiredAudioLanguage] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  // When set, the ServerSelector auto-opens to show multiStreams for this source
  const [autoOpenSourceId, setAutoOpenSourceId] = useState<string | null>(null);
  // Bumped by the "Retry" button for a FULL fresh restart (only offered when
  // every server has failed). The init effect depends on it.
  const [reloadKey, setReloadKey] = useState(0);

  const autoPlayAbortedRef = useRef(false);
  const autoPlayIndexRef = useRef(0);
  const pendingAutoPlayRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastTimestampRef = useRef<number>(0);

  const sourceStatusesRef = useRef<Record<string, SourceStatus>>({});
  useEffect(() => {
    sourceStatusesRef.current = sourceStatuses;
  }, [sourceStatuses]);

  const sourcesRef = useRef<SourceInfo[]>([]);
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  const updateSourceStatus = useCallback((sourceId: string, update: Partial<SourceStatus>) => {
    setSourceStatuses(prev => {
      const next = {
        ...prev,
        [sourceId]: { ...prev[sourceId], sourceId, ...update },
      };
      // Write the ref IMMEDIATELY (not after re-render): tryAutoPlay calls
      // playSource right after fetchSource resolves, and playSource reads
      // streamType from this ref. With the deferred useEffect sync the ref
      // was still empty on first auto-play → playbackType fell back to
      // 'auto' → hls.js tried to parse a direct MKV/MP4 as a manifest
      // (manifestParsingError) and the source got wrongly marked failed.
      sourceStatusesRef.current = next;
      return next;
    });
  }, []);

  const fetchSource = useCallback(async (sourceId: string): Promise<SourceStatus> => {
    const existing = sourceStatusesRef.current[sourceId];
    if (existing?.status === 'loading') return existing;

    updateSourceStatus(sourceId, {
      status: 'loading',
      audioTracks: [],
      qualities: [],
      subtitles: [],
    });

    try {
      const params = new URLSearchParams({ sourceId, tmdbId, type });
      if (type === 'tv' && season) params.set('season', season);
      if (type === 'tv' && episode) params.set('episode', episode);

      const res = await fetch(`/api/stream?${params}`);
      const data = await res.json();

      const status: SourceStatus = {
        sourceId,
        status: data.success ? 'success' : 'failed',
        streamUrl: data.url,
        streamType: data.type === 'direct' ? 'direct' : 'm3u8',
        audioTracks: data.audioTracks || [],
        qualities: data.qualities || [],
        subtitles: data.subtitles || [],
        headers: data.headers,
        multiStreams: data.multiStreams,
        error: data.error,
      };

      updateSourceStatus(sourceId, status);
      return status;
    } catch (err) {
      const status: SourceStatus = {
        sourceId,
        status: 'failed',
        audioTracks: [],
        qualities: [],
        subtitles: [],
        error: err instanceof Error ? err.message : 'Fetch failed',
      };
      updateSourceStatus(sourceId, status);
      return status;
    }
  }, [tmdbId, type, season, episode, updateSourceStatus]);

  const playSource = useCallback((sourceId: string, overrideUrl?: string) => {
    const status = sourceStatusesRef.current[sourceId];
    const url = overrideUrl || status?.streamUrl;
    if (!url) return;

    setActiveSourceId(sourceId);
    setActiveStreamUrl(url);
    setActivePlaybackType(status?.streamType === 'direct' ? 'native' : 'auto');
    setActiveHeaders(status?.headers);
    setDesiredAudioLanguage(undefined);
    setLoading(false);
  }, []);

  const tryAutoPlay = useCallback(async (sourceList: SourceInfo[], startIndex: number) => {
    autoPlayAbortedRef.current = false;

    for (let i = startIndex; i < sourceList.length; i++) {
      if (autoPlayAbortedRef.current) {
        return;
      }

      autoPlayIndexRef.current = i;
      const source = sourceList[i];

      // Use what we already know — never re-fetch sources with a known
      // status. A source that failed for this title will fail again, so
      // skipping it instantly avoids the "reset to server #1 and re-fetch
      // everything" storm when the chain restarts.
      const cached = sourceStatusesRef.current[source.id];
      let status: SourceStatus | null = null;
      if (cached?.status === 'success' && cached.streamUrl) {
        status = cached;
      } else if (cached?.status === 'failed') {
        continue; // known-failed — skip without a network round-trip
      } else {
        status = await fetchSource(source.id);
      }

      if (autoPlayAbortedRef.current) {
        return;
      }

      if (status && status.status === 'success' && status.streamUrl) {
        playSource(source.id, status.streamUrl);

        // If this source has multiStreams, auto-open the dropdown so user can pick a language
        if (status.multiStreams && status.multiStreams.length > 1) {
          setAutoOpenSourceId(source.id);
        }
        return;
      }
    }

    setLoading(false);
  }, [fetchSource, playSource]);

  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    async function init() {
      setLoading(true);
      setActiveSourceId(null);
      setActiveStreamUrl(null);
      setActiveHeaders(undefined);
      setDesiredAudioLanguage(undefined);
      setAutoOpenSourceId(null);
      setSourceStatuses({});
      setSources([]);
      autoPlayAbortedRef.current = false;
      autoPlayIndexRef.current = 0;
      pendingAutoPlayRef.current = null;

      try {
        const params = new URLSearchParams({ type });
        const res = await fetch(`/api/sources?${params}`, { signal: controller.signal });
        const data = await res.json();
        const loadedSources: SourceInfo[] = data.sources || [];

        if (controller.signal.aborted) return;

        setSources(loadedSources);
        await tryAutoPlay(loadedSources, 0);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Failed to initialize:', err);
        setLoading(false);
      }
    }

    init();

    return () => {
      controller.abort();
      autoPlayAbortedRef.current = true;
    };
  }, [tmdbId, type, season, episode, tryAutoPlay, reloadKey]);

  const handleHlsError = useCallback(() => {
    const currentSourceId = activeSourceId;
    if (!currentSourceId) return;

    // Mark the source as failed, but DON'T auto-switch to next source.
    // The ArtPlayerWrapper already tried multiple recovery attempts with backoff.
    // If it still failed, auto-switching to a different source is jarring —
    // the user was watching this source and wants to stay on it.
    // They can manually switch via the server selector or retry.
    updateSourceStatus(currentSourceId, {
      status: 'failed',
      error: 'Playback error — try again or switch server',
    });

    // Keep the source active so the user can retry easily
    // Just clear the stream URL to show the error overlay
    setActiveStreamUrl(null);
    setActiveHeaders(undefined);
  }, [activeSourceId, updateSourceStatus]);

  const handleSelectSource = useCallback(async (sourceId: string, providedUrl?: string) => {
    autoPlayAbortedRef.current = true;

    // If a URL was provided directly (e.g. from ServerSelector after successful fetch),
    // use it immediately without checking the potentially stale ref
    if (providedUrl) {
      const status = sourceStatusesRef.current[sourceId];
      playSource(sourceId, providedUrl);
      // Also set headers from the status if available
      if (status?.headers) {
        setActiveHeaders(status.headers);
      }
      return;
    }

    const existingStatus = sourceStatusesRef.current[sourceId];

    if (existingStatus?.status === 'success' && existingStatus.streamUrl) {
      playSource(sourceId, existingStatus.streamUrl);
      return;
    }

    if (existingStatus?.status === 'loading') {
      return;
    }

    const status = await fetchSource(sourceId);

    if (status.status === 'success' && status.streamUrl) {
      playSource(sourceId, status.streamUrl);
    }
    // If the user's chosen server failed: fetchSource already marked it
    // failed and the per-source error card appears. We deliberately do NOT
    // auto-jump to another server and do NOT restart the auto-play chain —
    // the user picked this one, let them pick the next move.
  }, [fetchSource, playSource]);

  const handleSelectSubStream = useCallback((sourceId: string, streamUrl: string, _streamTitle: string, desiredLanguage?: string, streamType?: string) => {
    autoPlayAbortedRef.current = true;

    setActiveSourceId(sourceId);
    setActiveStreamUrl(streamUrl);
    setActivePlaybackType(streamType === 'direct' ? 'native' : 'auto');
    setDesiredAudioLanguage(desiredLanguage);
    setAutoOpenSourceId(null);
    setLoading(false);
    const status = sourceStatusesRef.current[sourceId];
    if (status?.headers) {
      setActiveHeaders(status.headers);
    }
  }, []);

  const handleAudioTrackChange = useCallback((_track: AudioTrack) => {
    // Track change is handled by HLS.js internally
  }, []);

  const handleTimeUpdate = useCallback((time: number) => {
    lastTimestampRef.current = time;
  }, []);

  const handleManifestParsed = useCallback((data: { qualities: QualityLevel[]; audioTracks: AudioTrack[]; subtitleTracks?: SubtitleTrack[] }) => {
    if (activeSourceId) {
      const update: Partial<SourceStatus> = {
        qualities: data.qualities,
        audioTracks: data.audioTracks.length > 0 ? data.audioTracks : sourceStatusesRef.current[activeSourceId]?.audioTracks || [],
      };
      // If HLS manifest has subtitle tracks, merge them with existing external subs
      if (data.subtitleTracks && data.subtitleTracks.length > 0) {
        const existingSubs = sourceStatusesRef.current[activeSourceId]?.subtitles || [];
        // Keep external subs, add HLS subs that aren't duplicates
        const hlsSubLabels = new Set(data.subtitleTracks.map(s => s.label.toLowerCase()));
        const mergedSubs = [
          ...existingSubs.filter(s => !hlsSubLabels.has(s.label.toLowerCase())),
          ...data.subtitleTracks,
        ];
        update.subtitles = mergedSubs;
      }
      updateSourceStatus(activeSourceId, update);
    }
  }, [activeSourceId, updateSourceStatus]);

  // Retry JUST the failed server (offered on the per-source error card).
  // Keeps every other server's status — no reset, no re-fetch storm.
  const handleRetryCurrent = useCallback(async () => {
    const sourceId = activeSourceId;
    if (!sourceId) return;
    autoPlayAbortedRef.current = true;
    const status = await fetchSource(sourceId);
    if (status.status === 'success' && status.streamUrl) {
      playSource(sourceId, status.streamUrl);
    }
    // Still failed → the error card stays; the dropdown stays usable.
  }, [activeSourceId, fetchSource, playSource]);

  // FULL restart — only offered when every single server has failed (or none
  // were loaded). Re-runs the init effect: fresh source list + fresh attempts.
  const handleRetry = useCallback(() => {
    setReloadKey(k => k + 1);
  }, []);

  return (
    <div className="relative w-full bg-black" style={{ aspectRatio: '16/9' }}>
      <div className="absolute inset-0" style={{ zIndex: 1 }}>
        <ArtPlayerWrapper
          url={activeStreamUrl}
          playbackType={activePlaybackType}
          headers={activeHeaders}
          qualities={[]}
          audioTracks={[]}
          desiredAudioLanguage={desiredAudioLanguage}
          onAudioTrackChange={handleAudioTrackChange}
          onHlsError={handleHlsError}
          onManifestParsed={handleManifestParsed}
          onTimeUpdate={handleTimeUpdate}
          externalSubtitles={activeSourceId ? sourceStatuses[activeSourceId]?.subtitles || [] : []}
        />
      </div>

      {/* Server selector sits ABOVE every overlay so the user can always
          switch servers — an error on one server must never lock the UI. */}
      <div className="absolute top-2 right-2" style={{ zIndex: 4 }}>
        <ServerSelector
          sources={sources}
          sourceStatuses={sourceStatuses}
          activeSourceId={activeSourceId}
          onSelectSource={handleSelectSource}
          onSelectSubStream={handleSelectSubStream}
          fetchSource={fetchSource}
          autoOpenSourceId={autoOpenSourceId}
          onAutoOpenHandled={() => setAutoOpenSourceId(null)}
        />
      </div>

      {(() => {
        // Backdrops are pointer-events-none so nothing ever blocks the
        // selector; only the inner card itself captures clicks.
        const activeSourceName = activeSourceId
          ? sources.find(s => s.id === activeSourceId)?.name
          : null;
        // The stream API's real reason (e.g. "CDN blocks our proxy (HTTP
        // 427)" for Moon, "Stream CDN error (HTTP 502)" for Comet's dead
        // origin) — shown instead of a generic shrug so the user knows WHY.
        const activeError = activeSourceId
          ? sourceStatuses[activeSourceId]?.error
          : null;
        const hasSources = sources.length > 0;
        // "No servers available" is ONLY true when every single server
        // failed its own check (or none were loaded). One failing server
        // is NOT "no servers available".
        const allSourcesFailed = hasSources
          && sources.every(s => sourceStatuses[s.id]?.status === 'failed');

        if (activeStreamUrl) {
          // Playing — no overlay at all.
          return null;
        }

        if (loading) {
          return (
            <div
              className="absolute inset-0 flex items-center justify-center bg-black/80"
              style={{ zIndex: 3, pointerEvents: 'none' }}
            >
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <p className="text-sm text-zinc-400">Finding best server...</p>
              </div>
            </div>
          );
        }

        if (!hasSources || allSourcesFailed) {
          // Genuinely out of options — offer a full fresh restart.
          return (
            <div
              className="absolute inset-0 flex items-center justify-center bg-black/80"
              style={{ zIndex: 3, pointerEvents: 'none' }}
            >
              <div
                className="flex flex-col items-center gap-3 rounded-lg border border-white/10 bg-black/70 px-6 py-5 backdrop-blur-sm"
                style={{ pointerEvents: 'auto' }}
              >
                <p className="text-sm text-zinc-400">No servers available</p>
                <button
                  onClick={handleRetry}
                  className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-sm rounded-md transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          );
        }

        // One server failed, others may be fine — say exactly that.
        return (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/80"
            style={{ zIndex: 3, pointerEvents: 'none' }}
          >
            <div
              className="flex flex-col items-center gap-2 rounded-lg border border-white/10 bg-black/70 px-6 py-5 backdrop-blur-sm"
              style={{ pointerEvents: 'auto' }}
            >
              <p className="text-sm font-medium text-zinc-200">
                {activeSourceName ? `${activeSourceName} isn't responding` : 'That server failed'}
              </p>
              {activeError && (
                <p className="text-xs text-zinc-400 max-w-70 text-center">{activeError}</p>
              )}
              <p className="text-xs text-zinc-500">Pick another server from the list (top-right)</p>
              {activeSourceId && (
                <button
                  onClick={handleRetryCurrent}
                  className="mt-1 px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-sm rounded-md transition-colors"
                >
                  Retry {activeSourceName || 'this server'}
                </button>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
