'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, X, Loader2, Server } from 'lucide-react';
import type { SourceInfo, SourceStatus } from './EmbedPlayer';

interface ServerSelectorProps {
  sources: SourceInfo[];
  sourceStatuses: Record<string, SourceStatus>;
  activeSourceId: string | null;
  onSelectSource: (sourceId: string) => void;
  onSelectSubStream?: (sourceId: string, streamUrl: string, streamTitle: string, desiredLanguage?: string) => void;
  fetchSource: (sourceId: string) => Promise<SourceStatus>;
  autoOpenSourceId?: string | null;
  onAutoOpenHandled?: () => void;
}

export function ServerSelector({
  sources,
  sourceStatuses,
  activeSourceId,
  onSelectSource,
  onSelectSubStream,
  fetchSource,
  autoOpenSourceId,
  onAutoOpenHandled,
}: ServerSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedSourceForTracks, setSelectedSourceForTracks] = useState<string | null>(null);
  const [fetchingSourceId, setFetchingSourceId] = useState<string | null>(null);
  const [dropdownMaxH, setDropdownMaxH] = useState(280);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const activeSource = sources.find(s => s.id === activeSourceId);

  // Calculate available dropdown height to stay within player/iframe bounds
  const recalculateHeight = useCallback(() => {
    if (!wrapperRef.current) return;
    const button = wrapperRef.current.querySelector('[data-trigger-btn]');
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    // Available space below the button, leaving 8px margin at bottom
    const availableBelow = window.innerHeight - buttonRect.bottom - 8;
    // Minimum 100px so it's still usable, cap at 300px
    const maxH = Math.max(100, Math.min(300, availableBelow));
    setDropdownMaxH(maxH);
  }, []);

  useEffect(() => {
    if (isOpen) {
      recalculateHeight();
    }
  }, [isOpen, recalculateHeight]);

  // Also recalculate on resize (iframe resize, orientation change, etc.)
  useEffect(() => {
    if (!isOpen) return;
    const observer = new ResizeObserver(recalculateHeight);
    if (wrapperRef.current) observer.observe(wrapperRef.current);
    window.addEventListener('resize', recalculateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', recalculateHeight);
    };
  }, [isOpen, recalculateHeight]);

  // Auto-open dropdown when autoOpenSourceId is set
  useEffect(() => {
    if (autoOpenSourceId) {
      setIsOpen(true);
      setSelectedSourceForTracks(autoOpenSourceId);
      onAutoOpenHandled?.();
    }
  }, [autoOpenSourceId, onAutoOpenHandled]);

  const handleSourceClick = async (sourceId: string) => {
    const status = sourceStatuses[sourceId];

    // If already fetched and has multi-streams, show sub-streams panel
    if (status?.multiStreams && status.multiStreams.length > 1) {
      setSelectedSourceForTracks(sourceId);
      // Scroll to top when switching to tracks view
      setTimeout(() => scrollContainerRef.current?.scrollTo({ top: 0 }), 0);
      return;
    }

    // If already fetched and successful with no multi-streams, play directly
    if (status?.status === 'success' && status.streamUrl) {
      onSelectSource(sourceId);
      setIsOpen(false);
      return;
    }

    // If already loading, do nothing
    if (status?.status === 'loading') {
      return;
    }

    // Not fetched yet or failed — fetch it first, then decide
    setFetchingSourceId(sourceId);
    try {
      const newStatus = await fetchSource(sourceId);

      // Check if it has multi-streams now
      if (newStatus.multiStreams && newStatus.multiStreams.length > 1) {
        setSelectedSourceForTracks(sourceId);
        setTimeout(() => scrollContainerRef.current?.scrollTo({ top: 0 }), 0);
      } else if (newStatus.status === 'success' && newStatus.streamUrl) {
        onSelectSource(sourceId);
        setIsOpen(false);
      }
    } finally {
      setFetchingSourceId(null);
    }
  };

  const handleSubStreamClick = (sourceId: string, streamUrl: string, streamTitle: string, desiredLanguage?: string) => {
    onSelectSubStream?.(sourceId, streamUrl, streamTitle, desiredLanguage);
    setIsOpen(false);
    setSelectedSourceForTracks(null);
  };

  const handleBack = () => {
    setSelectedSourceForTracks(null);
    setTimeout(() => scrollContainerRef.current?.scrollTo({ top: 0 }), 0);
  };

  const toggleDropdown = () => {
    setIsOpen(prev => !prev);
    setSelectedSourceForTracks(null);
  };

  const closeDropdown = () => {
    setIsOpen(false);
    setSelectedSourceForTracks(null);
  };

  const tracksSource = selectedSourceForTracks
    ? sources.find(s => s.id === selectedSourceForTracks)
    : null;
  const tracksStatus = selectedSourceForTracks
    ? sourceStatuses[selectedSourceForTracks]
    : null;

  return (
    <div ref={wrapperRef} className="relative" style={{ zIndex: 20 }}>
      <button
        data-trigger-btn
        onClick={toggleDropdown}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium
          bg-black/50 hover:bg-black/70 text-white/90 border border-white/10
          backdrop-blur-sm transition-all duration-150 hover:border-white/20"
      >
        <Server className="w-3 h-3" />
        <span className="max-w-[80px] truncate">
          {activeSource ? `${activeSource.name} ${activeSource.languageFlags}` : 'Server'}
        </span>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.1 }}
            className="absolute right-0 top-full mt-1.5
              w-60 overflow-hidden rounded-md
              bg-zinc-900/95 border border-white/10 backdrop-blur-xl
              shadow-xl shadow-black/60"
            style={{ maxHeight: `${dropdownMaxH}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              ref={scrollContainerRef}
              className="overflow-y-auto py-1"
              style={{
                maxHeight: `${dropdownMaxH - 2}px`,
                scrollbarWidth: 'thin',
                scrollbarColor: '#52525b transparent',
              }}
            >
              <AnimatePresence mode="wait">
                {!selectedSourceForTracks ? (
                  <motion.div
                    key="sources"
                    initial={{ x: 0, opacity: 1 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: -20, opacity: 0 }}
                    transition={{ duration: 0.1 }}
                  >
                    <div className="px-2 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                      Servers
                    </div>
                    {sources.map((source) => {
                      const status = sourceStatuses[source.id];
                      const isActive = source.id === activeSourceId;
                      const isFetching = fetchingSourceId === source.id;
                      const hasMultiStreams = status?.multiStreams && status.multiStreams.length > 1;
                      const hasAudioTracks = (status?.audioTracks && status.audioTracks.length > 1) || hasMultiStreams;

                      return (
                        <button
                          key={source.id}
                          onClick={() => handleSourceClick(source.id)}
                          disabled={isFetching}
                          className={`w-full flex items-center justify-between gap-1.5 px-2 py-1.5 rounded
                            text-xs transition-all duration-100 group
                            ${isActive
                              ? 'bg-red-600/20 text-red-400'
                              : status?.status === 'failed'
                                ? 'text-zinc-600 hover:bg-white/5'
                                : 'text-zinc-300 hover:bg-white/10'
                            }
                            ${isFetching ? 'opacity-70' : ''}`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            {isFetching ? (
                              <Loader2 className="w-3 h-3 text-yellow-400 animate-spin shrink-0" />
                            ) : null}
                            <span className="truncate font-medium">{source.name}</span>
                            <span className="text-[10px] whitespace-nowrap">
                              {hasAudioTracks && status?.audioTracks
                                ? status.audioTracks.map(t => t.flagEmoji).join('')
                                : source.languageFlags}
                            </span>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {status?.status === 'loading' && !isFetching && (
                              <Loader2 className="w-3 h-3 text-yellow-400 animate-spin" />
                            )}
                            {status?.status === 'success' && !isActive && !hasMultiStreams && (
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            )}
                            {status?.status === 'failed' && (
                              <X className="w-3 h-3 text-red-500" />
                            )}
                            {hasMultiStreams && (
                              <span className="text-[9px] text-zinc-500 group-hover:text-zinc-300">›</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </motion.div>
                ) : (
                  <motion.div
                    key="tracks"
                    initial={{ x: 20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 20, opacity: 0 }}
                    transition={{ duration: 0.1 }}
                  >
                    <button
                      onClick={handleBack}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded
                        text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/5
                        transition-all duration-100"
                    >
                      <ChevronLeft className="w-3 h-3" />
                      <span className="font-medium">{tracksSource?.name}</span>
                      <span className="text-[10px]">{tracksSource?.languageFlags}</span>
                    </button>

                    <div className="mt-0.5">
                      {tracksStatus?.multiStreams?.map((stream, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSubStreamClick(
                            selectedSourceForTracks!,
                            stream.url,
                            stream.title,
                            // Pass the language code from the stream's audio track for language-based matching
                            stream.audioTracks[0]?.language || undefined
                          )}
                          className="w-full flex items-center justify-between gap-1.5 px-2 py-1.5 rounded
                            text-xs text-zinc-300 hover:bg-white/10 transition-all duration-100"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[10px]">
                              {stream.audioTracks[0]?.flagEmoji || '🌍'}
                            </span>
                            <span className="truncate">{stream.language}</span>
                          </div>
                          <span className="text-[10px] text-zinc-500 shrink-0">{stream.quality}</span>
                        </button>
                      )) || (
                        <div className="px-2 py-1.5 text-xs text-zinc-500">
                          No tracks available
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {isOpen && (
        <div
          className="fixed inset-0"
          style={{ zIndex: -1 }}
          onClick={closeDropdown}
        />
      )}
    </div>
  );
}
