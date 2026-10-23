# Qualité vidéo : l'échelle HLS multi-débit

## Le problème que ça règle

`indexer.ts` construisait un bon jeu d'arguments ffmpeg — résolution native,
`-preset veryfast -crf 22`, toutes les pistes audio — puis faisait `void args;`
et lançait à la place `simpleArgs` : `-preset ultrafast -crf 23 -vf scale=-2:720`,
une seule piste audio. **Tout MKV était donc regardé en 720p ultrafast** alors
que le propriétaire croyait être en qualité maximale.

Par ailleurs une seule qualité veut dire un seul débit : quand la ligne
algérienne faiblit, le lecteur ne peut que bufferiser, et les deux lecteurs se
désynchronisent.

## Ce qu'on produit maintenant

Un master multi-variantes, `1080p / 720p / 480p`, **sur la même timeline** :

```
<film>.hls/
  master.m3u8            <- les trois échelons + les pistes audio
  stream_1080p/index.m3u8, seg_00000.ts, ...
  stream_720p/...
  stream_480p/...
  stream_<lang>_<n>/...  <- une piste audio par langue, partagée par les échelons
  watchy.json            <- descripteur : durée, échelons, pistes audio
```

hls.js descend d'un échelon tout seul quand sa ligne faiblit, au lieu de
bufferiser, **sans que lui perde en qualité** — chacun est servi à son débit —
et **sans qu'ils se désynchronisent**, parce que les trois échelons partagent
exactement les mêmes frontières de segments.

C'est ce dernier point qui compte, et il ne s'obtient pas tout seul :

- un seul appel ffmpeg, donc un seul décodage et une seule timeline ;
- GOP fixé à `fps × 4` avec `-keyint_min` égal et `-sc_threshold 0`, donc pas
  d'image-clé posée sur un changement de plan ;
- `-force_key_frames expr:gte(t,n_forced*4)` sur chaque échelon ;
- `-hls_flags independent_segments`.

Vérification : les `#EXTINF` doivent être identiques d'un échelon à l'autre.

```
stream_1080p 4.000000 4.000000 4.000000 ...
stream_720p  4.000000 4.000000 4.000000 ...
stream_480p  4.000000 4.000000 4.000000 ...
```

L'échelle ne surclasse jamais : une source 720p donne 720p et 480p, pas un faux
1080p.

## Où encoder : sur votre machine, pas sur le VPS

Le CX22 a **2 vCPU et 40 Go de disque dont 22 libres**. Encoder trois variantes
d'un film de deux heures dessus prend des heures, entre en concurrence avec la
lecture en cours, et remplit le disque. Le VPS ne doit plus que **servir des
fichiers**.

```bash
# 1. sur votre PC — l'encodage, une fois
./scripts/transcode-hls.sh ~/films/Film.mkv

# 2. sur votre PC — l'envoi
WATCH_SSH=root@le-vps ./scripts/publish-hls.sh ~/films/Film.mkv --subs
```

Par défaut `publish-hls.sh` **n'envoie que le dossier `.hls`**, pas la source de
8 Go : l'échelle suffit à regarder le film, et sur 22 Go libres ça fait la
différence entre deux films et cinq. Ajoutez `--with-source` si vous voulez
quand même la copie d'origine sur le serveur.

Le serveur sait afficher un film livré ainsi, sans fichier vidéo à côté : il
apparaît au catalogue avec `hlsOnly: true`, ses pistes audio et sa durée lues
dans `watchy.json`. Seule `/api/stream/:id` (lecture octet par octet du fichier
source) renvoie 404 pour ces films — le client doit utiliser `hlsPath`.

`master.m3u8` est transféré **en dernier**, volontairement : tant qu'il n'est pas
là, le serveur ignore le dossier, donc on ne voit jamais un film à moitié
transféré dans le catalogue.

## L'encodage sur serveur, repli explicite

`POST /api/movies/:id/prepare` **refuse** désormais par défaut, avec un 409 qui
rappelle la marche à suivre. Pour forcer malgré tout :

```bash
curl -X PUT ... -d '{"force":true}'   # {"force":true,"preset":"veryfast","maxHeight":720}
```

C'est volontairement pénible : ça ne doit jamais redevenir le comportement par
défaut silencieux qui a fait regarder des films en 720p ultrafast pendant des
mois.

## Options

```
transcode-hls.sh <fichier> [--preset slow|veryfast] [--crf-mode]
                           [--max-height 720] [--out DIR] [--force]
publish-hls.sh   <fichier|dossier.hls> [--with-source] [--subs]
                           [--host user@vps] [--dry-run]
```

`--preset slow` donne la meilleure qualité par octet ; c'est le défaut, puisque
ça tourne sur votre machine et pas sur le VPS.
