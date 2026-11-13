import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { ResolvedConfig } from "../shared/types";
import { authorizedFetch, googleError, resolveCredentials, type Credentials } from "./google";
import { audioDir } from "./voice-catalog";

/**
 * Where clip files live: the app's own audio directory, or a bucket. The
 * voice command reads and writes clips through this, so the rest of it
 * does not care which.
 *
 * A clip is addressed by the path the audio catalog stores for it
 * ("es-ES/1abc-female-0.mp3"); a bucket puts its prefix in front.
 */
export interface ClipStore {
  kind: "local" | "gcs";
  /** For messages: the directory or "gs://bucket/prefix". */
  label: string;
  has(file: string): Promise<boolean>;
  read(file: string): Promise<Buffer>;
  write(file: string, bytes: Buffer): Promise<void>;
  /** Missing files are not an error. */
  remove(files: string[]): Promise<void>;
  /** Every clip file kept for a locale, as catalog paths. */
  list(locale: string): Promise<string[]>;
}

function contentTypeOf(file: string): string {
  return file.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
}

/** Ten hex characters of the audio's SHA-256: enough to tell two takes of a clip apart. */
export function audioFingerprint(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}

function localStore(config: ResolvedConfig, cwd: string): ClipStore {
  const root = audioDir(config, cwd);
  return {
    kind: "local",
    label: config.voice.audioDir,
    async has(file) {
      return fs.existsSync(path.join(root, file));
    },
    async read(file) {
      return fs.readFileSync(path.join(root, file));
    },
    async write(file, bytes) {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, bytes);
    },
    async remove(files) {
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(root, file));
        } catch {
          // Already gone.
        }
      }
    },
    async list(locale) {
      const dir = path.join(root, locale);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `${locale}/${entry.name}`);
    },
  };
}

const GCS_API = "https://storage.googleapis.com/storage/v1";
const GCS_UPLOAD = "https://storage.googleapis.com/upload/storage/v1";

function bucketStore(
  config: ResolvedConfig,
  storage: Extract<ResolvedConfig["voice"]["storage"], { type: "gcs" }>,
): ClipStore {
  // Credentials are read on first use, so a run that never touches the
  // bucket (an estimate, a locale with nothing to do) needs none.
  let creds: Credentials | null = null;
  const credentials = (): Credentials => {
    if (!creds) {
      creds = resolveCredentials(config);
      if (creds.kind !== "service-account") {
        throw new Error(
          "a storage bucket needs a service account — an API key cannot write to Cloud Storage",
        );
      }
    }
    return creds;
  };
  const bucket = encodeURIComponent(storage.bucket);
  const objectName = (file: string) => (storage.prefix ? `${storage.prefix}/${file}` : file);
  const objectUrl = (file: string) => `${GCS_API}/b/${bucket}/o/${encodeURIComponent(objectName(file))}`;

  return {
    kind: "gcs",
    label: `gs://${storage.bucket}${storage.prefix ? `/${storage.prefix}` : ""}`,
    async has(file) {
      const res = await authorizedFetch(credentials(), `${objectUrl(file)}?fields=name`);
      if (res.status === 404) return false;
      if (!res.ok) throw await googleError(res);
      return true;
    },
    async read(file) {
      const res = await authorizedFetch(credentials(), `${objectUrl(file)}?alt=media`);
      if (!res.ok) throw await googleError(res);
      return Buffer.from(await res.arrayBuffer());
    },
    async write(file, bytes) {
      // One multipart request carries the object's metadata and its bytes.
      const boundary = `glotforge-${crypto.randomBytes(12).toString("hex")}`;
      const contentType = contentTypeOf(file);
      const metadata = JSON.stringify({
        name: objectName(file),
        contentType,
        cacheControl: storage.cacheControl,
      });
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
            `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
          "utf8",
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
      ]);
      const res = await authorizedFetch(credentials(), `${GCS_UPLOAD}/b/${bucket}/o?uploadType=multipart`, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!res.ok) throw await googleError(res);
    },
    async remove(files) {
      for (const file of files) {
        const res = await authorizedFetch(credentials(), objectUrl(file), { method: "DELETE" });
        if (!res.ok && res.status !== 404) throw await googleError(res);
      }
    },
    async list(locale) {
      const folder = `${objectName(locale)}/`;
      const files: string[] = [];
      let pageToken = "";
      do {
        const url =
          `${GCS_API}/b/${bucket}/o?prefix=${encodeURIComponent(folder)}` +
          `&fields=${encodeURIComponent("items(name),nextPageToken")}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await authorizedFetch(credentials(), url);
        if (!res.ok) throw await googleError(res);
        const data = (await res.json()) as { items?: { name: string }[]; nextPageToken?: string };
        for (const item of data.items ?? []) {
          // Back to the catalog's path: without the bucket prefix.
          files.push(storage.prefix ? item.name.slice(storage.prefix.length + 1) : item.name);
        }
        pageToken = data.nextPageToken ?? "";
      } while (pageToken);
      return files;
    },
  };
}

export function openClipStore(config: ResolvedConfig, cwd: string): ClipStore {
  const storage = config.voice.storage;
  return storage.type === "gcs" ? bucketStore(config, storage) : localStore(config, cwd);
}
