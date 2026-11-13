/**
 * Clip duration from the bytes Google returns — WAV by header arithmetic,
 * MP3 by walking the frame headers, with no decoder. Below that: reading
 * the uncompressed audio a speech model returns, and encoding it as MP3.
 */

export function audioDurationMs(bytes: Buffer, format: "MP3" | "LINEAR16"): number {
  return format === "MP3" ? mp3DurationMs(bytes) : wavDurationMs(bytes);
}

function wavDurationMs(bytes: Buffer): number {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("not a WAV file");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bitsPerSample = bytes.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (!sampleRate || !channels || !bitsPerSample) {
        throw new Error("WAV data chunk before fmt chunk");
      }
      // Google may write a streaming-style size of 0 / 0xFFFFFFFF; fall
      // back to what is actually present.
      const dataBytes =
        size === 0 || size === 0xffffffff || body + size > bytes.length
          ? bytes.length - body
          : size;
      const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
      return Math.round((dataBytes / bytesPerSecond) * 1000);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

// MPEG audio frame tables (Layer III).
const BITRATES: Record<string, number[]> = {
  // kbps, index 1..14 (0 = free, 15 = bad)
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<string, number[]> = {
  v1: [44100, 48000, 32000],
  v2: [22050, 24000, 16000],
  v25: [11025, 12000, 8000],
};

function mp3DurationMs(bytes: Buffer): number {
  let offset = 0;
  // Skip an ID3v2 tag.
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "ID3") {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    offset = 10 + size;
  }
  let samples = 0;
  let sampleRate = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset++;
      continue;
    }
    const versionBits = (bytes[offset + 1] >> 3) & 0x03; // 0=2.5, 2=2, 3=1
    const layerBits = (bytes[offset + 1] >> 1) & 0x03; // 1 = Layer III
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    const rateIndex = (bytes[offset + 2] >> 2) & 0x03;
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      offset++;
      continue;
    }
    const version = versionBits === 3 ? "v1" : versionBits === 2 ? "v2" : "v25";
    const bitrate = BITRATES[version === "v1" ? "v1" : "v2"][bitrateIndex] * 1000;
    const rate = SAMPLE_RATES[version][rateIndex];
    const samplesPerFrame = version === "v1" ? 1152 : 576;
    const frameLength = Math.floor((samplesPerFrame / 8) * bitrate / rate) + padding;
    if (frameLength <= 4) {
      offset++;
      continue;
    }
    // A Xing/Info header frame carries no audio — leave it out of the count.
    const frameEnd = Math.min(offset + frameLength, bytes.length);
    const xing = bytes.indexOf("Xing", offset + 4, "ascii");
    const info = bytes.indexOf("Info", offset + 4, "ascii");
    const isInfoFrame =
      (xing !== -1 && xing < frameEnd) || (info !== -1 && info < frameEnd);
    if (!isInfoFrame) {
      samples += samplesPerFrame;
      frames++;
    }
    sampleRate = rate;
    offset += frameLength;
  }
  if (!frames || !sampleRate) throw new Error("no MPEG audio frames found");
  return Math.round((samples / sampleRate) * 1000);
}

/* ------------------------------ PCM and MP3 ------------------------------- */

