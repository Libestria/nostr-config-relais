/* Signer NIP-46 (« Nostr Connect ») : signer distant joint par des relais (Amber, nsec.app, Primal…).
   La clé privée reste dans le signer. L'application crée une clé de session temporaire, gardée
   uniquement en mémoire, qui sert à chiffrer les échanges (kind 24133, chiffrement NIP-44).

   Deux façons de se connecter :
   - createNostrConnect() : l'application affiche un lien nostrconnect:// (QR code ou lien direct) ;
   - connectBunker()      : l'utilisateur colle une adresse bunker:// fournie par son signer.
   Les deux renvoient un signer qui respecte l'interface décrite dans common.js.

   Bibliothèques (chargées seulement quand NIP-46 est choisi) :
   vendor/nostr-tools/nostr.bundle.js (window.NostrTools) et vendor/qrcode-generator/qrcode.js (window.qrcode). */

import { withTimeout } from "./common.js";

const LIBRARIES = ["vendor/nostr-tools/nostr.bundle.js", "vendor/qrcode-generator/qrcode.js"];
const KIND = 24133;
export const NIP46_TIMEOUT = Object.freeze({
  relayConnect: 6000,   // ouverture d'un relais de communication
  pairing: 300000,      // attente du scan du QR code ou de l'ouverture du lien (5 min)
  request: 120000       // réponse à une demande (connexion bunker, clé publique, signature) : validation possible sur téléphone
});

/* Chargement des bibliothèques ------------------------------------------ */
const scriptLoads = new Map();

function loadScript(src) {
  if (!scriptLoads.has(src)) {
    scriptLoads.set(src, new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { scriptLoads.delete(src); script.remove(); reject(new Error("NIP46_LIBS_MISSING")); };
      document.head.appendChild(script);
    }));
  }
  return scriptLoads.get(src);
}

export async function loadNip46Libraries() {
  await Promise.all(LIBRARIES.map(loadScript));
  if (!window.NostrTools?.nip44 || typeof window.qrcode !== "function") throw new Error("NIP46_LIBS_MISSING");
}

const tools = () => window.NostrTools;

/* Outils ----------------------------------------------------------------- */
const HEX64 = /^[0-9a-f]{64}$/i;

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}

function normalizeRelay(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== "wss:" && u.protocol !== "ws:") return null;
    return u.protocol + "//" + u.host + u.pathname.replace(/\/$/, "");
  } catch { return null; }
}

// bunker://<clé du signer>?relay=wss://…&relay=…&secret=…  →  { remotePubkey, relays, secret } ou null
export function parseBunkerUri(input) {
  let u;
  try { u = new URL(String(input || "").trim()); } catch { return null; }
  if (u.protocol !== "bunker:") return null;
  const remotePubkey = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
  if (!HEX64.test(remotePubkey)) return null;
  const relays = [...new Set(u.searchParams.getAll("relay").map(normalizeRelay).filter(Boolean))];
  if (!relays.length) return null;
  return { remotePubkey, relays, secret: u.searchParams.get("secret") || "" };
}

/* Session : connexions aux relais et échanges chiffrés -------------------- */
class Nip46Session {
  constructor(relays) {
    this.relays = relays;
    this.secretKey = tools().generateSecretKey();
    this.clientPubkey = tools().getPublicKey(this.secretKey);
    this.remotePubkey = null;
    this.sockets = new Map();     // url -> WebSocket
    this.pending = new Map();     // id de la demande -> { resolve, reject }
    this.pairing = null;          // { secret, resolve } pendant l'attente nostrconnect://
    this.seen = new Set();
    this.since = Math.floor(Date.now() / 1000) - 10;
    this.closed = false;
    this.onAuthUrl = null;
    this.onVisible = () => { if (document.visibilityState === "visible") void this.connect().catch(() => {}); };
    document.addEventListener("visibilitychange", this.onVisible);
  }

  // Ouvre (ou rouvre) les relais. Au moins un relais doit répondre.
  async connect() {
    if (this.closed) throw new Error("NIP46_CLOSED");
    await Promise.allSettled(this.relays.map(url => this.openRelay(url)));
    if (![...this.sockets.values()].some(ws => ws.readyState === WebSocket.OPEN)) throw new Error("NIP46_RELAYS_UNREACHABLE");
  }

