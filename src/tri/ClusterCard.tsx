/**
 * Carte visuelle d'un groupe (cluster) dans l'ecran Tri.
 * Affiche jusqu'a 6 thumbnails + bouton "Voir tout" si plus, input nom + actions.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import type { Cluster } from './clustering';

interface Props {
  cluster: Cluster;
  index: number;
  albums: MediaLibrary.Album[];
  onSeeAll: () => void;
  onMove: (albumName: string) => void;
  onSkip: () => void;
  busy: boolean;
}

const MAX_SHOW = 6;

export default function ClusterCard({
  cluster,
  index,
  albums,
  onSeeAll,
  onMove,
  onSkip,
  busy,
}: Props) {
  const [name, setName] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const visible = cluster.items.slice(0, MAX_SHOW);
  const remaining = cluster.items.length - visible.length;

  // Auto-completion : albums existants qui matchent
  const matchingAlbums = name
    ? albums
        .filter((a) => a.title.toLowerCase().includes(name.toLowerCase()))
        .slice(0, 4)
    : [];

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{index}</Text>
        </View>
        <Text style={styles.infoText}>
          {cluster.items.length} fichier{cluster.items.length > 1 ? 's' : ''}
        </Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbs}>
        {visible.map((it) => (
          <Image
            key={it.id}
            source={{ uri: it.uri }}
            style={styles.thumb}
            contentFit="cover"
          />
        ))}
        {remaining > 0 && (
          <TouchableOpacity style={styles.moreBtn} onPress={onSeeAll}>
            <Text style={styles.moreText}>+{remaining}</Text>
            <Text style={styles.moreSubText}>voir tout</Text>
          </TouchableOpacity>
        )}
        {remaining === 0 && cluster.items.length > 1 && (
          <TouchableOpacity style={styles.moreBtnSecondary} onPress={onSeeAll}>
            <Text style={styles.moreSubText}>Voir tout</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      <TextInput
        style={styles.input}
        placeholder="Nom de l'album (ex: skyvision, Plage...)"
        placeholderTextColor="#5a5e70"
        value={name}
        onChangeText={(t) => {
          setName(t);
          setShowSuggestions(t.length >= 1);
        }}
        editable={!busy}
        autoCapitalize="none"
      />

      {showSuggestions && matchingAlbums.length > 0 && (
        <View style={styles.suggestions}>
          {matchingAlbums.map((a) => (
            <TouchableOpacity
              key={a.id}
              style={styles.suggestionRow}
              onPress={() => {
                setName(a.title);
                setShowSuggestions(false);
              }}
            >
              <Text style={styles.suggestionText}>{a.title}</Text>
              <Text style={styles.suggestionCount}>{a.assetCount}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={[styles.btn, busy && styles.btnDisabled]}
          onPress={() => onMove(name)}
          disabled={busy}
        >
          <Text style={styles.btnText}>Creer album et deplacer</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipBtn} onPress={onSkip} disabled={busy}>
          <Text style={styles.skipText}>Ignorer</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1a1d27',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  badge: {
    backgroundColor: '#6c5ce7',
    width: 28,
    height: 28,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  badgeText: { color: 'white', fontWeight: '800', fontSize: 13 },
  infoText: { color: '#e4e6f0', fontWeight: '600' },
  thumbs: { marginVertical: 8 },
  thumb: {
    width: 70,
    height: 70,
    borderRadius: 4,
    marginRight: 6,
    backgroundColor: '#252836',
  },
  moreBtn: {
    width: 70,
    height: 70,
    borderRadius: 4,
    backgroundColor: '#252836',
    borderWidth: 1,
    borderColor: '#6c5ce7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  moreBtnSecondary: {
    width: 70,
    height: 70,
    borderRadius: 4,
    backgroundColor: '#252836',
    borderWidth: 1,
    borderColor: '#2e3244',
    justifyContent: 'center',
    alignItems: 'center',
  },
  moreText: { color: '#e4e6f0', fontWeight: '700', fontSize: 14 },
  moreSubText: { color: '#a29bfe', fontSize: 10 },
  input: {
    backgroundColor: '#252836',
    color: '#e4e6f0',
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#2e3244',
    marginTop: 4,
  },
  suggestions: {
    backgroundColor: '#252836',
    borderRadius: 4,
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  suggestionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  suggestionText: { color: '#e4e6f0' },
  suggestionCount: { color: '#8b8fa3', fontSize: 12 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: {
    flex: 1,
    backgroundColor: '#6c5ce7',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: 'white', fontWeight: '700' },
  skipBtn: {
    backgroundColor: '#252836',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  skipText: { color: '#e4e6f0' },
});