/** Uncompressed 16-bit audio, samples interleaved by channel. */
export interface PcmAudio {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

function int16From(bytes: Buffer, start: number, end: number): Int16Array {
  const count = Math.floor((end - start) / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = bytes.readInt16LE(start + i * 2);
  return samples;
}

/**
 * The samples of what a speech model returned: a WAV file, or headerless
 * 16-bit PCM whose sample rate is named in the MIME type
 * ("audio/L16;rate=24000"). Anything else is refused.
 */
export function readPcm(bytes: Buffer, mimeType = ""): PcmAudio {
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF") {
    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bitsPerSample = 0;
    let format = 0;
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === "fmt ") {
        format = bytes.readUInt16LE(body);
        channels = bytes.readUInt16LE(body + 2);
        sampleRate = bytes.readUInt32LE(body + 4);
        bitsPerSample = bytes.readUInt16LE(body + 14);
      } else if (id === "data") {
        // 1 = PCM; 0xFFFE = extensible, which wraps PCM for these files.
        if ((format !== 1 && format !== 0xfffe) || bitsPerSample !== 16 || !sampleRate || !channels) {
          throw new Error(
            `unsupported WAV audio (format ${format}, ${bitsPerSample}-bit) — 16-bit PCM is expected`,
          );
        }
        const end =
          size === 0 || size === 0xffffffff || body + size > bytes.length ? bytes.length : body + size;
        return { sampleRate, channels, samples: int16From(bytes, body, end) };
      }
      offset = body + size + (size % 2);
    }
    throw new Error("WAV file has no data chunk");
  }
  if (/audio\/(l16|pcm)/i.test(mimeType)) {
    const rate = /rate=(\d+)/i.exec(mimeType);
    const channels = /channels=(\d+)/i.exec(mimeType);
    return {
      sampleRate: rate ? Number(rate[1]) : 24000,
      channels: channels ? Number(channels[1]) : 1,
      samples: int16From(bytes, 0, bytes.length),
    };
  }
  throw new Error(`unexpected audio from the speech model (${mimeType || "no MIME type"})`);
}

/** A WAV file holding the given samples. */
export function wavFromPcm(pcm: PcmAudio): Buffer {
  const dataBytes = pcm.samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(pcm.channels, 22);
  out.writeUInt32LE(pcm.sampleRate, 24);
  out.writeUInt32LE(pcm.sampleRate * pcm.channels * 2, 28);
  out.writeUInt16LE(pcm.channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.samples.length; i++) out.writeInt16LE(pcm.samples[i], 44 + i * 2);
  return out;
}

/** The slice of the MP3 encoder package GlotForge uses. */
interface Mp3Encoder {
  configure(params: { sampleRate: number; channels: 1 | 2; bitrate: number }): void;
  encode(samples: readonly Float32Array[]): Uint8Array;
  finalize(): Uint8Array;
}

let mp3Encoder: Promise<Mp3Encoder> | null = null;

function loadMp3Encoder(): Promise<Mp3Encoder> {
  if (!mp3Encoder) {
    let create: () => Promise<Mp3Encoder>;
    try {
      // Loaded on first use, so a project whose voices already arrive as
      // MP3 never touches the encoder.
      create = (require("wasm-media-encoders") as { createMp3Encoder: () => Promise<Mp3Encoder> })
        .createMp3Encoder;
    } catch (err) {
      throw new Error(
        `the MP3 encoder could not be loaded (${(err as Error).message}) — reinstall dependencies, or set voice.format to "LINEAR16" to keep WAV clips`,
      );
    }
    mp3Encoder = create();
  }
  return mp3Encoder;
}

/**
 * Encode samples as a constant-bitrate MP3. Audio with more than two
 * channels is refused; speech models return one.
 */
export async function mp3FromPcm(pcm: PcmAudio, bitrateKbps: number): Promise<Buffer> {
  if (pcm.channels !== 1 && pcm.channels !== 2) {
    throw new Error(`cannot encode ${pcm.channels}-channel audio as MP3`);
  }
  const encoder = await loadMp3Encoder();
  const frames = Math.floor(pcm.samples.length / pcm.channels);
  const channelData: Float32Array[] = [];
  for (let c = 0; c < pcm.channels; c++) {
    const data = new Float32Array(frames);
    for (let i = 0; i < frames; i++) data[i] = pcm.samples[i * pcm.channels + c] / 32768;
    channelData.push(data);
  }
  // One encoder is shared: everything from configure to finalize runs
  // without yielding, so clips encoded at the same time cannot interleave.
  // Each returned chunk is a view the encoder reuses and must be copied.
  encoder.configure({ sampleRate: pcm.sampleRate, channels: pcm.channels === 2 ? 2 : 1, bitrate: bitrateKbps });
  const body = Buffer.from(encoder.encode(channelData));
  const tail = Buffer.from(encoder.finalize());
  return Buffer.concat([body, tail]);
}
