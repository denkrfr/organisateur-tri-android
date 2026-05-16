/**
 * Setup initial du mode IA cloud :
 *   1. Disclosure privacy (les photos vont sortir du tel)
 *   2. Choisir provider (Gemini gratuit OU Claude payant)
 *   3. Coller la cle API
 *   4. Stocker chiffre dans Android Keystore via expo-secure-store
 *
 * Affiche aussi le lien vers la page de creation de cle de chaque provider.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Linking,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { saveApiKey, saveSelectedProvider, type ProviderId } from './keyStore';

interface Props {
  onDone: (provider: ProviderId) => void;
  onBack: () => void;
}

type Step = 'disclosure' | 'provider' | 'key';

const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';
const CLAUDE_KEY_URL = 'https://console.anthropic.com/settings/keys';
const GEMINI_PRIVACY = 'https://ai.google.dev/gemini-api/terms';
const CLAUDE_PRIVACY = 'https://www.anthropic.com/legal/privacy';

export default function SetupScreen({ onDone, onBack }: Props) {
  const [step, setStep] = useState<Step>('disclosure');
  const [provider, setProvider] = useState<ProviderId>('gemini');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      Alert.alert('Cle vide', 'Colle ta cle API avant de continuer.');
      return;
    }
    setSaving(true);
    try {
      await saveApiKey(provider, apiKey.trim());
      await saveSelectedProvider(provider);
      onDone(provider);
    } catch (e: any) {
      Alert.alert('Erreur stockage', e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  if (step === 'disclosure') {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Mode IA cloud</Text>
        <Text style={styles.body}>
          Cette option utilise un service d'IA en ligne (Google Gemini ou Anthropic Claude)
          pour trier tes photos par theme. Le tri est plus rapide et plus precis qu'avec
          le mode local, et l'IA propose elle-meme des noms d'albums.
        </Text>
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>⚠️ Important sur la confidentialite</Text>
          <Text style={styles.warningBody}>
            En utilisant ce mode, tes photos seront envoyees a Google ou Anthropic
            pour analyse. Elles ne sont pas stockees durablement par ces services
            (selon leurs politiques) mais elles quittent ton telephone.
          </Text>
          <Text style={styles.warningBody}>
            Pour rester 100% offline, retourne au mode local (CLIP).
          </Text>
        </View>
        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={onBack}>
            <Text style={styles.secondaryBtnText}>Retour</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setStep('provider')}>
            <Text style={styles.primaryBtnText}>J'accepte, continuer</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  if (step === 'provider') {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Choisis ton fournisseur</Text>

        <TouchableOpacity
          style={[styles.providerCard, provider === 'gemini' && styles.providerCardSelected]}
          onPress={() => setProvider('gemini')}
        >
          <Text style={styles.providerTitle}>Google Gemini Flash</Text>
          <Text style={styles.providerTag}>GRATUIT</Text>
          <Text style={styles.providerDesc}>
            Quota gratuit : 15 requetes/min, 1500/jour. Pour 200 photos ≈ 1 min d'analyse.
            Cle creee gratuitement sur Google AI Studio.
          </Text>
          <TouchableOpacity onPress={() => Linking.openURL(GEMINI_PRIVACY)}>
            <Text style={styles.linkText}>Confidentialite Gemini ↗</Text>
          </TouchableOpacity>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.providerCard, provider === 'claude' && styles.providerCardSelected]}
          onPress={() => setProvider('claude')}
        >
          <Text style={styles.providerTitle}>Anthropic Claude Haiku</Text>
          <Text style={styles.providerTagPaid}>PAYANT ~0,60$ / 200 photos</Text>
          <Text style={styles.providerDesc}>
            Pas de quota gratuit. Compte Anthropic avec credits (a recharger une fois).
            Qualite de regroupement excellente, descriptions tres precises.
          </Text>
          <TouchableOpacity onPress={() => Linking.openURL(CLAUDE_PRIVACY)}>
            <Text style={styles.linkText}>Confidentialite Claude ↗</Text>
          </TouchableOpacity>
        </TouchableOpacity>

        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setStep('disclosure')}>
            <Text style={styles.secondaryBtnText}>Retour</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setStep('key')}>
            <Text style={styles.primaryBtnText}>Choisir {provider === 'gemini' ? 'Gemini' : 'Claude'}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // step === 'key'
  const keyUrl = provider === 'gemini' ? GEMINI_KEY_URL : CLAUDE_KEY_URL;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Cle API {provider === 'gemini' ? 'Gemini' : 'Claude'}</Text>
      <Text style={styles.body}>
        1. Va sur la page de creation de cle de {provider === 'gemini' ? 'Google AI Studio' : 'Anthropic Console'}.
        {'\n'}2. Cree une cle (gratuit pour Gemini, compte Anthropic pour Claude).
        {'\n'}3. Copie-la et colle-la ci-dessous.
      </Text>
      <TouchableOpacity onPress={() => Linking.openURL(keyUrl)}>
        <Text style={styles.linkText}>Ouvrir la page de creation de cle ↗</Text>
      </TouchableOpacity>
      <Text style={styles.label}>Cle API (collee depuis la page) :</Text>
      <TextInput
        style={styles.keyInput}
        value={apiKey}
        onChangeText={setApiKey}
        placeholder={provider === 'gemini' ? 'AIza...' : 'sk-ant-...'}
        placeholderTextColor="#5a5e70"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving}
      />
      <Text style={styles.helpText}>
        La cle est chiffree dans le coffre-fort Android (Keystore) via expo-secure-store.
        Seule cette app peut la lire. Tu peux la supprimer plus tard depuis les parametres.
      </Text>
      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => setStep('provider')} disabled={saving}>
          <Text style={styles.secondaryBtnText}>Retour</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.primaryBtn} onPress={handleSave} disabled={saving}>
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.primaryBtnText}>Enregistrer et continuer</Text>}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0f1117' },
  scrollContent: { padding: 20, paddingTop: 40 },
  title: { color: '#e4e6f0', fontSize: 22, fontWeight: '800', marginBottom: 12 },
  body: { color: '#e4e6f0', fontSize: 14, lineHeight: 20, marginBottom: 14 },
  warning: {
    backgroundColor: 'rgba(255, 212, 59, 0.1)',
    borderColor: '#ffd43b',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginVertical: 14,
  },
  warningTitle: { color: '#ffd43b', fontWeight: '700', marginBottom: 8 },
  warningBody: { color: '#e4e6f0', fontSize: 13, lineHeight: 19, marginBottom: 6 },
  providerCard: {
    backgroundColor: '#1a1d27',
    borderColor: '#2e3244',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
  },
  providerCardSelected: {
    borderColor: '#6c5ce7',
    borderWidth: 2,
  },
  providerTitle: { color: '#e4e6f0', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  providerTag: { color: '#00b894', fontSize: 12, fontWeight: '700', marginBottom: 6 },
  providerTagPaid: { color: '#ffd43b', fontSize: 12, fontWeight: '700', marginBottom: 6 },
  providerDesc: { color: '#8b8fa3', fontSize: 13, lineHeight: 18, marginBottom: 6 },
  linkText: { color: '#a29bfe', fontSize: 13, marginTop: 4, marginBottom: 4 },
  label: { color: '#e4e6f0', fontSize: 13, marginTop: 14, marginBottom: 6, fontWeight: '600' },
  keyInput: {
    backgroundColor: '#252836',
    color: '#e4e6f0',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#2e3244',
    fontFamily: 'monospace',
  },
  helpText: { color: '#5a5e70', fontSize: 11, marginTop: 8, lineHeight: 16, fontStyle: 'italic' },
  actionsRow: { flexDirection: 'row', gap: 10, marginTop: 22 },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#6c5ce7',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  secondaryBtn: {
    backgroundColor: '#252836',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2e3244',
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#e4e6f0', fontSize: 14 },
});
