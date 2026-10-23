# Contrat de synchronisation — chantier 2026-08

**Ce fichier fait autorité.** Le serveur et le client sont écrits par deux agents distincts,
en parallèle. Tout ce qui traverse le WebSocket est défini ici et **ne se négocie pas**.
Si tu penses qu'une décision de ce document est mauvaise, applique-la quand même et signale-le
dans ton rapport final.

## Frontières de propriété — à respecter strictement

- **Agent SERVEUR** : `apps/server/**`, `scripts/**`. Ne touche à rien dans `apps/web/`.
- **Agent CLIENT** : `apps/web/**`. Ne touche à rien dans `apps/server/`.
- Ce fichier (`docs/PROTOCOLE-SYNC.md`) est en **lecture seule** pour les deux.

## Messages client → serveur

```ts
| { type: "hello"; username: string }
| { type: "join"; movieId: string }
| { type: "leave" }
| { type: "play"; mediaTime: number }
| { type: "pause"; mediaTime: number }
| { type: "seek"; mediaTime: number; playing: boolean }
| { type: "heartbeat"; mediaTime: number; playing: boolean }
| { type: "reload" }
| { type: "reaction"; emoji: string }
| { type: "stall"; stalled: boolean }            // NOUVEAU — mise en tampon
| { type: "ready"; ready: boolean }              // NOUVEAU — décompte
| { type: "away"; away: boolean; reason?: string } // NOUVEAU — « je reviens »
```

## Messages serveur → client

```ts
type PeerInfo = {
  name: string;
  watching: string | null;   // movieId, ou null si dans le catalogue
  stalled: boolean;
  ready: boolean;
  away: boolean;
  awayReason?: string;
};

| { type: "state"; state: SyncState; serverNow: number; peers: PeerInfo[] }
| { type: "peers"; peers: PeerInfo[] }
| { type: "countdown"; startsAt: number; movieId: string }  // NOUVEAU
| { type: "reload" }
| { type: "reaction"; emoji: string; from: string; at: number }
| { type: "error"; message: string }
```

**Changement cassant assumé** : `peers` passe de `string[]` à `PeerInfo[]`. Les deux côtés
changent ensemble, il n'y a pas de compatibilité ascendante à maintenir — il y a deux
utilisateurs et un seul déploiement.

`SyncState` est inchangé.

## Règles de synchronisation

**Serveur — rediffusion périodique.** Un `setInterval` de **4 s** appelle `broadcastState()`
tant qu'au moins un pair a `watching !== null`. C'est la correction de dérive : sans elle,
rien ne réaligne les lecteurs entre deux clics. L'intervalle doit être arrêté proprement
quand la salle se vide (pas de timer qui fuit).

**Serveur — progression.** `persistProgress()` est appelé depuis le `heartbeat`, **throttlé à
15 s** par film. Aujourd'hui il n'est appelé que sur play/pause/seek, donc 50 minutes de
lecture ininterrompue ne sont jamais écrites.

**Client — correction de dérive.** À chaque `state` reçu, calculer la position attendue en
compensant la latence avec `serverNow`. Puis, en valeur absolue :

| Dérive | Action |
|---|---|
| < 0,3 s | ne rien faire |
| 0,3 s à 2,5 s | `video.playbackRate = 1.02` (en retard) ou `0.98` (en avance), jusqu'à revenir sous 0,15 s, puis `1.0` |
| ≥ 2,5 s | `video.currentTime =` — saut assumé |

Ne jamais laisser `playbackRate` bloqué ailleurs qu'à `1.0` : le remettre à 1 dès que l'écart
est résorbé, à la pause, au seek, et au démontage du composant.

**Client — badge de synchro.** Le badge doit refléter la **dérive réelle mesurée**, jamais une
valeur en dur. Trois états : synchronisé (< 0,3 s), rattrapage en cours, désynchronisé (≥ 2,5 s).
Aujourd'hui `Player.tsx` écrit `data-state="synced"` en dur : c'est un mensonge à supprimer.

**Mise en tampon.** Le client envoie `stall: true` sur `onWaiting` et `stall: false` sur
`onPlaying`. Le serveur le propage dans `PeerInfo.stalled`. Le client affiche l'état du pair
(« Elle charge… »). **Ne mets pas en pause automatiquement** — signale seulement ; la pause
automatique sur une connexion instable rendrait le film inregardable.

## Décompte de démarrage

1. Chacun clique « Prêt ? » → `{type:"ready", ready:true}`.
2. Quand tous les pairs qui regardent ce film sont prêts, le serveur émet
   `{type:"countdown", startsAt: <epoch ms, environ 3 s dans le futur>, movieId}`.
3. Chaque client décompte jusqu'à `startsAt` (en compensant avec `serverNow`) puis lance.
4. Le serveur remet les `ready` à faux après le démarrage.

Le clic sur « Prêt ? » est aussi l'**activation utilisateur** dont le navigateur a besoin pour
autoriser la lecture. Si `video.play()` échoue malgré tout, le client doit afficher un message
explicite — jamais `.catch(() => undefined)`, qui laisse aujourd'hui une image figée sans
explication.

## Branche et commits

Tout se passe sur la branche `chantier/2026-08`, déjà créée. Committe par lot cohérent, en
français, à l'impératif, sans emoji. **Ne pousse rien, ne déploie rien, ne touche pas au VPS.**

Commence par les correctifs courts et committe-les **avant** d'attaquer les gros chantiers :
si le reste dérape, les gains rapides sont déjà acquis.
