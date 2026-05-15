/**
 * Greedy clustering par similarite cosinus (port direct de la version PC).
 *
 * Pour chaque embedding non assigne :
 *   - en faire le centre d'un nouveau cluster
 *   - y ajouter tous les autres embeddings >= threshold de similarite
 *   - les marquer comme utilises
 *
 * Output trie par taille decroissante (gros groupes utiles en premier).
 */

import { cosineSim } from './embeddings';

export interface ClusterItem {
  id: string;
  uri: string;
  filename: string;
  embedding: Float32Array;
}

export interface Cluster {
  items: ClusterItem[];
}

export function greedyCluster(
  items: ClusterItem[],
  threshold: number = 0.88
): Cluster[] {
  const clusters: Cluster[] = [];
  const used = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (used.has(it.id)) continue;
    const cluster: ClusterItem[] = [it];
    used.add(it.id);

    for (let j = i + 1; j < items.length; j++) {
      const other = items[j];
      if (used.has(other.id)) continue;
      const sim = cosineSim(it.embedding, other.embedding);
      if (sim >= threshold) {
        cluster.push(other);
        used.add(other.id);
      }
    }
    clusters.push({ items: cluster });
  }

  // Tri par taille decroissante
  clusters.sort((a, b) => b.items.length - a.items.length);
  return clusters;
}
