"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashMessage } from "../shared/hash";
import type { VoiceClip, VoiceEntry, VoiceManifest } from "../shared/types";
import { useI18n } from "./context";

/**
 * How the app names a voiced message: its voice key (<Trans voice="intro">),
 * or a msg()/t descriptor (the loader injects its id), or a raw hash.
 */
export type VoiceRef =
  | string
  | { id?: string; message?: string; context?: string };

export interface ResolvedVoiceClip extends VoiceClip {
  /** Absolute URL of the clip, ready for an <audio> element. */
  url: string;
  /** Global index of this clip's first word across the whole message. */
  wordOffset: number;
  /** Start of this clip on the message's combined timeline. */
  offsetMs: number;
}

export interface ResolvedVoice {
  id: string;
  /** The variant actually resolved (the preferred one, or the locale's first). */
  variant: string;
  entry: VoiceEntry;
  clips: ResolvedVoiceClip[];
  /** Words across every clip (0 when the entry is sentence-timed only). */
  wordCount: number;
  /** Sum of the clip durations. */
  durationMs: number;
}

function joinUrl(base: string, file: string): string {
  return `${base.replace(/\/$/, "")}/${file.replace(/^\//, "")}`;
}

/**
 * Variant names the active locale's audio catalog offers, in config order,
 * for a voice picker. Empty while loading or when the locale has no audio.
 */
export function useVoiceVariants(): string[] {
  const { voiceManifest } = useI18n();
  return voiceManifest?.variants ?? [];
}

export interface ResolveVoiceOptions {
  /** Where the clip files are served from. Default "/audio/i18n". */
  audioBaseUrl?: string;
  /** Preferred variant; one the entry lacks falls back to the locale's first. */
  variant?: string | null;
}

/**
 * Look a voiced message up in an audio catalog: its clips with URLs, word
 * offsets and durations, ready for any player. Plain data in, plain data
 * out, no React. `useVoice` is this over the provider's catalog. Returns
 * null when the catalog has no audio for the message.
 */
export function resolveVoice(
  manifest: VoiceManifest | null | undefined,
  ref: VoiceRef | null | undefined,
  options: ResolveVoiceOptions = {},
): ResolvedVoice | null {
  if (!ref || !manifest) return null;
  let id: string | undefined;
  if (typeof ref === "string") {
    id = manifest.keys[ref] ?? (manifest.entries[ref] ? ref : undefined);
  } else if (ref.id) {
    id = ref.id;
  } else if (ref.message) {
    id = hashMessage(ref.message, ref.context);
  }
  if (!id) return null;
  const byVariant = manifest.entries[id];
  if (!byVariant) return null;
  const available = manifest.variants.filter((name) => byVariant[name]);
  const wanted = options.variant;
  const resolvedVariant =
    wanted && byVariant[wanted] ? wanted : (available[0] ?? Object.keys(byVariant)[0]);
  if (!resolvedVariant) return null;
  const entry = byVariant[resolvedVariant];
  const base = options.audioBaseUrl ?? "/audio/i18n";
  let wordOffset = 0;
  let offsetMs = 0;
  const clips = entry.clips.map((clip) => {
    const resolved: ResolvedVoiceClip = {
      ...clip,
      url: joinUrl(base, clip.file),
      wordOffset,
      offsetMs,
    };
    wordOffset += clip.words?.length ?? 0;
    offsetMs += clip.durationMs;
    return resolved;
  });
  return {
    id,
    variant: resolvedVariant,
    entry,
    clips,
    wordCount: wordOffset,
    durationMs: offsetMs,
  };
}

/**
 * The generated audio for a message in the active locale, or null while the
 * audio catalog is loading, when the message has no audio, or when the app
 * never loads audio catalogs. `variant` overrides the provider's preferred
 * variant; a variant the entry lacks falls back to the locale's first.
 */
export function useVoice(
  ref: VoiceRef | null | undefined,
  variant?: string | null,
): ResolvedVoice | null {
  const { voiceManifest, audioBaseUrl, voiceVariant } = useI18n();
  const wanted = variant === undefined ? voiceVariant : variant;
  return useMemo(
    () => resolveVoice(voiceManifest, ref, { audioBaseUrl, variant: wanted }),
    [ref, wanted, voiceManifest, audioBaseUrl],
  );
}

export type VoicePlayerStatus = "idle" | "playing" | "paused" | "ended";

