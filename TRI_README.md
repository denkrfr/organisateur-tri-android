# Tri par ressemblance (mobile) - Guide d'installation

## Ce qui a été ajouté

Le nouveau bouton **"Tri par ressemblance (IA)"** sur l'écran d'accueil. Il ouvre
un écran qui :

1. Télécharge un modèle ONNX CLIP au 1er lancement (~85 Mo, depuis HuggingFace)
2. Permet de choisir un album à analyser
3. Calcule un embedding visuel pour chaque photo
4. Regroupe les photos similaires
5. Pour chaque groupe : créer un nouvel album Android et y déplacer les photos

**Tout est calculé localement après le téléchargement initial. Aucune donnée
ne quitte le téléphone.**

## Code ajouté (rien n'a été cassé dans le dedup existant)

- `src/tri/png.ts` — décodeur PNG isolé
- `src/tri/models.ts` — download + cache + load ONNX
- `src/tri/embeddings.ts` — pipeline CLIP vision
- `src/tri/clustering.ts` — algo greedy cosinus
- `src/tri/TriScreen.tsx` — écran principal
- `src/tri/ClusterCard.tsx` — 1 carte de groupe
- `src/tri/ClusterContentsModal.tsx` — voir/décocher le contenu d'un groupe

Modifications dans `App.tsx` :
- 1 import en haut
- 1 valeur ajoutée au type `Screen`
- 1 if pour render `TriScreen`
- 1 prop `onOpenTri` au `HomeScreen`
- 1 bouton vert "Tri par ressemblance"
- 1 style `triBtn`

## Installation

```bash
cd "C:\Users\USER\Downloads\orgaisateur mobile"
npm install
```

`onnxruntime-react-native` est ajouté à package.json.

## Build de développement (premier setup)

`onnxruntime-react-native` est une lib native custom — **Expo Go classique ne
suffit pas**. Il faut un Development Build via EAS.

```bash
# Une fois pour set up EAS (si tu l'as pas déjà)
npm install -g eas-cli
eas login
eas build:configure   # si pas déjà fait

# Build l'APK dev (cloud, 10-15 min)
eas build --profile development --platform android
```

EAS te donne un lien pour télécharger l'APK dev. Installe-le sur ton téléphone
(autorise les sources inconnues, etc.).

Ensuite :

```bash
npx expo start --dev-client
```

→ scanne le QR avec l'APK dev → hot-reload comme Expo Go classique.

## Build de production (pour distribuer aux amis)

```bash
eas build --profile production --platform android
```

EAS te donne un APK production à partager. Tes amis l'installent (autoriser
sources inconnues), c'est tout.

## Notes techniques

- **Premier lancement de la fonction Tri** : il télécharge ~85 Mo depuis
  HuggingFace. Une fois fait, tout marche offline.
- **Perf** : ~2-5 secondes par photo sur CPU ARM moderne. Pour 200 photos =
  ~10 minutes. Optimisable plus tard avec NNAPI delegate.
- **L'app garde le dedup existant intact**. Les 2 features coexistent.

## Si tu veux désactiver le tri (juste pour tester)

Commente la ligne `if (screen === 'tri') { ... }` dans `App.tsx`. Le bouton
restera visible mais ne fera rien. Pour le cacher complètement, commente aussi
le bloc `<TouchableOpacity style={styles.triBtn} ...>` dans `HomeScreen`.

## Si quelque chose plante

- Vérifie que le téléphone a au moins ~200 Mo de stockage libre pour le modèle
- Vérifie la permission MediaLibrary (galerie)
- Si l'app crash au premier lancement après install d'APK dev : `npx expo start
  --dev-client --clear` pour vider le cache Metro
