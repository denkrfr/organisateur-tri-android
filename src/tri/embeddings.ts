/**
 * Pipeline d'embedding image via CLIP ViT-B/32 vision (mobile).
 *
 * Etapes pour 1 image :
 *   1. Resize -> 224x224 PNG via expo-image-manipulator (rapide, hardware-acc)
 *   2. Decoder le PNG -> pixels RGB
 *   3. Normaliser selon CLIP (rescale [0,1] + mean/std CLIP)
 *   4. Inference ONNX -> vecteur 512-d
 *   5. L2-normalize -> permet cosinus = dot product
 *
 * Note perf : ~2-5s par image sur CPU ARM. Pour 200 images = ~10 min.
 * Optimisable plus tard avec NNAPI delegate ou MobileCLIP-S0.
 */

import * as ImageManipulator from 'expo-image-manipulator';
import { decodePng, b64ToBytes } from './png';
import { loadVisionSession, loadOnnxLib } from './models';

const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

/** Resize l'image en 224x224 PNG base64. */
async function resizeToBase64(uri: string): Promise<string | null> {
  try {
    const r = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 224, height: 224 } }],
      { compress: 1, format: ImageManipulator.SaveFormat.PNG, base64: true }
    );
    return r.base64 ?? null;
  } catch {
    return null;
  }
}

/** Transforme un PNG decode en Float32Array (3*224*224) normalise pour CLIP. */
function pixelsToFloat32(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number
): Float32Array {
  // CHW (channels first), forme attendue par CLIP : [3, 224, 224]
  const out = new Float32Array(3 * width * height);
  const planeSize = width * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixIdx = (y * width + x) * channels;
      // Si grayscale on duplique sur les 3 channels
      let r: number, g: number, b: number;
      if (channels === 1 || channels === 2) {
        r = g = b = pixels[pixIdx];
      } else {
        r = pixels[pixIdx];
        g = pixels[pixIdx + 1];
        b = pixels[pixIdx + 2];
      }
      const planeOff = y * width + x;
      out[planeOff] = (r / 255 - CLIP_MEAN[0]) / CLIP_STD[0];
      out[planeSize + planeOff] = (g / 255 - CLIP_MEAN[1]) / CLIP_STD[1];
      out[2 * planeSize + planeOff] = (b / 255 - CLIP_MEAN[2]) / CLIP_STD[2];
    }
  }
  return out;
}

/** L2-normalize en place. */
function l2Normalize(vec: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n);
  if (n < 1e-9) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / n;
  return vec;
}

/** Cosinus de 2 vecteurs L2-normalises = simple dot product. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Encode 1 image en vecteur 512-d L2-normalise. Renvoie null si echec
 * (image illisible, modele non charge, etc.).
 */
export async function encodeImage(uri: string): Promise<Float32Array | null> {
  const b64 = await resizeToBase64(uri);
  if (!b64) return null;
  let png;
  try {
    png = decodePng(b64ToBytes(b64));
  } catch {
    return null;
  }
  if (png.width !== 224 || png.height !== 224) return null;

  const input = pixelsToFloat32(png.pixels, png.width, png.height, png.bytesPerPixel);

  let session: any;
  try {
    session = await loadVisionSession();
  } catch {
    return null;
  }

  const onnx = loadOnnxLib();
  const tensor = new onnx.Tensor('float32', input, [1, 3, 224, 224]);
  const feeds: { [key: string]: any } = { pixel_values: tensor };
  const out = await session.run(feeds);
  // Output : "image_embeds" shape [1, 512]
  const key = 'image_embeds' in out ? 'image_embeds' : Object.keys(out)[0];
  const data = out[key].data as Float32Array;
  if (data.length !== 512) return null;
  const vec = new Float32Array(data);
  return l2Normalize(vec);
}
