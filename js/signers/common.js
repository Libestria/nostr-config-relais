/* Outils communs à tous les signers (NIP-07 aujourd'hui, NIP-46 plus tard).

   Un signer est un objet qui respecte cette interface :
     id                          identifiant court ("nip07", "nip46"…)
     isAvailable()               true si le signer peut être utilisé
     getPublicKey(cancelled)     Promise<string> : clé publique hexadécimale (64 caractères)
     signEvent(event, cancelled) Promise<object> : événement signé

   « cancelled » est une promesse rejetée quand l'utilisateur clique sur Annuler.
   Codes d'erreur communs : SIGNER_TIMEOUT, SIGNER_UNAVAILABLE, USER_CANCELLED. */

export const SIGNER_TIMEOUT = Object.freeze({ login: 30000, sign: 30000 });

// Exécute une action du signer avec un délai maximal et une annulation possible.
export async function withTimeout(action, ms, cancelled) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SIGNER_TIMEOUT")), ms);
      }),
      ...(cancelled ? [cancelled] : [])
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Marque une erreur comme venant du signer lui-même (message à afficher tel quel à l'utilisateur).
export function signerError(error) {
  const marked = error instanceof Error ? error : new Error(String(error?.message ?? error ?? ""));
  if (error && typeof error === "object" && "code" in error && !("code" in marked)) marked.code = error.code;
  marked.fromSigner = true;
  return marked;
}

// Refus explicite de l'utilisateur dans son signer.
export function isRefusal(error) {
  return error?.code === 4001 || error?.code === "4001" || error?.name === "NotAllowedError" ||
    /reject|denied|declin|cancel|refus/i.test(String(error?.message || ""));
}

// Vérifie qu'un événement signé correspond bien à la demande.
export function checkSignedEvent(event, unsigned, pubkey) {
  // Certains signers retournent une réponse vide ou non signée après un refus.
  if (!event?.sig) throw new Error("SIGNATURE_MISSING");
  if (!event.id || event.kind !== unsigned.kind || (event.pubkey && event.pubkey.toLowerCase() !== pubkey)) {
    throw new Error("SIGNED_EVENT_INVALID");
  }
  if (JSON.stringify(event.tags) !== JSON.stringify(unsigned.tags) || (event.content ?? "") !== unsigned.content) {
    throw new Error("SIGNED_EVENT_MODIFIED");
  }
  return event;
}