  openRelay(url) {
    const existing = this.sockets.get(url);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return existing.readyState === WebSocket.OPEN ? Promise.resolve() : existing.ready;
    }
    const ws = new WebSocket(url);
    ws.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, NIP46_TIMEOUT.relayConnect);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.send(JSON.stringify(["REQ", "nip46", { kinds: [KIND], "#p": [this.clientPubkey], since: this.since }]));
        resolve();
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("error")); };
    });
    ws.onmessage = ({ data }) => this.onRelayMessage(data);
    ws.onclose = () => { if (this.sockets.get(url) === ws) this.sockets.delete(url); };
    this.sockets.set(url, ws);
    return ws.ready;
  }

  onRelayMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg) || msg[0] !== "EVENT") return;
    const event = msg[2];
    if (!event || event.kind !== KIND || this.seen.has(event.id)) return;
    if (!event.tags?.some(tag => tag[0] === "p" && tag[1] === this.clientPubkey)) return;
    if (!tools().verifyEvent(event)) return;
    // Une fois le signer connu, seules ses réponses sont acceptées.
    if (this.remotePubkey && event.pubkey !== this.remotePubkey) return;
    this.seen.add(event.id);

    let response;
    try { response = JSON.parse(this.decrypt(event.content, event.pubkey)); } catch { return; }
    if (!response || typeof response !== "object") return;

    // Appairage nostrconnect:// : le signer prouve qu'il a lu le lien en renvoyant le secret.
    if (this.pairing && !this.remotePubkey && response.result === this.pairing.secret) {
      this.remotePubkey = event.pubkey;
      const { resolve } = this.pairing;
      this.pairing = null;
      resolve();
      return;
    }

    const request = this.pending.get(response.id);
    if (!request) return;
    if (response.result === "auth_url") {
      // Le signer demande une validation sur sa propre page ; la réponse finale arrivera ensuite.
      if (typeof response.error === "string" && /^https:\/\//i.test(response.error)) this.onAuthUrl?.(response.error);
      return;
    }
    this.pending.delete(response.id);
    if (response.error) request.reject(new Error(String(response.error)));
    else request.resolve(response.result);
  }

  decrypt(content, pubkey) {
    // Les anciens signers répondent encore en NIP-04 (« …?iv=… »).
    if (/\?iv=/.test(content)) return tools().nip04.decrypt(this.secretKey, pubkey, content);
    return tools().nip44.decrypt(content, tools().nip44.getConversationKey(this.secretKey, pubkey));
  }

  async request(method, params, cancelled, timeout = NIP46_TIMEOUT.request) {
    if (!this.remotePubkey) throw new Error("SIGNER_UNAVAILABLE");
    await this.connect();
    const id = randomHex(16);
    const content = tools().nip44.encrypt(JSON.stringify({ id, method, params }),
      tools().nip44.getConversationKey(this.secretKey, this.remotePubkey));
    const event = tools().finalizeEvent({
      kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", this.remotePubkey]], content
    }, this.secretKey);
    const answer = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const message = JSON.stringify(["EVENT", event]);
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(message); } catch { /* relais suivant */ } }
    }
    try {
      return await withTimeout(() => answer, timeout, cancelled);
    } finally {
      this.pending.delete(id);
    }
  }

  close() {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisible);
    for (const ws of this.sockets.values()) { try { ws.close(); } catch { /* fermeture */ } }
    this.sockets.clear();
    for (const { reject } of this.pending.values()) reject(new Error("NIP46_CLOSED"));
    this.pending.clear();
  }
}

/* Signer renvoyé à l'application ------------------------------------------ */
async function createSigner(session, cancelled) {
  const userPubkey = await session.request("get_public_key", [], cancelled);
  if (typeof userPubkey !== "string" || !HEX64.test(userPubkey)) throw new Error("INVALID_PUBLIC_KEY");
  return {
    id: "nip46",
    isAvailable: () => !session.closed,
    getPublicKey: async () => userPubkey.toLowerCase(),
    async signEvent(unsignedEvent, cancelled) {
      const result = await session.request("sign_event", [JSON.stringify(unsignedEvent)], cancelled);
      return typeof result === "string" ? JSON.parse(result) : result;
    },
    set onAuthUrl(callback) { session.onAuthUrl = callback; },
    close: () => session.close()
  };
}

// Lien nostrconnect:// : à afficher en QR code ou à ouvrir directement sur le téléphone.
// options : { relays, perms, name, url, image, onAuthUrl }
export async function createNostrConnect(options) {
  const session = new Nip46Session(options.relays);
  session.onAuthUrl = options.onAuthUrl;
  const secret = randomHex(16);
  const params = new URLSearchParams();
  options.relays.forEach(relay => params.append("relay", relay));
  params.set("secret", secret);
  if (options.perms?.length) params.set("perms", options.perms.join(","));
  if (options.name) params.set("name", options.name);
  if (options.url) params.set("url", options.url);
  if (options.image) params.set("image", options.image);
  const paired = new Promise(resolve => { session.pairing = { secret, resolve }; });
  try { await session.connect(); }
  catch (error) { session.close(); throw error; }
  return {
    uri: `nostrconnect://${session.clientPubkey}?${params.toString().replace(/\+/g, "%20")}`,
    // Attend que le signer accepte, puis récupère la clé publique du compte.
    async waitForSigner(cancelled, onPaired) {
      await withTimeout(() => paired, NIP46_TIMEOUT.pairing, cancelled);
      onPaired?.();
      return createSigner(session, cancelled);
    },
    close: () => session.close()
  };
}

// Adresse bunker:// collée par l'utilisateur. options : { perms, onAuthUrl }
export async function connectBunker(input, options, cancelled) {
  const bunker = parseBunkerUri(input);
  if (!bunker) throw new Error("NIP46_INVALID_BUNKER");
  const session = new Nip46Session(bunker.relays);
  session.onAuthUrl = options.onAuthUrl;
  session.remotePubkey = bunker.remotePubkey;
  try {
    await session.connect();
    await session.request("connect", [bunker.remotePubkey, bunker.secret, (options.perms || []).join(",")], cancelled);
    return await createSigner(session, cancelled);
  } catch (error) {
    session.close();
    throw error;
  }
}
