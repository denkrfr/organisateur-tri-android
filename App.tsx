/**
 * Doublons photos - App Android (Expo + React Native + TypeScript)
 *
 * 4 ecrans :
 *   1. Permission : demande l'acces aux medias au 1er lancement
 *   2. Accueil    : bouton scanner + toggle videos + acces corbeille
 *   3. Scan       : barre de progression + bouton annuler
 *   4. Resultats  : groupes de doublons avec multi-select -> "Vers corbeille"
 *   5. Corbeille  : fichiers en attente de suppression
 *                   -> "Restaurer" (annule) ou "Supprimer definitivement" (corbeille systeme)
 *
 * Triple filet de securite avant suppression definitive :
 *   1. Corbeille interne de l'app  (annulable a tout moment, juste un changement de state)
 *   2. Corbeille systeme Android   (recuperable 30 jours via app Galerie)
 *   3. Effacement definitif        (apres 30 jours dans corbeille systeme)
 *
 * Logique de detection :
 *   - Permission expo-media-library granular (photos +/- videos)
 *   - Scan paginate des Assets de la galerie (pages de 500)
 *   - Quick-hash = SHA256(first 16KB + last 16KB + size) -> tres rapide, zero collision
 *   - Hashing parallelise par batches de 8 -> ~3x plus rapide
 *   - Groupement par hash, groupes >= 2 (doublons, triples, plus)
 *   - Suppression via MediaLibrary.deleteAssetsAsync -> dialog systeme + corbeille Galerie
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  StatusBar,
  Switch,
  Pressable,
  Platform,
  Linking,
  AppState,
} from 'react-native';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';
import { inflate } from 'pako';

// ============================================================================
// Types & constantes
// ============================================================================
type Screen = 'permission' | 'home' | 'albums' | 'scan' | 'results' | 'corbeille';

interface AlbumItem {
  id: string;
  title: string;
  assetCount: number;
}

interface AssetItem {
  id: string;
  uri: string;
  filename: string;
  fileSize: number;
  duration: number;
  mediaType: 'photo' | 'video' | 'audio' | 'unknown';
  createdAt: number;
  hash?: string;
}

interface DupGroup {
  hash: string;
  items: AssetItem[];
  totalRecoverable: number; // bytes recuperables si on supprime tous sauf le plus gros
  kind: 'exact' | 'quasi'; // V2.1 : exact = byte-identique, quasi = aHash similar
}

const COLORS = {
  bg:        '#0f1117',
  card:      '#1a1d27',
  card2:     '#252836',
  border:    '#2e3244',
  text:      '#e4e6f0',
  text2:     '#8b8fa3',
  text3:     '#5a5e70',
  // V2 : couleur turquoise pour distinguer visuellement de la V1 (violet)
  accent:    '#00b894',
  accent2:   '#55efc4',
  danger:    '#ff6b6b',
  warn:      '#ffd43b',
  ok:        '#51cf66',
};

// On lit 16 KB au debut + 16 KB a la fin pour le quick-hash
const QUICK_HASH_BYTES = 16 * 1024;

// Sur Android 11+, MediaLibrary.deleteAssetsAsync ne supprime PAS vraiment les
// fichiers : ils sont deplaces dans la corbeille systeme (.trash) avec un flag
// IS_TRASHED=true, mais MediaStore continue de les retourner via getAssetsAsync.
// Sans filtre on les re-detecte comme doublons au scan suivant.
// On persiste donc localement les ids deja envoyes a la corbeille systeme,
// et on les filtre au debut de chaque scan. Apres ~30 jours le fichier est
// vraiment efface par Android, son id disparait alors de MediaStore et notre
// liste ne fait plus rien pour cet id (taille negligeable de toute facon).
const DELETED_IDS_FILE = FileSystem.documentDirectory + 'deleted_ids.json';

async function loadDeletedIds(): Promise<Set<string>> {
  try {
    const info = await FileSystem.getInfoAsync(DELETED_IDS_FILE);
    if (!info.exists) return new Set();
    const text = await FileSystem.readAsStringAsync(DELETED_IDS_FILE);
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

async function saveDeletedIds(ids: Set<string>): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(
      DELETED_IDS_FILE,
      JSON.stringify(Array.from(ids))
    );
  } catch {
    // best-effort : si l'ecriture echoue le filtre se fera au prochain run
  }
}

// ============================================================================
// Helpers : hashing
// ============================================================================
async function quickHash(uri: string, fileSize: number): Promise<string | null> {
  try {
    let payload = '';
    if (fileSize <= 2 * QUICK_HASH_BYTES) {
      // Petit fichier : on lit tout
      payload = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } else {
      // Gros fichier : debut + fin
      const head = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        position: 0,
        length: QUICK_HASH_BYTES,
      });
      const tail = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        position: fileSize - QUICK_HASH_BYTES,
        length: QUICK_HASH_BYTES,
      });
      payload = head + tail;
    }
    // Inclut la taille pour reduire encore les collisions
    const hash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      payload + '|' + fileSize.toString(),
      { encoding: Crypto.CryptoEncoding.HEX }
    );
    return hash;
  } catch {
    return null;
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} Go`;
}

// ============================================================================
// Scan logic
// ============================================================================
type ProgressCb = (current: number, total: number, label: string) => void;

// Liste les albums (= dossiers de la galerie : DCIM, WhatsApp, etc.) avec
// le nombre d'assets de chaque (photos+videos pour pouvoir choisir lesquels
// scanner). On ignore les smart albums pour rester aligne avec les vrais
// dossiers du systeme de fichiers.
async function fetchAllAlbums(): Promise<AlbumItem[]> {
  const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
  const items: AlbumItem[] = albums
    .map((a) => ({ id: a.id, title: a.title, assetCount: a.assetCount }))
    .filter((a) => a.assetCount > 0);
  // Tri par taille decroissante : les gros dossiers en premier
  items.sort((a, b) => b.assetCount - a.assetCount);
  return items;
}

async function fetchAllAssets(
  includeVideos: boolean,
  selectedAlbumIds: string[] | null, // null = toute la galerie sans filtre
  onProgress: ProgressCb,
  cancelRef: { cancelled: boolean }
): Promise<AssetItem[]> {
  const assets: AssetItem[] = [];
  const seenIds = new Set<string>(); // dedup au cas ou un asset est dans plusieurs albums
  const PAGE_SIZE = 500;
  const mediaTypes: MediaLibrary.MediaTypeValue[] = includeVideos
    ? ['photo', 'video']
    : ['photo'];

  // Si selectedAlbumIds null on scanne sans filtre (= toute la galerie),
  // sinon on enchaine les scans album par album.
  const scopes: (string | undefined)[] =
    selectedAlbumIds === null ? [undefined] : selectedAlbumIds;

  // Total approx pour la progress bar : on probe chaque scope.
  let totalEstimated = 0;
  for (const albumId of scopes) {
    if (cancelRef.cancelled) return assets;
    const probe = await MediaLibrary.getAssetsAsync({
      mediaType: mediaTypes,
      first: 1,
      ...(albumId ? { album: albumId } : {}),
    });
    totalEstimated += probe.totalCount;
  }
  onProgress(0, totalEstimated, 'Recuperation de la liste...');

  for (const albumId of scopes) {
    if (cancelRef.cancelled) break;
    let after: string | undefined = undefined;
    while (true) {
      if (cancelRef.cancelled) break;
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: mediaTypes,
        first: PAGE_SIZE,
        after,
        sortBy: [MediaLibrary.SortBy.creationTime],
        ...(albumId ? { album: albumId } : {}),
      });
      for (const a of page.assets) {
        if (seenIds.has(a.id)) continue;
        seenIds.add(a.id);
        assets.push({
          id: a.id,
          uri: a.uri,
          filename: a.filename,
          fileSize: 0, // on remplira via getAssetInfoAsync
          duration: a.duration ?? 0,
          mediaType: a.mediaType,
          createdAt: a.creationTime ?? 0,
        });
      }
      onProgress(
        assets.length,
        totalEstimated,
        `Liste : ${assets.length} / ${totalEstimated}`
      );
      if (!page.hasNextPage) break;
      after = page.endCursor;
    }
  }
  return assets;
}

// Hashe un asset unique. Retourne null si echec ou fichier non-local.
async function hashOneAsset(a: AssetItem): Promise<AssetItem | null> {
  try {
    const info = await MediaLibrary.getAssetInfoAsync(a, { shouldDownloadFromNetwork: false });
    const localUri = info.localUri || info.uri;
    if (!localUri) return null;
    // Skip les content:// URIs non resolus (asset cloud non telecharge)
    if (!localUri.startsWith('file://') && !localUri.startsWith('/')) {
      return null;
    }
    let size = (info as any).fileSize as number | undefined;
    if (!size) {
      const fi = await FileSystem.getInfoAsync(localUri, { size: true });
      size = (fi as any).size || 0;
    }
    if (!size || size < 1024) return null;
    const h = await quickHash(localUri, size);
    if (!h) return null;
    return { ...a, uri: localUri, fileSize: size, hash: h };
  } catch {
    return null;
  }
}

async function hashAllAssets(
  assets: AssetItem[],
  onProgress: ProgressCb,
  cancelRef: { cancelled: boolean }
): Promise<AssetItem[]> {
  // Parallelisme par batchs : I/O-bound sur le file system, donc 8 simultanees
  // donne un speedup ~3-5x sans saturer la RAM.
  const BATCH_SIZE = 8;
  const out: AssetItem[] = [];
  let done = 0;

  for (let i = 0; i < assets.length; i += BATCH_SIZE) {
    if (cancelRef.cancelled) break;
    const batch = assets.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(hashOneAsset));
    for (const r of results) {
      if (r) out.push(r);
    }
    done += batch.length;
    onProgress(done, assets.length, `Hash ${done} / ${assets.length}`);
  }
  return out;
}

// ============================================================================
// Verification byte-by-byte (V2) — securite Czkawka-style
// ============================================================================
// Le quick-hash (16 KB head + 16 KB tail + size) est tres fiable mais peut
// theoriquement collisionner sur 2 photos prises en rafale au meme moment et
// au meme byte de taille. Cette verif lit les fichiers en entier par chunks
// et confirme que les bytes sont strictement identiques. Apres ca, taux de
// faux positifs = 0 sur les doublons exacts.

const VERIFY_CHUNK_BYTES = 1024 * 1024; // 1 Mo par chunk

async function filesAreIdentical(
  uriA: string,
  uriB: string,
  size: number,
  cancelRef: { cancelled: boolean }
): Promise<boolean> {
  for (let pos = 0; pos < size; pos += VERIFY_CHUNK_BYTES) {
    if (cancelRef.cancelled) return false;
    const len = Math.min(VERIFY_CHUNK_BYTES, size - pos);
    try {
      const [a, b] = await Promise.all([
        FileSystem.readAsStringAsync(uriA, {
          encoding: FileSystem.EncodingType.Base64,
          position: pos,
          length: len,
        }),
        FileSystem.readAsStringAsync(uriB, {
          encoding: FileSystem.EncodingType.Base64,
          position: pos,
          length: len,
        }),
      ]);
      if (a !== b) return false;
    } catch {
      // I/O error : on refuse de confirmer plutot que d'avoir un faux positif
      return false;
    }
  }
  return true;
}

// Pour un groupe candidat (meme quick-hash), repartit ses items en sous-groupes
// par contenu reellement identique. Algorithme : pour chaque item, on essaie
// de le placer dans un bucket existant (= meme contenu que le 1er du bucket),
// sinon on cree un nouveau bucket. Au final on garde les buckets >= 2.
async function verifyGroup(
  group: DupGroup,
  cancelRef: { cancelled: boolean }
): Promise<DupGroup[]> {
  if (group.items.length < 2) return [];

  const buckets: AssetItem[][] = [];
  for (const item of group.items) {
    if (cancelRef.cancelled) break;
    let placed = false;
    for (const bucket of buckets) {
      if (await filesAreIdentical(bucket[0].uri, item.uri, item.fileSize, cancelRef)) {
        bucket.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) buckets.push([item]);
  }

  const out: DupGroup[] = [];
  for (const items of buckets) {
    if (items.length < 2) continue;
    items.sort((a, b) => b.fileSize - a.fileSize);
    const totalRec = items.slice(1).reduce((s, x) => s + x.fileSize, 0);
    out.push({ hash: group.hash, items, totalRecoverable: totalRec, kind: 'exact' });
  }
  return out;
}

async function verifyAllGroups(
  groups: DupGroup[],
  onProgress: ProgressCb,
  cancelRef: { cancelled: boolean }
): Promise<DupGroup[]> {
  const verified: DupGroup[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (cancelRef.cancelled) break;
    onProgress(i, groups.length, `Verification ${i + 1} / ${groups.length}`);
    const sub = await verifyGroup(groups[i], cancelRef);
    verified.push(...sub);
  }
  if (!cancelRef.cancelled) {
    onProgress(groups.length, groups.length, `Verification ${groups.length} / ${groups.length}`);
  }
  verified.sort((a, b) => b.totalRecoverable - a.totalRecoverable);
  return verified;
}

// ============================================================================
// Quasi-doublons via aHash (V2.1) — pour les screenshots avec timestamp
// different, recompressions WhatsApp, exports HEIC/JPG, etc.
// ============================================================================
// Strategie : on resize chaque image en 8x8 pixels grayscale via
// expo-image-manipulator, on decode le PNG en JS pur, on calcule un hash
// 64-bit via la moyenne (aHash). 2 images visuellement identiques produisent
// des hashes a distance de Hamming faible (< 5 typiquement) meme si les
// bytes du fichier diffèrent (compression, codec, timestamp).

function b64ToBytes(b64: string): Uint8Array {
  // RN 0.74 expose globalement atob.
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

interface DecodedPng {
  width: number;
  height: number;
  pixels: Uint8Array;
  bytesPerPixel: number;
  colorType: number;
}

// Decoder PNG minimal : signature, IHDR, IDAT (concat + zlib inflate),
// unfilter (5 filtres standards). Suffisant pour ce qu'expo-image-manipulator
// produit en sortie.
function decodePng(bytes: Uint8Array): DecodedPng {
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
    pos += len + 4;

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
      const upLeft =
        y > 0 && x >= channels ? pixels[outStart - stride + x - channels] : 0;
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

// Calcule un aHash 64-bit a partir d'une image. Renvoie null en cas d'erreur.
async function computeAHash(uri: string): Promise<bigint | null> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 8, height: 8 } }],
      { compress: 1, format: ImageManipulator.SaveFormat.PNG, base64: true }
    );
    if (!result.base64) return null;
    const png = decodePng(b64ToBytes(result.base64));
    if (png.width !== 8 || png.height !== 8) return null;

    const gray = new Float32Array(64);
    const { pixels, bytesPerPixel, colorType } = png;
    for (let i = 0; i < 64; i++) {
      const off = i * bytesPerPixel;
      let g = 0;
      if (colorType === 0 || colorType === 4) {
        g = pixels[off]; // grayscale
      } else {
        // RGB(A) -> luminance perceptuelle
        g =
          0.299 * pixels[off] +
          0.587 * pixels[off + 1] +
          0.114 * pixels[off + 2];
      }
      gray[i] = g;
    }
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += gray[i];
    const mean = sum / 64;

    let hash = 0n;
    for (let i = 0; i < 64; i++) {
      if (gray[i] > mean) hash |= 1n << BigInt(i);
    }
    return hash;
  } catch {
    return null;
  }
}

function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff !== 0n) {
    if ((diff & 1n) !== 0n) count++;
    diff >>= 1n;
  }
  return count;
}

// Heuristique : un screenshot a "screenshot" dans son nom ou son uri (le
// dossier Screenshots sur Samsung). On l'utilise pour regler un threshold
// Hamming plus permissif (les screenshots changent tres peu entre 2 instants).
function isScreenshot(item: AssetItem): boolean {
  const s = (item.filename || '') + ' ' + (item.uri || '');
  return /screen.?shot/i.test(s);
}

async function computeAHashes(
  items: AssetItem[],
  onProgress: ProgressCb,
  cancelRef: { cancelled: boolean }
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const BATCH = 4; // I/O + decode JS, on garde modeste
  for (let i = 0; i < items.length; i += BATCH) {
    if (cancelRef.cancelled) break;
    const batch = items.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((it) => computeAHash(it.uri)));
    for (let j = 0; j < batch.length; j++) {
      const h = results[j];
      if (h !== null) out.set(batch[j].id, h);
    }
    const done = Math.min(i + BATCH, items.length);
    onProgress(done, items.length, `Quasi-doublons ${done} / ${items.length}`);
  }
  return out;
}

// Group items by aHash similarity. Threshold normal pour photos, plus
// permissif pour les screenshots.
const QUASI_THRESHOLD_PHOTO = 5;
const QUASI_THRESHOLD_SCREENSHOT = 7;

function clusterByAHash(
  items: AssetItem[],
  hashes: Map<string, bigint>
): AssetItem[][] {
  const clusters: AssetItem[][] = [];
  for (const item of items) {
    const h = hashes.get(item.id);
    if (h === undefined) continue;
    const t = isScreenshot(item) ? QUASI_THRESHOLD_SCREENSHOT : QUASI_THRESHOLD_PHOTO;
    let placed = false;
    for (const cluster of clusters) {
      const repHash = hashes.get(cluster[0].id);
      if (repHash !== undefined && hammingDistance(h, repHash) <= t) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }
  return clusters;
}

// Pour chaque cluster aHash >= 2 :
//  - si tous les items du cluster sont deja groupes EXACTEMENT ensemble,
//    on n'ajoute rien (deja affiche par le pipeline exact).
//  - sinon on ajoute le cluster comme groupe 'quasi'.
function buildQuasiGroups(
  clusters: AssetItem[][],
  exactGroups: DupGroup[],
  hashes: Map<string, bigint>
): DupGroup[] {
  // Map item.id -> exactGroup index (ou -1)
  const exactGroupOf = new Map<string, number>();
  exactGroups.forEach((g, idx) => {
    for (const it of g.items) exactGroupOf.set(it.id, idx);
  });

  const out: DupGroup[] = [];
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    // Si tous les items du cluster sont dans le meme exact group, skip.
    const exactIdxs = new Set(
      cluster.map((it) => exactGroupOf.get(it.id) ?? -1)
    );
    if (exactIdxs.size === 1) {
      const onlyIdx = exactIdxs.values().next().value;
      if (onlyIdx !== undefined && onlyIdx >= 0) continue;
    }
    cluster.sort((a, b) => b.fileSize - a.fileSize);
    const totalRec = cluster.slice(1).reduce((s, x) => s + x.fileSize, 0);
    const repHash = hashes.get(cluster[0].id);
    out.push({
      hash: '~' + (repHash !== undefined ? repHash.toString(16) : '?'),
      items: cluster,
      totalRecoverable: totalRec,
      kind: 'quasi',
    });
  }
  return out;
}

function groupByHash(items: AssetItem[]): DupGroup[] {
  const buckets = new Map<string, AssetItem[]>();
  for (const it of items) {
    if (!it.hash) continue;
    const arr = buckets.get(it.hash);
    if (arr) arr.push(it);
    else buckets.set(it.hash, [it]);
  }
  const groups: DupGroup[] = [];
  for (const [hash, arr] of buckets.entries()) {
    if (arr.length < 2) continue;
    // Tri par taille decroissante (le + gros d'abord = la "meilleure copie")
    arr.sort((a, b) => b.fileSize - a.fileSize);
    const totalRecoverable = arr.slice(1).reduce((s, x) => s + x.fileSize, 0);
    groups.push({ hash, items: arr, totalRecoverable, kind: 'exact' });
  }
  // Tri des groupes par espace recuperable decroissant
  groups.sort((a, b) => b.totalRecoverable - a.totalRecoverable);
  return groups;
}

// ============================================================================
// Permission gate
// ============================================================================
function PermissionScreen({ onGranted }: { onGranted: () => void }) {
  const [requesting, setRequesting] = useState(false);
  const [partial, setPartial] = useState(false);

  const ask = async () => {
    setRequesting(true);
    const result = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
    setRequesting(false);

    const isFull =
      result.status === 'granted' &&
      (result as any).accessPrivileges !== 'limited';
    const isLimited =
      result.status === 'granted' &&
      (result as any).accessPrivileges === 'limited';

    if (isFull) {
      onGranted();
    } else if (isLimited) {
      // Acces partiel (Android 14 "Photos selectionnees") : on ne peut pas
      // scanner toute la galerie. On invite l'utilisateur a passer en
      // "Autoriser toutes" via les parametres systeme.
      setPartial(true);
    } else {
      Alert.alert(
        'Permission refusee',
        "Sans acces aux photos, l'app ne peut pas detecter les doublons. Ouvre les parametres systeme pour autoriser l'acces."
      );
    }
  };

  const openSettings = () => {
    Linking.openSettings();
  };

  return (
    <View style={styles.container}>
      <View style={styles.permissionWrap}>
        <Text style={styles.permIcon}>📁</Text>
        <Text style={styles.title}>Doublons photos</Text>
        <Text style={styles.subtitle}>
          Pour detecter les doublons, l'app a besoin d'acceder a {'\n'}toutes tes photos.
        </Text>
        <Text style={styles.permPrivacy}>
          Tout reste sur ton telephone. Aucune donnee n'est envoyee sur internet.
        </Text>

        {partial ? (
          <>
            <View style={[styles.corbeilleNotice, { marginBottom: 18 }]}>
              <Text style={styles.corbeilleNoticeText}>
                Tu as autorise un acces partiel (photos selectionnees). Pour detecter les doublons sur toute ta galerie, choisis "Autoriser toutes les photos et videos" dans les parametres.
              </Text>
            </View>
            <TouchableOpacity style={styles.primaryBtn} onPress={openSettings}>
              <Text style={styles.primaryBtnText}>Ouvrir les parametres</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={ask} disabled={requesting}>
              <Text style={styles.secondaryBtnText}>Reessayer</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity style={styles.primaryBtn} onPress={ask} disabled={requesting}>
            <Text style={styles.primaryBtnText}>
              {requesting ? 'Demande en cours...' : 'Autoriser l\'acces'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ============================================================================
// Home screen
// ============================================================================
function HomeScreen({
  includeVideos,
  setIncludeVideos,
  includePHash,
  setIncludePHash,
  onScan,
  corbeilleCount,
  onOpenCorbeille,
}: {
  includeVideos: boolean;
  setIncludeVideos: (v: boolean) => void;
  includePHash: boolean;
  setIncludePHash: (v: boolean) => void;
  onScan: () => void;
  corbeilleCount: number;
  onOpenCorbeille: () => void;
}) {
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
      <View style={styles.homeHeader}>
        <Text style={styles.title}>Doublons photos & videos</Text>
        <Text style={styles.subtitle}>
          Scanne ta galerie pour trouver les copies identiques. 100% local.
        </Text>
      </View>

      <View style={styles.optionCard}>
        <View style={styles.optionRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.optionLabel}>Inclure les videos</Text>
            <Text style={styles.optionHelp}>
              {includeVideos
                ? 'Photos et videos seront scannees.'
                : 'Seules les photos seront scannees.'}
            </Text>
          </View>
          <Switch
            value={includeVideos}
            onValueChange={setIncludeVideos}
            trackColor={{ false: COLORS.border, true: COLORS.accent }}
            thumbColor="#fff"
          />
        </View>
        <View style={[styles.optionRow, { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: COLORS.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.optionLabel}>Quasi-doublons (pHash)</Text>
            <Text style={styles.optionHelp}>
              {includePHash
                ? 'Detecte aussi les screenshots a temps different, recompressions WhatsApp, HEIC/JPG.'
                : 'Detecte uniquement les copies strictement identiques (rapide).'}
            </Text>
          </View>
          <Switch
            value={includePHash}
            onValueChange={setIncludePHash}
            trackColor={{ false: COLORS.border, true: COLORS.accent }}
            thumbColor="#fff"
          />
        </View>
      </View>

      <TouchableOpacity style={styles.bigBtn} onPress={onScan}>
        <Text style={styles.bigBtnIcon}>🔍</Text>
        <Text style={styles.bigBtnText}>Scanner ma galerie</Text>
      </TouchableOpacity>

      {corbeilleCount > 0 && (
        <TouchableOpacity style={styles.corbeilleHomeBtn} onPress={onOpenCorbeille}>
          <Text style={styles.corbeilleHomeIcon}>🗑️</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.corbeilleHomeTitle}>
              Corbeille ({corbeilleCount})
            </Text>
            <Text style={styles.corbeilleHomeSubtitle}>
              {corbeilleCount} fichier(s) en attente de suppression
            </Text>
          </View>
          <Text style={styles.corbeilleHomeChevron}>›</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.footer}>v2.1.0  ·  100% local, aucune donnee envoyee en ligne</Text>
    </View>
  );
}

// ============================================================================
// Albums screen : choisir les dossiers a scanner
// ============================================================================
function AlbumsScreen({
  albums,
  loading,
  selected,
  setSelected,
  onLaunchScan,
  onBack,
}: {
  albums: AlbumItem[];
  loading: boolean;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onLaunchScan: () => void;
  onBack: () => void;
}) {
  const totalSelectedAssets = useMemo(
    () =>
      albums
        .filter((a) => selected.has(a.id))
        .reduce((s, a) => s + a.assetCount, 0),
    [albums, selected]
  );

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const checkAll = () => setSelected(new Set(albums.map((a) => a.id)));
  const checkNone = () => setSelected(new Set());

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={COLORS.accent2} />
        <Text style={[styles.subtitle, { marginTop: 12 }]}>Chargement des dossiers...</Text>
      </View>
    );
  }

  if (albums.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyIcon}>📂</Text>
          <Text style={styles.title}>Aucun dossier trouve</Text>
          <Text style={styles.subtitle}>
            La galerie ne contient aucun album avec des photos.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={onBack}>
            <Text style={styles.primaryBtnText}>Retour</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.resultsHeader}>
        <View style={styles.corbeilleHeaderRow}>
          <Pressable onPress={onBack} hitSlop={12}>
            <Text style={styles.backArrow}>‹</Text>
          </Pressable>
          <Text style={styles.title}>Choisir les dossiers</Text>
          <View style={{ width: 24 }} />
        </View>
        <Text style={styles.subtitle}>
          Coche les dossiers que tu veux scanner.{'\n'}
          {selected.size} dossier(s) · {totalSelectedAssets} fichier(s) au total
        </Text>
        <View style={styles.resultsActions}>
          <Pressable style={styles.smallBtn} onPress={checkAll}>
            <Text style={styles.smallBtnText}>Tout cocher</Text>
          </Pressable>
          <Pressable style={styles.smallBtn} onPress={checkNone}>
            <Text style={styles.smallBtnText}>Tout decocher</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={albums}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ paddingBottom: 130 }}
        renderItem={({ item }) => (
          <Pressable
            style={[
              styles.fileRow,
              { backgroundColor: COLORS.card, marginBottom: 8 },
              selected.has(item.id) && styles.albumRowSelected,
            ]}
            onPress={() => toggle(item.id)}
          >
            <Text style={styles.albumIcon}>📁</Text>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.fileName} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.fileSize}>{item.assetCount} fichier(s)</Text>
            </View>
            <View
              style={[
                styles.checkbox,
                selected.has(item.id) && styles.checkboxAlbumOn,
              ]}
            >
              {selected.has(item.id) && <Text style={styles.checkboxMark}>✓</Text>}
            </View>
          </Pressable>
        )}
      />

      <View style={styles.bottomBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.bottomBarLine1}>
            <Text style={[styles.bottomBarCount, { color: COLORS.accent2 }]}>
              {selected.size}
            </Text>{' '}
            dossier(s) coche(s)
          </Text>
          <Text style={styles.bottomBarLine2}>
            ~{totalSelectedAssets} fichier(s) a scanner
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.bigBtnInline, selected.size === 0 && styles.dangerBtnDisabled]}
          disabled={selected.size === 0}
          onPress={onLaunchScan}
        >
          <Text style={styles.bigBtnInlineText}>Lancer le scan</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ============================================================================
// Scan screen
// ============================================================================
function ScanScreen({
  progress,
  onCancel,
}: {
  progress: { current: number; total: number; label: string };
  onCancel: () => void;
}) {
  const pct = progress.total > 0 ? Math.round((progress.current * 100) / progress.total) : 0;
  return (
    <View style={styles.container}>
      <View style={styles.scanWrap}>
        <Text style={styles.title}>Analyse en cours...</Text>
        <Text style={styles.subtitle}>{progress.label}</Text>
        <View style={styles.pbarOuter}>
          <View style={[styles.pbarInner, { width: `${pct}%` }]} />
        </View>
        <Text style={styles.scanCount}>
          {progress.current} / {progress.total} ({pct}%)
        </Text>
        <ActivityIndicator size="large" color={COLORS.accent2} style={{ marginTop: 22 }} />
        <TouchableOpacity style={styles.secondaryBtn} onPress={onCancel}>
          <Text style={styles.secondaryBtnText}>Annuler</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ============================================================================
// Corbeille screen (corbeille INTERNE de l'app, avant suppression OS)
// ============================================================================
function CorbeilleScreen({
  items,
  onRestore,
  onDeleteForReal,
  onBack,
}: {
  items: AssetItem[];
  onRestore: (ids: string[]) => void;
  onDeleteForReal: (ids: string[]) => Promise<boolean>;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const totalSize = useMemo(
    () => items.reduce((s, it) => s + it.fileSize, 0),
    [items]
  );
  const selectedItems = useMemo(
    () => items.filter((it) => selected.has(it.id)),
    [items, selected]
  );
  const selectedSize = useMemo(
    () => selectedItems.reduce((s, it) => s + it.fileSize, 0),
    [selectedItems]
  );

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const checkAll = () => setSelected(new Set(items.map((it) => it.id)));
  const checkNone = () => setSelected(new Set());

  const handleRestore = () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    Alert.alert(
      'Restaurer ?',
      `${ids.length} fichier(s) seront retires de la corbeille de l'app. Ils restent intacts sur ton telephone.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Restaurer',
          onPress: () => {
            onRestore(ids);
            setSelected(new Set());
          },
        },
      ]
    );
  };

  const handleDeleteForReal = () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    Alert.alert(
      'Supprimer definitivement ?',
      `${ids.length} fichier(s) vont etre envoyes a la corbeille systeme Android.\n\nIls resteront recuperables 30 jours via l'app Galerie Samsung (album Corbeille), puis seront definitivement effaces.\n\nAndroid va t'afficher une derniere confirmation.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            const ok = await onDeleteForReal(ids);
            if (ok) {
              setSelected(new Set());
              Alert.alert(
                'Termine',
                `${ids.length} fichier(s) envoyes a la corbeille systeme. Tu peux les recuperer pendant 30 jours depuis l'app Galerie -> Corbeille.`
              );
            } else {
              Alert.alert(
                'Annule',
                "La suppression a ete annulee ou refusee. Les fichiers sont toujours dans la corbeille de l'app."
              );
            }
          },
        },
      ]
    );
  };

  if (items.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyIcon}>🗑️</Text>
          <Text style={styles.title}>Corbeille vide</Text>
          <Text style={styles.subtitle}>
            Aucun fichier en attente de suppression.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={onBack}>
            <Text style={styles.primaryBtnText}>Retour</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.resultsHeader}>
        <View style={styles.corbeilleHeaderRow}>
          <Pressable onPress={onBack} hitSlop={12}>
            <Text style={styles.backArrow}>‹</Text>
          </Pressable>
          <Text style={styles.title}>Corbeille</Text>
          <View style={{ width: 24 }} />
        </View>
        <Text style={styles.subtitle}>
          {items.length} fichier(s) en attente  ·  {fmtSize(totalSize)} a liberer si tu confirmes
        </Text>
        <View style={styles.corbeilleNotice}>
          <Text style={styles.corbeilleNoticeText}>
            Aucun fichier n'a encore ete supprime de ton telephone. Coche ce que tu veux vraiment supprimer, puis valide.
          </Text>
        </View>
        <View style={styles.resultsActions}>
          <Pressable style={styles.smallBtn} onPress={checkAll}>
            <Text style={styles.smallBtnText}>Tout cocher</Text>
          </Pressable>
          <Pressable style={styles.smallBtn} onPress={checkNone}>
            <Text style={styles.smallBtnText}>Tout decocher</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{ paddingBottom: 180 }}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews
        renderItem={({ item: it }) => (
          <Pressable
            style={[
              styles.fileRow,
              { backgroundColor: COLORS.card, marginBottom: 8 },
              selected.has(it.id) && styles.fileRowSelected,
            ]}
            onPress={() => toggle(it.id)}
          >
            <Image
              source={{ uri: it.uri }}
              style={styles.thumb}
              contentFit="cover"
              cachePolicy="disk"
              recyclingKey={it.id}
              transition={120}
            />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.fileName} numberOfLines={1}>
                {it.filename}
              </Text>
              <Text style={styles.fileSize}>
                {fmtSize(it.fileSize)}
                {it.mediaType === 'video' && '   ·   video'}
              </Text>
            </View>
            <View
              style={[
                styles.checkbox,
                selected.has(it.id) && styles.checkboxOn,
              ]}
            >
              {selected.has(it.id) && <Text style={styles.checkboxMark}>✓</Text>}
            </View>
          </Pressable>
        )}
      />

      <View style={[styles.bottomBar, { flexDirection: 'column', alignItems: 'stretch' }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.bottomBarLine1}>
              <Text style={styles.bottomBarCount}>{selected.size}</Text> selectionne(s)
            </Text>
            <Text style={styles.bottomBarLine2}>
              {fmtSize(selectedSize)}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity
            style={[
              styles.restoreBtn,
              selected.size === 0 && styles.dangerBtnDisabled,
            ]}
            disabled={selected.size === 0}
            onPress={handleRestore}
          >
            <Text style={styles.restoreBtnText}>Restaurer</Text>
          </TouchableOpacity>
          <View style={{ width: 10 }} />
          <TouchableOpacity
            style={[
              styles.dangerBtn,
              { flex: 1 },
              selected.size === 0 && styles.dangerBtnDisabled,
            ]}
            disabled={selected.size === 0}
            onPress={handleDeleteForReal}
          >
            <Text style={styles.dangerBtnText}>Supprimer definitivement</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}


// ============================================================================
// Results screen
// ============================================================================
// Pour eviter le freeze quand on a beaucoup de groupes, on aplatit la liste
// en lignes (header / item / item / header / ...) et on laisse FlatList
// virtualiser chaque ligne individuellement. Sinon, FlatList ne virtualise
// que les groupes et chaque renderItem rend toutes les sous-images d'un coup
// -> avec plusieurs centaines de Image en RAM via cachePolicy='memory',
// l'UI thread se bloque -> ANR.
type ResultRow =
  | { kind: 'header'; group: DupGroup }
  | { kind: 'item'; item: AssetItem; isFirst: boolean };

function ResultItemRow({
  item,
  isFirst,
  isSelected,
  onToggle,
}: {
  item: AssetItem;
  isFirst: boolean;
  isSelected: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <Pressable
      style={[
        styles.fileRow,
        { marginHorizontal: 12 },
        isSelected && styles.fileRowSelected,
      ]}
      onPress={() => onToggle(item.id)}
    >
      <Image
        source={{ uri: item.uri }}
        style={styles.thumb}
        contentFit="cover"
        cachePolicy="disk"
        recyclingKey={item.id}
        transition={120}
      />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={styles.fileName} numberOfLines={1}>
          {item.filename}
        </Text>
        <Text style={styles.fileSize}>
          {fmtSize(item.fileSize)}
          {isFirst && '   ·   le + gros'}
        </Text>
      </View>
      <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
        {isSelected && <Text style={styles.checkboxMark}>✓</Text>}
      </View>
    </Pressable>
  );
}

const ResultItemRowMemo = React.memo(ResultItemRow);

function ResultsScreen({
  groups,
  selected,
  setSelected,
  onMoveToCorbeille,
  onBack,
  corbeilleCount,
  onOpenCorbeille,
}: {
  groups: DupGroup[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onMoveToCorbeille: () => void;
  onBack: () => void;
  corbeilleCount: number;
  onOpenCorbeille: () => void;
}) {
  const totals = useMemo(() => {
    let count = 0;
    let bytes = 0;
    for (const g of groups) {
      for (const it of g.items) {
        if (selected.has(it.id)) {
          count += 1;
          bytes += it.fileSize;
        }
      }
    }
    return { count, bytes };
  }, [groups, selected]);

  const totalRecoverable = useMemo(
    () => groups.reduce((s, g) => s + g.totalRecoverable, 0),
    [groups]
  );

  const flatRows = useMemo<ResultRow[]>(() => {
    const rows: ResultRow[] = [];
    for (const g of groups) {
      rows.push({ kind: 'header', group: g });
      g.items.forEach((it, idx) => {
        rows.push({ kind: 'item', item: it, isFirst: idx === 0 });
      });
    }
    return rows;
  }, [groups]);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
    },
    [selected, setSelected]
  );

  const checkAllButFirst = () => {
    const next = new Set<string>();
    for (const g of groups) {
      for (let i = 1; i < g.items.length; i++) next.add(g.items[i].id);
    }
    setSelected(next);
  };

  const checkNone = () => setSelected(new Set());

  if (groups.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyIcon}>✨</Text>
          <Text style={styles.title}>Aucun doublon trouve</Text>
          <Text style={styles.subtitle}>
            {corbeilleCount > 0
              ? `Tu as ${corbeilleCount} fichier(s) en attente dans la corbeille.`
              : 'Ta galerie est propre.'}
          </Text>
          {corbeilleCount > 0 && (
            <TouchableOpacity style={[styles.primaryBtn, { marginBottom: 10 }]} onPress={onOpenCorbeille}>
              <Text style={styles.primaryBtnText}>Voir la corbeille ({corbeilleCount})</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.secondaryBtn} onPress={onBack}>
            <Text style={styles.secondaryBtnText}>Retour</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.resultsHeader}>
        <View style={styles.corbeilleHeaderRow}>
          <Pressable onPress={onBack} hitSlop={12}>
            <Text style={styles.backArrow}>‹</Text>
          </Pressable>
          <Text style={styles.title}>{groups.length} groupes</Text>
          <View style={{ width: 24 }} />
        </View>
        <Text style={styles.subtitle}>
          {fmtSize(totalRecoverable)} recuperables au total
        </Text>
        <View style={styles.resultsActions}>
          <Pressable style={styles.smallBtn} onPress={checkAllButFirst}>
            <Text style={styles.smallBtnText}>Tout cocher sauf le + gros</Text>
          </Pressable>
          <Pressable style={styles.smallBtn} onPress={checkNone}>
            <Text style={styles.smallBtnText}>Tout decocher</Text>
          </Pressable>
          {corbeilleCount > 0 && (
            <Pressable style={[styles.smallBtn, styles.smallBtnAccent]} onPress={onOpenCorbeille}>
              <Text style={styles.smallBtnText}>Corbeille ({corbeilleCount})</Text>
            </Pressable>
          )}
        </View>
      </View>

      <FlatList
        data={flatRows}
        keyExtractor={(r) =>
          r.kind === 'header' ? `h-${r.group.hash}` : r.item.id
        }
        contentContainerStyle={{ paddingBottom: 130 }}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews
        renderItem={({ item: row }) =>
          row.kind === 'header' ? (
            <View style={styles.groupHeaderRow}>
              <Text style={styles.groupHeader}>
                {row.group.items.length} copies  ·  {fmtSize(row.group.totalRecoverable)} si on garde le + gros
              </Text>
              <View
                style={[
                  styles.groupKindBadge,
                  row.group.kind === 'quasi' ? styles.groupKindQuasi : styles.groupKindExact,
                ]}
              >
                <Text style={styles.groupKindText}>
                  {row.group.kind === 'quasi' ? 'QUASI' : 'EXACT'}
                </Text>
              </View>
            </View>
          ) : (
            <ResultItemRowMemo
              item={row.item}
              isFirst={row.isFirst}
              isSelected={selected.has(row.item.id)}
              onToggle={toggle}
            />
          )
        }
      />

      <View style={styles.bottomBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.bottomBarLine1}>
            <Text style={styles.bottomBarCount}>{totals.count}</Text> selectionnes
          </Text>
          <Text style={styles.bottomBarLine2}>
            {fmtSize(totals.bytes)} a liberer
          </Text>
        </View>
        <TouchableOpacity
          style={[
            styles.warnBtn,
            totals.count === 0 && styles.dangerBtnDisabled,
          ]}
          disabled={totals.count === 0}
          onPress={onMoveToCorbeille}
        >
          <Text style={styles.warnBtnText}>Vers corbeille</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ============================================================================
// Root component
// ============================================================================
export default function App() {
  // On gere l'etat de permission manuellement au lieu de usePermissions() :
  // sur Android 14, le hook expo-media-library ne se synchronise pas
  // toujours apres requestPermissionsAsync, ce qui laissait l'app bloquee
  // sur l'ecran de permission meme apres autorisation.
  const [permGranted, setPermGranted] = useState<boolean | null>(null);
  const [screen, setScreen] = useState<Screen>('home');
  // Defaut : photos ET videos (l'utilisateur peut decocher s'il ne veut que les photos)
  const [includeVideos, setIncludeVideos] = useState(true);
  // V2.1 : pHash/aHash pour detecter les quasi-doublons (compressions
  // WhatsApp, HEIC<->JPG, screenshots avec timestamp different).
  const [includePHash, setIncludePHash] = useState(true);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: 'Initialisation...' });
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanCancelRef] = useState({ cancelled: false });
  // Corbeille interne : fichiers marques pour suppression mais pas encore
  // envoyes au systeme. Securite supplementaire avant la suppression Android.
  const [corbeille, setCorbeille] = useState<AssetItem[]>([]);
  // Albums (= dossiers de la galerie) : liste + selection.
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [selectedAlbums, setSelectedAlbums] = useState<Set<string>>(new Set());
  // Ids deja envoyes a la corbeille systeme Android. Persiste sur disque pour
  // survivre aux redemarrages. Filtre les scans pour ne pas re-detecter les
  // fichiers en attente de suppression definitive (30j dans .trash).
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const ids = await loadDeletedIds();
      setDeletedIds(ids);
    })();
  }, []);

  // Re-check de la permission au mount + a chaque retour sur l'app (utile
  // si l'utilisateur a change la permission depuis les parametres systeme).
  const refreshPermission = useCallback(async () => {
    const result = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
    const granted =
      result.status === 'granted' &&
      (result as any).accessPrivileges !== 'limited';
    setPermGranted(granted);
    if (!granted) {
      setScreen('permission');
    } else if (screen === 'permission') {
      setScreen('home');
    }
  }, [screen]);

  useEffect(() => {
    refreshPermission();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshPermission();
    });
    return () => sub.remove();
  }, [refreshPermission]);

  // Charge la liste des albums et passe a l'ecran de selection.
  const onOpenAlbums = useCallback(async () => {
    setScreen('albums');
    setAlbumsLoading(true);
    try {
      const list = await fetchAllAlbums();
      setAlbums(list);
      // Si rien n'a encore ete coche, on coche tout par defaut (= comportement
      // initial de l'app).
      setSelectedAlbums((prev) =>
        prev.size === 0 ? new Set(list.map((a) => a.id)) : prev
      );
    } catch (e: any) {
      Alert.alert('Erreur', `Impossible de lister les dossiers : ${e?.message || e}`);
      setScreen('home');
    } finally {
      setAlbumsLoading(false);
    }
  }, []);

  const onLaunchScan = useCallback(async () => {
    const ids = Array.from(selectedAlbums);
    setScreen('scan');
    setProgress({ current: 0, total: 0, label: 'Recuperation de la liste...' });
    setGroups([]);
    setSelected(new Set());
    scanCancelRef.cancelled = false;

    try {
      const onProg: ProgressCb = (c, t, label) => {
        setProgress({ current: c, total: t, label });
      };
      let assets = await fetchAllAssets(
        includeVideos,
        ids.length > 0 ? ids : null,
        onProg,
        scanCancelRef
      );
      if (scanCancelRef.cancelled) {
        setScreen('albums');
        return;
      }
      // Filtre les assets deja envoyes a la corbeille systeme Android via
      // une suppression definitive precedente. Sinon on les re-detecte
      // comme doublons tant qu'Android n'a pas vraiment efface (~30j).
      if (deletedIds.size > 0) {
        const before = assets.length;
        assets = assets.filter((a) => !deletedIds.has(a.id));
        const skipped = before - assets.length;
        if (skipped > 0) {
          onProg(0, assets.length, `${skipped} fichier(s) en corbeille systeme ignore(s)`);
        }
      }
      const hashed = await hashAllAssets(assets, onProg, scanCancelRef);
      if (scanCancelRef.cancelled) {
        setScreen('albums');
        return;
      }
      const candidates = groupByHash(hashed);
      if (scanCancelRef.cancelled) {
        setScreen('albums');
        return;
      }
      // V2 : verification byte-by-byte sur les groupes candidats pour
      // eliminer toute collision de quick-hash. Czkawka-style.
      setProgress({
        current: 0,
        total: candidates.length,
        label: `Verification 0 / ${candidates.length}`,
      });
      const verified = await verifyAllGroups(candidates, onProg, scanCancelRef);
      if (scanCancelRef.cancelled) {
        setScreen('albums');
        return;
      }

      // V2.1 : analyse aHash (perceptual) pour les quasi-doublons.
      // On la fait sur tous les hashed items, pas juste les non-exacts, pour
      // pouvoir regrouper un fichier exact + ses quasi-equivalents (ex: jpg
      // recompresse via WhatsApp en plus de la copie exacte).
      let quasiGroups: DupGroup[] = [];
      if (includePHash) {
        setProgress({
          current: 0,
          total: hashed.length,
          label: `Quasi-doublons 0 / ${hashed.length}`,
        });
        const aHashes = await computeAHashes(hashed, onProg, scanCancelRef);
        if (scanCancelRef.cancelled) {
          setScreen('albums');
          return;
        }
        const clusters = clusterByAHash(hashed, aHashes);
        quasiGroups = buildQuasiGroups(clusters, verified, aHashes);
      }

      const merged = [...verified, ...quasiGroups];
      merged.sort((a, b) => b.totalRecoverable - a.totalRecoverable);
      setGroups(merged);
      setScreen('results');
    } catch (e: any) {
      Alert.alert('Erreur', `Le scan a echoue : ${e?.message || e}`);
      setScreen('albums');
    }
  }, [includeVideos, includePHash, selectedAlbums, scanCancelRef, deletedIds]);

  const onCancelScan = useCallback(() => {
    scanCancelRef.cancelled = true;
  }, [scanCancelRef]);

  // Etape 1 : depuis Resultats, deplace les fichiers selectionnes vers la
  // corbeille INTERNE de l'app. Aucun fichier n'est touche sur le tel.
  const onMoveToCorbeille = useCallback(() => {
    const ids = selected;
    if (ids.size === 0) return;

    const itemsToMove: AssetItem[] = [];
    for (const g of groups) {
      for (const it of g.items) {
        if (ids.has(it.id)) itemsToMove.push(it);
      }
    }
    if (itemsToMove.length === 0) return;

    Alert.alert(
      'Mettre dans la corbeille ?',
      `${itemsToMove.length} fichier(s) seront deplaces dans la corbeille de l'app.\n\nRien n'est supprime du telephone pour l'instant. Tu pourras les restaurer ou les supprimer definitivement depuis la corbeille.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Mettre dans la corbeille',
          onPress: () => {
            // Ajoute a la corbeille (deduplique au cas ou)
            setCorbeille((prev) => {
              const seen = new Set(prev.map((p) => p.id));
              const fresh = itemsToMove.filter((it) => !seen.has(it.id));
              return [...prev, ...fresh];
            });
            // Retire des groupes affiches
            const removedSet = new Set(itemsToMove.map((it) => it.id));
            const newGroups: DupGroup[] = [];
            for (const g of groups) {
              const remaining = g.items.filter((it) => !removedSet.has(it.id));
              if (remaining.length >= 2) {
                const totalRec = remaining
                  .slice(1)
                  .reduce((s, x) => s + x.fileSize, 0);
                newGroups.push({ ...g, items: remaining, totalRecoverable: totalRec });
              }
            }
            setGroups(newGroups);
            setSelected(new Set());
          },
        },
      ]
    );
  }, [selected, groups]);

  // Etape 2 : depuis la corbeille interne, restaure des fichiers (les retire
  // de la corbeille, ils restent intacts sur le tel).
  const onRestoreFromCorbeille = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const removed = new Set(ids);
    setCorbeille((prev) => prev.filter((it) => !removed.has(it.id)));
  }, []);

  // Etape 3 : supprime DEFINITIVEMENT depuis la corbeille interne.
  // Passe par MediaLibrary.deleteAssetsAsync : declenche le dialog systeme
  // Android, fichiers vont a la corbeille Galerie Samsung (30j recuperables).
  const onDeleteForReal = useCallback(
    async (ids: string[]): Promise<boolean> => {
      if (ids.length === 0) return false;
      try {
        const success = await MediaLibrary.deleteAssetsAsync(ids);
        if (success) {
          const removed = new Set(ids);
          setCorbeille((prev) => prev.filter((it) => !removed.has(it.id)));
          // Marque ces ids comme "envoyes a la corbeille systeme" et persiste
          // sur disque, pour ne pas les re-detecter aux scans suivants tant
          // qu'Android ne les a pas vraiment effaces (~30 jours).
          const next = new Set(deletedIds);
          for (const id of ids) next.add(id);
          setDeletedIds(next);
          saveDeletedIds(next); // best-effort, fire-and-forget
        }
        return success;
      } catch (e: any) {
        Alert.alert('Erreur', e?.message || String(e));
        return false;
      }
    },
    [deletedIds]
  );

  // Loading initial : permGranted est null tant que getPermissionsAsync
  // n'a pas repondu. Affiche un spinner court pour eviter de flasher l'ecran
  // de permission a tort.
  if (permGranted === null) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={COLORS.accent2} />
      </View>
    );
  }

  if (!permGranted || screen === 'permission') {
    return (
      <PermissionScreen
        onGranted={() => {
          setPermGranted(true);
          setScreen('home');
        }}
      />
    );
  }

  if (screen === 'albums') {
    return (
      <AlbumsScreen
        albums={albums}
        loading={albumsLoading}
        selected={selectedAlbums}
        setSelected={setSelectedAlbums}
        onLaunchScan={onLaunchScan}
        onBack={() => setScreen('home')}
      />
    );
  }

  if (screen === 'scan') {
    return <ScanScreen progress={progress} onCancel={onCancelScan} />;
  }

  if (screen === 'corbeille') {
    return (
      <CorbeilleScreen
        items={corbeille}
        onRestore={onRestoreFromCorbeille}
        onDeleteForReal={onDeleteForReal}
        onBack={() => setScreen(groups.length > 0 ? 'results' : 'home')}
      />
    );
  }

  if (screen === 'results') {
    return (
      <ResultsScreen
        groups={groups}
        selected={selected}
        setSelected={setSelected}
        onMoveToCorbeille={onMoveToCorbeille}
        onBack={() => setScreen('home')}
        corbeilleCount={corbeille.length}
        onOpenCorbeille={() => setScreen('corbeille')}
      />
    );
  }

  return (
    <HomeScreen
      includeVideos={includeVideos}
      setIncludeVideos={setIncludeVideos}
      includePHash={includePHash}
      setIncludePHash={setIncludePHash}
      onScan={onOpenAlbums}
      corbeilleCount={corbeille.length}
      onOpenCorbeille={() => setScreen('corbeille')}
    />
  );
}

// ============================================================================
// Styles
// ============================================================================
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingTop: Platform.OS === 'android' ? 36 : 60,
    paddingHorizontal: 20,
  },
  title: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: COLORS.text2,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 6,
  },
  footer: {
    color: COLORS.text3,
    fontSize: 11,
    textAlign: 'center',
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
  },
  // Permission
  permissionWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
  },
  permIcon: { fontSize: 64, marginBottom: 16 },
  permPrivacy: {
    color: COLORS.text3,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 14,
    marginBottom: 30,
    fontStyle: 'italic',
  },
  // Home
  homeHeader: { marginTop: 30, marginBottom: 30 },
  optionCard: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    marginBottom: 28,
  },
  optionRow: { flexDirection: 'row', alignItems: 'center' },
  optionLabel: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  optionHelp: { color: COLORS.text2, fontSize: 12, marginTop: 2 },
  bigBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingVertical: 22,
    alignItems: 'center',
    shadowColor: COLORS.accent,
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  bigBtnIcon: { fontSize: 30, marginBottom: 6 },
  bigBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  // Buttons
  primaryBtn: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryBtn: {
    marginTop: 18,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  secondaryBtnText: { color: COLORS.text2, fontSize: 14 },
  smallBtn: {
    backgroundColor: COLORS.card2,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginRight: 8,
    marginTop: 8,
  },
  smallBtnAccent: {
    backgroundColor: COLORS.warn,
  },
  smallBtnText: { color: COLORS.text, fontSize: 12, fontWeight: '600' },
  // Scan
  scanWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
  },
  pbarOuter: {
    width: '100%',
    height: 10,
    backgroundColor: COLORS.card,
    borderRadius: 5,
    marginTop: 26,
    overflow: 'hidden',
  },
  pbarInner: { height: '100%', backgroundColor: COLORS.accent, borderRadius: 5 },
  scanCount: { color: COLORS.text2, fontSize: 13, marginTop: 8 },
  // Results
  resultsHeader: { marginBottom: 14 },
  resultsActions: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  groupCard: {
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    marginBottom: 12,
  },
  groupHeader: {
    color: COLORS.accent2,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  groupHeaderRow: {
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 8,
    marginBottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  groupKindBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginLeft: 8,
  },
  groupKindExact: {
    backgroundColor: COLORS.accent,
  },
  groupKindQuasi: {
    backgroundColor: COLORS.warn,
  },
  groupKindText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  fileRowSelected: { borderColor: COLORS.danger, backgroundColor: '#2d1b1b' },
  fileRowFirst: {},
  albumRowSelected: { borderColor: COLORS.accent, backgroundColor: '#1d1c30' },
  albumIcon: { fontSize: 26, marginLeft: 4 },
  checkboxAlbumOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  bigBtnInline: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigBtnInlineText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 6,
    backgroundColor: '#000',
  },
  fileName: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  fileSize: { color: COLORS.text2, fontSize: 11, marginTop: 2 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxOn: { backgroundColor: COLORS.danger, borderColor: COLORS.danger },
  checkboxMark: { color: '#fff', fontWeight: '700' },
  // Bottom action bar
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    padding: 14,
    paddingBottom: 24,
  },
  bottomBarLine1: { color: COLORS.text, fontSize: 14 },
  bottomBarCount: { color: COLORS.danger, fontWeight: '700', fontSize: 16 },
  bottomBarLine2: { color: COLORS.warn, fontSize: 12 },
  dangerBtn: {
    backgroundColor: COLORS.danger,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerBtnDisabled: { opacity: 0.4 },
  dangerBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  warnBtn: {
    backgroundColor: COLORS.warn,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 10,
  },
  warnBtnText: { color: '#000', fontSize: 15, fontWeight: '700' },
  restoreBtn: {
    backgroundColor: COLORS.card2,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  restoreBtnText: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  // Corbeille screen specifics
  corbeilleHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  backArrow: { color: COLORS.accent2, fontSize: 32, fontWeight: '300' },
  corbeilleNotice: {
    backgroundColor: '#3d2d0d',
    borderWidth: 1,
    borderColor: COLORS.warn,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
  corbeilleNoticeText: { color: COLORS.warn, fontSize: 12, lineHeight: 17 },
  corbeilleHomeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.warn,
    borderRadius: 12,
    padding: 14,
    marginTop: 16,
  },
  corbeilleHomeIcon: { fontSize: 28, marginRight: 12 },
  corbeilleHomeTitle: { color: COLORS.warn, fontSize: 15, fontWeight: '700' },
  corbeilleHomeSubtitle: { color: COLORS.text2, fontSize: 12, marginTop: 2 },
  corbeilleHomeChevron: { color: COLORS.text2, fontSize: 24, marginLeft: 8 },
  // Empty
  emptyWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
  },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
});
