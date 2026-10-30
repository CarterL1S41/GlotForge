/**
 * Google Cloud client for the voice command: Text-to-Speech synthesis and
 * Speech-to-Text V2 recognition over REST, with no SDK dependency.
 *
 * Auth, in order:
 *   1. A service-account key (env var named by voice.credentialsEnv, default
 *      GOOGLE_APPLICATION_CREDENTIALS — a file path or the JSON itself),
 *      exchanged for a bearer token with a self-signed RS256 JWT.
 *   2. An API key (env var named by voice.apiKeyEnv, default GOOGLE_TTS_KEY).
 */

import crypto from "crypto";
import fs from "fs";
import type { ResolvedConfig } from "../shared/types";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

interface Credentials {
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

/* ------------------------------ synthesis -------------------------------- */

export interface SynthesisRequest {
  /** Plain sentence text. */
  text: string;
  /** Words to place SSML marks before (mark names are their indices). */
  markWords?: { text: string; start: number; end: number }[];
  locale: string;
  voice: string;
  format: "MP3" | "LINEAR16";
  speakingRate: number;
}

export interface SynthesisResult {
  audio: Buffer;
  /** Mark index -> seconds from the start, when marks were honoured. */
  timepoints: Map<number, number> | null;
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
      : { text: req.text },
    voice: { languageCode: req.locale, name: req.voice },
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

/** Families documented to honour SSML <mark> timepoints. */
export function familyHonoursMarks(voice: string): boolean {
  return /neural2|wavenet|standard|news|polyglot/i.test(voice);
}
