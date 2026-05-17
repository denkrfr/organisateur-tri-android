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
  isModelDownloaded,
  downloadModel,
  loadVisionSession,
  isOnnxAvailable,
} from './models';
import { encodeImage } from './embeddings';
import { greedyCluster, type Cluster, type ClusterItem } from './clustering';
import ClusterCard from './ClusterCard';
import ClusterContentsModal from './ClusterContentsModal';
import SingletonGroupCard from './SingletonGroupCard';

interface TriScreenProps {
  onBack: () => void;
}

// Helper : formate proprement un message d'erreur en evitant "[object Object]"
// quand `e` est un objet brut sans `.message`.
function fmtError(e: any): string {
  if (e?.message && typeof e.message === 'string') return e.message;
  if (typeof e === 'string') return e;
  return 'Erreur inconnue';
}

// Nettoie un nom d'album : retire caracteres interdits Android pour noms de
// fichier/dossier, trim, cape a 100 chars. Si le resultat est vide, retourne
// "Sans nom" pour eviter de crasher createAlbumAsync.
function sanitizeAlbumName(name: string): string {
  const cleaned = name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'Sans nom';
}

type Phase = 'check_model' | 'no_onnx' | 'need_download' | 'downloading' | 'ready' | 'analyzing' | 'results';

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
  // 0.78 = sweet spot pour tri par theme (photos d'un voyage, paysages,
  // animaux). 0.88+ etait trop strict -> presque tout en singletons.
  const [threshold, setThreshold] = useState(0.78);
  const [openClusterIdx, setOpenClusterIdx] = useState<number | null>(null);
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Mode batch : firstItemId -> albumName cible (cf TriApiScreen pour la rationale)
  const [queued, setQueued] = useState<Map<string, string>>(new Map());
  // Cancellation : pour pouvoir interrompre une analyse longue (500 photos =
  // potentiellement 25 min). Sans ca, l'user qui appuie back perdait tout
  // ET un setState arrivait sur un composant unmount.
  const analysisCancelRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      analysisCancelRef.current = true;
    };
  }, []);

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

  // Garde l'ecran allume pendant les phases longues (DL modele + analyse
  // CLIP qui prend 2-5s par photo). Sans ca, Android peut tuer l'app si
  // l'user eteint l'ecran ou switch d'app, perdant tout l'avancement.
  useEffect(() => {
    if (phase === 'analyzing' || phase === 'downloading') {
      activateKeepAwakeAsync('tri-clip');
      return () => {
        deactivateKeepAwake('tri-clip');
      };
    }
  }, [phase]);

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
      Alert.alert('Erreur', fmtError(e));
      setPhase('need_download');
    }
  }, []);

  // Charge la liste des albums
  useEffect(() => {
    if (phase === 'ready') {
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
      Alert.alert('Erreur', fmtError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Annule l'analyse en cours et revient sur 'ready'. Marque aussi mountedRef
  // false pour stopper les setState orphelins.
  const cancelAnalysis = useCallback(() => {
    analysisCancelRef.current = true;
    if (mountedRef.current) setPhase('ready');
  }, []);

  // Lance l'analyse
  const startAnalysis = useCallback(async () => {
    if (pickedAssets.length === 0) {
      Alert.alert('Vide', 'Choisis au moins un album a analyser.');
      return;
    }
    analysisCancelRef.current = false;
    setPhase('analyzing');
    setAnalysisProgress(0);
    setAnalysisTotal(pickedAssets.length);

    const items: ClusterItem[] = [];
    for (let i = 0; i < pickedAssets.length; i++) {
      // Check cancellation a chaque iteration (user a tape "Annuler" ou back)
      if (analysisCancelRef.current || !mountedRef.current) return;
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
      if (analysisCancelRef.current || !mountedRef.current) return;
      const emb = await encodeImage(localUri);
      if (analysisCancelRef.current || !mountedRef.current) return;
      if (emb) {
        items.push({ id: a.id, uri: localUri, filename: a.filename, embedding: emb });
      }
      setAnalysisProgress(i + 1);
    }

    if (analysisCancelRef.current || !mountedRef.current) return;
    const groups = greedyCluster(items, threshold);
    if (!mountedRef.current) return;
    setClusters(groups);
    setPhase('results');
  }, [pickedAssets, threshold]);

  // Intercept hardware back :
  // - analyzing / downloading : Alert confirm (pas perdre 25 min de travail)
  // - autres phases (ready / results / no_onnx / need_download) : appeler
  //   onBack() pour revenir au TriModeScreen au lieu de quitter l'app
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase === 'analyzing' || phase === 'downloading') {
        Alert.alert(
          phase === 'analyzing' ? "Annuler l'analyse ?" : 'Annuler le telechargement ?',
          phase === 'analyzing'
            ? "L'avancement sera perdu (tu peux toujours relancer)."
            : 'Le modele ne sera pas telecharge.',
          [
            { text: 'Continuer', style: 'cancel' },
            {
              text: 'Annuler',
              style: 'destructive',
              onPress: () => {
                if (phase === 'analyzing') cancelAnalysis();
                else setPhase('need_download');
              },
            },
          ]
        );
        return true;
      }
      // Pour les phases passives, back hardware = back logiciel
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [phase, cancelAnalysis, onBack]);

  // Action : creer un album + y deplacer les fichiers d'un cluster
  const moveClusterToAlbum = useCallback(
    async (cluster: Cluster, albumName: string) => {
      const clean = sanitizeAlbumName(albumName);
      if (!albumName.trim() || clean === 'Sans nom') {
        Alert.alert('Nom requis', "Tape un nom d'album valide avant de creer.");
        return;
      }
      setBusy(true);
      try {
        const assetIds = cluster.items.map((it) => it.id);
        const fakeAssets = assetIds.map((id) => ({ id } as MediaLibrary.Asset));
        // Cree l'album avec le 1er asset, puis ajoute le reste
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
        // Retire le cluster de la liste
        setClusters((prev) => prev.filter((c) => c !== cluster));
      } catch (e: any) {
        Alert.alert('Erreur', fmtError(e));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  // Ajoute / met a jour un cluster dans la file d'attente
  const queueCluster = useCallback((cluster: Cluster, albumName: string) => {
    const key = cluster.items[0]?.id;
    const clean = sanitizeAlbumName(albumName);
    if (!key || !albumName.trim() || clean === 'Sans nom') return;
    setQueued((prev) => {
      const next = new Map(prev);
      next.set(key, clean);
      return next;
    });
  }, []);

  // Vider la file avec confirmation (destructif, peut faire perdre 30 noms
  // tapes a la main).
  const clearQueueWithConfirm = useCallback(() => {
    if (queued.size === 0) return;
    Alert.alert(
      'Vider la file ?',
      `Tu vas perdre les ${queued.size} groupe(s) prepares (noms d'album et associations).`,
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

  // Flush : groupe tous les clusters en file PAR ALBUM CIBLE (insensible
  // casse/accents), puis fait 1-2 appels MediaLibrary par album unique
  // (au lieu de 1-2 par cluster). Resultat : si 5 clusters vont dans
  // "Voyage Japon" (meme avec casse differente), 1 popup Android au
  // lieu de 5-10.
  const flushAll = useCallback(async () => {
    if (queued.size === 0) return;
    setBusy(true);

    // Normalisation insensible casse/accents pour la cle de groupage.
    // displayName = premier nom rencontre (garde sa casse pour l'API).
    const normalize = (s: string) =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const byAlbum = new Map<
      string,
      { items: ClusterItem[]; firstIds: string[]; displayName: string }
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
        errors.push({ name: entry.displayName, msg: fmtError(e) });
      }
    }

    // Guard mountedRef : si l'user back navigates pendant flushAll, on evite
    // les setState orphelins et l'Alert qui apparait apres unmount.
    if (!mountedRef.current) return;
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

  // Deplace TOUTES les photos isolees (clusters d'1 element) dans un meme
  // album d'un coup. Permet a l'user d'eviter 100 cartes/100 taps quand le
  // clustering ne trouve pas de groupes evidents.
  const moveAllSingletons = useCallback(
    async (albumName: string) => {
      const clean = sanitizeAlbumName(albumName);
      if (!albumName.trim() || clean === 'Sans nom') {
        Alert.alert('Nom requis', "Tape un nom d'album valide avant de creer.");
        return;
      }
      const singletonClusters = clusters.filter((c) => c.items.length === 1);
      const items = singletonClusters.flatMap((c) => c.items);
      if (items.length === 0) return;
      setBusy(true);
      try {
        const assetIds = items.map((it) => it.id);
        const fakeAssets = assetIds.map((id) => ({ id } as MediaLibrary.Asset));
        const existing = await MediaLibrary.getAlbumAsync(clean);
        let album: MediaLibrary.Album;
        if (existing) {
          album = existing;
          await MediaLibrary.addAssetsToAlbumAsync(fakeAssets as any, album, false);
        } else {
          album = await MediaLibrary.createAlbumAsync(clean, fakeAssets[0] as any, false);
          if (fakeAssets.length > 1) {
            await MediaLibrary.addAssetsToAlbumAsync(
              fakeAssets.slice(1) as any,
              album,
              false
            );
          }
        }
        Alert.alert('Album cree', `${items.length} photo(s) ajoutee(s) a "${clean}".`);
        setClusters((prev) => prev.filter((c) => c.items.length >= 2));
        // Cleanup defensif de queued (les singletons n'y sont normalement pas
        // mais si l'user a tape "+File" sur un, retirer la cle)
        setQueued((prev) => {
          if (prev.size === 0) return prev;
          const next = new Map(prev);
          for (const c of singletonClusters) {
            const key = c.items[0]?.id;
            if (key) next.delete(key);
          }
          return next;
        });
      } catch (e: any) {
        Alert.alert('Erreur', fmtError(e));
      } finally {
        setBusy(false);
      }
    },
    [clusters]
  );

  const skipAllSingletons = useCallback(() => {
    setClusters((prev) => prev.filter((c) => c.items.length >= 2));
    setQueued((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const c of clusters) {
        if (c.items.length === 1) {
          const key = c.items[0]?.id;
          if (key) next.delete(key);
        }
      }
      return next;
    });
  }, [clusters]);

  // Re-cluster TOUS les items courants avec un seuil reduit de 0.05 (min 0.65).
  // Vide la file (les firstId changent potentiellement). Si la file n'est
  // pas vide, on demande confirmation pour pas que ca disparaisse en silence.
  const reclusterMoreLoose = useCallback(() => {
    const doRecluster = () => {
      const allItems = clusters.flatMap((c) => c.items);
      if (allItems.length === 0) return;
      const newThreshold = Math.max(0.65, threshold - 0.05);
      setThreshold(newThreshold);
      setClusters(greedyCluster(allItems, newThreshold));
      setQueued(new Map());
    };
    if (queued.size > 0) {
      Alert.alert(
        'Vider la file ?',
        `Re-grouper va vider ta file de ${queued.size} groupe(s) en attente (les groupes vont changer). Continuer ?`,
        [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Continuer', style: 'destructive', onPress: doRecluster },
        ]
      );
    } else {
      doRecluster();
    }
  }, [clusters, threshold, queued]);

  // Retire des items d'un cluster (via modal contenu).
  // Migre la cle dans "queued" (firstItemId -> albumName) si items[0] change,
  // sinon l'entree devient orpheline (badge "en file" disparait visuellement).
  const updateClusterItems = useCallback((idx: number, kept: ClusterItem[]) => {
    let oldFirstId: string | undefined;
    let newFirstId: string | undefined;
    setClusters((prev) => {
      const cur = prev[idx];
      if (!cur) return prev;
      const next = [...prev];
      oldFirstId = cur.items[0]?.id;
      newFirstId = kept[0]?.id;
      if (kept.length === 0) {
        next.splice(idx, 1);
      } else {
        next[idx] = { items: kept };
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
        <TouchableOpacity
          style={[styles.secondaryCancelBtn]}
          onPress={() => {
            Alert.alert(
              "Annuler l'analyse ?",
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
        {(() => {
          // Split multi vs singletons : les singletons sont regroupes dans
          // UNE seule carte speciale (SingletonGroupCard) en bas de la liste,
          // pour eviter 100 cartes/taps quand CLIP ne trouve pas de groupes.
          const multi = clusters
            .map((c, idx) => ({ c, idx }))
            .filter(({ c }) => c.items.length >= 2);
          const singletonItems = clusters
            .filter((c) => c.items.length === 1)
            .flatMap((c) => c.items);
          if (multi.length === 0 && singletonItems.length === 0) {
            return (
              <Text style={styles.body}>
                Aucun groupe forme. Recommence avec d'autres images.
              </Text>
            );
          }
          return (
            <>
              {multi.map(({ c, idx }, multiIdx) => (
                <ClusterCard
                  key={c.items[0]?.id ?? idx}
                  cluster={c}
                  index={multiIdx + 1}
                  albums={albums}
                  onSeeAll={() => setOpenClusterIdx(idx)}
                  onMove={(name) => moveClusterToAlbum(c, name)}
                  onSkip={() => {
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
              {singletonItems.length > 0 && (
                <SingletonGroupCard
                  items={singletonItems}
                  albums={albums}
                  onMoveAll={moveAllSingletons}
                  onSkipAll={skipAllSingletons}
                  onRecluster={threshold > 0.65 ? reclusterMoreLoose : undefined}
                  busy={busy}
                />
              )}
            </>
          );
        })()}
        {openClusterIdx !== null && clusters[openClusterIdx] && (
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

  // phase === 'ready'
  return (
    <ScrollView style={styles.screen}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={onBack} disabled={busy}>
          <Text style={[styles.link, busy && { opacity: 0.4 }]}>← Retour</Text>
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
            style={[
              styles.albumRow,
              selected && styles.albumRowSelected,
              busy && { opacity: 0.5 },
            ]}
            onPress={() => pickAlbum(al)}
            disabled={busy}
          >
            <Text style={styles.albumTitle} numberOfLines={1}>{al.title}</Text>
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
            Sensibilite du regroupement : {Math.round(threshold * 100)}%
          </Text>
          <View style={styles.thresholdRow}>
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => setThreshold((t) => Math.max(0.65, t - 0.02))}
              disabled={busy}
            >
              <Text style={styles.smallBtnText}>- permissif</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => setThreshold((t) => Math.min(0.95, t + 0.02))}
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
