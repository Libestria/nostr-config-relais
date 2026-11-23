/* Signer NIP-07 : extension de navigateur qui expose window.nostr.
   La clé privée reste dans l'extension ; l'application ne demande que la clé publique et des signatures. */

import { SIGNER_TIMEOUT, withTimeout, signerError } from "./common.js";

export const nip07Signer = {
  id: "nip07",

  isAvailable() {
    return typeof window.nostr?.getPublicKey === "function";
  },

  getPublicKey(cancelled) {
    return withTimeout(() => Promise.resolve().then(() => window.nostr.getPublicKey()).catch(e => { throw signerError(e); }), SIGNER_TIMEOUT.login, cancelled);
  },

  signEvent(unsignedEvent, cancelled) {
    if (typeof window.nostr?.signEvent !== "function") return Promise.reject(new Error("SIGNER_UNAVAILABLE"));
    return withTimeout(() => Promise.resolve().then(() => window.nostr.signEvent(unsignedEvent)).catch(e => { throw signerError(e); }), SIGNER_TIMEOUT.sign, cancelled);
  }
};
