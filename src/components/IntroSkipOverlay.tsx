'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { SkipForward, ArrowRight, Clock } from 'lucide-react'

interface Segment {
  start_sec: number
  end_sec: number
}

interface IntroSkipOverlayProps {
  mediaType: 'movie' | 'tv'
  season?: number
  episode?: number
  introSegment?: Segment | null
  recapSegment?: Segment | null
  outroSegment?: Segment | null
  currentTime: number
  duration: number
  autoSkipIntro: boolean
  autoSkipOutro: boolean
  autoPlayNext: boolean
  onSkipTo: (seconds: number) => void
  onNextEpisode: () => void
}

const MAX_INTRO_DURATION = 300
const MAX_OUTRO_DURATION = 600

function isValidSegment(segment: Segment | null, maxDuration: number): Segment | null {
  if (!segment) return null
  const dur = segment.end_sec - segment.start_sec
  if (dur <= 0 || dur > maxDuration) return null
  return segment
}

export default function IntroSkipOverlay({
  mediaType,
  season,
  episode,
  introSegment: rawIntroSegment,
  recapSegment: rawRecapSegment,
  outroSegment: rawOutroSegment,
  currentTime,
  duration,
  autoSkipIntro,
  autoSkipOutro,
  autoPlayNext,
  onSkipTo,
  onNextEpisode,
}: IntroSkipOverlayProps) {
  const introSegment = isValidSegment(rawIntroSegment, MAX_INTRO_DURATION)
  const recapSegment = isValidSegment(rawRecapSegment, MAX_INTRO_DURATION)
  const outroSegment = isValidSegment(rawOutroSegment, MAX_OUTRO_DURATION)

  const [showSkipButton, setShowSkipButton] = useState<'recap' | 'intro' | 'outro' | null>(null)
  const [skipNotification, setSkipNotification] = useState<'recap' | 'intro' | 'outro' | null>(null)
  const [outroCountdown, setOutroCountdown] = useState<number | null>(null)
  const [nextEpisodeCountdown, setNextEpisodeCountdown] = useState<number | null>(null)

  const hasAutoSkippedOutroRef = useRef(false)
  const hasTriggeredAutoPlayNextRef = useRef(false)
  const skipCooldownRef = useRef(false)
  const lastZoneRef = useRef<string>('unknown')
  const episodeStartWallClockRef = useRef<number>(0)
  const transitionLockRef = useRef(false)

  const MIN_REAL_VIEWING_TIME = 10

  // Reset state on episode change
  const prevEpKeyRef = useRef(`${season}:${episode}`)
  useEffect(() => {
    const key = `${season}:${episode}`
    if (prevEpKeyRef.current !== key) {
      prevEpKeyRef.current = key
      hasAutoSkippedOutroRef.current = false
      hasTriggeredAutoPlayNextRef.current = false
      skipCooldownRef.current = false
      lastZoneRef.current = 'unknown'
      episodeStartWallClockRef.current = 0
      transitionLockRef.current = true
      // Use microtask to avoid setState-in-effect lint
      requestAnimationFrame(() => {
        setShowSkipButton(null)
        setSkipNotification(null)
        setOutroCountdown(null)
        setNextEpisodeCountdown(null)
      })
      setTimeout(() => { transitionLockRef.current = false }, 5000)
    }
  }, [season, episode])

  // Initialize wall-clock time
  useEffect(() => {
    if (currentTime > 0 && episodeStartWallClockRef.current === 0) {
      episodeStartWallClockRef.current = Date.now()
    }
  }, [currentTime])

  // Main skip logic - runs on currentTime changes
  useEffect(() => {
    if (transitionLockRef.current || currentTime <= 0) return

    const realViewingSeconds = episodeStartWallClockRef.current > 0
      ? (Date.now() - episodeStartWallClockRef.current) / 1000
      : 0

    // Determine which "opening" segment the player is in
    const openingSegment = recapSegment && currentTime >= recapSegment.start_sec && currentTime < recapSegment.end_sec
      ? { type: 'recap' as const, segment: recapSegment }
      : introSegment && currentTime >= introSegment.start_sec && currentTime < introSegment.end_sec
        ? { type: 'intro' as const, segment: introSegment }
        : null

    if (openingSegment) {
      lastZoneRef.current = 'in-opening'

      if (autoSkipIntro && !skipCooldownRef.current) {
        skipCooldownRef.current = true
        const skipTo = openingSegment.segment.end_sec + 1
        console.log(`[IntroSkip] Auto-skipping ${openingSegment.type} to ${skipTo}s`)
        // Use microtask to avoid setState-in-effect lint
        requestAnimationFrame(() => setSkipNotification(openingSegment.type))
        onSkipTo(skipTo)
        setTimeout(() => {
          setSkipNotification(null)
          skipCooldownRef.current = false
        }, 5000)
      } else if (!autoSkipIntro) {
        requestAnimationFrame(() => setShowSkipButton(openingSegment.type))
      }
      return
    } else if (introSegment || recapSegment) {
      const openingEnd = Math.max(
        recapSegment ? recapSegment.end_sec : 0,
        introSegment ? introSegment.end_sec : 0
      )
      lastZoneRef.current = currentTime >= openingEnd ? 'after-opening' : 'before-opening'
    }

    // Check outro
    if (outroSegment && currentTime >= (outroSegment.start_sec - 5) && currentTime <= outroSegment.end_sec && realViewingSeconds > MIN_REAL_VIEWING_TIME) {
      if (autoSkipOutro && !hasAutoSkippedOutroRef.current) {
        hasAutoSkippedOutroRef.current = true
        hasTriggeredAutoPlayNextRef.current = true
        console.log(`[IntroSkip] Outro detected — starting countdown`)
        requestAnimationFrame(() => setOutroCountdown(5))
      } else if (!autoSkipOutro) {
        requestAnimationFrame(() => setShowSkipButton('outro'))
      }
      return
    }

    // Not in any segment
    requestAnimationFrame(() => setShowSkipButton(null))

    // Auto-play next episode when video nears end (no outro segment)
    if (
      mediaType === 'tv' &&
      autoPlayNext &&
      !outroSegment &&
      !hasTriggeredAutoPlayNextRef.current &&
      duration > 0 &&
      realViewingSeconds > MIN_REAL_VIEWING_TIME
    ) {
      const progress = currentTime / duration
      if (progress > 0.95) {
        hasTriggeredAutoPlayNextRef.current = true
        console.log('[IntroSkip] Video near end, starting countdown')
        requestAnimationFrame(() => setNextEpisodeCountdown(5))
      }
    }
  }, [currentTime, introSegment, recapSegment, outroSegment, autoSkipIntro, autoSkipOutro, autoPlayNext, mediaType, duration, onSkipTo])

  // Outro countdown
  const outroCountdownFiredRef = useRef(false)
  useEffect(() => {
    if (outroCountdown === null) return
    if (outroCountdown <= 0) {
      if (outroCountdownFiredRef.current) return
      outroCountdownFiredRef.current = true
      transitionLockRef.current = true
      onNextEpisode()
      setTimeout(() => {
        setOutroCountdown(null)
        setSkipNotification('outro')
        setTimeout(() => setSkipNotification(null), 2000)
      }, 0)
      return
    }
    const timer = setTimeout(() => setOutroCountdown(outroCountdown - 1), 1000)
    return () => clearTimeout(timer)
  }, [outroCountdown, onNextEpisode])

  useEffect(() => {
    if (outroCountdown !== null && outroCountdown > 0) outroCountdownFiredRef.current = false
  }, [outroCountdown])

  // Next episode countdown
  const nextEpCountdownFiredRef = useRef(false)
  useEffect(() => {
    if (nextEpisodeCountdown === null) return
    if (nextEpisodeCountdown <= 0) {
      if (nextEpCountdownFiredRef.current) return
      nextEpCountdownFiredRef.current = true
      transitionLockRef.current = true
      onNextEpisode()
      setTimeout(() => setNextEpisodeCountdown(null), 0)
      return
    }
    const timer = setTimeout(() => setNextEpisodeCountdown(nextEpisodeCountdown - 1), 1000)
    return () => clearTimeout(timer)
  }, [nextEpisodeCountdown, onNextEpisode])

  useEffect(() => {
    if (nextEpisodeCountdown !== null && nextEpisodeCountdown > 0) nextEpCountdownFiredRef.current = false
  }, [nextEpisodeCountdown])

  const handleManualSkip = useCallback(() => {
    if (showSkipButton === 'recap' && recapSegment) {
      setSkipNotification('recap')
      onSkipTo(recapSegment.end_sec + 1)
      setTimeout(() => setSkipNotification(null), 2500)
    } else if (showSkipButton === 'intro' && introSegment) {
      setSkipNotification('intro')
      onSkipTo(introSegment.end_sec + 1)
      setTimeout(() => setSkipNotification(null), 2500)
    } else if (showSkipButton === 'outro') {
      transitionLockRef.current = true
      hasAutoSkippedOutroRef.current = true
      hasTriggeredAutoPlayNextRef.current = true
      setSkipNotification('outro')
      onNextEpisode()
      setTimeout(() => setSkipNotification(null), 1500)
    }
  }, [showSkipButton, recapSegment, introSegment, onSkipTo, onNextEpisode])

  const hasAnySegmentData = !!(introSegment || recapSegment || outroSegment)

  const segmentConfig = {
    recap: { gradient: 'from-violet-400 to-fuchsia-500', bg: 'bg-violet-500/20', text: 'text-violet-300', label: 'Recap Skipped', buttonLabel: 'Skip Opening', Icon: SkipForward },
    intro: { gradient: 'from-violet-400 to-fuchsia-500', bg: 'bg-violet-500/20', text: 'text-violet-300', label: 'Intro Skipped', buttonLabel: 'Skip Opening', Icon: SkipForward },
    outro: { gradient: 'from-emerald-400 to-cyan-500', bg: 'bg-emerald-500/20', text: 'text-emerald-300', label: 'Outro Skipped', buttonLabel: 'Skip Outro', Icon: SkipForward },
  }

  const notifConfig = skipNotification ? segmentConfig[skipNotification] : null
  const buttonConfig = showSkipButton ? segmentConfig[showSkipButton] : null

  return (
    <>
      {/* ─── Timeline overlay showing segment regions ─── */}
      {hasAnySegmentData && duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
          <div className="relative w-full h-[6px] bg-white/[0.08]">
            {/* Intro/recap region (violet) */}
            {(recapSegment || introSegment) && (() => {
              const openingStart = Math.min(
                recapSegment?.start_sec ?? Infinity,
                introSegment?.start_sec ?? Infinity
              )
              const openingEnd = Math.max(
                recapSegment?.end_sec ?? 0,
                introSegment?.end_sec ?? 0
              )
              return (
                <div
                  className="absolute top-0 h-full bg-violet-400/70 rounded-[1px]"
                  style={{
                    left: `${(openingStart / duration) * 100}%`,
                    width: `${((openingEnd - openingStart) / duration) * 100}%`,
                  }}
                />
              )
            })()}
            {/* Outro region (emerald) */}
            {outroSegment && (
              <div
                className="absolute top-0 h-full bg-emerald-400/60 rounded-[1px]"
                style={{
                  left: `${(outroSegment.start_sec / duration) * 100}%`,
                  width: `${((outroSegment.end_sec - outroSegment.start_sec) / duration) * 100}%`,
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* ─── Auto-Skip Notification ─── */}
      <AnimatePresence>
        {skipNotification && notifConfig && (
          <motion.div
            initial={{ opacity: 0, x: -30, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -20, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="absolute bottom-6 sm:bottom-10 left-3 sm:left-6 z-30 pointer-events-none"
          >
            <div className="relative overflow-hidden rounded-xl shadow-2xl shadow-black/40">
              <div className="flex items-center gap-3 bg-black/85 backdrop-blur-xl border border-white/[0.08] px-4 py-2.5 sm:px-5 sm:py-3">
                <div className={`absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b ${notifConfig.gradient}`} />
                <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${notifConfig.bg}`}>
                  <notifConfig.Icon className={`w-4 h-4 ${notifConfig.text}`} />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Auto-Skip</span>
                  <span className="text-sm font-semibold text-white flex items-center gap-1.5">
                    {notifConfig.label}
                    <ArrowRight className="w-3 h-3 text-white/40" />
                  </span>
                </div>
              </div>
              <motion.div
                className={`absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r ${notifConfig.gradient}`}
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: 2.5, ease: 'linear' }}
                style={{ transformOrigin: 'left' }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Outro Countdown ─── */}
      <AnimatePresence>
        {outroCountdown !== null && outroCountdown > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 350, damping: 28 }}
            className="absolute bottom-6 sm:bottom-10 right-3 sm:right-6 z-30"
          >
            <div className="flex items-center gap-3 bg-black/85 backdrop-blur-xl border border-white/[0.08] px-4 py-3 sm:px-5 sm:py-3.5 rounded-xl shadow-2xl shadow-black/40">
              <div className="relative flex items-center justify-center w-10 h-10">
                <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2.5" />
                  <circle cx="22" cy="22" r="18" fill="none" stroke="url(#outroGrad)" strokeWidth="2.5" strokeLinecap="round"
                    strokeDasharray={113.1} strokeDashoffset={113.1 * (1 - outroCountdown / 5)} />
                  <defs><linearGradient id="outroGrad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#34d399" /><stop offset="100%" stopColor="#22d3ee" /></linearGradient></defs>
                </svg>
                <span className="text-lg font-bold text-white">{outroCountdown}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Skipping outro in</span>
                <span className="text-sm font-semibold text-white flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-emerald-300" />{outroCountdown}s
                </span>
              </div>
              <button
                onClick={() => { setOutroCountdown(null); hasAutoSkippedOutroRef.current = false; hasTriggeredAutoPlayNextRef.current = false }}
                className="ml-1 text-white/30 hover:text-white/70 text-[11px] font-medium uppercase tracking-wider transition-colors cursor-pointer px-2 py-1 rounded-md hover:bg-white/5"
              >Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Manual Skip Button ─── */}
      <AnimatePresence>
        {showSkipButton && buttonConfig && !skipNotification && (
          <motion.button
            initial={{ opacity: 0, x: 30, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 30, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 350, damping: 28 }}
            onClick={handleManualSkip}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            className="absolute bottom-6 sm:bottom-10 right-3 sm:right-6 z-30 cursor-pointer"
          >
            <div className="flex items-center gap-2.5 bg-black/80 backdrop-blur-xl border border-white/[0.12] hover:border-white/[0.2] px-4 py-2.5 sm:px-5 sm:py-3 rounded-xl shadow-2xl shadow-black/40 transition-all">
              <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${buttonConfig.bg}`}>
                <buttonConfig.Icon className={`w-4 h-4 ${buttonConfig.text}`} />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Press to</span>
                <span className="text-sm font-semibold text-white">{buttonConfig.buttonLabel}</span>
              </div>
            </div>
          </motion.button>
        )}
      </AnimatePresence>

      {/* ─── Next Episode Countdown ─── */}
      <AnimatePresence>
        {nextEpisodeCountdown !== null && nextEpisodeCountdown > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 350, damping: 28 }}
            className="absolute bottom-6 sm:bottom-10 right-3 sm:right-6 z-30"
          >
            <div className="flex items-center gap-3 bg-black/85 backdrop-blur-xl border border-white/[0.08] px-4 py-3 sm:px-5 sm:py-3.5 rounded-xl shadow-2xl shadow-black/40">
              <div className="relative flex items-center justify-center w-10 h-10">
                <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2.5" />
                  <circle cx="22" cy="22" r="18" fill="none" stroke="url(#nextEpGrad)" strokeWidth="2.5" strokeLinecap="round"
                    strokeDasharray={113.1} strokeDashoffset={113.1 * (1 - nextEpisodeCountdown / 5)} />
                  <defs><linearGradient id="nextEpGrad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#a78bfa" /><stop offset="100%" stopColor="#c084fc" /></linearGradient></defs>
                </svg>
                <span className="text-lg font-bold text-white">{nextEpisodeCountdown}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Up next in</span>
                <span className="text-sm font-semibold text-white">Next Episode</span>
              </div>
              <button
                onClick={() => { setNextEpisodeCountdown(null); hasTriggeredAutoPlayNextRef.current = false }}
                className="ml-1 text-white/30 hover:text-white/70 text-[11px] font-medium uppercase tracking-wider transition-colors cursor-pointer px-2 py-1 rounded-md hover:bg-white/5"
              >Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
