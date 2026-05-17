/**
 * Adapters Gemini & Claude pour le tri par IA.
 *
 * Contrat : recoit un lot d'images (uri locale), renvoie des clusters
 * thematiques avec un nom suggere par l'IA.
 *
 * Strategie de batching :
 *   - Resize chaque image en 1024px max + JPEG quality 70
 *   - Encode en base64
 *   - Envoie BATCH_SIZE images par requete, demande un regroupement JSON
 *   - Apres tous les batches : merge clusters dont le nom est equivalent
 *     (normalisation case+accent insensible).
 *
 * Format JSON attendu de l'IA :
 *   { "groups": [ { "name": "...", "indices": [0, 2, 5] }, ... ] }
 *
 * Les indices sont relatifs au batch courant.
 */

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import type { ProviderId } from './keyStore';

export const BATCH_SIZE = 20;

export interface ApiClusterItem {
  id: string;
  uri: string;
  filename: string;
}

export interface ApiCluster {
  items: ApiClusterItem[];
  suggestedName: string;
}

export interface ProviderProgress {
  (batchIdx: number, totalBatches: number, label: string): void;
}

const PROMPT_FR = `Tu reçois plusieurs photos. Regroupe-les par thème ou sujet similaire (plage, repas, capture d'écran de cours, animal de compagnie, événement, document, etc.).

Règles :
- Une photo appartient à un seul groupe.
- Donne à chaque groupe un nom court et descriptif en français (3 mots max, sans guillemets).
- Une photo isolée (sans similaire) peut former son propre groupe.
- N'invente pas de noms vagues comme "Divers" ou "Autres", essaie d'être spécifique au contenu.

Réponds STRICTEMENT en JSON, rien d'autre, format :
{"groups":[{"name":"...","indices":[0,2,5]},{"name":"...","indices":[1,3]}]}

Les indices correspondent à l'ordre des photos reçues (0-indexé).`;

interface LlmGroup {
  name: string;
  indices: number[];
}

interface LlmResponse {
  groups: LlmGroup[];
}

/**
 * Prepare une image : resize + JPEG + base64. Renvoie null si echec.
 */
async function prepImage(uri: string): Promise<string | null> {
  try {
    const r = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1024 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    return r.base64 ?? null;
  } catch {
    return null;
  }
}

function extractJson(text: string): LlmResponse | null {
  // Les LLMs aiment encadrer le JSON de ```json ... ``` ou de baratin. On extrait.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  // Trouve la 1ere accolade ouvrante et la derniere fermante
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!parsed || !Array.isArray(parsed.groups)) return null;
    return parsed as LlmResponse;
  } catch {
    return null;
  }
}

// ============================================================================
// Gemini (Google AI Studio)
// ============================================================================
// gemini-2.5-flash : stable GA, multimodal, free tier 15 RPM.
// (gemini-2.0-flash-exp etait experimental et a ete retire par Google -> 404.)
const GEMINI_MODEL = 'gemini-2.5-flash';
// La cle est passee via le header X-goog-api-key plutot que dans la query
// string : evite qu'elle apparaisse dans d'eventuels logs intermediaires
// (proxies d'entreprise avec inspection TLS, outils de monitoring, etc.)
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function callGemini(apiKey: string, imagesB64: string[]): Promise<LlmResponse> {
  const parts: any[] = [{ text: PROMPT_FR }];
  for (const b64 of imagesB64) {
    parts.push({
      inline_data: { mime_type: 'image/jpeg', data: b64 },
    });
  }
  const body = {
    contents: [{ parts }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.2,
    },
  };
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status} : ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const parsed = extractJson(text);
  if (!parsed) throw new Error('Gemini : reponse JSON invalide');
  return parsed;
}

// ============================================================================
// Claude (Anthropic)
// ============================================================================
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

async function callClaude(apiKey: string, imagesB64: string[]): Promise<LlmResponse> {
  const content: any[] = [];
  for (const b64 of imagesB64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
    });
  }
  content.push({ type: 'text', text: PROMPT_FR });

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content }],
  };
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Claude ${res.status} : ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  // Claude renvoie content: [{type: "text", text: "..."}]
  const text: string = data?.content?.[0]?.text ?? '';
  const parsed = extractJson(text);
  if (!parsed) throw new Error('Claude : reponse JSON invalide');
  return parsed;
}

// ============================================================================
// Pipeline principal
// ============================================================================
function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Analyse N items via l'API selectionnee. Renvoie des clusters fusionnes.
 */
export async function analyzeWithApi(
  provider: ProviderId,
  apiKey: string,
  items: ApiClusterItem[],
  onProgress: ProviderProgress
): Promise<ApiCluster[]> {
  const totalBatches = Math.ceil(items.length / BATCH_SIZE);
  // Map "nom normalise" -> ApiCluster (pour fusion entre batches)
  const merged = new Map<string, ApiCluster>();

  for (let b = 0; b < totalBatches; b++) {
    const start = b * BATCH_SIZE;
    const batch = items.slice(start, start + BATCH_SIZE);

    onProgress(b, totalBatches, `Preparation lot ${b + 1}/${totalBatches}...`);
    // Prepare les images en parallele (8 a la fois pour ne pas exploser la RAM)
    const b64s: (string | null)[] = new Array(batch.length).fill(null);
    const PARA = 8;
    for (let i = 0; i < batch.length; i += PARA) {
      const slice = batch.slice(i, i + PARA);
      const results = await Promise.all(slice.map((it) => prepImage(it.uri)));
      for (let j = 0; j < results.length; j++) b64s[i + j] = results[j];
    }

    // Filtre les images qui n'ont pas pu etre encodees
    const validIdx: number[] = [];
    const validB64: string[] = [];
    for (let i = 0; i < b64s.length; i++) {
      if (b64s[i]) {
        validIdx.push(i);
        validB64.push(b64s[i]!);
      }
    }
    if (validB64.length === 0) continue;

    onProgress(b, totalBatches, `Envoi lot ${b + 1}/${totalBatches} (${validB64.length} photos)...`);
    let llm: LlmResponse;
    try {
      llm = provider === 'gemini'
        ? await callGemini(apiKey, validB64)
        : await callClaude(apiKey, validB64);
    } catch (e: any) {
      // On laisse remonter l'erreur pour que l'UI puisse la gerer (cle invalide, quota, etc.)
      throw e;
    }

    // Reporte les indices LLM (0..validB64.length-1) -> indices dans le batch
    for (const g of llm.groups) {
      const norm = normalizeName(g.name);
      if (!norm) continue;
      const groupItems: ApiClusterItem[] = [];
      for (const llmIdx of g.indices) {
        if (typeof llmIdx !== 'number' || llmIdx < 0 || llmIdx >= validIdx.length) continue;
        const batchIdx = validIdx[llmIdx];
        groupItems.push(batch[batchIdx]);
      }
      if (groupItems.length === 0) continue;

      const existing = merged.get(norm);
      if (existing) {
        existing.items.push(...groupItems);
      } else {
        merged.set(norm, { items: groupItems, suggestedName: g.name.trim() });
      }
    }
  }

  // Tri : clusters les plus gros en premier
  return Array.from(merged.values()).sort((a, b) => b.items.length - a.items.length);
}
