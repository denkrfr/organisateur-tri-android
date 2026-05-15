/**
 * Decoder PNG minimal (port du code existant App.tsx, isole pour ne pas
 * dependre du fichier principal).
 *
 * Supporte : bitDepth 8, colorTypes 0/2/4/6 (grayscale, RGB, gray+alpha, RGBA).
 * Suffisant pour ce qu'expo-image-manipulator produit en sortie PNG.
 */

import { inflate } from 'pako';

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export interface DecodedPng {
  width: number;
  height: number;
  pixels: Uint8Array; // entrelaces RGBA (4 chan) ou RGB (3 chan) ou grayscale
  bytesPerPixel: number;
  colorType: number;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new Error('Not a PNG');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];

  let pos = 8;
  while (pos < bytes.length) {
    const len =
      (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    pos += 4;
    const type = String.fromCharCode(
      bytes[pos],
      bytes[pos + 1],
      bytes[pos + 2],
      bytes[pos + 3]
    );
    pos += 4;
    const data = bytes.subarray(pos, pos + len);
    pos += len + 4; // skip CRC

    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error('PNG bitDepth ' + bitDepth + ' unsupported');

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : -1;
  if (channels < 0) throw new Error('PNG colorType ' + colorType + ' unsupported');

  let totalIdat = 0;
  for (const c of idatChunks) totalIdat += c.length;
  const compressed = new Uint8Array(totalIdat);
  let off = 0;
  for (const c of idatChunks) {
    compressed.set(c, off);
    off += c.length;
  }
  const filtered = inflate(compressed);

  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filterType = filtered[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const filt = filtered[rowStart + x];
      const left = x >= channels ? pixels[outStart + x - channels] : 0;
      const up = y > 0 ? pixels[outStart - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[outStart - stride + x - channels] : 0;
      let val = 0;
      switch (filterType) {
        case 0:
          val = filt;
          break;
        case 1:
          val = (filt + left) & 0xff;
          break;
        case 2:
          val = (filt + up) & 0xff;
          break;
        case 3:
          val = (filt + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          val = (filt + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error('Unknown PNG filter ' + filterType);
      }
      pixels[outStart + x] = val;
    }
  }

  return { width, height, pixels, bytesPerPixel: channels, colorType };
}
