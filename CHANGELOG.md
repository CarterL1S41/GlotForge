# Changelog

All notable changes to GlotForge. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.1] — 2026-10-30

### Changed

- The release workflow publishes through npm Trusted Publishing (GitHub
  OIDC with `id-token: write`, Node 24, provenance attached) instead of a
  stored `NPM_TOKEN` secret. README documents the one-time trusted
  publisher setup on npmjs.com.

No package code changed.

## [1.0.0] — 2026-10-30

### Added

- **Spoken audio.** Mark a message with `voice` (`<Trans voice="intro">`,
  bare `<Trans voice>`, `t("...", { voice: "key" })`, `msg(...)`) and
  `glotforge voice` generates one audio clip per sentence for every locale
  with a configured voice, the source locale included. Google Cloud
  Text-to-Speech is the synthesizer; the voice name picks the family
  (Chirp 3 HD, Neural2, WaveNet, Standard).
- **Word timing.** Each clip records per-word start and end offsets for
  read-along highlighting. Families that honour SSML marks (Neural2,
  WaveNet, Standard) give exact timepoints; Chirp 3 HD ignores marks, so its
  clips are aligned through Speech-to-Text V2 (`chirp_2`, word offsets on)
  by placing the known words onto what the recogniser heard. Dropped words
  are interpolated and flagged `estimated`. `voice.wordTiming` selects
  `auto`, `marks`, `align` or `none`.
- **Audio catalogs**, committed beside the text catalogs:
  `i18n/voice/<locale>.json` (voice keys plus per-clip text, duration and
  words) and clip files under `voice.audioDir` (default
  `public/audio/i18n/<locale>/<hash>-<n>.mp3`). `extract` prunes entries and
  files whose message is gone or no longer voiced and keeps the key map
  current. `status` reports audio coverage and word-timed counts per locale.
- **`voice` config section**: per-locale voices, `format` (`MP3` default,
  `LINEAR16` override), `speakingRate`, `audioDir`, `wordTiming`,
  `sttRegion`, `sttModel`, `pricing`, `sttPerMinuteUsd`, `concurrency`,
  `project`, `credentialsEnv`, `apiKeyEnv`.
- **Google credentials** with no SDK dependency: a service-account key
  (`GOOGLE_APPLICATION_CREDENTIALS`, file path or JSON) exchanged for a
  token with a self-signed RS256 JWT, or an API key (`GOOGLE_TTS_KEY` plus
  `voice.project`).
- **Cost estimate and confirmation** before any synthesis, priced per voice
  family and per aligned minute; `--dry-run`, `--yes`, `--force`, `--locale`
  work as they do for `translate`. Catalogs are written after every entry.
  Entries regenerate only when their voice, format, pace or text changed.
- **Runtime playback.** `I18nProvider` takes `loadVoiceManifest` and
  `audioBaseUrl`. `useVoice(ref)` resolves a message's clips with URLs.
  `useVoicePlayer(ref)` plays clips in sequence and reports the live clip
  and word index with `play`, `pause`, `stop`, `toggle`, `seekToClip` and
  `seekToWord`. `<Trans highlight={player.word}>` renders every word in a
  `<span data-voice-word={n}>` and marks the current one
  `data-voice-active`. A ref is a voice key, a `msg()` descriptor or a hash.
- `splitSentences` and `splitWords` in `src/shared/speech.ts`, exported from
  the client entry. Word numbering is a shared contract between the CLI and
  the renderer and joins the list of things that must never change casually.
- `MessageEntry.voice`, `VoiceManifest`, `VoiceEntry`, `VoiceClip`,
  `VoiceWord` and `VoiceTiming` types, exported from both entries.
- MP3 and WAV duration readers (frame-header scan and header arithmetic).

### Changed

- `glotforge extract` now errors when one message carries two different
  voice keys or two messages share a key.
- `TOptions` and `MessageDescriptor` accept `voice`; the loader carries it
  into compiled `t()` / `msg()` descriptors.
- The `voice` marker on a message with a placeholder, plural or select is
  reported as an extract diagnostic and ignored, since spoken text must be
  static.
- Package description and keywords mention text-to-speech.

## [0.1.0] — 2026-09-03

Initial release.

### Added

- **Runtime** (`glotforge`): `<Trans>` with inline elements mapped to
  semantic tags, `<Plural>`, `t` in tagged-template, plain-string and
  descriptor forms, `msg` for module-scope constants, `I18nProvider` with
  cookie-resolved locale, lazy per-locale catalogs and a localStorage cache,
  `useT`, `useFormat` Intl helpers, RTL `dir` and `data-i18n-font` on
  `<html>`, and devtools with a hover inspector, locale switcher and a
  pseudo-locale gated by a server-controlled `devtoolsAllowed`.
- **Server helpers** (`glotforge/server`): `readLocaleCookie`, `pickLocale`,
  `createT` for per-request translation.
- **Loader** (`glotforge/loader`): build-time injection of hashes, canonical
  messages and named placeholder values, so the runtime never hashes.
- **ESLint plugin** (`glotforge/eslint`): `no-bare-text` and
  `no-block-in-trans`, with a `recommended` flat config.
- **CLI** (`npx glotforge`): `init`, `extract` (manifest reconciliation and
  orphan pruning, scoped runs), `translate` (Claude by default with thinking
  on, per-locale model/thinking/effort overrides, OpenAI-compatible
  providers, glossary and app context in every prompt, token-counted cost
  estimate with confirmation, structural validation with one retry,
  server-side refusal fallbacks, crash-safe per-batch writes, single-line
  progress bar) and `status`.
- Content-hash catalogs committed in the consuming app: `i18n/messages.json`
  and `i18n/catalog/<locale>.json` are the translation cache.
- Own message grammar: arguments, plural, select, semantic tags, escapes.
- JSX entity decoding and Babel-style whitespace cleaning in the extractor
  so hashes match what React renders.
- CI on `develop` and `main`; release workflow on `v*` tags publishing to
  npm.

[1.0.1]: https://github.com/CarterL1S41/GlotForge/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/CarterL1S41/GlotForge/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/CarterL1S41/GlotForge/releases/tag/v0.1.0
