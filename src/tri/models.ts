/**
 * Telechargement, cache et chargement du modele CLIP ViT-B/32 vision (quantize INT8).
 *
 * On utilise UNIQUEMENT le vision encoder (pas le text encoder) puisque le tri
 * par ressemblance se fait image-vs-image sans interaction textuelle.
 *
 * Source : Xenova/clip-vit-base-patch32 sur HuggingFace (~85 MB quantize).
 * Cache dans FileSystem.documentDirectory/models/.
 */

import * as FileSystem from 'expo-file-system';

const MODEL_URL =
  'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx';
const MODEL_FILE = 'clip_vision_quantized.onnx';
const EXPECTED_MIN_SIZE = 80 * 1024 * 1024; // sanity check (~85 MB)

let _session: any = null;
let _onnxLib: any = null;

// Charge onnxruntime-react-native via require paresseux. Si l'app tourne dans
// Expo Go classique (pas de lib native), throw une erreur explicite.
export function loadOnnxLib(): any {
  if (_onnxLib) return _onnxLib;
  try {
    // require() est dynamique en React Native (Metro). Si la lib n'est pas
    // linkee (Expo Go classique), ca throw.
    _onnxLib = require('onnxruntime-react-native');
    return _onnxLib;
  } catch (e) {
    throw new Error(
      'ONNX_NOT_AVAILABLE: cette fonction necessite un Dev Build EAS ' +
      '(pas Expo Go classique). Build un dev client avec : ' +
      'eas build --profile development --platform android'
    );
  }
}

export function isOnnxAvailable(): boolean {
  try {
    loadOnnxLib();
    return true;
  } catch {
    return false;
  }
}

export function modelLocalPath(): string {
  return (FileSystem.documentDirectory ?? '') + 'models/' + MODEL_FILE;
}

export async function isModelDownloaded(): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(modelLocalPath(), { size: true });
  if (!info.exists) return false;
  const size = (info as any).size as number | undefined;
  return !!size && size >= EXPECTED_MIN_SIZE;
}

export type DownloadProgressCb = (downloaded: number, total: number) => void;

export async function downloadModel(onProgress: DownloadProgressCb): Promise<void> {
  const target = modelLocalPath();
  // Cree le dossier models/ si necessaire
  const dir = (FileSystem.documentDirectory ?? '') + 'models/';
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});

  // Telechargement avec progress callback
  const dl = FileSystem.createDownloadResumable(
    MODEL_URL,
    target,
    {},
    (p) => {
      if (p.totalBytesExpectedToWrite > 0) {
        onProgress(p.totalBytesWritten, p.totalBytesExpectedToWrite);
      }
    }
  );
  const result = await dl.downloadAsync();
  if (!result || !result.uri) {
    throw new Error('Telechargement du modele echoue');
  }
  // Verification de taille
  const info = await FileSystem.getInfoAsync(target, { size: true });
  const size = (info as any).size as number | undefined;
  if (!size || size < EXPECTED_MIN_SIZE) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error('Fichier modele corrompu (taille ' + size + ' bytes)');
  }
}

export async function loadVisionSession(): Promise<any> {
  if (_session) return _session;
  if (!(await isModelDownloaded())) {
    throw new Error('Modele non telecharge - utilise downloadModel() d abord');
  }
  const onnx = loadOnnxLib();
  // Strip le prefixe file:// pour onnxruntime-react-native
  const path = modelLocalPath().replace(/^file:\/\//, '');
  _session = await onnx.InferenceSession.create(path);
  return _session;
}

export function releaseSession(): void {
  // Note : onnxruntime-react-native ne necessite pas de release explicite,
  // la session est GC'ee. On reset juste la reference pour permettre un reload.
  _session = null;
}
