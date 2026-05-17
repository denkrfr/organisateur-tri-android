/**
 * Adapters Gemini & OpenAI GPT-5 nano pour le tri par IA.
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

// Wrapper fetch avec timeout et propagation d'un signal externe (pour
// cancellation cote UI). Timeout par defaut 90s : un batch de 20 images
// peut prendre 30-60s legitimement, surtout sur reseau faible. AbortError
// se distingue par error.name === 'AbortError'.
async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number; externalSignal?: AbortSignal }
): Promise<Response> {
  const { timeoutMs = 90000, externalSignal, ...init } = options;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Si le signal externe est aborte, propager au notre.
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function callGemini(
  apiKey: string,
  imagesB64: string[],
  signal?: AbortSignal
): Promise<LlmResponse> {
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
  const res = await fetchWithTimeout(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    externalSignal: signal,
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
// OpenAI (GPT-5 nano) via Chat Completions
// ============================================================================
// gpt-5-nano : modele le moins cher d'OpenAI avec vision native (~$0.20/M
// input, $1.25/M output). Pour notre use case (classification + JSON court)
// avec detail:'low' on tombe a ~$0.05 / 1000 photos.
const OPENAI_MODEL = 'gpt-5-nano';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(
  apiKey: string,
  imagesB64: string[],
  signal?: AbortSignal
): Promise<LlmResponse> {
  // Format Chat Completions vision : content = array de parts mixtes.
  // detail:'low' divise par ~10 les tokens vision sans degrader la
  // classification de groupes (pas besoin d'OCR fin pour clusteriser).
  const content: any[] = [{ type: 'text', text: PROMPT_FR }];
  for (const b64 of imagesB64) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${b64}`,
        detail: 'low',
      },
    });
  }

  const body = {
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content }],
    // Mode JSON : oblige la reponse a etre du JSON parseable. Necessite que
    // le prompt contienne le mot "JSON" — c'est le cas dans PROMPT_FR.
    response_format: { type: 'json_object' },
    // GPT-5 series utilise max_completion_tokens (et non max_tokens).
    max_completion_tokens: 2048,
  };

  const res = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    externalSignal: signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status} : ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  // Chat Completions : choices[0].message.content (string)
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(text);
  if (!parsed) throw new Error('OpenAI : reponse JSON invalide');
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
 *
 * Le signal optionnel permet d'annuler l'analyse (cancellation via UI) :
 * on check entre chaque batch, et on le passe a fetchWithTimeout pour
 * couper la requete en cours.
 */
export async function analyzeWithApi(
  provider: ProviderId,
  apiKey: string,
  items: ApiClusterItem[],
  onProgress: ProviderProgress,
  signal?: AbortSignal
): Promise<ApiCluster[]> {
  const totalBatches = Math.ceil(items.length / BATCH_SIZE);
  const merged = new Map<string, ApiCluster>();

  for (let b = 0; b < totalBatches; b++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const start = b * BATCH_SIZE;
    const batch = items.slice(start, start + BATCH_SIZE);

    onProgress(b, totalBatches, `Preparation lot ${b + 1}/${totalBatches}...`);
    // Prepare les images en parallele. PARA=3 sur Android : chaque
    // manipulateAsync decode l'image originale en bitmap natif (potentiellement
    // 50MB JPEG) puis re-encode -> 8 simultanes = jusqu'a 400MB de bitmaps
    // vivants en RAM = OOM sur appareils 4GB.
    const b64s: (string | null)[] = new Array(batch.length).fill(null);
    const PARA = 3;
    for (let i = 0; i < batch.length; i += PARA) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
      // 'gemini' et 'gemini-paid' utilisent le meme code (meme API, meme modele,
      // meme endpoint). La distinction est uniquement declarative cote user :
      // 'gemini-paid' indique que son projet GCP a le billing active.
      llm = provider === 'openai'
        ? await callOpenAI(apiKey, validB64, signal)
        : await callGemini(apiKey, validB64, signal);
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
