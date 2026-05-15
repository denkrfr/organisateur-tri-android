/**
 * Modal "voir tout le contenu d'un cluster" avec checkboxes pour decocher
 * les intrus avant le deplacement.
 */

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
} from 'react-native';
import { Image } from 'expo-image';
import type { Cluster, ClusterItem } from './clustering';

interface Props {
  cluster: Cluster;
  onClose: () => void;
  onApply: (kept: ClusterItem[]) => void;
}

export default function ClusterContentsModal({ cluster, onClose, onApply }: Props) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(cluster.items.map((it) => it.id))
  );

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const checkAll = () => setChecked(new Set(cluster.items.map((it) => it.id)));
  const uncheckAll = () => setChecked(new Set());

  const apply = () => {
    const kept = cluster.items.filter((it) => checked.has(it.id));
    onApply(kept);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>
            Contenu du groupe ({cluster.items.length})
          </Text>
          <Text style={styles.subtitle}>
            Decoche les fichiers qui ne devraient pas etre dans ce groupe.
          </Text>
        </View>

        <View style={styles.quickActions}>
          <TouchableOpacity style={styles.smallBtn} onPress={checkAll}>
            <Text style={styles.smallBtnText}>Tout cocher</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.smallBtn} onPress={uncheckAll}>
            <Text style={styles.smallBtnText}>Tout decocher</Text>
          </TouchableOpacity>
          <Text style={styles.counter}>
            {checked.size} / {cluster.items.length}
          </Text>
        </View>

        <FlatList
          data={cluster.items}
          keyExtractor={(it) => it.id}
          numColumns={3}
          renderItem={({ item }) => {
            const isChecked = checked.has(item.id);
            return (
              <TouchableOpacity
                style={[styles.tile, isChecked ? styles.tileChecked : styles.tileUnchecked]}
                onPress={() => toggle(item.id)}
              >
                <Image source={{ uri: item.uri }} style={styles.tileImg} contentFit="cover" />
                {!isChecked && <View style={styles.tileOverlay} />}
                <View style={styles.checkBox}>
                  <Text style={styles.checkMark}>{isChecked ? '✓' : ''}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />

        <View style={styles.footer}>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>Annuler</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.okBtn} onPress={apply}>
            <Text style={styles.okText}>OK ({checked.size})</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f1117', paddingTop: 30 },
  header: { padding: 16 },
  title: { color: '#e4e6f0', fontSize: 18, fontWeight: '700' },
  subtitle: { color: '#8b8fa3', fontSize: 12, marginTop: 4 },
  quickActions: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingBottom: 8,
    alignItems: 'center',
    gap: 8,
  },
  smallBtn: {
    backgroundColor: '#252836',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  smallBtnText: { color: '#e4e6f0', fontSize: 11 },
  counter: { color: '#e4e6f0', marginLeft: 'auto' },
  tile: {
    flex: 1 / 3,
    aspectRatio: 1,
    margin: 2,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#1a1d27',
  },
  tileChecked: { borderWidth: 2, borderColor: '#6c5ce7' },
  tileUnchecked: { borderWidth: 1, borderColor: '#2e3244', opacity: 0.5 },
  tileImg: { width: '100%', height: '100%' },
  tileOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  checkBox: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(108, 92, 231, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkMark: { color: 'white', fontWeight: '800' },
  footer: {
    flexDirection: 'row',
    padding: 16,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#2e3244',
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    backgroundColor: '#252836',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#2e3244',
    alignItems: 'center',
  },
  cancelText: { color: '#e4e6f0', fontWeight: '600' },
  okBtn: {
    flex: 1,
    paddingVertical: 12,
    backgroundColor: '#6c5ce7',
    borderRadius: 6,
    alignItems: 'center',
  },
  okText: { color: 'white', fontWeight: '700' },
});
