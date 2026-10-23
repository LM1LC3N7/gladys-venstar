# Venstar

Intégration non officielle pour les thermostats Wi-Fi **Venstar ColorTouch et
Explorer**, par l'API locale documentée du thermostat, sur votre propre
réseau. Pas de cloud, pas de compte.

**Jamais testé avec un vrai appareil** : elle suit la documentation publique
de l'API et la bibliothèque venstarcolortouch (utilisée par Home Assistant).
Sans lien avec Venstar.

## Ce que vous obtenez

Un appareil Gladys pour le thermostat, avec :

- la température de la pièce, l'humidité intérieure (si le thermostat la
  mesure) et la température extérieure (si une sonde extérieure est câblée) ;
- la consigne de chauffage et la consigne de climatisation ;
- le mode : arrêt, chauffage, climatisation, auto (seulement les modes que le
  thermostat propose) ;
- la ventilation : auto ou toujours en marche, et si elle tourne ;
- le fonctionnement (en attente, chauffe, refroidit) et un texte d'état (aussi
  verrouillé et erreur) ;
- les alertes : l'alerte du filtre à air en valeur 0/1, et la liste des
  alertes actives (filtre à air, lampe UV, entretien).

Les températures sont dans l'unité du thermostat (°C ou °F) au moment où
l'appareil est ajouté ; les valeurs sont toujours converties dans l'unité de
chaque fonctionnalité telle qu'elle a été créée.

## Configuration

1. Sur le thermostat, activez l'**API locale** dans ses réglages Wi-Fi.
2. Dans votre routeur, donnez au thermostat une **adresse IP fixe**. L'appareil
   Gladys suit cette adresse : si elle change, un nouvel appareil apparaît.
3. Dans l'onglet **Configuration** de l'intégration, saisissez l'adresse et
   enregistrez. Le thermostat est lu aussitôt (puis toutes les minutes par
   défaut) et apparaît dans l'onglet **Découverte** : ajoutez-le.

Si le **« Basic Auth »** du thermostat est activé, activez **HTTPS** et
saisissez son nom d'utilisateur et son mot de passe. Le mot de passe est
gardé par Gladys dans sa base, jamais réaffiché, et envoyé seulement au
thermostat en HTTPS : jamais en HTTP simple. À la première connexion HTTPS, le
certificat du thermostat (auto-signé) est épinglé (son empreinte SHA-256
gardée dans `/data`) ; s'il change ensuite, plus rien n'est envoyé et l'état
affiche la nouvelle empreinte. Si vous avez remplacé ou réinitialisé le
thermostat, cliquez deux fois sur **Accepter le changement** (le premier clic
affiche ce qui sera accepté, le second dans les 60 s accepte exactement
celui-ci).

