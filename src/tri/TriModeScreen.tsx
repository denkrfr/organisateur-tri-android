/**
 * Ecran de choix du mode de tri :
 *   - Local (CLIP) : 100% offline, lent, regroupe par ressemblance visuelle
 *   - IA cloud    : photos envoyees a Google ou OpenAI, rapide, regroupe
 *                    par theme et propose des noms d'albums
 *
 * Tap sur "Reset cle API" supprime la config IA cloud (utile pour changer
 * de provider ou de cle).
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import {
  getConfiguredProvider,
  deleteApiKey,
  type ProviderId,
} from './apiTri/keyStore';

interface Props {
  onChooseLocal: () => void;
  onChooseApi: () => void;
  onBack: () => void;
}

export default function TriModeScreen({ onChooseLocal, onChooseApi, onBack }: Props) {
  const [configuredProvider, setConfiguredProvider] = useState<ProviderId | null>(null);

  useEffect(() => {
    (async () => {
      const p = await getConfiguredProvider();
      setConfiguredProvider(p);
    })();
  }, []);

  const resetApi = async () => {
    Alert.alert(
      'Reset cle API',
      'Cela supprime la cle stockee. Tu devras la re-configurer la prochaine fois que tu utilises le mode IA cloud.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            if (configuredProvider) {
              await deleteApiKey(configuredProvider);
              setConfiguredProvider(null);
            }
          },
        },
      ]
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.link}>← Retour</Text>
        </TouchableOpacity>
        <Text style={styles.titleSmall}>Tri par ressemblance</Text>
      </View>
      <Text style={styles.body}>
        Choisis comment tu veux trier tes photos.
      </Text>

      <TouchableOpacity style={styles.modeCard} onPress={onChooseLocal}>
        <View style={styles.modeHeader}>
          <Text style={styles.modeIcon}>🔒</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeTitle}>Mode local (CLIP)</Text>
            <Text style={styles.tag}>100% PRIVE</Text>
          </View>
        </View>
        <Text style={styles.modeDesc}>
          Aucune photo ne quitte ton telephone. Un modele IA (~85 Mo) telecharge une
          fois, tourne sur le CPU.{'\n\n'}
          Regroupe par ressemblance visuelle (memes couleurs, formes, scenes).
          C'est lent (2-5 sec par photo) mais 100% offline ensuite.
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.modeCard, styles.modeCardApi]} onPress={onChooseApi}>
        <View style={styles.modeHeader}>
          <Text style={styles.modeIcon}>☁️</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeTitle}>Mode IA cloud</Text>
            <Text style={styles.tagApi}>RAPIDE & MALIN</Text>
          </View>
        </View>
        <Text style={styles.modeDesc}>
          Tes photos sont envoyees a Google Gemini ou OpenAI GPT-5 nano pour analyse.
          {'\n\n'}
          Regroupe par theme (plage, repas, captures de cours, animaux, etc.) et te
          propose un nom d'album pour chaque groupe. Beaucoup plus rapide et precis,
          mais tes photos quittent le telephone.
        </Text>
        {configuredProvider && (
          <Text style={styles.providerNote}>
            ✓ Configure : {configuredProvider === 'gemini' ? 'Google Gemini' : 'OpenAI GPT-5 nano'}
          </Text>
        )}
      </TouchableOpacity>

      {configuredProvider && (
        <TouchableOpacity style={styles.resetBtn} onPress={resetApi}>
          <Text style={styles.resetBtnText}>Reset cle API (mode IA cloud)</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0f1117' },
  scrollContent: { padding: 16, paddingTop: 40 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  titleSmall: { color: '#e4e6f0', fontSize: 16, fontWeight: '700' },
  link: { color: '#a29bfe', fontSize: 14, fontWeight: '600' },
  body: { color: '#e4e6f0', fontSize: 14, marginBottom: 16, lineHeight: 20 },
  modeCard: {
    backgroundColor: '#1a1d27',
    borderRadius: 10,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#2e3244',
  },
  modeCardApi: {
    borderColor: '#6c5ce7',
  },
  modeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  modeIcon: { fontSize: 28, marginRight: 12 },
  modeTitle: { color: '#e4e6f0', fontSize: 17, fontWeight: '700', marginBottom: 2 },
  tag: { color: '#00b894', fontSize: 11, fontWeight: '700' },
  tagApi: { color: '#a29bfe', fontSize: 11, fontWeight: '700' },
  modeDesc: { color: '#e4e6f0', fontSize: 13, lineHeight: 19 },
  providerNote: {
    color: '#00b894',
    fontSize: 12,
    marginTop: 10,
    fontWeight: '600',
  },
  resetBtn: {
    marginTop: 18,
    alignSelf: 'center',
    padding: 10,
  },
  resetBtnText: {
    color: '#8b8fa3',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
});
