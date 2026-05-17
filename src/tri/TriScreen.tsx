/**
 * Ecran "Tri par ressemblance" (mobile).
 *
 * Workflow :
 *   1. Verifier que le modele ONNX CLIP est telecharge, sinon le DL avec progress
 *   2. L'user choisit des photos depuis ses albums (Galerie)
 *   3. L'app calcule un embedding CLIP pour chaque, puis fait du clustering
 *   4. Pour chaque groupe : thumbs + input nom + bouton "Creer album"
 *   5. Au move : MediaLibrary.createAlbumAsync ou addAssetsToAlbumAsync
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ScrollView,
  Alert,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';

import {
  isModelDownloaded,
  downloadModel,
  loadVisionSession,
  isOnnxAvailable,
} from './models';
import { encodeImage } from './embeddings';
import { greedyCluster, type Cluster, type ClusterItem } from './clustering';
import ClusterCard from './ClusterCard';
import ClusterContentsModal from './ClusterContentsModal';

interface TriScreenProps {
  onBack: () => void;
}

type Phase = 'check_model' | 'no_onnx' | 'need_download' | 'downloading' | 'ready' | 'picking' | 'analyzing' | 'results';

interface PickedAsset {
  id: string;
  uri: string;
  filename: string;
}

export default function TriScreen({ onBack }: TriScreenProps) {
  const [phase, setPhase] = useState<Phase>('check_model');
  const [downloadPct, setDownloadPct] = useState(0);
  const [pickedAssets, setPickedAssets] = useState<PickedAsset[]>([]);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisTotal, setAnalysisTotal] = useState(0);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [threshold, setThreshold] = useState(0.88);
  const [openClusterIdx, setOpenClusterIdx] = useState<number | null>(null);
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Mode batch : firstItemId -> albumName cible (cf TriApiScreen pour la rationale)
  const [queued, setQueued] = useState<Map<string, string>>(new Map());

  // 1. Au mount : check d'abord la dispo onnxruntime, puis le modele
  useEffect(() => {
    (async () => {
      if (!isOnnxAvailable()) {
        setPhase('no_onnx');
        return;
      }
      const ok = await isModelDownloaded();
      setPhase(ok ? 'ready' : 'need_download');
    })();
  }, []);

  // Telecharge le modele
  const startDownload = useCallback(async () => {
    setPhase('downloading');
    setDownloadPct(0);
    try {
      await downloadModel((dl, total) => {
        setDownloadPct(Math.round((dl / total) * 100));
      });
      // Pre-chauffe : charge la session une fois pour valider
      await loadVisionSession();
      setPhase('ready');
    } catch (e: any) {
      Alert.alert('Erreur', String(e?.message ?? e));
      setPhase('need_download');
    }
  }, []);

  // Charge la liste des albums
  useEffect(() => {
    if (phase === 'ready' || phase === 'picking') {
      (async () => {
        const list = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
        setAlbums(list.filter((a) => a.assetCount > 0).sort((a, b) => b.assetCount - a.assetCount));
      })();
    }
  }, [phase]);

  // Pick un album entier
  const pickAlbum = useCallback(async (album: MediaLibrary.Album) => {
    setBusy(true);
    try {
      const all: PickedAsset[] = [];
      let after: string | undefined = undefined;
      while (true) {
        const page = await MediaLibrary.getAssetsAsync({
          album: album.id,
          first: 500,
          after,
          mediaType: ['photo'],
        });
        for (const a of page.assets) {
          all.push({ id: a.id, uri: a.uri, filename: a.filename });
        }
        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
      setPickedAssets(all);
      setSelectedAlbumId(album.id);
      setPhase('ready');
    } catch (e: any) {
      Alert.alert('Erreur', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Lance l'analyse
  const startAnalysis = useCallback(async () => {
    if (pickedAssets.length === 0) {
      Alert.alert('Vide', 'Choisis au moins un album a analyser.');
      return;
    }
    setPhase('analyzing');
    setAnalysisProgress(0);
    setAnalysisTotal(pickedAssets.length);

    const items: ClusterItem[] = [];
    for (let i = 0; i < pickedAssets.length; i++) {
      const a = pickedAssets[i];
      // Resolve uri locale via getAssetInfoAsync
      let localUri = a.uri;
      try {
        const info = await MediaLibrary.getAssetInfoAsync({ id: a.id } as any, {
          shouldDownloadFromNetwork: false,
        });
        if (info.localUri) localUri = info.localUri;
      } catch {
        // ignore
      }
      const emb = await encodeImage(localUri);
      if (emb) {
        items.push({ id: a.id, uri: localUri, filename: a.filename, embedding: emb });
      }
      setAnalysisProgress(i + 1);
    }

    const groups = greedyCluster(items, threshold);
    setClusters(groups);
    setPhase('results');
  }, [pickedAssets, threshold]);

  // Action : creer un album + y deplacer les fichiers d'un cluster
  const moveClusterToAlbum = useCallback(
    async (cluster: Cluster, albumName: string) => {
      if (!albumName.trim()) {
        Alert.alert('Nom requis', "Tape un nom d'album avant de creer.");
        return;
      }
      setBusy(true);
      try {
        const assetIds = cluster.items.map((it) => it.id);
        const fakeAssets = assetIds.map((id) => ({ id } as MediaLibrary.Asset));
        // Cree l'album avec le 1er asset, puis ajoute le reste
        const existing = await MediaLibrary.getAlbumAsync(albumName);
        let album: MediaLibrary.Album;
        if (existing) {
          album = existing;
          await MediaLibrary.addAssetsToAlbumAsync(fakeAssets as any, album, false);
        } else {
          album = await MediaLibrary.createAlbumAsync(albumName, fakeAssets[0] as any, false);
          if (fakeAssets.length > 1) {
            await MediaLibrary.addAssetsToAlbumAsync(fakeAssets.slice(1) as any, album, false);
          }
        }
        Alert.alert(
          'Album cree',
          `${cluster.items.length} fichier(s) ajoute(s) a "${albumName}".`
        );
        // Retire le cluster de la liste
        setClusters((prev) => prev.filter((c) => c !== cluster));
      } catch (e: any) {
        Alert.alert('Erreur', String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  // Ajoute / met a jour un cluster dans la file d'attente
  const queueCluster = useCallback((cluster: Cluster, albumName: string) => {
    const key = cluster.items[0]?.id;
    if (!key || !albumName.trim()) return;
    setQueued((prev) => {
      const next = new Map(prev);
      next.set(key, albumName.trim());
      return next;
    });
  }, []);

  // Flush : execute en serie tous les deplacements en file, retire les
  // clusters reussis. 1 seul Alert final pour le bilan.
  const flushAll = useCallback(async () => {
    if (queued.size === 0) return;
    setBusy(true);
    const succeeded: string[] = [];
    const errors: { name: string; msg: string }[] = [];
    for (const [firstId, albumName] of queued) {
      const cluster = clusters.find((c) => c.items[0]?.id === firstId);
      if (!cluster) continue;
      try {
        const assetIds = cluster.items.map((it) => it.id);
        const fakeAssets = assetIds.map((id) => ({ id } as MediaLibrary.Asset));
        const existing = await MediaLibrary.getAlbumAsync(albumName);
        let album: MediaLibrary.Album;
        if (existing) {
          album = existing;
          await MediaLibrary.addAssetsToAlbumAsync(fakeAssets as any, album, false);
        } else {
          album = await MediaLibrary.createAlbumAsync(albumName, fakeAssets[0] as any, false);
          if (fakeAssets.length > 1) {
            await MediaLibrary.addAssetsToAlbumAsync(fakeAssets.slice(1) as any, album, false);
          }
        }
        succeeded.push(firstId);
      } catch (e: any) {
        errors.push({ name: albumName, msg: e?.message ?? String(e) });
      }
    }
    const okSet = new Set(succeeded);
    setClusters((prev) => prev.filter((c) => !okSet.has(c.items[0]?.id ?? '')));
    setQueued((prev) => {
      const next = new Map(prev);
      for (const id of succeeded) next.delete(id);
      return next;
    });
    setBusy(false);
    if (errors.length === 0) {
      Alert.alert('File traitee', `${succeeded.length} groupe(s) deplace(s).`);
    } else {
      Alert.alert(
        'File traitee avec erreurs',
        `OK : ${succeeded.length}\nEchecs : ${errors.length}\n\n` +
          errors.map((e) => `- ${e.name} : ${e.msg.slice(0, 80)}`).join('\n')
      );
    }
  }, [queued, clusters]);

  // Retire des items d'un cluster (via modal contenu)
  const updateClusterItems = useCallback((idx: number, kept: ClusterItem[]) => {
    setClusters((prev) => {
      const next = [...prev];
      if (kept.length === 0) {
        next.splice(idx, 1);
      } else {
        next[idx] = { items: kept };
      }
      return next;
    });
  }, []);

  // ============================================================================
  // Rendu selon phase
  // ============================================================================
  if (phase === 'check_model') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6c5ce7" />
        <Text style={styles.muted}>Verification du modele...</Text>
      </View>
    );
  }

  if (phase === 'no_onnx') {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Fonction non disponible dans Expo Go</Text>
        <Text style={styles.body}>
          Le tri par ressemblance utilise un modele d'IA (CLIP) qui necessite
          une librairie native (onnxruntime-react-native).
        </Text>
        <Text style={styles.body}>
          Pour activer cette fonction, il faut un Development Build EAS :{'\n'}{'\n'}
          eas build --profile development --platform android
        </Text>
        <Text style={styles.muted}>
          Le reste de l'app (Doublons, Corbeille) marche normalement dans Expo Go.
        </Text>
        <TouchableOpacity onPress={onBack} style={styles.btn}>
          <Text style={styles.btnText}>Retour</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'need_download') {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Tri par ressemblance</Text>
        <Text style={styles.body}>
          Cette fonction utilise un modele d intelligence visuelle (CLIP, ~85 Mo).
          Telechargement une fois, ensuite 100% offline.
        </Text>
        <TouchableOpacity style={styles.btn} onPress={startDownload}>
          <Text style={styles.btnText}>Telecharger le modele (~85 Mo)</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.link}>Retour</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'downloading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6c5ce7" />
        <Text style={styles.body}>Telechargement... {downloadPct}%</Text>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${downloadPct}%` }]} />
        </View>
      </View>
    );
  }

  if (phase === 'analyzing') {
    const pct = analysisTotal > 0 ? Math.round((analysisProgress / analysisTotal) * 100) : 0;
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6c5ce7" />
        <Text style={styles.body}>
          Analyse {analysisProgress} / {analysisTotal} ({pct}%)
        </Text>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>
        <Text style={styles.muted}>~2-5 secondes par image, sois patient</Text>
      </View>
    );
  }

  if (phase === 'results') {
    return (
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack}>
            <Text style={styles.link}>← Retour</Text>
          </TouchableOpacity>
          <Text style={styles.titleSmall}>
            {clusters.length} groupe(s) trouve(s)
          </Text>
        </View>
        {queued.size > 0 && (
          <View style={styles.queueBar}>
            <Text style={styles.queueBarText}>
              📦 {queued.size} groupe(s) en file
            </Text>
            <View style={styles.queueBarActions}>
              <TouchableOpacity
                style={styles.queueClearBtn}
                onPress={() => setQueued(new Map())}
                disabled={busy}
              >
                <Text style={styles.queueClearText}>Vider</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.queueFlushBtn, busy && styles.btnDisabled]}
                onPress={flushAll}
                disabled={busy}
              >
                <Text style={styles.queueFlushText}>Tout deplacer</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        {clusters.length === 0 && (
          <Text style={styles.body}>Aucun groupe forme. Recommence avec d'autres images.</Text>
        )}
        {clusters.map((c, idx) => (
          <ClusterCard
            key={c.items[0]?.id ?? idx}
            cluster={c}
            index={idx + 1}
            albums={albums}
            onSeeAll={() => setOpenClusterIdx(idx)}
            onMove={(name) => moveClusterToAlbum(c, name)}
            onSkip={() => setClusters((prev) => prev.filter((_, i) => i !== idx))}
            onQueue={(name) => queueCluster(c, name)}
            queuedName={queued.get(c.items[0]?.id ?? '')}
            busy={busy}
          />
        ))}
        {openClusterIdx !== null && (
          <ClusterContentsModal
            cluster={clusters[openClusterIdx]}
            onClose={() => setOpenClusterIdx(null)}
            onApply={(kept) => {
              updateClusterItems(openClusterIdx, kept);
              setOpenClusterIdx(null);
            }}
          />
        )}
      </ScrollView>
    );
  }

  // phase === 'ready' (ou 'picking')
  return (
    <ScrollView style={styles.screen}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.link}>← Retour</Text>
        </TouchableOpacity>
        <Text style={styles.titleSmall}>Tri par ressemblance</Text>
      </View>
      <Text style={styles.body}>
        Choisis un album a analyser. L'app regroupera les photos qui se ressemblent.
      </Text>

      <Text style={styles.section}>Albums disponibles</Text>
      {albums.map((al) => {
        const selected = al.id === selectedAlbumId;
        return (
          <TouchableOpacity
            key={al.id}
            style={[styles.albumRow, selected && styles.albumRowSelected]}
            onPress={() => pickAlbum(al)}
            disabled={busy}
          >
            <Text style={styles.albumTitle}>{al.title}</Text>
            <Text style={styles.albumCount}>{al.assetCount} photo(s)</Text>
          </TouchableOpacity>
        );
      })}

      {pickedAssets.length > 0 && (
        <View style={styles.summaryBox}>
          <Text style={styles.body}>
            {pickedAssets.length} photo(s) selectionnee(s)
          </Text>
          <Text style={styles.muted}>
            Sensibilite du regroupement : {Math.round(threshold * 100)}%
          </Text>
          <View style={styles.thresholdRow}>
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => setThreshold((t) => Math.max(0.7, t - 0.02))}
              disabled={busy}
            >
              <Text style={styles.smallBtnText}>- permissif</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => setThreshold((t) => Math.min(0.97, t + 0.02))}
              disabled={busy}
            >
              <Text style={styles.smallBtnText}>+ strict</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.btn, busy && styles.btnDisabled]}
            onPress={startAnalysis}
            disabled={busy}
          >
            <Text style={styles.btnText}>Analyser et regrouper</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0f1117', padding: 16 },
  center: {
    flex: 1,
    backgroundColor: '#0f1117',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: { color: '#e4e6f0', fontSize: 22, fontWeight: '800', marginBottom: 12 },
  titleSmall: { color: '#e4e6f0', fontSize: 16, fontWeight: '700' },
  body: { color: '#e4e6f0', fontSize: 14, marginBottom: 14, lineHeight: 20 },
  muted: { color: '#8b8fa3', fontSize: 12, marginTop: 6 },
  link: { color: '#a29bfe', fontSize: 14, fontWeight: '600' },
  btn: {
    backgroundColor: '#6c5ce7',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 8,
    marginTop: 10,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: 'white', fontWeight: '700', textAlign: 'center' },
  section: { color: '#8b8fa3', fontSize: 12, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  albumRow: {
    backgroundColor: '#1a1d27',
    borderRadius: 6,
    padding: 12,
    marginBottom: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  albumRowSelected: { borderColor: '#6c5ce7', borderWidth: 2 },
  albumTitle: { color: '#e4e6f0', fontWeight: '600' },
  albumCount: { color: '#8b8fa3' },
  summaryBox: {
    backgroundColor: '#1a1d27',
    borderRadius: 8,
    padding: 14,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  thresholdRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  smallBtn: {
    backgroundColor: '#252836',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  smallBtnText: { color: '#e4e6f0', fontSize: 11 },
  progressBar: {
    width: '80%',
    height: 8,
    backgroundColor: '#252836',
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 12,
  },
  progressFill: { height: '100%', backgroundColor: '#6c5ce7' },
  queueBar: {
    backgroundColor: 'rgba(0, 184, 148, 0.10)',
    borderColor: '#00b894',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  queueBarText: { color: '#e4e6f0', fontWeight: '700', fontSize: 13 },
  queueBarActions: { flexDirection: 'row', gap: 6 },
  queueClearBtn: {
    backgroundColor: '#252836',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  queueClearText: { color: '#e4e6f0', fontSize: 12 },
  queueFlushBtn: {
    backgroundColor: '#00b894',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 4,
  },
  queueFlushText: { color: 'white', fontWeight: '700', fontSize: 12 },
});