Si l'écran du thermostat est verrouillé par un **code PIN**, saisissez-le : il
est envoyé avec chaque commande (dans le corps de la requête, jamais dans
l'adresse). Sans HTTPS, le code PIN circule **en clair** sur votre réseau
local. Un code refusé par le thermostat n'est plus envoyé pour les commandes
de mise en marche, de consigne et de ventilation tant que vous ne le changez
pas (un arrêt l'essaie quand même).

## Commandes

**Désactivées par défaut.** Activez **Autoriser les commandes** pour que
Gladys puisse changer le mode, la ventilation et les consignes. Alors :

- une commande est décidée sur une lecture fraîche du thermostat, jamais sur
  une valeur en mémoire, et refusée si une valeur nécessaire est inconnue ;
- les consignes sont refusées (jamais ramenées dans la plage) hors chauffage
  5 à 30 °C (41 à 86 °F) et climatisation 16 à 35 °C (61 à 95 °F), et hors
  des limites du thermostat ; en mode auto, la consigne de climatisation doit
  rester au moins de l'écart du thermostat au-dessus de celle de chauffage ;
  l'autre consigne est réécrite exactement telle que lue ;
- une commande de consigne ou de mode est refusée tant qu'une commande de
  consigne précédente n'est pas confirmée (l'API exige les deux consignes :
  l'ancienne valeur serait réécrite par-dessus) ; réessayez quelques secondes
  plus tard ;
- une commande est écrite dans les 3,5 s qui suivent le clic, ou refusée sans
  être envoyée ; elle n'est confirmée que si le thermostat affiche la valeur
  demandée, sinon Gladys indique « envoyée, sans confirmation » et relit 5 s
  plus tard ;
- **l'arrêt du thermostat** (mode arrêt) exige aussi **Autoriser les
  commandes** : lecture seule veut dire lecture seule (couper le chauffage
  n'est pas sans risque en hiver). Une fois autorisé, il n'est jamais refusé
  parce qu'une autre commande est en cours, à cause d'une pause ou d'un refus
  gardé en mémoire : il annule une commande pas encore écrite, réécrit la
  consigne demandée par une commande pas encore confirmée, et il est écrit
  même si le thermostat est déjà à l'arrêt. Une autre commande de mise en
  marche attend qu'il soit fini. Après une mise en marche jamais confirmée,
  l'intégration surveille : si une lecture montre le thermostat de nouveau en
  marche dans les 90 s, l'arrêt est réécrit ;
- comme toute commande, l'arrêt est refusé si le certificat a changé ou si un
  autre thermostat répond à l'adresse. **Renommer le thermostat sur son écran
  suffit** à bloquer les commandes, arrêt compris, jusqu'à deux clics sur
  **Accepter le changement**.

Le mode est un mode de thermostat, jamais un interrupteur : un « éteins tout »
d'un assistant vocal ou d'une scène ne l'atteint pas.

## Lecture

Le thermostat est lu à chaque **intervalle de rafraîchissement** (60 s par
défaut, 30 s au moins), jamais plus tôt : un redémarrage, une reconnexion,
l'onglet Découverte, une configuration enregistrée ou le bouton de test
attendent l'intervalle. Si le thermostat ne répond pas, les essais suivants
sont espacés (1, 2, 5, puis 10 minutes). S'il répond « occupé » (HTTP 429 ou
5xx), toutes les lectures font une pause (1 minute à 6 heures, gardée après
un redémarrage).

En HTTPS, un 401 sur un nonce repris d'une requête précédente reçoit une
réponse au nouveau défi ; seule une réponse refusée à un défi frais compte
comme des identifiants refusés. Des identifiants refusés arrêtent les
lectures : pas de nouvel essai automatique. Changez-les, ou cliquez sur
**Tester la connexion** (un essai, au plus une fois par intervalle). Un nom
d'utilisateur contenant un guillemet ou une barre oblique inverse ne peut pas
être envoyé : l'état le dit.

Un autre thermostat qui répond à l'adresse (autre modèle, ou autre nom) est
signalé dans l'état : ses valeurs ne sont pas affichées et les commandes sont
refusées. Si c'est le même (renommé), cliquez deux fois sur **Accepter le
changement**. C'est le nom qui distingue deux thermostats du même modèle :
**donnez à vos thermostats des noms distincts**. Tant que le nom du
thermostat n'a pas été lu une fois, les commandes autres que l'arrêt sont
refusées.

## Limites

- Un seul thermostat par installation de l'intégration.
- Le mode absence, le programme, les consignes d'humidité et les durées de
  fonctionnement ne sont pas encore affichés.
- Pas de découverte sur le réseau : saisissez l'adresse.
- Une lecture et un arrêt peuvent ouvrir deux connexions en même temps.
- Jamais testé avec un vrai appareil.

## Vie privée

Tout reste sur votre réseau. `/data` garde l'heure de la dernière lecture,
l'empreinte du certificat, le modèle et le nom du thermostat, la fin d'une
pause, une empreinte salée d'un nom d'utilisateur et d'un mot de passe
refusés par le thermostat (effacée au premier succès), et un simple marqueur
quand un code PIN a été refusé (pas d'empreinte du code : un code de
4 caractères numériques se retrouverait trop facilement). Jamais le mot de passe, le nom
d'utilisateur ni le code PIN eux-mêmes.
