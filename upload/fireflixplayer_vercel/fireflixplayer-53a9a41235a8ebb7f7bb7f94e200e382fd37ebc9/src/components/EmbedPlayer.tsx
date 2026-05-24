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
  const [activeHeaders, setActiveHeaders] = useState<Record<string, string> | undefined>();
  const [desiredAudioLanguage, setDesiredAudioLanguage] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  // When set, the ServerSelector auto-opens to show multiStreams for this source
  const [autoOpenSourceId, setAutoOpenSourceId] = useState<string | null>(null);

  const autoPlayAbortedRef = useRef(false);
  const autoPlayIndexRef = useRef(0);
  const pendingAutoPlayRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sourceStatusesRef = useRef<Record<string, SourceStatus>>({});
  useEffect(() => {
    sourceStatusesRef.current = sourceStatuses;
  }, [sourceStatuses]);

  const sourcesRef = useRef<SourceInfo[]>([]);
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  const updateSourceStatus = useCallback((sourceId: string, update: Partial<SourceStatus>) => {
    setSourceStatuses(prev => ({
      ...prev,
      [sourceId]: { ...prev[sourceId], sourceId, ...update },
    }));
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
    setActiveHeaders(status?.headers);
    setDesiredAudioLanguage(undefined);
    setLoading(false);
  }, []);

  const tryAutoPlay = useCallback(async (sourceList: SourceInfo[], startIndex: number) => {
    autoPlayAbortedRef.current = false;

    for (let i = startIndex; i < sourceList.length; i++) {
      if (autoPlayAbortedRef.current) {
        pendingAutoPlayRef.current = i;
        return;
      }

      autoPlayIndexRef.current = i;
      const source = sourceList[i];

      const status = await fetchSource(source.id);

      if (autoPlayAbortedRef.current) {
        pendingAutoPlayRef.current = i;
        return;
      }

      if (status.status === 'success' && status.streamUrl) {
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
  }, [tmdbId, type, season, episode, tryAutoPlay]);

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

  const handleSelectSource = useCallback(async (sourceId: string) => {
    autoPlayAbortedRef.current = true;

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
    } else {
      const resumeIndex = pendingAutoPlayRef.current ?? autoPlayIndexRef.current + 1;
      autoPlayAbortedRef.current = false;
      tryAutoPlay(sourcesRef.current, resumeIndex);
    }
  }, [fetchSource, playSource, tryAutoPlay]);

  const handleSelectSubStream = useCallback((sourceId: string, streamUrl: string, _streamTitle: string, desiredLanguage?: string) => {
    autoPlayAbortedRef.current = true;
    setActiveSourceId(sourceId);
    setActiveStreamUrl(streamUrl);
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

  const handleRetry = useCallback(() => {
    setSourceStatuses({});
    setLoading(true);
    setActiveSourceId(null);
    setActiveStreamUrl(null);
    setDesiredAudioLanguage(undefined);
    setAutoOpenSourceId(null);
    autoPlayAbortedRef.current = false;
    pendingAutoPlayRef.current = null;
    autoPlayIndexRef.current = 0;
    tryAutoPlay(sourcesRef.current, 0);
  }, [tryAutoPlay]);

  return (
    <div className="relative w-full bg-black" style={{ aspectRatio: '16/9' }}>
      <div className="absolute inset-0" style={{ zIndex: 1 }}>
        <ArtPlayerWrapper
          url={activeStreamUrl}
          headers={activeHeaders}
          qualities={[]}
          audioTracks={[]}
          desiredAudioLanguage={desiredAudioLanguage}
          onAudioTrackChange={handleAudioTrackChange}
          onHlsError={handleHlsError}
          onManifestParsed={handleManifestParsed}
          externalSubtitles={activeSourceId ? sourceStatuses[activeSourceId]?.subtitles || [] : []}
        />
      </div>

      <div className="absolute top-2 right-2" style={{ zIndex: 2 }}>
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

      {!activeStreamUrl && loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80" style={{ zIndex: 3 }}>
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <p className="text-sm text-zinc-400">Finding best server...</p>
          </div>
        </div>
      )}

      {!activeStreamUrl && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80" style={{ zIndex: 3 }}>
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-zinc-400">No servers available</p>
            <button
              onClick={handleRetry}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-sm rounded-md transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
