# Doublons photos — App Android (Expo)

Détecte les doublons exacts (et triples, et plus) dans la galerie photo +
vidéo d'un téléphone Android. **100% local**. Pour usage personnel.

## Stack
- Expo SDK 51 + React Native + TypeScript
- expo-media-library (scan galerie)
- expo-file-system (lecture bytes pour hash)
- expo-crypto (SHA256 natif)
- expo-image (vignettes performantes)

## Pré-requis sur le PC
- Node.js 18+ : https://nodejs.org/
- npm (livré avec Node)

## Installation (1re fois)

```bash
cd organisateur-android
npm install
```

(quelques minutes, ~400 Mo de node_modules)

## Tester en mode dev sur ton tel (Expo Go)

1. Sur le Samsung A35, installe **Expo Go** depuis le Play Store
2. Connecte le tel et le PC sur le même WiFi
3. Dans le terminal : `npx expo start`
4. Scanne le QR code affiché avec Expo Go
5. L'app se lance sur ton tel via Expo Go (modifications en hot reload)

⚠️ **En Expo Go**, le dialog Android de suppression dira "Expo Go" et non
"Doublons photos". Une fois en APK, ce sera bien le nom de l'app.

## Build APK (pour utilisation autonome)

```bash
npx eas-cli login                              # avec ton compte Expo Dev
npx eas-cli build -p android --profile preview # ~10-15 min en cloud
```

EAS donne ensuite une URL — ouvre-la sur ton tel, télécharge l'APK,
autorise "Sources inconnues" pour ton navigateur, installe.

## Les 5 écrans

### 1. Permission (1er lancement)
Demande l'accès aux médias via dialog Android natif.

### 2. Accueil
- Toggle "Inclure les vidéos" (ON par défaut)
- Bouton "Scanner ma galerie"
- Lien "Corbeille (N)" si des fichiers sont en attente

### 3. Scan
- Phase 1 : récupération de la liste (~5-15 s pour 10k fichiers)
- Phase 2 : hash parallélisé par batchs de 8 (~2-3 min pour 10k)
- Bouton Annuler

### 4. Résultats
- Liste des groupes (2, 3, 4+ copies) triés par espace récupérable
- Le **+ gros** marqué automatiquement, sélection multi-coche
- "Tout cocher sauf le + gros" (raccourci utile)
- Bouton **Vers corbeille** : envoie la sélection vers la corbeille interne

### 5. Corbeille
**Aucun fichier n'est supprimé du téléphone tant que tu ne valides pas ici.**

- Liste de tous les fichiers marqués pour suppression
- Multi-sélection
- **Restaurer** : retire de la corbeille (le fichier reste intact sur le tel)
- **Supprimer définitivement** : passe par MediaLibrary.deleteAssetsAsync
  - Dialog système Android demande confirmation
  - Fichiers vont à la corbeille de l'app Galerie Samsung
  - Récupérables 30 jours via Galerie → Corbeille

## Triple filet de sécurité

```
Sélection dans Résultats   → corbeille INTERNE de l'app   (aucune action OS)
Confirmation Corbeille     → corbeille SYSTÈME Android    (récupérable 30j)
30 jours sans restoration  → effacement DÉFINITIF         (perdu)
```

## Algorithme

**Quick-hash** : SHA256(16 premiers Ko + 16 derniers Ko + taille en hex)
- Très rapide (lit ~32 Ko par fichier au lieu du fichier entier)
- Zéro collision en pratique sur des photos réelles
- Parallélisé par batchs de 8 → ~3x plus rapide qu'en séquentiel
- Pour 10 000 photos sur un Samsung A35 : ~2-3 minutes

## Privacy

- **Pas de réseau** : INTERNET, NETWORK_STATE bloqués au niveau du manifest Android
- **Pas de tracking** : aucun SDK analytics/crash
- **Pas de stockage** : tout en RAM, rien dans une DB ou des shared prefs
- **Pas de logs externes** : aucun fichier d'audit n'est écrit
- **Updates OTA Expo désactivés** : `expo-updates` ne pingera jamais leurs serveurs

## Permissions Android

**Demandées :**
- `READ_MEDIA_IMAGES` (Android 13+)
- `READ_MEDIA_VIDEO` (Android 13+)
- `READ_EXTERNAL_STORAGE` (legacy, Android 12-)

**Bloquées explicitement** (sinon ajoutées par défaut par Expo) :
- `INTERNET`, `ACCESS_NETWORK_STATE`
- `CAMERA`, `RECORD_AUDIO`
- `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`
- `SYSTEM_ALERT_WINDOW`, `WAKE_LOCK`

## Limites V1 connues

- ❌ Pas de quasi-doublons (pHash) — exact uniquement
- ❌ Pas d'icône custom (utilise icône Expo générique)
- ❌ Pas de splash screen custom
- ❌ La corbeille interne n'est PAS persistée si tu fermes l'app (volontaire pour V1)

## Structure

```
organisateur-android/
├── App.tsx              → tout le code de l'app (5 écrans + logique)
├── package.json         → deps Expo SDK 51
├── app.json             → permissions Android + blocages réseau
├── eas.json             → profile preview (APK)
├── tsconfig.json        → strict TS
├── babel.config.js
└── README.md
```
