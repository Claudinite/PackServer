import { LIMITS } from "./limits.ts";
import { bomb, unsafe } from "./errors.ts";

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
const MAX_BLOCK = 128 * 1024;

/**
 * Walks the frame and block headers of a zstd stream without decoding anything, so the checks that
 * need only declared parameters (window, skippable frames, dictionaries, structure) cost a few
 * header reads. Returns the end offset of each frame, so a decoder can be fed one frame at a time.
 */
export function inspectFrames(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length;
  let pos = 0;
  const ends: number[] = [];
  const need = (n: number) => {
    if (pos + n > end) throw unsafe("zstd-truncated");
  };

  if (end === 0) throw unsafe("zstd-magic");
  while (pos < end) {
    need(4);
    const magic = view.getUint32(pos, true);
    if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) throw unsafe("zstd-skippable-frame");
    if (magic !== ZSTD_MAGIC) throw unsafe("zstd-magic");
    pos += 4;

    need(1);
    const descriptor = bytes[pos++]!;
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    if ((descriptor & 0x18) !== 0) throw unsafe("zstd-reserved-bits");
    if ((descriptor & 0x03) !== 0) throw unsafe("zstd-dictionary");

    let windowSize: number;
    if (!singleSegment) {
      need(1);
      const w = bytes[pos++]!;
      const base = 2 ** (10 + (w >> 3));
      windowSize = base + (base / 8) * (w & 7);
    } else {
      windowSize = 0;
    }
    const fcsBytes = [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]!;
    need(fcsBytes);
    if (singleSegment) {
      // With no window descriptor the declared content size is the window.
      windowSize = fcsBytes === 1 ? bytes[pos]! : fcsBytes === 2 ? view.getUint16(pos, true) + 256 : fcsBytes === 4 ? view.getUint32(pos, true) : Number(view.getBigUint64(pos, true));
    }
    pos += fcsBytes;
    if (windowSize > LIMITS.windowBytes) throw bomb("zstd-window", `${windowSize} bytes`);

    const blockMax = Math.min(windowSize, MAX_BLOCK);
    for (;;) {
      need(3);
      const h = bytes[pos]! | (bytes[pos + 1]! << 8) | (bytes[pos + 2]! << 16);
      pos += 3;
      const last = (h & 1) !== 0;
      const type = (h >> 1) & 3;
      const size = h >> 3;
      if (type === 3) throw unsafe("zstd-block-type");
      if (size > blockMax) throw unsafe("zstd-block-size");
      const stored = type === 1 ? 1 : size;
      need(stored);
      pos += stored;
      if (last) break;
    }
    if (checksum) {
      need(4);
      pos += 4;
    }
    ends.push(pos);
    if (ends.length > LIMITS.frames) throw unsafe("zstd-frame-count");
  }
  return ends;
}
