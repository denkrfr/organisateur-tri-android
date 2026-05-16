/**
 * Stockage chiffre des cles API utilisateur via Android Keystore (expo-secure-store).
 *
 * Les cles ne quittent jamais le telephone, sont chiffrees au repos, et sont
 * accessibles seulement par notre app (UID Linux Android).
 */

import * as SecureStore from 'expo-secure-store';

export type ProviderId = 'gemini' | 'claude';

const KEY_PREFIX = 'tri_api_';
const PROVIDER_KEY = 'tri_provider';

export async function saveApiKey(provider: ProviderId, key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_PREFIX + provider, key);
}

export async function loadApiKey(provider: ProviderId): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_PREFIX + provider);
  } catch {
    return null;
  }
}

export async function deleteApiKey(provider: ProviderId): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY_PREFIX + provider);
  } catch {
    // ignore
  }
}

export async function saveSelectedProvider(provider: ProviderId): Promise<void> {
  await SecureStore.setItemAsync(PROVIDER_KEY, provider);
}

export async function loadSelectedProvider(): Promise<ProviderId | null> {
  try {
    const v = await SecureStore.getItemAsync(PROVIDER_KEY);
    if (v === 'gemini' || v === 'claude') return v;
    return null;
  } catch {
    return null;
  }
}

/**
 * Verifie si un provider est configure (cle presente).
 * Renvoie le provider selectionne s'il a une cle, sinon null.
 */
export async function getConfiguredProvider(): Promise<ProviderId | null> {
  const selected = await loadSelectedProvider();
  if (!selected) return null;
  const key = await loadApiKey(selected);
  return key ? selected : null;
}