export interface VoicePlayer {
  /** False until the audio catalog is loaded and has this message. */
  available: boolean;
  voice: ResolvedVoice | null;
  status: VoicePlayerStatus;
  /** Index of the clip being spoken, or null when idle. */
  clip: number | null;
  /**
   * Global index of the word being spoken, or null between words, when
   * idle, or when the entry has no word timing. Pass it straight to
   * <Trans highlight={player.word}>.
   */
  word: number | null;
  /** Position on the message's combined timeline. */
  currentMs: number;
  durationMs: number;
  play: () => void;
  pause: () => void;
  /** Pause and rewind to the start. */
  stop: () => void;
  toggle: () => void;
  /** Jump to a clip and keep the current play state. */
  seekToClip: (index: number) => void;
  /** Jump to a global word index and keep the current play state. */
  seekToWord: (index: number) => void;
}

export interface VoicePlayerOptions {
  /** Called when the last clip finishes. */
  onEnd?: () => void;
  /** Playback speed applied to every clip. Default 1. */
  rate?: number;
  /**
   * Loudness applied to every clip. Default 1, the clip as recorded; 0 is
   * silent. Above 1 amplifies through Web Audio, which needs clips served
   * from the page's own origin: elsewhere the value is held at 1.
   */
  volume?: number;
  /** Voice variant for this player; default is the provider's preferred one. */
  variant?: string | null;
}

/**
 * The word being spoken at `clipMs` into a clip, as a global index across
 * the whole message, or null between words and for a clip without word
 * timing. What `useVoicePlayer` reports as `word`.
 */
export function voiceWordAt(clip: ResolvedVoiceClip, clipMs: number): number | null {
  const words = clip.words;
  if (!words || !words.length) return null;
  // Words are monotonic; the last one that has started is the active one,
  // provided it has not ended yet.
  let active: number | null = null;
  for (let i = 0; i < words.length; i++) {
    if (words[i].startMs <= clipMs) active = i;
    else break;
  }
  if (active === null) return null;
  return clipMs < words[active].endMs ? clip.wordOffset + active : null;
}

/**
 * Sequential playback of a voiced message with live clip and word indices
 * for highlighting. One <audio> element, clips chained on `ended`, position
 * sampled every animation frame while playing.
 */
