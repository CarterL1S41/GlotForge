/**
 * Google Cloud client for the voice command: Text-to-Speech synthesis,
 * speech models through generateContent, and Speech-to-Text V2
 * recognition, all over REST with no SDK dependency.
 *
 * Auth, in order:
 *   1. A service-account key (env var named by voice.credentialsEnv, default
 *      GOOGLE_APPLICATION_CREDENTIALS — a file path or the JSON itself),
 *      exchanged for a bearer token with a self-signed RS256 JWT.
 *   2. An API key (env var named by voice.apiKeyEnv, default GOOGLE_TTS_KEY).
 */

import crypto from "crypto";
import fs from "fs";
import type { ResolvedConfig, VoiceTokenPrice } from "../shared/types";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

export interface Credentials {
  kind: "service-account" | "api-key";
  project: string;
  /** Returns the value for the Authorization header, or null for API-key auth. */
  bearer(): Promise<string | null>;
  apiKey?: string;
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1beta1/text:synthesize";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function loadServiceAccount(raw: string): ServiceAccount {
  const trimmed = raw.trim();
  let text = trimmed;
  if (!trimmed.startsWith("{")) {
    if (!fs.existsSync(trimmed)) {
      throw new Error(`service-account file not found: ${trimmed}`);
    }
    text = fs.readFileSync(trimmed, "utf8");
  }
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(text) as ServiceAccount;
  } catch (err) {
    throw new Error(`service-account key is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("service-account key is missing client_email or private_key");
  }
  return parsed;
}

export function resolveCredentials(config: ResolvedConfig): Credentials {
  const saRaw = config.voice.credentialsEnv
    ? process.env[config.voice.credentialsEnv]
    : undefined;
  if (saRaw) {
    const sa = loadServiceAccount(saRaw);
    const project =
      config.voice.project || process.env.GOOGLE_CLOUD_PROJECT || sa.project_id || "";
    if (!project) {
      throw new Error(
        "voice.project is required — the service-account key has no project_id",
      );
    }
    let cached: { token: string; expiresAt: number } | null = null;
    return {
      kind: "service-account",
      project,
      async bearer() {
        if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
        const now = Math.floor(Date.now() / 1000);
        const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
        const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const claims = base64url(
          JSON.stringify({
            iss: sa.client_email,
            scope: SCOPE,
            aud: tokenUri,
            iat: now,
            exp: now + 3600,
          }),
        );
        const signature = crypto.sign(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          sa.private_key,
        );
        const assertion = `${header}.${claims}.${base64url(signature)}`;
        const res = await fetch(tokenUri, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`service-account token exchange failed: ${res.status} ${text.slice(0, 300)}`);
        }
        const data = (await res.json()) as { access_token: string; expires_in: number };
        cached = {
          token: data.access_token,
          expiresAt: Date.now() + data.expires_in * 1000,
        };
        return cached.token;
      },
    };
  }

  const apiKey = config.voice.apiKeyEnv ? process.env[config.voice.apiKeyEnv] : undefined;
  if (apiKey) {
    const project = config.voice.project || process.env.GOOGLE_CLOUD_PROJECT || "";
    if (!project) {
      throw new Error(
        "voice.project (or GOOGLE_CLOUD_PROJECT) is required when authenticating with an API key",
      );
    }
    return {
      kind: "api-key",
      project,
      apiKey,
      async bearer() {
        return null;
      },
    };
  }

  throw new Error(
    `no Google credentials: set ${config.voice.credentialsEnv || "GOOGLE_APPLICATION_CREDENTIALS"} to a service-account key, or ${config.voice.apiKeyEnv || "GOOGLE_TTS_KEY"} to an API key (in the app's .env / .env.local or the environment)`,
  );
}

async function postJson<T>(
  creds: Credentials,
  url: string,
  body: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "x-goog-user-project": creds.project,
  };
  const bearer = await creds.bearer();
  let target = url;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (creds.apiKey) {
    target += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(creds.apiKey);
  }
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(target, { method: "POST", headers, body: JSON.stringify(body) });
    // Transient quota/availability errors: back off and retry a few times.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Not JSON — raw body is the detail.
    }
    throw new GoogleApiError(res.status, detail.slice(0, 400));
  }
  return (await res.json()) as T;
}

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(`Google API ${status}: ${detail}`);
    this.name = "GoogleApiError";
  }
}

/**
 * A request to a Google API with the caller's credentials, retried on
 * quota and availability errors. The response is returned as it came, so
 * the caller decides what a 404 means; other failures still need checking.
 */
