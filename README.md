# Libestria – Configurer ses relais Nostr

Application web de [Libestria](https://libestria.fr) pour configurer ses relais Nostr et publier ses listes de relais, sans passer par un client Nostr.

**Accéder à l’application :** https://libestria.fr/nostr-config-relais/

## Ce que permet l’application

L’application gère trois listes publiques de relais, associées au compte Nostr de l’utilisateur :

- **Relais de lecture et d’écriture** (NIP-65) : les relais où l’utilisateur publie ses événements, et ceux où les autres peuvent lui envoyer les réponses et mentions qui le concernent. Chaque relais peut être configuré en lecture (R), en écriture (W) ou dans les deux modes (R+W).
- **Relais de recherche** (NIP-50) : les relais utilisés pour rechercher des événements et des profils.
- **Relais de messagerie privée** (NIP-17) : les relais destinés à recevoir les messages privés chiffrés.

Pour chaque liste, l’utilisateur peut ajouter un relais (en saisissant son adresse ou en choisissant parmi des suggestions), en retirer un, puis publier la liste mise à jour.

## Fonctionnement

1. **Connexion** : l’utilisateur connecte son compte avec un signer (voir ci-dessous).
2. **Chargement** : l’application interroge un ensemble de relais publics pour retrouver le profil et les listes existantes de l’utilisateur.
3. **Analyse des relais** : pour chaque relais, l’application mesure le temps de connexion et indique les NIP pris en charge :
   - **Annoncé** : le relais déclare prendre en charge ce NIP (NIP-11) ;
   - **Détecté** : des événements liés à ce NIP ont été observés sur le relais ;
   - **Indéterminé** : aucune information n’a pu être obtenue.
4. **Modification** : l’utilisateur ajoute, retire ou change le mode de ses relais. Les relais injoignables sont signalés avant leur ajout.
5. **Publication** : la liste est signée par le signer, puis envoyée aux relais d’écriture de l’utilisateur et à des relais de diffusion publics, pour faciliter sa propagation. Un compte rendu indique quels relais ont accepté la publication.

Si aucune liste existante n’a pu être trouvée, l’application prévient l’utilisateur avant la publication, car une nouvelle liste remplacerait celle qui n’a pas pu être lue.

## Connexion du compte Nostr

L’application propose deux types de signers :

- **Extension de navigateur** compatible NIP-07 (Alby Extension, Nostr Map Signer, Nostash…).
- **Signer distant** compatible NIP-46 (Amber, nsec.app, Primal…), de deux façons :
  - en scannant un QR code, ou en ouvrant directement un lien `nostrconnect://` sur téléphone ;
  - en collant une adresse `bunker://` fournie par le signer.

Avec un signer distant, l’application demande uniquement l’autorisation de signer les trois listes de relais.

## Sécurité et confidentialité

- La clé privée (nsec) n’est jamais demandée ni manipulée par l’application : toutes les signatures sont faites par le signer.
- Avant chaque publication, l’application vérifie que l’événement signé correspond exactement à la liste demandée.
- Pour une connexion NIP-46, une clé de session temporaire chiffre les échanges avec le signer. Elle n’existe qu’en mémoire et disparaît au rechargement de la page.
- Aucune donnée n’est enregistrée dans le navigateur ni transmise à un serveur de Libestria : l’application dialogue directement avec les relais Nostr.

## Bibliothèques utilisées

Ces bibliothèques ne sont chargées que lorsque l’utilisateur choisit la connexion par signer distant (NIP-46) :

- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) (version 2.26.1) : chiffrement des échanges et signature des messages de connexion NIP-46.
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (version 2.0.4, licence MIT, © Kazuhiko Arase) : affichage du QR code de connexion.

## NIP utilisés

NIP-01, NIP-04, NIP-05, NIP-07, NIP-11, NIP-17, NIP-19, NIP-23, NIP-44, NIP-46, NIP-50, NIP-59, NIP-65.

---

© 2026 Libestria.fr
