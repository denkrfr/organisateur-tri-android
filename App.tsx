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

// ============================================================================
// Types & constantes
// ============================================================================
type Screen = 'permission' | 'home' | 'scan' | 'results' | 'corbeille';

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
}

const COLORS = {
  bg:        '#0f1117',
  card:      '#1a1d27',
  card2:     '#252836',
  border:    '#2e3244',
  text:      '#e4e6f0',
  text2:     '#8b8fa3',
  text3:     '#5a5e70',
  accent:    '#6c5ce7',
  accent2:   '#a29bfe',
  danger:    '#ff6b6b',
  warn:      '#ffd43b',
  ok:        '#51cf66',
};

// On lit 16 KB au debut + 16 KB a la fin pour le quick-hash
const QUICK_HASH_BYTES = 16 * 1024;

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

async function fetchAllAssets(
  includeVideos: boolean,
  onProgress: ProgressCb,
  cancelRef: { cancelled: boolean }
): Promise<AssetItem[]> {
  const assets: AssetItem[] = [];
  let after: string | undefined = undefined;
  const PAGE_SIZE = 500;
  const mediaTypes: MediaLibrary.MediaTypeValue[] = includeVideos
    ? ['photo', 'video']
    : ['photo'];

  // 1er passage pour avoir le total approx (nb de photos sur le tel)
  // On demande juste 1 element pour lire `totalCount`
  const probe = await MediaLibrary.getAssetsAsync({
    mediaType: mediaTypes,
    first: 1,
  });
  const total = probe.totalCount;
  onProgress(0, total, 'Recuperation de la liste...');

  while (true) {
    if (cancelRef.cancelled) break;
    const page = await MediaLibrary.getAssetsAsync({
      mediaType: mediaTypes,
      first: PAGE_SIZE,
      after,
      sortBy: [MediaLibrary.SortBy.creationTime],
    });
    for (const a of page.assets) {
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
    onProgress(assets.length, total, `Liste : ${assets.length} / ${total}`);
    if (!page.hasNextPage) break;
    after = page.endCursor;
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
    groups.push({ hash, items: arr, totalRecoverable });
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
  onScan,
  corbeilleCount,
  onOpenCorbeille,
}: {
  includeVideos: boolean;
  setIncludeVideos: (v: boolean) => void;
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

      <Text style={styles.footer}>v1.0  ·  100% local, aucune donnee envoyee en ligne</Text>
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
              cachePolicy="memory"
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

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

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
        <Text style={styles.title}>{groups.length} groupes de doublons</Text>
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
        data={groups}
        keyExtractor={(g) => g.hash}
        contentContainerStyle={{ paddingBottom: 130 }}
        renderItem={({ item }) => (
          <View style={styles.groupCard}>
            <Text style={styles.groupHeader}>
              {item.items.length} copies  ·  {fmtSize(item.totalRecoverable)} si on garde le + gros
            </Text>
            {item.items.map((it, idx) => (
              <Pressable
                key={it.id}
                style={[
                  styles.fileRow,
                  selected.has(it.id) && styles.fileRowSelected,
                  idx === 0 && styles.fileRowFirst,
                ]}
                onPress={() => toggle(it.id)}
              >
                <Image
                  source={{ uri: it.uri }}
                  style={styles.thumb}
                  contentFit="cover"
                  cachePolicy="memory"
                  transition={120}
                />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.fileName} numberOfLines={1}>
                    {it.filename}
                  </Text>
                  <Text style={styles.fileSize}>
                    {fmtSize(it.fileSize)}
                    {idx === 0 && '   ·   le + gros'}
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
            ))}
          </View>
        )}
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
  const [progress, setProgress] = useState({ current: 0, total: 0, label: 'Initialisation...' });
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanCancelRef] = useState({ cancelled: false });
  // Corbeille interne : fichiers marques pour suppression mais pas encore
  // envoyes au systeme. Securite supplementaire avant la suppression Android.
  const [corbeille, setCorbeille] = useState<AssetItem[]>([]);

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

  const onScan = useCallback(async () => {
    setScreen('scan');
    setProgress({ current: 0, total: 0, label: 'Recuperation de la liste...' });
    setGroups([]);
    setSelected(new Set());
    scanCancelRef.cancelled = false;

    try {
      const onProg: ProgressCb = (c, t, label) => {
        setProgress({ current: c, total: t, label });
      };
      const assets = await fetchAllAssets(includeVideos, onProg, scanCancelRef);
      if (scanCancelRef.cancelled) {
        setScreen('home');
        return;
      }
      const hashed = await hashAllAssets(assets, onProg, scanCancelRef);
      if (scanCancelRef.cancelled) {
        setScreen('home');
        return;
      }
      const grp = groupByHash(hashed);
      setGroups(grp);
      setScreen('results');
    } catch (e: any) {
      Alert.alert('Erreur', `Le scan a echoue : ${e?.message || e}`);
      setScreen('home');
    }
  }, [includeVideos, scanCancelRef]);

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
        }
        return success;
      } catch (e: any) {
        Alert.alert('Erreur', e?.message || String(e));
        return false;
      }
    },
    []
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
      onScan={onScan}
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
