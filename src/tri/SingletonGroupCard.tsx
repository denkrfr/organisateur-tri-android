/**
 * Carte unique qui regroupe toutes les photos "isolees" (clusters d'un seul
 * element) apres un tri CLIP. Sans elle, l'user devait gerer 100 cartes a la
 * main quand le clustering ne trouvait pas de groupes evidents (ex: 140
 * paysages varies du Japon).
 *
 * Actions bulk :
 *  - "Creer album X et deplacer les N photos" : un seul tap pour tout
 *  - "↻ Regrouper plus large" : relance le clustering avec un seuil -0.05
 *    (jusqu'a un minimum). Pratique si l'user veut decouvrir des groupes plus
 *    larges sans toucher au slider manuellement.
 *  - "Ignorer tout" : retire toutes les singletons des resultats
 *
 * Reutilise le pattern autocomplete d'albums de ClusterCard (match insensible
 * casse/accents, suggestions top N).
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
import type { ClusterItem } from './clustering';

interface Props {
  items: ClusterItem[];
  albums: MediaLibrary.Album[];
  onMoveAll: (albumName: string) => void;
  onSkipAll: () => void;
  // Optionnel : si fourni, affiche un bouton "Regrouper plus large" qui
  // relance le clustering avec un seuil reduit. Le parent gere le state.
  onRecluster?: () => void;
  busy: boolean;
}

const MAX_SHOW = 8;
const MAX_SUGGESTIONS = 5;

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export default function SingletonGroupCard({
  items,
  albums,
  onMoveAll,
  onSkipAll,
  onRecluster,
  busy,
}: Props) {
  const [name, setName] = useState('');
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const visible = expanded ? items : items.slice(0, MAX_SHOW);
  const remaining = items.length - MAX_SHOW;

  const trimmed = name.trim();
  const normalizedTyped = normalize(trimmed);
  const exactMatch = trimmed
    ? albums.find((a) => normalize(a.title) === normalizedTyped) ?? null
    : null;
  const matchingAlbums = trimmed
    ? albums
        .filter((a) => normalize(a.title).includes(normalizedTyped))
        .slice(0, MAX_SUGGESTIONS)
    : albums.slice(0, MAX_SUGGESTIONS);
  const showSuggestions = focused && matchingAlbums.length > 0;
  const targetName = exactMatch?.title ?? trimmed;
  const canAct = trimmed.length > 0;
  const willAdd = !!exactMatch;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.icon}>📸</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {items.length} photo{items.length > 1 ? 's' : ''} isolee{items.length > 1 ? 's' : ''}
          </Text>
          <Text style={styles.subtitle}>
            {items.length > 1
              ? "Aucun groupe similaire trouve. Tu peux toutes les deplacer dans un meme album d'un coup, regrouper plus large pour decouvrir des groupes, ou les ignorer."
              : "Cette photo n'a trouve aucune similaire. Donne-lui un album, regrouper plus large pourra t'aider, ou ignore-la."}
          </Text>
        </View>
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
        {!expanded && remaining > 0 && (
          <TouchableOpacity style={styles.moreBtn} onPress={() => setExpanded(true)}>
            <Text style={styles.moreText}>+{remaining}</Text>
            <Text style={styles.moreSubText}>voir tout</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      <TextInput
        style={styles.input}
        placeholder="Nom d'album pour toutes (ex: Divers, A trier, Voyage Japon...)"
        placeholderTextColor="#5a5e70"
        value={name}
        onChangeText={setName}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        editable={!busy}
        autoCapitalize="words"
      />

      {showSuggestions && (
        <View style={styles.suggestions}>
          {!trimmed && (
            <Text style={styles.suggestionsHint}>Tes albums (tap pour reutiliser)</Text>
          )}
          {matchingAlbums.map((a) => {
            const isMatch = !!trimmed && normalize(a.title) === normalizedTyped;
            return (
              <TouchableOpacity
                key={a.id}
                style={[styles.suggestionRow, isMatch && styles.suggestionRowMatch]}
                onPress={() => {
                  setName(a.title);
                  setFocused(false);
                }}
              >
                <Text style={[styles.suggestionText, isMatch && styles.suggestionTextMatch]}>
                  {isMatch ? '✓ ' : ''}{a.title}
                </Text>
                <Text style={styles.suggestionCount}>{a.assetCount}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <TouchableOpacity
        style={[
          styles.primaryBtn,
          (!canAct || busy) && styles.btnDisabled,
          canAct && willAdd && styles.btnAddExisting,
        ]}
        onPress={() => onMoveAll(targetName)}
        disabled={!canAct || busy}
      >
        <Text style={styles.primaryBtnText} numberOfLines={2}>
          {!canAct
            ? "Tape un nom d'album"
            : willAdd
            ? `Ajouter les ${items.length} photos a "${exactMatch!.title}"`
            : `Creer "${trimmed}" et deplacer les ${items.length} photos`}
        </Text>
      </TouchableOpacity>

      <View style={styles.actionsRow}>
        {onRecluster && (
          <TouchableOpacity
            style={[styles.secondaryBtn, busy && styles.btnDisabled]}
            onPress={onRecluster}
            disabled={busy}
          >
            <Text style={styles.secondaryBtnText}>↻ Regrouper plus large</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.secondaryBtn, busy && styles.btnDisabled]}
          onPress={onSkipAll}
          disabled={busy}
        >
          <Text style={styles.secondaryBtnText}>Ignorer tout</Text>
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
    borderColor: '#ffd43b',
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8, gap: 8 },
  icon: { fontSize: 22 },
  title: { color: '#ffd43b', fontSize: 15, fontWeight: '800' },
  subtitle: { color: '#8b8fa3', fontSize: 12, marginTop: 2, lineHeight: 16 },
  thumbs: { marginVertical: 8 },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: 4,
    marginRight: 5,
    backgroundColor: '#252836',
  },
  moreBtn: {
    width: 60,
    height: 60,
    borderRadius: 4,
    backgroundColor: '#252836',
    borderWidth: 1,
    borderColor: '#ffd43b',
    justifyContent: 'center',
    alignItems: 'center',
  },
  moreText: { color: '#e4e6f0', fontWeight: '700', fontSize: 13 },
  moreSubText: { color: '#ffd43b', fontSize: 9 },
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
  suggestionsHint: {
    color: '#8b8fa3',
    fontSize: 10,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 2,
    fontStyle: 'italic',
  },
  suggestionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  suggestionRowMatch: { backgroundColor: 'rgba(0, 184, 148, 0.15)' },
  suggestionText: { color: '#e4e6f0' },
  suggestionTextMatch: { color: '#00b894', fontWeight: '700' },
  suggestionCount: { color: '#8b8fa3', fontSize: 12 },
  primaryBtn: {
    backgroundColor: '#6c5ce7',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: {
    color: 'white',
    fontWeight: '700',
    fontSize: 13,
    textAlign: 'center',
  },
  btnAddExisting: { backgroundColor: '#00b894' },
  btnDisabled: { opacity: 0.4 },
  actionsRow: { flexDirection: 'row', gap: 6, marginTop: 6 },
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#252836',
    paddingVertical: 9,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#3a3f55',
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#e4e6f0', fontSize: 12, fontWeight: '600' },
});
