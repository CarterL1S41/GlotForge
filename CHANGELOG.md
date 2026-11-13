# Changelog

All notable changes to GlotForge. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [1.5.0] — 2026-11-13

### Added

- **Clips from another origin.** The provider's `audioCrossOrigin`
  (`"anonymous"` or `"use-credentials"`) has the player request clips as
  CORS media, for clips served from a bucket, a CDN or an API on its own
  host. With it set, a `volume` above 1 amplifies those clips too; without
  it the value is still held at 1 for another origin.

## [1.4.0] — 2026-11-13

### Added

- **Clips in a storage bucket.** `voice.storage: { "type": "gcs", "bucket",
  "prefix" }` keeps clip files in a Google Cloud Storage bucket instead of
  the app's `audioDir`. The audio catalogs stay in the catalog directory
  and are still committed, so they still record every clip and nothing is
  generated twice. Uploading uses the service account the `voice` command
  already authenticates with. The default, `{ "type": "local" }`, is
  unchanged.
- **Fingerprinted file names.** `voice.fileNames: "fingerprint"` adds a
  short hash of the audio to each clip's name, so a file never changes
  once written and can be cached for good. It is the default for a bucket;
  local storage keeps `"stable"` names.
- **`voice --sync`** uploads every clip the catalogs record that is in
  `audioDir` and not yet in the bucket, so an existing library moves
  without being generated again.
- **`voice --prune`** deletes the clip files in storage that no catalog
  records. With a bucket, the files of regenerated and dropped clips are
  left in place during generation, since an earlier deployed build may
  still play them, and are removed by this command.

### Fixed

- **Word timing past the end of a clip.** Speech-to-Text now and then
  reports a word offset far beyond the clip's length. Alignment used it as
  given, so the last words of a clip could be timed minutes after it
  ended. A start beyond the clip is now treated as unheard and
  interpolated, and an end beyond it is replaced with the next word's
  start or the end of the clip; those words are flagged `estimated`.

## [1.3.0] — 2026-11-13

### Added

- **Speech models.** `voice.model` names a generative speech model
  (for example `gemini-3.8-flash-tts`) to speak the voices in place of a
  Cloud Text-to-Speech voice family; a voice is then the model's speaker
  name. Without `model` nothing changes. The model is called through
  `generateContent`; `voice.api: "text-to-speech"` sends it through Cloud
  Text-to-Speech as `modelName` for the speech models that API serves.
  `voice.location` and `voice.endpoint` choose where `generateContent`
  requests go.
- **Style direction.** `voice.style` gives a speech model its tone, pace,
  accent and delivery in plain words. `voice.styles` sets it per locale,
  which is where accent and dialect go for a model that detects the
  language from the text. A variant written as an object
  (`{ "voice", "model", "style", "api" }`) carries its own settings, so one
  config can mix speech models and voice families.
- **MP3 from uncompressed audio.** A model that returns only WAV or raw
  PCM still produces MP3 clips: with `format: "MP3"` GlotForge encodes each
  clip itself at `voice.mp3Bitrate` kbps (default 64). `format:
  "LINEAR16"` keeps the clips as WAV. The encoder is the
  `wasm-media-encoders` package, loaded on first use.
- **Token pricing.** Speech models are estimated and costed per million
  tokens: list prices are built in for the models GlotForge knows,
  `voice.tokenPricing` sets or overrides them, and
  `voice.audioTokensPerSecond` sizes the audio for the estimate. The cost
  reported after a run uses the token counts the API returns. A model with
  no price is left out of the estimate and named.

### Changed

- An audio catalog entry records the `model` and `style` it was generated
  with, and changing either regenerates the entry. Entries from earlier
  versions carry neither and stay current for voice families.
- `status` and the `voice` plan show a model voice as `Kore
  (gemini-3.8-flash-tts)`.

## [1.2.0] — 2026-11-12

### Added

- **Whole-message clips.** `voice.clips` chooses how a message is cut:
  `"sentence"` (the default, unchanged) makes one clip per sentence;
  `"message"` synthesizes the whole message as a single clip, so the voice
  hears each sentence in context and its intonation carries across
  sentence boundaries. Word timing, highlighting and `seekToWord` work the
  same either way. Changing the setting regenerates every entry on the
  next `voice` run.
- **Player volume.** `useVoicePlayer(ref, { volume })` sets how loud the
  clips play: `1` is the clip as recorded, `0` is silent, and a value above
  `1` amplifies it through Web Audio. Amplifying needs clips served from
  the page's own origin; from another origin the value is held at `1`.
- **Clips without the player.** `resolveVoice(manifest, ref, options)`
  looks a message up in an audio catalog and returns its clips with URLs,
  word offsets and durations: plain data, no React, for a player of your
  own. `voiceWordAt(clip, ms)` gives the word being spoken at a position in
  a clip. The `VoiceManifest`, `VoiceEntry` and `VoiceClip` types are
  exported.

## [1.1.0] — 2026-10-30

### Added

- **Voice variants.** A locale's entry in `voice.voices` can be a map of
  named voices (`{ "female": "...Aoede", "male": "...Charon" }`) instead of
  one string. Every variant is synthesized and word-timed on its own; clips
  are named `<hash>-<variant>-<n>`, and the audio catalog keys entries by
  hash then variant and lists the locale's `variants` in config order. A
  plain string still works as a single variant named `default`. Removing a
  variant from config drops its entries and files on the next `voice` run.
- Runtime: `voiceVariant` / `setVoiceVariant` on the provider (persisted
  locally), `useVoiceVariants()` for pickers, a `variant` option on
  `useVoicePlayer` and a second argument on `useVoice`. A variant the
  current locale lacks falls back to the locale's first; the resolved name
  is reported on `ResolvedVoice.variant`.
- `status` reports audio coverage per locale and variant.

### Changed

- Audio catalog format: `entries[hash]` is now `entries[hash][variant]`
  and the manifest carries `variants`. Catalogs written by 1.0.x are not
  read; delete `i18n/voice/` and the clip directory and run
  `glotforge voice` again.

## [1.0.1] — 2026-10-30

### Changed

- Releases publish through npm Trusted Publishing with provenance
  attestations instead of a stored registry token.

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

[1.1.0]: https://github.com/CarterL1S41/GlotForge/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/CarterL1S41/GlotForge/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/CarterL1S41/GlotForge/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/CarterL1S41/GlotForge/releases/tag/v0.1.0
