#!/bin/sh
# Télécharge les bibliothèques nécessaires à la connexion NIP-46, puis se supprime.
# Utilisation, depuis la racine du dépôt : bash telecharger.sh
set -e
mkdir -p vendor/nostr-tools vendor/qrcode-generator
curl -fL -o vendor/nostr-tools/nostr.bundle.js https://unpkg.com/nostr-tools@2.26.1/lib/nostr.bundle.js
curl -fL -o vendor/qrcode-generator/qrcode.js https://unpkg.com/qrcode-generator@2.0.4/dist/qrcode.js
rm -f telecharger.sh
echo ""
echo "Fichiers téléchargés :"
ls -l vendor/nostr-tools vendor/qrcode-generator
