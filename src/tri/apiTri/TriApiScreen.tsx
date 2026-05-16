/**
 * Ecran "Tri par ressemblance - mode IA cloud".
 *
 * Workflow analogue a TriScreen (mode CLIP) :
 *   1. Verifie qu'une cle API est configuree (sinon redirige vers SetupScreen)
 *   2. L'user choisit un album
 *   3. Envoi par batches a l'API → regroupement avec noms suggeres
 *   4. Affichage des clusters via ClusterCard (reutilise le composant existant)
 *      Le suggestedName de chaque cluster pre-remplit l'input "Nom de l'album"
 *   5. Action "Creer album / Ajouter a existant" identique au mode CLIP
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import {
  getConfiguredProvider,
  loadApiKey,
  loadSelectedProvider,
  type ProviderId,
} from './keyStore';
import { analyzeWithApi, type ApiCluster, type ApiClusterItem } from './providers';
import ClusterCard from '../ClusterCard';
import ClusterContentsModal from '../ClusterContentsModal';
import type { Cluster, ClusterItem } from '../clustering';
import SetupScreen from './SetupScreen';

interface Props {
  onBack: () => void;
}

type Phase = 'init' | 'setup' | 'ready' | 'analyzing' | 'results';

interface PickedAsset {
  id: string;
  uri: string;
  filename: string;
}

export default function TriApiScreen({ onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('init');
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [pickedAssets, setPickedAssets] = useState<PickedAsset[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ batch: 0, total: 0, label: '' });
  const [clusters, setClusters] = useState<ApiCluster[]>([]);
  const [openClusterIdx, setOpenClusterIdx] = useState<number | null>(null);

  // 1. Verif setup au mount
  useEffect(() => {
    (async () => {
      const conf = await getConfiguredProvider();
      if (conf) {
        setProvider(conf);
        setPhase('ready');
      } else {
        setPhase('setup');
      }
    })();
  }, []);

  // Charge liste albums quand on est pret
  useEffect(() => {
    if (phase === 'ready') {
      (async () => {
        const list = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
        setAlbums(list.filter((a) => a.assetCount > 0).sort((a, b) => b.assetCount - a.assetCount));
      })();
    }
  }, [phase]);

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
    } catch (e: any) {
      Alert.alert('Erreur', e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const startAnalysis = useCallback(async () => {
    if (!provider) return;
    if (pickedAssets.length === 0) {
      Alert.alert('Vide', 'Choisis un album avec au moins une photo.');
      return;
    }
    const apiKey = await loadApiKey(provider);
    if (!apiKey) {
      Alert.alert('Cle manquante', 'Reconfigure ta cle API.');
      setPhase('setup');
      return;
    }

    setPhase('analyzing');
    setProgress({ batch: 0, total: 0, label: 'Resolution des URIs locales...' });

    // Resolution des localUri (necessaire pour ImageManipulator)
    const items: ApiClusterItem[] = [];
    for (const a of pickedAssets) {
      let uri = a.uri;
      try {
        const info = await MediaLibrary.getAssetInfoAsync({ id: a.id } as any, {
          shouldDownloadFromNetwork: false,
        });
        if (info.localUri) uri = info.localUri;
      } catch {
        // ignore, on garde a.uri
      }
      items.push({ id: a.id, uri, filename: a.filename });
    }

    try {
      const apiClusters = await analyzeWithApi(
        provider,
        apiKey,
        items,
        (batch, total, label) => setProgress({ batch, total, label })
      );
      setClusters(apiClusters);
      setPhase('results');
    } catch (e: any) {
      Alert.alert(
        'Echec analyse IA',
        (e?.message ?? String(e)) +
          '\n\nTu peux reessayer ou revenir choisir le mode local.'
      );
      setPhase('ready');
    }
  }, [provider, pickedAssets]);

  // Convertit ApiCluster -> Cluster (format attendu par ClusterCard).
  // ClusterCard ignore le champ 'embedding' donc on peut le mettre vide.
  const clusterAsClassic = (c: ApiCluster, idx: number): Cluster => ({
    items: c.items.map((it) => ({
      id: it.id,
      uri: it.uri,
      filename: it.filename,
      embedding: new Float32Array(0),
    })),
  });

  const moveClusterToAlbum = useCallback(
    async (cluster: ApiCluster, albumName: string) => {
      if (!albumName.trim()) {
        Alert.alert('Nom requis', "Tape un nom d'album avant de creer.");
        return;
      }
      setBusy(true);
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
        Alert.alert(
          'Album cree',
          `${cluster.items.length} fichier(s) ajoute(s) a "${albumName}".`
        );
        setClusters((prev) => prev.filter((c) => c !== cluster));
      } catch (e: any) {
        Alert.alert('Erreur', e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const updateClusterItems = useCallback((idx: number, kept: ClusterItem[]) => {
    setClusters((prev) => {
      const next = [...prev];
      const keptIds = new Set(kept.map((k) => k.id));
      const filteredItems = next[idx].items.filter((it) => keptIds.has(it.id));
      if (filteredItems.length === 0) {
        next.splice(idx, 1);
      } else {
        next[idx] = { ...next[idx], items: filteredItems };
      }
      return next;
    });
  }, []);

  // ============================================================================
  // Rendu selon phase
  // ============================================================================
  if (phase === 'init') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6c5ce7" />
      </View>
    );
  }

  if (phase === 'setup') {
    return (
      <SetupScreen
        onDone={(p) => {
          setProvider(p);
          setPhase('ready');
        }}
        onBack={onBack}
      />
    );
  }

  if (phase === 'analyzing') {
    const pct =
      progress.total > 0 ? Math.round(((progress.batch + 1) / progress.total) * 100) : 0;
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6c5ce7" />
        <Text style={styles.body}>{progress.label}</Text>
        {progress.total > 0 && (
          <>
            <Text style={styles.muted}>Lot {progress.batch + 1} / {progress.total}</Text>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${pct}%` }]} />
            </View>
          </>
        )}
        <Text style={styles.muted}>L'IA analyse tes photos en lignes...</Text>
      </View>
    );
  }

  if (phase === 'results') {
    return (
      <ScrollView style={styles.screen}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack}>
            <Text style={styles.link}>← Retour</Text>
          </TouchableOpacity>
          <Text style={styles.titleSmall}>
            {clusters.length} groupe(s) trouve(s) (IA)
          </Text>
        </View>
        {clusters.length === 0 && (
          <Text style={styles.body}>
            Aucun groupe forme. Recommence avec d'autres photos.
          </Text>
        )}
        {clusters.map((c, idx) => (
          <ClusterCardApiWrapper
            key={idx}
            apiCluster={c}
            index={idx + 1}
            albums={albums}
            onSeeAll={() => setOpenClusterIdx(idx)}
            onMove={(name) => moveClusterToAlbum(c, name)}
            onSkip={() => setClusters((prev) => prev.filter((_, i) => i !== idx))}
            busy={busy}
          />
        ))}
        {openClusterIdx !== null && clusters[openClusterIdx] && (
          <ClusterContentsModal
            cluster={clusterAsClassic(clusters[openClusterIdx], openClusterIdx)}
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

  // phase === 'ready'
  return (
    <ScrollView style={styles.screen}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.link}>← Retour</Text>
        </TouchableOpacity>
        <Text style={styles.titleSmall}>
          Tri IA ({provider === 'gemini' ? 'Gemini' : 'Claude'})
        </Text>
      </View>
      <Text style={styles.body}>
        Choisis un album. L'IA analysera chaque photo et te proposera des regroupements
        par theme avec un nom d'album suggere automatiquement.
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
            Sera envoye a {provider === 'gemini' ? 'Google Gemini' : 'Anthropic Claude'}
            {' '}par lots de 20.
          </Text>
          <TouchableOpacity
            style={[styles.btn, busy && styles.btnDisabled]}
            onPress={startAnalysis}
            disabled={busy}
          >
            <Text style={styles.btnText}>Lancer l'analyse IA</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

// ============================================================================
// Wrapper ClusterCard : adapte ApiCluster -> Cluster + pre-remplit le nom IA
// ============================================================================
function ClusterCardApiWrapper({
  apiCluster,
  index,
  albums,
  onSeeAll,
  onMove,
  onSkip,
  busy,
}: {
  apiCluster: ApiCluster;
  index: number;
  albums: MediaLibrary.Album[];
  onSeeAll: () => void;
  onMove: (name: string) => void;
  onSkip: () => void;
  busy: boolean;
}) {
  const cluster: Cluster = {
    items: apiCluster.items.map((it) => ({
      id: it.id,
      uri: it.uri,
      filename: it.filename,
      embedding: new Float32Array(0),
    })),
  };
  return (
    <View>
      {!!apiCluster.suggestedName && (
        <View style={styles.suggBanner}>
          <Text style={styles.suggBannerText}>
            ✨ IA propose : <Text style={styles.suggBannerName}>{apiCluster.suggestedName}</Text>
          </Text>
        </View>
      )}
      <ClusterCard
        cluster={cluster}
        index={index}
        albums={albums}
        onSeeAll={onSeeAll}
        onMove={onMove}
        onSkip={onSkip}
        busy={busy}
        initialName={apiCluster.suggestedName}
      />
    </View>
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
  titleSmall: { color: '#e4e6f0', fontSize: 16, fontWeight: '700' },
  body: { color: '#e4e6f0', fontSize: 14, marginBottom: 14, lineHeight: 20 },
  muted: { color: '#8b8fa3', fontSize: 12, marginTop: 6 },
  link: { color: '#a29bfe', fontSize: 14, fontWeight: '600' },
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
  btn: {
    backgroundColor: '#6c5ce7',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 8,
    marginTop: 10,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: 'white', fontWeight: '700' },
  progressBar: {
    width: '80%',
    height: 8,
    backgroundColor: '#252836',
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 12,
    marginBottom: 6,
  },
  progressFill: { height: '100%', backgroundColor: '#6c5ce7' },
  suggBanner: {
    backgroundColor: 'rgba(108, 92, 231, 0.18)',
    borderColor: '#6c5ce7',
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 4,
    marginBottom: -4,
    zIndex: 1,
  },
  suggBannerText: { color: '#e4e6f0', fontSize: 13 },
  suggBannerName: { color: '#a29bfe', fontWeight: '700' },
});
