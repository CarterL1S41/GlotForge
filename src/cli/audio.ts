/**
 * Clip duration from the bytes Google returns — WAV by header arithmetic,
 * MP3 by walking the frame headers. No decoder, no dependency.
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