export async function authorizedFetch(
  creds: Credentials,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}), "x-goog-user-project": creds.project };
  const bearer = await creds.bearer();
  let target = url;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (creds.apiKey) {
    target += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(creds.apiKey);
  }
  // Bytes go out as a plain typed array, which is what fetch accepts.
  const body = typeof init.body === "string" || init.body === undefined ? init.body : new Uint8Array(init.body);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(target, { method: init.method ?? "GET", headers, body });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    return res;
  }
}

/** The error for a response that is not OK, with Google's message when it sent one. */
export async function googleError(res: Response): Promise<GoogleApiError> {
  const text = await res.text().catch(() => "");
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // Not JSON — raw body is the detail.
  }
  return new GoogleApiError(res.status, detail.slice(0, 400));
}

/* ------------------------------ synthesis -------------------------------- */

export interface SynthesisRequest {
  /** Plain sentence text. */
  text: string;
  /** Words to place SSML marks before (mark names are their indices). */
  markWords?: { text: string; start: number; end: number }[];
  locale: string;
  voice: string;
  /** Speech model, when the voice is a model's speaker; "" for a voice family. */
  model: string;
  /** Style direction for a speech model; "" for none. */
  style: string;
  format: "MP3" | "LINEAR16";
  speakingRate: number;
}

export interface SynthesisResult {
  audio: Buffer;
  /** Mark index -> seconds from the start, when marks were honoured. */
  timepoints: Map<number, number> | null;
  /** Token counts, when the API bills by token and reports them. */
  tokens?: { input: number; output: number };
}

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** SSML with a <mark> before every word plus a closing mark. */
export function markedSsml(
  text: string,
  words: { start: number; end: number }[],
): string {
  let out = "<speak>";
  let cursor = 0;
  words.forEach((word, index) => {
    out += escapeSsml(text.slice(cursor, word.start));
    out += `<mark name="w${index}"/>`;
    out += escapeSsml(text.slice(word.start, word.end));
    cursor = word.end;
  });
  out += escapeSsml(text.slice(cursor));
  out += `<mark name="w${words.length}"/></speak>`;
  return out;
}

export async function synthesize(
  creds: Credentials,
  req: SynthesisRequest,
): Promise<SynthesisResult> {
  const useMarks = Boolean(req.markWords?.length);
  const body: Record<string, unknown> = {
    input: useMarks
      ? { ssml: markedSsml(req.text, req.markWords!) }
      : { text: req.text, ...(req.model && req.style ? { prompt: req.style } : {}) },
    voice: {
      languageCode: req.locale,
      name: req.voice,
      ...(req.model ? { modelName: req.model } : {}),
    },
    audioConfig: {
      audioEncoding: req.format,
      ...(req.speakingRate !== 1 ? { speakingRate: req.speakingRate } : {}),
    },
  };
  if (useMarks) body.enableTimePointing = ["SSML_MARK"];
  const data = await postJson<{
    audioContent: string;
    timepoints?: { markName: string; timeSeconds: number }[];
  }>(creds, TTS_ENDPOINT, body);
  const audio = Buffer.from(data.audioContent, "base64");
  let timepoints: Map<number, number> | null = null;
  if (useMarks && data.timepoints?.length) {
    timepoints = new Map();
    for (const tp of data.timepoints) {
      const match = /^w(\d+)$/.exec(tp.markName);
      if (match) timepoints.set(Number(match[1]), tp.timeSeconds);
    }
    if (timepoints.size === 0) timepoints = null;
  }
  return { audio, timepoints };
}

/* --------------------------- speech models ------------------------------- */

/** Host for generateContent: the configured one, the global one, or the location's own. */
export function generateContentHost(config: ResolvedConfig): string {
  if (config.voice.endpoint) return config.voice.endpoint;
  const location = config.voice.location;
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

interface GenerateContentResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Speech from a model served through generateContent. The model detects
 * the language of the text; voice and style are the only direction it
 * takes, and it returns uncompressed audio (WAV, or raw PCM named by its
 * MIME type), which the caller stores or encodes.
 */
export async function generateSpeech(
  creds: Credentials,
  config: ResolvedConfig,
  req: { text: string; voice: string; model: string; style: string },
): Promise<{ audio: Buffer; mimeType: string; tokens?: { input: number; output: number } }> {
  const url =
    `https://${generateContentHost(config)}/v1/projects/${encodeURIComponent(creds.project)}` +
    `/locations/${encodeURIComponent(config.voice.location)}/publishers/google/models/${encodeURIComponent(req.model)}:generateContent`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: req.text, ...(req.style ? { speechMetadata: { style: req.style } } : {}) }],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { voice: req.voice } },
    },
  };
  // A speech model now and then answers without audio; the same request
  // usually succeeds when asked again.
  let lastReason = "no audio in the response";
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await postJson<GenerateContentResponse>(creds, url, body);
    if (data.promptFeedback?.blockReason) {
      throw new Error(`the speech model refused the text (${data.promptFeedback.blockReason})`);
    }
    const candidate = data.candidates?.[0];
    const part = candidate?.content?.parts?.find((p) => p.inlineData?.data);
    if (part?.inlineData?.data) {
      const usage = data.usageMetadata;
      return {
        audio: Buffer.from(part.inlineData.data, "base64"),
        mimeType: part.inlineData.mimeType ?? "",
        tokens:
          usage && (usage.promptTokenCount !== undefined || usage.candidatesTokenCount !== undefined)
            ? { input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 }
            : undefined,
      };
    }
    if (candidate?.finishReason) lastReason = `no audio in the response (${candidate.finishReason})`;
  }
  throw new Error(`${req.model}: ${lastReason}`);
}

