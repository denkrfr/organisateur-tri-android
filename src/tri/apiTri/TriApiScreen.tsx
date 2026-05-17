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

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  BackHandler,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  getConfiguredProvider,
  loadApiKey,
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

// Cf TriScreen pour la rationale. On duplique localement pour pas creer un
// fichier util/ separe pour 6 lignes.
function sanitizeAlbumName(name: string): string {
  const cleaned = name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'Sans nom';
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
  // Mode batch : Map firstItemId -> albumName cible.
  // L'user prepare plusieurs clusters puis on flush en un coup
  // (1 popup d'autorisation Android au lieu de N).
  const [queued, setQueued] = useState<Map<string, string>>(new Map());
  // Cancellation : pour interrompre une analyse longue (1000 photos =
  // potentiellement 20-50 min sans cancel). AbortController coupe les
  // fetch en cours cote providers.ts.
  const analysisCancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      analysisCancelRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

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

  // Garde l'ecran allume pendant l'analyse IA (peut prendre 30s-2min selon
  // la taille de l'album + latence reseau). Evite que Android tue l'app.
  useEffect(() => {
    if (phase === 'analyzing') {
      activateKeepAwakeAsync('tri-api');
      return () => {
        deactivateKeepAwake('tri-api');
      };
    }
  }, [phase]);

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

  const cancelAnalysis = useCallback(() => {
    analysisCancelRef.current = true;
    abortRef.current?.abort();
    if (mountedRef.current) setPhase('ready');
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

    analysisCancelRef.current = false;
    abortRef.current = new AbortController();
    setPhase('analyzing');
    setProgress({ batch: 0, total: 0, label: 'Resolution des URIs locales...' });

    // Resolution des localUri (necessaire pour ImageManipulator).
    // Boucle interruptible : check le cancelRef apres chaque await.
    const items: ApiClusterItem[] = [];
    for (const a of pickedAssets) {
      if (analysisCancelRef.current || !mountedRef.current) return;
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

    if (analysisCancelRef.current || !mountedRef.current) return;

    try {
      const apiClusters = await analyzeWithApi(
        provider,
        apiKey,
        items,
        (batch, total, label) => {
          if (!mountedRef.current) return;
          setProgress({ batch, total, label });
        },
        abortRef.current.signal
      );
      if (analysisCancelRef.current || !mountedRef.current) return;
      setClusters(apiClusters);
      setPhase('results');
    } catch (e: any) {
      if (!mountedRef.current) return;
      // Si l'user a explicitement annule, on ne montre pas d'Alert (deja sur ready)
      if (analysisCancelRef.current || e?.name === 'AbortError') {
        return;
      }
      Alert.alert(
        'Echec analyse IA',
        (e?.message ?? String(e)) +
          '\n\nTu peux reessayer ou revenir choisir le mode local.'
      );
      setPhase('ready');
    }
  }, [provider, pickedAssets]);

  // Intercept hardware back pendant l'analyse pour confirmer l'annulation
  useEffect(() => {
    if (phase !== 'analyzing') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      Alert.alert(
        "Annuler l'analyse IA ?",
        "L'avancement sera perdu (tu peux relancer ensuite).",
        [
          { text: 'Continuer', style: 'cancel' },
          { text: 'Annuler', style: 'destructive', onPress: cancelAnalysis },
        ]
      );
      return true;
    });
    return () => sub.remove();
  }, [phase, cancelAnalysis]);

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
      const clean = sanitizeAlbumName(albumName);
      if (!albumName.trim() || clean === 'Sans nom') {
        Alert.alert('Nom requis', "Tape un nom d'album valide avant de creer.");
        return;
      }
      setBusy(true);
      try {
        const assetIds = cluster.items.map((it) => it.id);
        const fakeAssets = assetIds.map((id) => ({ id } as MediaLibrary.Asset));
        const existing = await MediaLibrary.getAlbumAsync(clean);
        let album: MediaLibrary.Album;
        if (existing) {
          album = existing;
          await MediaLibrary.addAssetsToAlbumAsync(fakeAssets as any, album, false);
        } else {
          album = await MediaLibrary.createAlbumAsync(clean, fakeAssets[0] as any, false);
          if (fakeAssets.length > 1) {
            await MediaLibrary.addAssetsToAlbumAsync(fakeAssets.slice(1) as any, album, false);
          }
        }
        Alert.alert(
          'Album cree',
          `${cluster.items.length} fichier(s) ajoute(s) a "${clean}".`
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

  // Ajoute / met a jour un cluster dans la file d'attente
  const queueCluster = useCallback((cluster: ApiCluster, albumName: string) => {
    const key = cluster.items[0]?.id;
    const clean = sanitizeAlbumName(albumName);
    if (!key || !albumName.trim() || clean === 'Sans nom') return;
    setQueued((prev) => {
      const next = new Map(prev);
      next.set(key, clean);
      return next;
    });
  }, []);

  const clearQueueWithConfirm = useCallback(() => {
    if (queued.size === 0) return;
    Alert.alert(
      'Vider la file ?',
      `Tu vas perdre les ${queued.size} groupe(s) prepares.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Vider',
          style: 'destructive',
          onPress: () => setQueued(new Map()),
        },
      ]
    );
  }, [queued]);

  // Flush : groupe les clusters en file PAR ALBUM CIBLE (normalise casse +
  // accents) -> 1-2 appels MediaLibrary par album unique. Reduit le nombre
  // de popups d'autorisation Android 11+ et evite "Voyage" vs "voyage" qui
  // resterait separe dans le bilan affiche a l'user.
  const flushAll = useCallback(async () => {
    if (queued.size === 0) return;
    setBusy(true);

    const normalize = (s: string) =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const byAlbum = new Map<
      string,
      { items: ApiClusterItem[]; firstIds: string[]; displayName: string }
    >();
    for (const [firstId, albumName] of queued) {
      const cluster = clusters.find((c) => c.items[0]?.id === firstId);
      if (!cluster) continue;
      const cleanName = sanitizeAlbumName(albumName);
      const key = normalize(cleanName);
      const entry = byAlbum.get(key) ?? {
        items: [],
        firstIds: [],
        displayName: cleanName,
      };
      entry.items.push(...cluster.items);
      entry.firstIds.push(firstId);
      byAlbum.set(key, entry);
    }

    const succeededFirstIds: string[] = [];
    const errors: { name: string; msg: string }[] = [];
    for (const [, entry] of byAlbum) {
      try {
        const fakeAssets = entry.items.map((it) => ({ id: it.id } as MediaLibrary.Asset));
        const existing = await MediaLibrary.getAlbumAsync(entry.displayName);
        let album: MediaLibrary.Album;
        if (existing) {
          album = existing;
          await MediaLibrary.addAssetsToAlbumAsync(fakeAssets as any, album, false);
        } else {
          album = await MediaLibrary.createAlbumAsync(
            entry.displayName,
            fakeAssets[0] as any,
            false
          );
          if (fakeAssets.length > 1) {
            await MediaLibrary.addAssetsToAlbumAsync(fakeAssets.slice(1) as any, album, false);
          }
        }
        succeededFirstIds.push(...entry.firstIds);
      } catch (e: any) {
        errors.push({ name: entry.displayName, msg: e?.message ?? String(e) });
      }
    }

    const okSet = new Set(succeededFirstIds);
    setClusters((prev) => prev.filter((c) => !okSet.has(c.items[0]?.id ?? '')));
    setQueued((prev) => {
      const next = new Map(prev);
      for (const id of succeededFirstIds) next.delete(id);
      return next;
    });
    setBusy(false);
    if (errors.length === 0) {
      Alert.alert(
        'File traitee',
        `${succeededFirstIds.length} groupe(s) deplace(s) dans ${byAlbum.size} album(s).`
      );
    } else {
      Alert.alert(
        'File traitee avec erreurs',
        `OK : ${succeededFirstIds.length}\nEchecs : ${errors.length}\n\n` +
          errors.map((e) => `- ${e.name} : ${e.msg.slice(0, 80)}`).join('\n')
      );
    }
  }, [queued, clusters]);

  const updateClusterItems = useCallback((idx: number, kept: ClusterItem[]) => {
    // On capture oldFirstId / newFirstId pour eventuellement migrer la cle
    // dans la Map "queued" (clusterFirstId -> albumName). Sinon, retirer la
    // 1ere photo d'un cluster en file la rendrait orpheline (le badge "en
    // file" disparaitrait visuellement mais l'entree persisterait).
    let oldFirstId: string | undefined;
    let newFirstId: string | undefined;
    setClusters((prev) => {
      const cur = prev[idx];
      if (!cur) return prev;
      const next = [...prev];
      const keptIds = new Set(kept.map((k) => k.id));
      oldFirstId = cur.items[0]?.id;
      const filteredItems = cur.items.filter((it) => keptIds.has(it.id));
      newFirstId = filteredItems[0]?.id;
      if (filteredItems.length === 0) {
        next.splice(idx, 1);
      } else {
        next[idx] = { ...cur, items: filteredItems };
      }
      return next;
    });
    if (oldFirstId && oldFirstId !== newFirstId) {
      setQueued((q) => {
        if (!q.has(oldFirstId!)) return q;
        const nq = new Map(q);
        const name = nq.get(oldFirstId!);
        nq.delete(oldFirstId!);
        if (newFirstId && name) nq.set(newFirstId, name);
        return nq;
      });
    }
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
        <Text style={styles.muted}>L'IA analyse tes photos en ligne...</Text>
        <TouchableOpacity
          style={styles.secondaryCancelBtn}
          onPress={() => {
            Alert.alert(
              "Annuler l'analyse IA ?",
              "L'avancement sera perdu. Tu pourras relancer.",
              [
                { text: 'Continuer', style: 'cancel' },
                { text: 'Annuler', style: 'destructive', onPress: cancelAnalysis },
              ]
            );
          }}
        >
          <Text style={styles.secondaryCancelText}>Annuler l'analyse</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'results') {
    return (
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack} disabled={busy}>
            <Text style={[styles.link, busy && { opacity: 0.4 }]}>← Retour</Text>
          </TouchableOpacity>
          <Text style={styles.titleSmall}>
            {clusters.length} groupe(s) trouve(s) (IA)
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
                onPress={clearQueueWithConfirm}
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
          <Text style={styles.body}>
            Aucun groupe forme. Recommence avec d'autres photos.
          </Text>
        )}
        {clusters.map((c, idx) => (
          <ClusterCardApiWrapper
            key={c.items[0]?.id ?? idx}
            apiCluster={c}
            index={idx + 1}
            albums={albums}
            onSeeAll={() => setOpenClusterIdx(idx)}
            onMove={(name) => moveClusterToAlbum(c, name)}
            onSkip={() => {
              // Cleanup queue entry pour eviter l'orphan (count gonfle)
              const key = c.items[0]?.id;
              if (key) {
                setQueued((prev) => {
                  if (!prev.has(key)) return prev;
                  const next = new Map(prev);
                  next.delete(key);
                  return next;
                });
              }
              setClusters((prev) => prev.filter((_, i) => i !== idx));
            }}
            onQueue={(name) => queueCluster(c, name)}
            queuedName={queued.get(c.items[0]?.id ?? '')}
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
        <TouchableOpacity onPress={onBack} disabled={busy}>
          <Text style={[styles.link, busy && { opacity: 0.4 }]}>← Retour</Text>
        </TouchableOpacity>
        <Text style={styles.titleSmall}>
          Tri IA ({
            provider === 'gemini'
              ? 'Gemini'
              : provider === 'gemini-paid'
              ? 'Gemini privee'
              : 'GPT-5 nano'
          })
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
            style={[
              styles.albumRow,
              selected && styles.albumRowSelected,
              busy && { opacity: 0.5 },
            ]}
            onPress={() => pickAlbum(al)}
            disabled={busy}
          >
            <Text style={styles.albumTitle}>{al.title}</Text>
            <Text style={styles.albumCount}>{al.assetCount} photo(s)</Text>
          </TouchableOpacity>
        );
      })}
      {busy && (
        <View style={styles.busyOverlay}>
          <ActivityIndicator size="large" color="#6c5ce7" />
          <Text style={styles.muted}>Chargement des photos...</Text>
        </View>
      )}
      {pickedAssets.length > 0 && (
        <View style={styles.summaryBox}>
          <Text style={styles.body}>
            {pickedAssets.length} photo(s) selectionnee(s)
          </Text>
          <Text style={styles.muted}>
            Sera envoye a {
              provider === 'gemini'
                ? 'Google Gemini (gratuit)'
                : provider === 'gemini-paid'
                ? 'Google Gemini (privee, billing actif)'
                : 'OpenAI GPT-5 nano'
            }
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
  onQueue,
  queuedName,
  busy,
}: {
  apiCluster: ApiCluster;
  index: number;
  albums: MediaLibrary.Album[];
  onSeeAll: () => void;
  onMove: (name: string) => void;
  onSkip: () => void;
  onQueue: (name: string) => void;
  queuedName?: string;
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
  // La banniere "IA propose : ..." est rendue dans ClusterCard (tappable +
  // selectable) via le prop suggestedName. initialName pre-remplit l'input.
  return (
    <ClusterCard
      cluster={cluster}
      index={index}
      albums={albums}
      onSeeAll={onSeeAll}
      onMove={onMove}
      onSkip={onSkip}
      busy={busy}
      initialName={apiCluster.suggestedName}
      suggestedName={apiCluster.suggestedName}
      onQueue={onQueue}
      queuedName={queuedName}
    />
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
  secondaryCancelBtn: {
    marginTop: 24,
    backgroundColor: '#252836',
    borderColor: '#3a3f55',
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 8,
  },
  secondaryCancelText: { color: '#e4e6f0', fontSize: 13, fontWeight: '600' },
  busyOverlay: {
    marginTop: 18,
    padding: 16,
    alignItems: 'center',
  },
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
    borderColor: '#3a3f55',
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