export function useVoicePlayer(
  ref: VoiceRef | null | undefined,
  options: VoicePlayerOptions = {},
): VoicePlayer {
  const voice = useVoice(ref, options.variant);
  const { locale } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clipRef = useRef<number>(0);
  const frameRef = useRef<number | null>(null);
  const onEndRef = useRef(options.onEnd);
  onEndRef.current = options.onEnd;
  const rate = options.rate ?? 1;
  const volume = Math.max(0, options.volume ?? 1);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const boostRef = useRef<{ context: AudioContext; gain: GainNode } | null>(null);

  const [status, setStatus] = useState<VoicePlayerStatus>("idle");
  const [clip, setClip] = useState<number | null>(null);
  const [word, setWord] = useState<number | null>(null);
  const [currentMs, setCurrentMs] = useState(0);

  const audio = useCallback((): HTMLAudioElement | null => {
    if (typeof window === "undefined") return null;
    if (!audioRef.current) {
      audioRef.current = new window.Audio();
      audioRef.current.preload = "auto";
    }
    return audioRef.current;
  }, []);

  /**
   * Set the element's loudness. Up to 1 is the element's own volume. Past 1
   * the element is routed through a gain node, once, on first need; from
   * then on the gain node carries every value.
   */
  const applyVolume = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    const wanted = volumeRef.current;
    let boost = boostRef.current;
    if (!boost && wanted > 1 && el.src && typeof window.AudioContext === "function") {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(el.src, window.location.href).origin === window.location.origin;
      } catch {
        sameOrigin = false;
      }
      if (sameOrigin) {
        try {
          const context = new window.AudioContext();
          const gain = context.createGain();
          context.createMediaElementSource(el).connect(gain).connect(context.destination);
          boost = boostRef.current = { context, gain };
        } catch {
          boost = null;
        }
      }
    }
    if (boost) {
      el.volume = 1;
      boost.gain.gain.value = wanted;
      // A context made before the first tap starts suspended.
      if (boost.context.state === "suspended") void boost.context.resume().catch(() => undefined);
    } else {
      el.volume = Math.min(1, wanted);
    }
  }, []);

  const stopSampling = useCallback(() => {
    if (frameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const sample = useCallback(() => {
    const el = audioRef.current;
    const current = voice?.clips[clipRef.current];
    if (!el || !current) return;
    const clipMs = el.currentTime * 1000;
    setCurrentMs(current.offsetMs + clipMs);
    setWord(voiceWordAt(current, clipMs));
    if (!el.paused && !el.ended) {
      frameRef.current = window.requestAnimationFrame(sample);
    }
  }, [voice]);

  const startSampling = useCallback(() => {
    stopSampling();
    frameRef.current = window.requestAnimationFrame(sample);
  }, [sample, stopSampling]);

  /** Load clip `index` into the element; play it when `autoplay`. */
  const loadClip = useCallback(
    (index: number, autoplay: boolean) => {
      const el = audio();
      if (!el || !voice) return;
      const target = voice.clips[index];
      if (!target) return;
      clipRef.current = index;
      setClip(index);
      setWord(null);
      setCurrentMs(target.offsetMs);
      if (el.src !== target.url) {
        el.src = target.url;
        el.load();
      } else {
        el.currentTime = 0;
      }
      el.playbackRate = rate;
      applyVolume();
      if (autoplay) {
        const attempt = el.play();
        if (attempt && typeof attempt.catch === "function") {
          attempt.catch(() => {
            // Autoplay blocked or decode failure: report as paused so the
            // UI can offer a tap.
            setStatus("paused");
            stopSampling();
          });
        }
      }
    },
    [audio, voice, rate, stopSampling, applyVolume],
  );

  // Wire the element's events once; handlers read the latest voice via refs.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const loadClipRef = useRef(loadClip);
  loadClipRef.current = loadClip;
  useEffect(() => {
    const el = audio();
    if (!el) return;
    const onPlay = () => {
      setStatus("playing");
      startSampling();
    };
    const onPause = () => {
      if (el.ended) return;
      stopSampling();
      setStatus("paused");
    };
    const onEnded = () => {
      stopSampling();
      const current = voiceRef.current;
      const nextIndex = clipRef.current + 1;
      if (current && nextIndex < current.clips.length) {
        loadClipRef.current(nextIndex, true);
        return;
      }
      setWord(null);
      setCurrentMs(current?.durationMs ?? 0);
      setStatus("ended");
      onEndRef.current?.();
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [audio, startSampling, stopSampling]);

  // A locale, variant or message change invalidates the loaded clips.
  useEffect(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    stopSampling();
    clipRef.current = 0;
    setStatus("idle");
    setClip(null);
    setWord(null);
    setCurrentMs(0);
  }, [voice?.id, voice?.variant, locale, stopSampling]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    applyVolume();
  }, [volume, applyVolume]);

  // Release the element on unmount.
  useEffect(() => {
    return () => {
      stopSampling();
      const el = audioRef.current;
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      audioRef.current = null;
      const boost = boostRef.current;
      boostRef.current = null;
      if (boost) void boost.context.close().catch(() => undefined);
    };
  }, [stopSampling]);

  const play = useCallback(() => {
    const el = audio();
    if (!el || !voice || !voice.clips.length) return;
    if (status === "paused" && el.src) {
      applyVolume();
      const attempt = el.play();
      if (attempt && typeof attempt.catch === "function") attempt.catch(() => undefined);
      return;
    }
    loadClip(0, true);
  }, [audio, voice, status, loadClip, applyVolume]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    stopSampling();
    clipRef.current = 0;
    setStatus("idle");
    setClip(null);
    setWord(null);
    setCurrentMs(0);
  }, [stopSampling]);

  const toggle = useCallback(() => {
    if (status === "playing") pause();
    else play();
  }, [status, play, pause]);

  const seekToClip = useCallback(
    (index: number) => {
      if (!voice || index < 0 || index >= voice.clips.length) return;
      loadClip(index, status === "playing");
      if (status !== "playing") setStatus("paused");
    },
    [voice, status, loadClip],
  );

  const seekToWord = useCallback(
    (index: number) => {
      if (!voice) return;
      const el = audio();
      if (!el) return;
      for (let c = 0; c < voice.clips.length; c++) {
        const target = voice.clips[c];
        const words = target.words;
        if (!words) continue;
        const local = index - target.wordOffset;
        if (local >= 0 && local < words.length) {
          const wasPlaying = status === "playing";
          loadClip(c, false);
          const seek = () => {
            el.currentTime = words[local].startMs / 1000;
            if (wasPlaying) {
              const attempt = el.play();
              if (attempt && typeof attempt.catch === "function") attempt.catch(() => undefined);
            } else {
              setStatus("paused");
              setWord(index);
              setCurrentMs(target.offsetMs + words[local].startMs);
            }
          };
          if (el.readyState >= 1) seek();
          else el.addEventListener("loadedmetadata", seek, { once: true });
          return;
        }
      }
    },
    [voice, audio, status, loadClip],
  );

  return {
    available: voice !== null && voice.clips.length > 0,
    voice,
    status,
    clip,
    word,
    currentMs,
    durationMs: voice?.durationMs ?? 0,
    play,
    pause,
    stop,
    toggle,
    seekToClip,
    seekToWord,
  };
}