/* ----------------------------- recognition ------------------------------- */

export interface RecognizedWord {
  text: string;
  startMs: number;
  endMs: number;
}

function parseDuration(value: string | undefined): number {
  if (!value) return 0;
  const seconds = parseFloat(value.replace(/s$/, ""));
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * Word-level offsets for a clip through Speech-to-Text V2 Recognize. The
 * transcript is already known; only the timing is wanted.
 */
export async function recognizeWords(
  creds: Credentials,
  config: ResolvedConfig,
  audio: Buffer,
  locale: string,
): Promise<RecognizedWord[]> {
  const region = config.voice.sttRegion;
  const url = `https://${region}-speech.googleapis.com/v2/projects/${creds.project}/locations/${region}/recognizers/_:recognize`;
  const data = await postJson<{
    results?: {
      alternatives?: {
        transcript?: string;
        words?: { word: string; startOffset?: string; endOffset?: string }[];
      }[];
    }[];
  }>(creds, url, {
    config: {
      model: config.voice.sttModel,
      languageCodes: [locale],
      autoDecodingConfig: {},
      features: { enableWordTimeOffsets: true },
    },
    content: audio.toString("base64"),
  });
  const words: RecognizedWord[] = [];
  for (const result of data.results ?? []) {
    const alt = result.alternatives?.[0];
    for (const word of alt?.words ?? []) {
      words.push({
        text: word.word,
        startMs: parseDuration(word.startOffset),
        endMs: parseDuration(word.endOffset),
      });
    }
  }
  return words;
}

/* ------------------------------- pricing --------------------------------- */

/** USD per million characters by voice-name fragment (Google list prices). */
const FAMILY_PRICING: [string, number][] = [
  ["Chirp3-HD", 30],
  ["Studio", 160],
  ["Journey", 30],
  ["Neural2", 16],
  ["Polyglot", 16],
  ["News", 16],
  ["Wavenet", 4],
  ["Standard", 4],
];

export function pricePerMillionChars(
  voice: string,
  configured: Record<string, number>,
): number {
  const lower = voice.toLowerCase();
  for (const [fragment, price] of Object.entries(configured)) {
    if (lower.includes(fragment.toLowerCase())) return price;
  }
  for (const [fragment, price] of FAMILY_PRICING) {
    if (lower.includes(fragment.toLowerCase())) return price;
  }
  return 30;
}

/**
 * List prices of speech models, USD per million tokens, by model-name
 * fragment; the more specific name comes first. Some carry an
 * introductory price with the date it ends.
 */
const MODEL_PRICING: [string, VoiceTokenPrice, { until: string; price: VoiceTokenPrice }?][] = [
  [
    "gemini-3.8-flash-lite-tts",
    { input: 1, output: 12 },
    { until: "2027-01-01", price: { input: 0.5, output: 6 } },
  ],
  [
    "gemini-3.8-flash-tts",
    { input: 1, output: 18 },
    { until: "2027-01-01", price: { input: 0.5, output: 9 } },
  ],
];

/** The price of a speech model, or null when none is known or configured. */
export function pricePerMillionTokens(
  model: string,
  configured: Record<string, VoiceTokenPrice>,
  now = new Date(),
): VoiceTokenPrice | null {
  const lower = model.toLowerCase();
  for (const [fragment, price] of Object.entries(configured)) {
    if (lower.includes(fragment.toLowerCase())) return price;
  }
  for (const [fragment, price, intro] of MODEL_PRICING) {
    if (!lower.includes(fragment)) continue;
    return intro && now < new Date(`${intro.until}T00:00:00Z`) ? intro.price : price;
  }
  return null;
}

/** About four characters of text make one token; good enough for an estimate. */
export const CHARS_PER_TOKEN = 4;

/** Families documented to honour SSML <mark> timepoints. */
export function familyHonoursMarks(voice: string): boolean {
  return /neural2|wavenet|standard|news|polyglot/i.test(voice);
}
