/**
 * Setup initial du mode IA cloud :
 *   1. Disclosure privacy (les photos vont sortir du tel)
 *   2. Choisir provider (Gemini gratuit OU OpenAI GPT-5 nano payant)
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
const GEMINI_BILLING_URL = 'https://ai.google.dev/gemini-api/docs/billing';
const OPENAI_KEY_URL = 'https://platform.openai.com/api-keys';
const GEMINI_PRIVACY = 'https://ai.google.dev/gemini-api/terms';
const OPENAI_PRIVACY = 'https://openai.com/policies/api-data-usage-policies';

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
          Cette option utilise un service d'IA en ligne (Google Gemini ou OpenAI GPT-5 nano)
          pour trier tes photos par theme. Le tri est plus rapide et plus precis qu'avec
          le mode local, et l'IA propose elle-meme des noms d'albums.
        </Text>
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>⚠️ Important sur la confidentialite</Text>
          <Text style={styles.warningBody}>
            En utilisant ce mode, tes photos seront envoyees a Google ou OpenAI
            pour analyse. Selon le fournisseur et le tier choisi, elles peuvent
            etre utilisees pour entrainer les modeles (notamment sur le tier
            gratuit de Gemini).
          </Text>
          <Text style={styles.warningBody}>
            👉 Lis TOUJOURS les conditions d'utilisation du fournisseur avant
            d'envoyer tes donnees. Les liens sont fournis sur chaque carte
            a l'etape suivante.
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
            Cle creee gratuitement sur Google AI Studio.{'\n\n'}
            ⚠️ Tier gratuit : selon les conditions Google, tes photos peuvent etre
            utilisees pour entrainer leurs modeles.
          </Text>
          <TouchableOpacity onPress={() => Linking.openURL(GEMINI_PRIVACY)}>
            <Text style={styles.linkText}>📖 Lire les conditions Gemini ↗</Text>
          </TouchableOpacity>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.providerCard, provider === 'gemini-paid' && styles.providerCardSelected]}
          onPress={() => setProvider('gemini-paid')}
        >
          <Text style={styles.providerTitle}>Google Gemini Flash (privee)</Text>
          <Text style={styles.providerTagPrivacy}>PRIVE — BILLING ACTIVE</Text>
          <Text style={styles.providerDesc}>
            Meme API que le tier gratuit, mais SI tu as active le billing sur ton
            projet Google Cloud, Google s'engage a NE PAS utiliser tes photos
            pour entrainer ses modeles.{'\n\n'}
            En pratique tu paies souvent 0$ tant que tu restes sous le quota
            gratuit, mais tu beneficies de la politique privacy du tier paye.
            A toi de verifier que ton projet a bien le billing actif.
          </Text>
          <TouchableOpacity onPress={() => Linking.openURL(GEMINI_BILLING_URL)}>
            <Text style={styles.linkText}>💳 Activer le billing Google Cloud ↗</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Linking.openURL(GEMINI_PRIVACY)}>
            <Text style={styles.linkText}>📖 Lire les conditions Gemini ↗</Text>
          </TouchableOpacity>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.providerCard, provider === 'openai' && styles.providerCardSelected]}
          onPress={() => setProvider('openai')}
        >
          <Text style={styles.providerTitle}>OpenAI GPT-5 nano</Text>
          <Text style={styles.providerTagPaid}>PAYANT ~0,05$ / 1000 photos</Text>
          <Text style={styles.providerDesc}>
            Le modele le moins cher d'OpenAI avec vision integree. Tres bonne qualite
            de regroupement par theme, lecture de scenes precise. A choisir quand tu
            depasses le quota Gemini gratuit.{'\n\n'}
            Politique API d'OpenAI : tes photos ne sont pas utilisees pour entrainer
            leurs modeles par defaut. Compte OpenAI avec credits requis (5$ minimum
            a recharger une fois, dure des mois pour un usage perso).
          </Text>
          <TouchableOpacity onPress={() => Linking.openURL(OPENAI_PRIVACY)}>
            <Text style={styles.linkText}>📖 Lire les conditions OpenAI ↗</Text>
          </TouchableOpacity>
        </TouchableOpacity>

        <Text style={styles.helpText}>
          Rappel : lis toujours les conditions du fournisseur avant d'envoyer tes
          photos. Les liens ci-dessus pointent vers la doc officielle.
        </Text>

        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setStep('disclosure')}>
            <Text style={styles.secondaryBtnText}>Retour</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setStep('key')}>
            <Text style={styles.primaryBtnText}>
              Choisir {provider === 'gemini'
                ? 'Gemini'
                : provider === 'gemini-paid'
                ? 'Gemini (privee)'
                : 'GPT-5 nano'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // step === 'key'
  // 'gemini' et 'gemini-paid' utilisent la meme URL de creation de cle :
  // c'est Google AI Studio dans les deux cas. Le billing s'active separement
  // dans Google Cloud Console.
  const isGemini = provider === 'gemini' || provider === 'gemini-paid';
  const keyUrl = isGemini ? GEMINI_KEY_URL : OPENAI_KEY_URL;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>
        Cle API {isGemini ? 'Gemini' : 'OpenAI'}
        {provider === 'gemini-paid' ? ' (privee)' : ''}
      </Text>
      <Text style={styles.body}>
        1. Va sur la page de creation de cle de {isGemini ? 'Google AI Studio' : 'OpenAI Platform'}.
        {'\n'}2. Cree une cle (gratuit pour Gemini, compte OpenAI avec credits pour GPT-5 nano).
        {'\n'}3. Copie-la et colle-la ci-dessous.
        {provider === 'gemini-paid' &&
          "\n4. IMPORTANT : verifie aussi que le billing est active sur ton projet Google Cloud (sinon, c'est le tier gratuit qui s'applique cote privacy)."}
      </Text>
      <TouchableOpacity onPress={() => Linking.openURL(keyUrl)}>
        <Text style={styles.linkText}>Ouvrir la page de creation de cle ↗</Text>
      </TouchableOpacity>
      {provider === 'gemini-paid' && (
        <TouchableOpacity onPress={() => Linking.openURL(GEMINI_BILLING_URL)}>
          <Text style={styles.linkText}>💳 Doc Google sur l'activation du billing ↗</Text>
        </TouchableOpacity>
      )}
      <Text style={styles.label}>Cle API (collee depuis la page) :</Text>
      <TextInput
        style={styles.keyInput}
        value={apiKey}
        onChangeText={setApiKey}
        placeholder={isGemini ? 'AIza...' : 'sk-...'}
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
  providerTagPrivacy: { color: '#74b9ff', fontSize: 12, fontWeight: '700', marginBottom: 6 },
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
