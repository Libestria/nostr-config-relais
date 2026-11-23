/* Application Libestria : configuration des relais Nostr.
   Données : data/boot-relays.json, data/suggested-relays.json, data/messages.json.
   Signers : js/signers/ (NIP-07 : extension de navigateur ; NIP-46 : signer distant, réglages dans data/nip46.json). */

import { setMessages, msg, t } from "./messages.js";
import { isRefusal, checkSignedEvent } from "./signers/common.js";
import { nip07Signer } from "./signers/nip07.js";
import { loadNip46Libraries, createNostrConnect, connectBunker } from "./signers/nip46.js";

/* 0. Chargement des données ------------------------------------------------ */
async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(path + " : HTTP " + response.status);
  return response.json();
}

let BOOT_RELAYS, SUGGESTED_RELAYS, NIP46_CONFIG;
try {
  let messages;
  [BOOT_RELAYS, SUGGESTED_RELAYS, NIP46_CONFIG, messages] = await Promise.all([
    loadJson("data/boot-relays.json"),
    loadJson("data/suggested-relays.json"),
    loadJson("data/nip46.json"),
    loadJson("data/messages.json")
  ]);
  setMessages(messages);
} catch (error) {
  // Texte écrit ici : messages.json peut justement être celui qui manque.
  console.error("Données de l’application introuvables", error);
  document.querySelectorAll("#btnLogin, #btnLoginNip46").forEach(button => { button.disabled = true; });
  const help = document.querySelector("#login .help");
  if (help) help.insertAdjacentHTML("afterbegin", '<p class="empty">⚠️ Impossible de charger les données de l’application. Recharge la page.</p>');
  throw error;
}

/* Le focus programmatique des dialogues ne doit pas simuler une navigation au clavier. */
document.addEventListener('keydown', event => {
  if (event.key === 'Tab') document.body.classList.add('keyboard-navigation');
}, { capture: true });
document.addEventListener('pointerdown', () => {
  document.body.classList.remove('keyboard-navigation');
}, { capture: true });

/* 1. Configuration ------------------------------------------------------- */
const FETCH_CONCURRENCY = 5;
// Diagnostic : ouvrir la page avec ?debug dans l’adresse pour tracer les appels dans la console.
const dbg = (...args) => { if (/[?&]debug\b/.test(location.search)) console.log("[relais]", new Date().toISOString(), ...args); };
const BOOT_FETCH_CONCURRENCY = 8; // chargement initial : 2 vagues au lieu de 3
const PROFILE_KIND = 0;
// Délais réseau centralisés (ms). Les sondes NIP et NIP-05 gardent leurs délais propres.
const TIMEOUT = Object.freeze({
  connect: 6000,
  fetchConnect: 6000,
  fetchEvents: 6000,
  publishConnect: 6000,
  publishAck: 6000,
  nip11: 4000,
  nipProbe: 4000,
  nip05: 5000
});
const LATENCY = { fast: 650, slow: 1200 }; // ms : vert <= fast, orange <= slow, rouge au-delà
const MIN_PROGRESS_DISPLAY_MS = 2000;
const SVG_NS = "http://www.w3.org/2000/svg";

// Listes publiées (paramètres du protocole). L'ordre des clés = l'ordre des accordéons.
// Les textes (tab, title, hint, notice) viennent de messages.json : lists.categories.<clé>.
const LISTS = {
  pub: { kind: 10002, rw: true, tag: "r" },
  search: { kind: 10007, rw: false, tag: "relay" },
  dm: { kind: 10050, rw: false, tag: "relay" },
};
for (const [key, list] of Object.entries(LISTS)) {
  Object.assign(list, msg("lists.categories." + key));
  Object.assign(list, { key, relays: [], dirty: false, found: false, lookup: { responded: 0, total: 0 }, extraTags: [], content: "" });
}

/* 2. État et références DOM ------------------------------------------- */
let pubkey = null;
let current = "pub";
let accordionOpen = false;
let measuringConnections = false;
let nip05VerificationSequence = 0;
let publishing = false;
let pendingPublishKey = null;
const latencies = {}; // url -> { ms } | { err }
const nipResults = new Map(); // url -> { declared, observed, ... }
const DISPLAY_NIPS = [17, 23, 50, 59, 65];
const NIP_PROBES = [
  { nip: 23, kind: 30023 }, { nip: 59, kind: 1059 }, { nip: 65, kind: 10002 }
];
const NIP_INFO = msg("nip.info");
const NIP_STATE_LABELS = msg("nip.states");
const NIP_HAS_PROBE = new Set(NIP_PROBES.map(probe => probe.nip));

function nipStatusText(nip, state) {
  if (state === "loading" || state === "observed") return t("nip.status." + state);
  if (!NIP_HAS_PROBE.has(nip)) return t(state === "announced" ? "nip.status.announcedNoProbe" : "nip.status.noneNoProbe");
  return t(state === "announced" ? "nip.status.announced" : "nip.status.none");
}

function showNipInfo(nip, state) {
  const info = NIP_INFO[nip];
  void showMessage({
    tone: "info", title: t("nip.pillTitle", { nip, name: info.name }), text: info.desc,
    details: [
      { heading: true, text: t("nip.stateHeading", { state: NIP_STATE_LABELS[state] }) },
      { plain: true, text: nipStatusText(nip, state) }
    ],
    actions: OK_ACTION
  });
}

const nipScanVersions = new Map(); // empêche une ancienne sonde d’écraser une actualisation récente

const $ = id => document.getElementById(id);
const currentList = () => LISTS[current];

/* 3. Communications WebSocket ----------------------------------------- */
function normalizeUrl(input) {
  if (typeof input !== "string") return null;
  let u = input.trim().replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  if (!/^wss?:\/\//i.test(u)) u = "wss://" + u;
  try {
    const x = new URL(u);
    if (!x.hostname.includes(".") && x.hostname !== "localhost") return null;
    return x.protocol + "//" + x.host + x.pathname.replace(/\/$/, "");
  } catch { return null; }
}

// Ferme sans propager les exceptions de fermeture des navigateurs / relais.
function closeSocket(ws) {
  if (!ws) return;
  try { if (ws.readyState !== WebSocket.CLOSED) ws.close(); }
  catch { /* fermeture best effort */ }
}

function openSocket(url, timeout = TIMEOUT.connect) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        ws.onopen = ws.onerror = ws.onclose = null;
        closeSocket(ws);
        reject(error);
      } else {
        // Les gestionnaires de connexion ne doivent pas interférer avec les opérations suivantes.
        ws.onopen = ws.onerror = ws.onclose = null;
        resolve(ws);
      }
    };
    const timer = setTimeout(() => finish(new Error(t("network.timeout"))), timeout);
    ws.onopen = () => finish(null);
    ws.onerror = () => finish(new Error(t("network.connectFailed")));
    ws.onclose = () => finish(new Error(t("network.closed")));
  });
}

function parseMessage(raw) {
  try { const msg = JSON.parse(raw); return Array.isArray(msg) ? msg : []; } catch { return []; }
}

async function fetchEvents(url, kinds) {
  try {
    const ws = await openSocket(url, TIMEOUT.fetchConnect);
    return await new Promise(resolve => {
      const events = [];
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ws.onmessage = ws.onclose = ws.onerror = null;
        closeSocket(ws);
        resolve(events);
      };
      const timer = setTimeout(done, TIMEOUT.fetchEvents);
      ws.onmessage = ({ data }) => {
        const [type, , event] = parseMessage(data);
        if (type === "EVENT" && event?.pubkey === pubkey && kinds.includes(event.kind)) events.push(event);
        if (type === "EOSE" || type === "CLOSED") done();
      };
      ws.onclose = done;
      ws.onerror = done;
      try { ws.send(JSON.stringify(["REQ", "lists", { kinds, authors: [pubkey] }])); }
      catch { done(); }
    });
  } catch { return null; } // null = relais injoignable (≠ [] : relais joint mais sans événement)
}

async function publishTo(url, event) {
  try {
    const ws = await openSocket(url, TIMEOUT.publishConnect);
    return await new Promise(resolve => {
      let settled = false;
      const finish = (ok, msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onmessage = ws.onclose = ws.onerror = null;
        closeSocket(ws);
        resolve({ url, ok, msg });
      };
      const timer = setTimeout(() => finish(false, t("network.noReply")), TIMEOUT.publishAck);
      ws.onmessage = ({ data }) => {
        const [type, id, ok, msg] = parseMessage(data);
        if (type === "OK" && id === event.id) finish(ok, msg || "");
      };
      ws.onclose = () => finish(false, t("network.closed"));
      ws.onerror = () => finish(false, t("network.connectionError"));
      try { ws.send(JSON.stringify(["EVENT", event])); }
      catch (e) { finish(false, e.message); }
    });
  } catch (e) { return { url, ok: false, msg: e.message }; }
}

async function ping(url) {
  const start = performance.now();
  try {
    const ws = await openSocket(url);
    const ms = Math.round(performance.now() - start);
    closeSocket(ws);
    return { ms };
  } catch (e) { return { err: e.message }; }
}

/* 3 bis. Détection NIP : NIP-11 et événements accessibles publiquement. */
function relayInfoUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "wss:" && u.protocol !== "ws:") throw new Error("protocole invalide");
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return u.href;
}

async function fetchRelayNips(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT.nip11);
  try {
    const response = await fetch(relayInfoUrl(url), {
      headers: { Accept: "application/nostr+json" },
      mode: "cors", credentials: "omit", signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!Array.isArray(data?.supported_nips)) return null;
    return [...new Set(data.supported_nips.filter(n => Number.isSafeInteger(n) && n >= 0))].sort((a, b) => a - b);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function probeRelayKinds(url) {
  let ws;
  try { ws = await openSocket(url, TIMEOUT.connect); }
  catch { return { observed: [], available: false }; }
  return new Promise(resolve => {
    const observed = new Set();
    const pending = new Map();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const id of pending.keys()) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify(["CLOSE", id])); } catch { /* fermeture */ }
        }
      }
      ws.onmessage = ws.onclose = ws.onerror = null;
      closeSocket(ws);
      resolve({ observed: [...observed].sort((a,b) => a-b), available: true });
    };
    const timer = setTimeout(finish, TIMEOUT.nipProbe);
    ws.onmessage = ({ data }) => {
      const msg = parseMessage(data);
      const [type, id, event] = msg;
      if (!pending.has(id)) return;
      if (type === "EVENT" && event?.kind === pending.get(id)) {
        const probe = NIP_PROBES.find(p => p.kind === event.kind);
        if (probe) observed.add(probe.nip);
        pending.delete(id);
        try { ws.send(JSON.stringify(["CLOSE", id])); } catch { /* fermeture */ }
      } else if (type === "EOSE" || type === "CLOSED") pending.delete(id);
      if (!pending.size) finish();
    };
    ws.onclose = finish;
    ws.onerror = finish;
    for (const probe of NIP_PROBES) {
      const id = `libestria-nip-${probe.kind}`;
      pending.set(id, probe.kind);
      try { ws.send(JSON.stringify(["REQ", id, { kinds: [probe.kind], limit: 1 }])); }
      catch { pending.delete(id); }
    }
    if (!pending.size) finish();
  });
}

function updateNipRows(url) {
  document.querySelectorAll(".relay").forEach(row => {
    if (row.dataset.relayUrl !== url) return;
    const target = row.querySelector(".relay-nips");
    if (target) populateNipView(target, nipResults.get(url));
  });
}

function populateNipView(target, result) {
  target.replaceChildren();
  const line = document.createElement("div");
  line.className = "nip-line";
  const declared = new Set(result?.declared || []);
  const observed = new Set(result?.observed || []);
  for (const nip of DISPLAY_NIPS) {
    // NIP-17 ne peut pas être confirmé par les événements NIP-59.
    // NIP-50 reste annoncé seulement tant qu'aucun test de recherche positif n'est implémenté.
    const detected = observed.has(nip);
    const announced = declared.has(nip);
    const state = detected ? "observed" : announced ? "announced" : (result?.loading || !result) ? "loading" : "none";
    const info = NIP_INFO[nip];
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "nip-pill" + (detected ? " observed" : announced ? " announced" : "");
    pill.textContent = `NIP-${nip}`;
    pill.title = t("nip.pillTitle", { nip, name: info.name });
    pill.setAttribute("aria-label", t("nip.pillLabel", { nip, name: info.name, state: NIP_STATE_LABELS[state] }));
    pill.addEventListener("click", () => showNipInfo(nip, state));
    line.appendChild(pill);
  }
  target.appendChild(line);

  const legend = document.createElement("div");
  legend.className = "nip-legend";
  for (const [cls, label] of [["observed", NIP_STATE_LABELS.observed], ["announced", NIP_STATE_LABELS.announced], ["", NIP_STATE_LABELS.none]]) {
    const item = document.createElement("span");
    item.className = "nip-legend-item";
    const dot = document.createElement("span");
    dot.className = "nip-legend-dot" + (cls ? " " + cls : "");
    dot.setAttribute("aria-hidden", "true");
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  }
  const hint = document.createElement("span");
  hint.className = "nip-legend-hint";
  hint.textContent = t("nip.legendHint");
  legend.appendChild(hint);
  target.appendChild(legend);
}

async function scanRelayNips(url) {
  const version = (nipScanVersions.get(url) || 0) + 1;
  nipScanVersions.set(url, version);
  nipResults.set(url, { loading: true });
  updateNipRows(url);
  const [declared, probe] = await Promise.all([fetchRelayNips(url), probeRelayKinds(url)]);
  // Une actualisation d'un autre relais ne doit pas annuler celle-ci.
  if (nipScanVersions.get(url) !== version) return;
  nipResults.set(url, { declared, observed: probe.observed });
  updateNipRows(url);
}

// File d'attente réutilisable : au maximum FETCH_CONCURRENCY relais en parallèle.
async function forEachRelayLimited(urls, task) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try { await task(url); }
      catch (error) { console.warn("Analyse du relais interrompue", url, error); }
    }
  }));
}

async function scanAllRelayNips(urls) {
  await forEachRelayLimited([...new Set(urls)], scanRelayNips);
}

/* 4. Encodage NIP-19 -------------------------------------------------- */
const BECH32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    gen.forEach((g, i) => { if ((top >> i) & 1) chk ^= g; });
  }
  return chk;
}

function npubEncode(hex) {
  const bytes = hex.match(/../g).map(h => parseInt(h, 16));
  const words = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
  }
  if (bits) words.push((acc << (5 - bits)) & 31);

  const hrp = "npub";
  const expanded = [...hrp].map(c => c.charCodeAt(0) >> 5).concat(0, [...hrp].map(c => c.charCodeAt(0) & 31));
  const mod = bech32Polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map(i => (mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...checksum].map(w => BECH32_CHARS[w]).join("");
}

/* 5. Conversion des événements ---------------------------------------- */
function latestEvent(events, kind) {
  let latest;
  for (const event of events) {
    if (event.kind === kind && (!latest || event.created_at > latest.created_at)) latest = event;
  }
  return latest;
}

function profileFromEvents(events) {
  const event = latestEvent(events, PROFILE_KIND);
  try { const data = event ? JSON.parse(event.content) : null; return data && typeof data === "object" ? data : {}; } catch { return {}; }
}

function relaysFromEvent(event, list) {
  const relays = [];
  for (const tag of Array.isArray(event.tags) ? event.tags : []) {
    if (!Array.isArray(tag) || tag[0] !== list.tag) continue;
    const url = normalizeUrl(tag[1]);
    if (!url) continue;
    const read = tag[2] !== "write", write = tag[2] !== "read";
    const known = relays.find(r => r.url === url);
    if (known) { known.read = known.read || read; known.write = known.write || write; known.rawTag = null; } // même relais déclaré deux fois (NIP-65) : fusion, le tag est reconstruit
    else relays.push({ url, read, write, rawTag: [...tag], rawUrl: tag[1] }); // tag d'origine conservé tel quel tant que le mode n'est pas modifié
  }
  return relays;
}

// Tags de l'événement d'origine que l'application ne gère pas : ils sont recopiés à la publication.
function extraTagsFromEvent(event, list) {
  return (Array.isArray(event.tags) ? event.tags : [])
    .filter(tag => Array.isArray(tag) && tag[0] !== list.tag)
    .map(tag => [...tag]);
}

function tagsFromList(list) {
  const relayTags = list.relays.map(r => {
    if (r.rawTag) return [...r.rawTag];
    const address = r.rawUrl || r.url; // adresse d'origine conservée (ex. paramètre ?token=) même si le mode change
    if (!list.rw) return ["relay", address];
    if (r.read && r.write) return ["r", address];
    return ["r", address, r.read ? "read" : "write"];
  });
  return [...relayTags, ...list.extraTags.map(tag => [...tag])];
}

/* 6. Affichage et composants ------------------------------------------ */
function latencyView(status) {
  if (!status) return { cls: "", bars: 0, text: "…" };
  if (status.err) return { cls: "r", bars: 0, text: t("relay.unreachable") };
  const bars = status.ms <= LATENCY.fast ? 3 : status.ms <= LATENCY.slow ? 2 : 1;
  return { cls: ["", "r", "o", "g"][bars], bars, text: t("relay.milliseconds", { ms: status.ms }) };
}

function signalSvg(lit) {
  const bars = [[0, 8, 4], [6, 4, 8], [12, 0, 12]]
    .map(([x, y, h], i) => `<rect x="${x}" y="${y}" width="4" height="${h}" rx="1" fill="currentColor"${i < lit ? "" : ' opacity=".25"'}/>`)
    .join("");
  return `<svg viewBox="0 0 16 12" aria-hidden="true">${bars}</svg>`;
}

function relayRow(list, relay) {
  const status = latencies[relay.url];
  const lat = latencyView(status);
  const mode = relay.read && relay.write ? "rw" : relay.read ? "r" : "w";

  const row = document.createElement("div");
  row.className = "relay";
  row.dataset.relayUrl = relay.url;
  // Structure HTML seulement : les textes sont ajoutés ensuite avec textContent et setAttribute.
  row.innerHTML =
    `<div class="relay-address"><span class="dot ${status ? (status.err ? "bad" : "ok") : ""}" aria-hidden="true"></span><div class="url"></div>` +
    `<button class="del" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg></button></div>` +
    `<div class="relay-connection"><span class="lat ${lat.cls}"><span class="lat-label"></span>${signalSvg(lat.bars)}<span class="lat-value"></span></span>` +
    `<button class="icon-btn refresh-relays${measuringConnections ? " is-measuring" : ""}" type="button" ${measuringConnections ? "disabled aria-busy=\"true\"" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14-5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 5l2-2"/><path d="M20 20v-4h-4"/></svg></button></div>` +
    (list.rw
      ? `<div class="relay-controls"><div class="modes">
             <button type="button" data-mode="r"></button>
             <button type="button" data-mode="w"></button>
             <button type="button" data-mode="rw"></button>
           </div></div>`
      : "");
  const latBox = row.querySelector(".lat");
  latBox.title = t("relay.latencyTitle");
  latBox.querySelector(".lat-label").textContent = t("relay.latencyLabel");
  latBox.querySelector(".lat-value").textContent = lat.text;
  const refreshButton = row.querySelector(".refresh-relays");
  refreshButton.title = t("relay.refresh");
  refreshButton.setAttribute("aria-label", t("relay.refreshLabel"));
  row.querySelector(".del").title = t("relay.delete");
  row.querySelectorAll(".modes [data-mode]").forEach(btn => { btn.textContent = t("relay.modes." + btn.dataset.mode); });

  const nipBox = document.createElement("div");
  nipBox.className = "relay-nips";
  nipBox.setAttribute("aria-label", t("nip.boxLabel"));
  row.appendChild(nipBox);
  populateNipView(nipBox, nipResults.get(relay.url));
  row.querySelector(".url").textContent = relay.url;
  row.querySelector(".del").setAttribute("aria-label", t("relay.deleteNamed", { url: relay.url }));
  row.querySelector(".refresh-relays").addEventListener("click", testAll);
  row.querySelector(".del").onclick = async () => {
    const choice = await showMessage({
      tone: "alert",
      title: t("relay.deleteConfirm.title"),
      text: t("relay.deleteConfirm.text", { url: relay.url }),
      actions: [{ id: "no", label: t("common.cancel"), defaultFocus: true }, { id: "yes", label: t("relay.deleteConfirm.confirm"), primary: true }]
    });
    if (choice !== "yes") return;
    const position = list.relays.indexOf(relay);
    if (position === -1) return;
    list.relays.splice(position, 1);
    list.dirty = true;
    render();
  };
  row.querySelectorAll("[data-mode]").forEach(btn => {
    const selected = btn.dataset.mode === mode;
    btn.classList.toggle("on", selected);
    btn.setAttribute("aria-pressed", String(selected));
    btn.onclick = () => {
      const index = list.relays.indexOf(relay);
      relay.read = btn.dataset.mode.includes("r");
      relay.write = btn.dataset.mode.includes("w");
      relay.rawTag = null; // choix volontaire : le tag est réécrit
      list.dirty = true;
      render();
      $("list").children[index]?.querySelector(`[data-mode="${btn.dataset.mode}"]`)?.focus(); // conserve le focus clavier
    };
  });
  return row;
}

function createIcon(symbolId) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#" + symbolId);
  svg.appendChild(use);
  return svg;
}

// Les en-têtes restent dans le DOM : les mises à jour ne détruisent ni le focus
// clavier ni les éléments de la carte contenant la liste de relais.
function initRelayAccordions() {
  const container = $("relayAccordions");
  for (const [key, list] of Object.entries(LISTS)) {
    const section = document.createElement("section");
    section.className = "relay-accordion";
    const heading = document.createElement("h3");
    heading.className = "relay-accordion-heading";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle";
    button.setAttribute("aria-controls", `relay-panel-${key}`);
    button.setAttribute("aria-expanded", "false");
    button.dataset.relayCategory = key;
    button.appendChild(createIcon("i-radio"));
    const label = document.createElement("strong");
    label.textContent = list.tab;
    button.appendChild(label);
    heading.appendChild(button);
    const panel = document.createElement("div");
    panel.className = "relay-accordion-content";
    panel.id = `relay-panel-${key}`;
    panel.hidden = true;
    const actions = document.createElement("div");
    actions.className = "publish-actions";
    const publishButton = document.createElement("button");
    publishButton.type = "button";
    publishButton.className = "main";
    publishButton.textContent = t("lists.publishButton");
    publishButton.dataset.publishCategory = key;
    actions.append(publishButton);
    panel.appendChild(actions);
    section.append(heading, panel);
    container.appendChild(section);
  }
  container.addEventListener("click", event => {
    const publishButton = event.target.closest("button[data-publish-category]");
    if (publishButton && container.contains(publishButton)) {
      requestPublish(publishButton.dataset.publishCategory);
      return;
    }
    const button = event.target.closest("button[data-relay-category]");
    if (!button || !container.contains(button)) return;
    const key = button.dataset.relayCategory;
    if (key === current && accordionOpen) {
      keepInView(button, () => {
        accordionOpen = false;
        updateRelayAccordions();
      });
      return;
    }
    keepInView(button, () => {
      current = key;
      accordionOpen = true;
      render();
    });
  });
}

// Un seul accordéon reste ouvert : en ouvrir un autre referme le précédent, ce qui
// peut décaler fortement le contenu. L'en-tête cliqué est donc maintenu à la même
// position à l'écran. L'ancrage natif du navigateur est suspendu le temps du
// changement, pour éviter une double correction.
function keepInView(anchor, change) {
  const page = anchor.closest(".page");
  if (!page) { change(); return; }
  const before = anchor.getBoundingClientRect().top;
  page.style.overflowAnchor = "none";
  change();
  const shift = anchor.getBoundingClientRect().top - before;
  if (shift) page.scrollTop += shift;
  requestAnimationFrame(() => { page.style.overflowAnchor = ""; });
}

function updateRelayAccordions() {
  const container = $("relayAccordions");
  const listCard = $("relayListCard");
  const addCard = $("relayAddCard");
  const activeKey = accordionOpen ? current : null;
  for (const button of container.querySelectorAll("button[data-relay-category]")) {
    const key = button.dataset.relayCategory;
    const expanded = key === activeKey;
    button.setAttribute("aria-expanded", String(expanded));
    const panel = $("relay-panel-" + key);
    if (expanded) {
      // Ordre du DOM = ordre visuel : liste, ajout, puis publication (le bouton clôt le panneau).
      panel.append(listCard, addCard, panel.querySelector(".publish-actions"));
    }
    // Modifications non publiées : le bouton reste fixé en bas de la zone visible tant que l'accordéon est à l'écran.
    panel.classList.toggle("has-changes", expanded && LISTS[key].dirty);
    panel.hidden = !expanded;
  }
  listCard.hidden = !activeKey;
  addCard.hidden = !activeKey;
}

function renderSuggestions(list) {
  const chips = $("chips");
  chips.innerHTML = "";
  // Groupes définis dans data/suggested-relays.json ; titres dans messages.json (suggestions.<id>).
  for (const group of SUGGESTED_RELAYS[list.key] || []) {
    const label = t("suggestions." + group.id);
    const urls = group.relays;
    const available = (urls || []).filter(u => !list.relays.some(r => r.url === u));
    if (!available.length) continue;
    const title = document.createElement("div");
    title.className = "lbl";
    title.textContent = label;
    chips.appendChild(title);
    for (const url of available) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "+ " + url;
      btn.onclick = () => addRelay(url);
      chips.appendChild(btn);
    }
  }
}

// Évite de réécrire un texte identique : un lecteur d'écran ne ré-annonce pas une alerte inchangée.
function setTextIfChanged(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function render() {
  const nip65Relays = LISTS.pub.relays;
  $("nip65ReadCount").textContent = nip65Relays.filter(relay => relay.read).length;
  $("nip65WriteCount").textContent = nip65Relays.filter(relay => relay.write).length;
  $("searchRelayCount").textContent = LISTS.search.relays.length;
  $("dmRelayCount").textContent = LISTS.dm.relays.length;
  const list = currentList();
  updateRelayAccordions();
  // Résumé : seule la liste de lecture et d'écriture (10002) est signalée ; l'absence d'une liste de recherche ou de messagerie est courante.
  const summaryWarning = $("summaryWarning");
  summaryWarning.hidden = LISTS.pub.found;
  setTextIfChanged(summaryWarning, LISTS.pub.found ? "" : t("lists.summaryNotFound"));
  const listWarning = $("listWarning");
  listWarning.hidden = list.found;
  setTextIfChanged(listWarning, list.found ? "" : t("lists.notFound", list.lookup));
  $("listTitle").textContent = list.title;
  $("listHint").textContent = list.hint;

  const container = $("list");
  container.replaceChildren();
  if (!list.relays.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("lists.empty");
    container.appendChild(empty);
  }
  list.relays.forEach(relay => container.appendChild(relayRow(list, relay)));
  renderSuggestions(list);
  syncRelayReveal();
}

// Le NIP-05 annoncé dans kind 0 n'est pas une preuve : vérifier nostr.json.
async function verifyNip05(identifier, expectedPubkey, signal) {
  const match = /^(?:(?<user>[a-z0-9._-]+)@)?(?<domain>[a-z0-9.-]+\.[a-z]{2,})$/i.exec(identifier);
  if (!match) return false;
  const user = (match.groups.user || "_").toLowerCase();
  const domain = match.groups.domain.toLowerCase();
  const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(user)}`, {
    signal, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store"
  });
  if (!response.ok) return false;
  const json = await response.json();
  return typeof json?.names?.[user] === "string" && json.names[user].toLowerCase() === expectedPubkey.toLowerCase();
}

async function showNip05(profile) {
  const element = $("profileNip05");
  const sequence = ++nip05VerificationSequence;
  const identifier = typeof profile.nip05 === "string" ? profile.nip05.trim() : "";
  element.replaceChildren();
  element.classList.remove("is-verified");
  element.hidden = !identifier;
  if (!identifier) return;
  element.textContent = identifier;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT.nip05);
  try {
    const verified = await verifyNip05(identifier, pubkey, controller.signal);
    if (sequence !== nip05VerificationSequence || !verified) return;
    element.classList.add("is-verified");
    const mark = document.createElement("span");
    mark.className = "verified-mark";
    mark.textContent = "✓";
    mark.setAttribute("aria-label", t("profile.nip05Verified"));
    element.appendChild(mark);
  } catch { /* Domaine indisponible, CORS ou délai dépassé : pas de coche. */ }
  finally { clearTimeout(timeout); }
}

function showProfile(profile = {}) {
  const text = value => (typeof value === "string" ? value.trim() : "");
  const name = text(profile.display_name) || text(profile.name);
  $("profileName").textContent = name || t("profile.noName");
  $("profileKey").textContent = npubEncode(pubkey);
  void showNip05(profile);

  const avatar = $("avatar");
  avatar.replaceChildren();
  const initial = document.createElement("span");
  initial.textContent = (name || "?").charAt(0).toUpperCase();
  avatar.appendChild(initial);

  if (typeof profile.picture === "string" && /^https:\/\//i.test(profile.picture)) {
    const img = new Image();
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onload = () => avatar.replaceChildren(img);
    img.src = profile.picture;
  }
}

/* 7. Messages (popup) ------------------------------------------------- */
// Tous les messages d'avancement, d'alerte, d'erreur et de confirmation passent par cette popup.
// tone : "busy" (avancement, sans bouton) · "success" · "alert" (alerte ou erreur).
const messageDialog = $("messageDialog");
const OK_ACTION = [{ id: "ok", label: t("common.ok"), primary: true }];
let messageResolve = null;

function settleMessage(value) {
  const resolve = messageResolve;
  messageResolve = null;
  resolve?.(value);
}

// Affiche (ou met à jour) la popup. La promesse renvoie l'id du bouton choisi, ou null si elle est fermée autrement.
function showMessage({ tone = "alert", title, text = "", details = [], actions = [], modal = tone !== "busy" }) {
  settleMessage(null);
  messageDialog.dataset.tone = tone;
  messageDialog.classList.toggle("nonmodal", !modal);
  // Attente sans action possible dans le signer : la page est verrouillée pendant l’opération.
  const lockPage = tone === "busy" && !actions.length;
  $("login").inert = lockPage;
  $("app").inert = lockPage;
  messageDialog.setAttribute("role", tone === "alert" ? "alertdialog" : "dialog");

  const icon = $("messageIcon");
  icon.dataset.tone = tone;
  icon.replaceChildren();
  if (tone === "busy") {
    const spinner = document.createElement("span");
    spinner.className = "loading-spinner";
    icon.appendChild(spinner);
  } else {
    icon.textContent = tone === "success" ? "✓" : tone === "info" ? "ℹ️" : "⚠️";
  }

  $("messageTitle").textContent = title;
  const textEl = $("messageText");
  textEl.textContent = text;
  textEl.hidden = !text;

  const detailsEl = $("messageDetails");
  detailsEl.replaceChildren(...details.map(detail => {
    const line = document.createElement("div");
    line.className = (detail.heading || detail.plain) ? "res" : "res " + (detail.ok ? "ok" : "bad");
    if (detail.heading) line.classList.add("heading");
    line.textContent = detail.text;
    return line;
  }));
  detailsEl.hidden = !details.length;

  const actionsEl = $("messageActions");
  actionsEl.replaceChildren(...actions.map(action => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    if (action.primary) button.className = "main";
    if (action.defaultFocus) button.dataset.defaultFocus = "true";
    button.addEventListener("click", () => {
      settleMessage(action.id);
      messageDialog.close();
    });
    return button;
  }));

  const done = new Promise(resolve => { messageResolve = resolve; });
  // Non modal : la pop-up d’un signer injecté dans la page (ex. Nostr Map Signer) reste cliquable.
  if (messageDialog.open && messageDialog.dataset.modal !== String(modal)) messageDialog.close();
  if (!messageDialog.open) { if (modal) messageDialog.showModal(); else messageDialog.show(); }
  messageDialog.dataset.modal = String(modal);
  if (modal) (actionsEl.querySelector("[data-default-focus]") || actionsEl.querySelector(".main") || actionsEl.querySelector("button"))?.focus();
  return done;
}

function hideMessage() {
  settleMessage(null);
  if (messageDialog.open) messageDialog.close();
}

// Un message d'avancement ne se ferme pas avec Échap.
messageDialog.addEventListener("cancel", event => {
  if (messageDialog.dataset.tone === "busy") event.preventDefault();
});
messageDialog.addEventListener("close", () => {
  if (!messageDialog.open) { settleMessage(null); $("login").inert = false; $("app").inert = false; }
});

/* 8. Actions sur les relais ------------------------------------------- */
let pendingRelay = null;
let selectedRelayMode = "rw";
let checkingRelayAddition = false;

function selectRelayMode(mode) {
  selectedRelayMode = mode;
  $("relayModeChoices").querySelectorAll("[data-mode]").forEach(button => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("on", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function commitRelay(list, url, mode = "rw") {
  // Une seconde vérification protège aussi des changements pendant l'ouverture de la fenêtre.
  if (list.relays.some(relay => relay.url === url)) return;
  list.relays.push({ url, read: mode.includes("r"), write: mode.includes("w") });
  list.dirty = true;
  $("newUrl").value = "";
  render();
  void testRelay(url);
  void scanAllRelayNips([url]);
}

function openRelayModeSelection(list, url) {
  pendingRelay = { list, url };
  $("relayModeUrl").textContent = url;
  // Mode proposé par défaut : celui du groupe de suggestions qui contient ce relais (ex. relais payant en lecture seule).
  const group = (SUGGESTED_RELAYS[list.key] || []).find(g => g.defaultMode && g.relays.includes(url));
  selectRelayMode(group?.defaultMode || "rw");
  $("relayModeDialog").showModal();
  $("relayModeAdd").focus();
}

async function checkRelayBeforeAddition(list, url) {
  if (checkingRelayAddition) return;
  checkingRelayAddition = true;
  try {
    void showMessage({ tone: "busy", title: t("addRelay.checkingTitle"), text: t("addRelay.checkingText") });
    const status = await ping(url);
    latencies[url] = status;
    hideMessage();
    if (status.err) {
      const choice = await showMessage({
        tone: "alert",
        title: t("addRelay.unreachableTitle"),
        text: t("addRelay.unreachableText"),
        actions: [
          { id: "cancel", label: t("common.cancel"), defaultFocus: true },
          { id: "add", label: t("addRelay.addAnyway"), primary: true }
        ]
      });
      if (choice !== "add") return;
    }
    // Le test est terminé avant toute sélection de droits ou confirmation d'ajout.
    if (list.relays.some(relay => relay.url === url)) return;
    if (list.rw) openRelayModeSelection(list, url);
    else commitRelay(list, url);
  } finally {
    checkingRelayAddition = false;
  }
}

async function offerSecureRelay(url) {
  const secure = "wss://" + url.slice(5);
  const choice = await showMessage({
    tone: "alert", title: t("addRelay.insecureTitle"),
    text: t("addRelay.insecureText", { secure }),
    actions: [{ id: "cancel", label: t("common.cancel"), defaultFocus: true }, { id: "wss", label: t("addRelay.tryWss"), primary: true }]
  });
  if (choice === "wss") addRelay(secure);
}

function addRelay(input) {
  const list = currentList();
  const url = normalizeUrl(input);
  if (!url) {
    void showMessage({ tone: "alert", title: t("addRelay.invalidTitle"), text: t("addRelay.invalidText"), actions: OK_ACTION });
    return;
  }
  if (url.startsWith("ws://") && location.protocol === "https:" && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)) {
    void offerSecureRelay(url);
    return;
  }
  if (list.relays.some(r => r.url === url)) {
    void showMessage({ tone: "alert", title: t("addRelay.duplicateTitle"), text: t("addRelay.duplicateText"), actions: OK_ACTION });
    return;
  }
  void checkRelayBeforeAddition(list, url);
}

async function testRelay(url) {
  latencies[url] = await ping(url);
  render();
}

async function testAll() {
  if (measuringConnections) return;
  measuringConnections = true;
  document.querySelectorAll(".refresh-relays").forEach(button => {
    button.disabled = true;
    button.classList.add("is-measuring");
    button.setAttribute("aria-busy", "true");
  });
  try {
    const urls = [...new Set(Object.values(LISTS).flatMap(list => list.relays.map(relay => relay.url)))];
    // Les tests de latence et les sondes NIP partagent la même file :
    // pas de rafale de WebSockets sur tous les relais à la fois.
    await forEachRelayLimited(urls, async url => {
      latencies[url] = await ping(url);
      await scanRelayNips(url);
    });
  } finally {
    measuringConnections = false;
    render();
  }
}

/* 9. Session NIP-07 et chargement ------------------------------------- */
// Signer utilisé pour la session : nip07Signer ou signer NIP-46 (même interface, voir js/signers/common.js).
let signer = null;

function showLoginError(message) {
  return showMessage({ tone: "alert", title: t("login.errorTitle"), text: message, actions: OK_ACTION });
}

function loginError(error) {
  if (error?.message === "SIGNER_TIMEOUT") return t("login.errors.timeout");
  const text = t(isRefusal(error) ? "login.errors.denied" : "login.errors.technical");
  return error?.fromSigner && error.message ? text + "\n" + t("login.errors.signerMessage", { message: error.message }) : text;
}

// Garantit un temps de lecture minimal pour chaque fenêtre de progression automatique.
function waitForMinimumDisplay(startedAt) {
  const remaining = MIN_PROGRESS_DISPLAY_MS - (performance.now() - startedAt);
  return remaining > 0 ? new Promise(resolve => setTimeout(resolve, remaining)) : Promise.resolve();
}

async function login() {
  const button = $("btnLogin");
  if (button.disabled) return;

  const candidate = nip07Signer;
  if (!candidate.isAvailable()) {
    await showLoginError(t("login.errors.missing"));
    return;
  }

  button.disabled = true;
  let loginStartedAt;
  try {
    loginStartedAt = performance.now();
    const wait = showMessage({ tone: "busy", modal: false, title: t("login.busyTitle"), text: t("login.busyText"), actions: [{ id: "cancel", label: t("common.cancel") }] });
    const cancelled = wait.then(choice => choice === "cancel" ? Promise.reject(new Error("USER_CANCELLED")) : new Promise(() => {}));
    cancelled.catch(() => {});
    const key = await candidate.getPublicKey(cancelled);
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error("INVALID_PUBLIC_KEY");
    }

    await waitForMinimumDisplay(loginStartedAt);
    await finishLogin(candidate, key);
  } catch (error) {
    if (error?.message === "USER_CANCELLED") { hideMessage(); return; }
    if (loginStartedAt !== undefined) await waitForMinimumDisplay(loginStartedAt);
    await showLoginError(loginError(error));
  } finally {
    button.disabled = false;
  }
}

// Étape commune à tous les signers : clé publique obtenue, chargement du compte.
async function finishLogin(candidate, key) {
  pubkey = key.toLowerCase();
  signer = candidate;
  showProfile();
  if (await loadAccountWithRetry()) {
    $("login").hidden = true;
    $("app").hidden = false;
    return true;
  }
  signer = null;
  return false;
}

/* 9 bis. Connexion NIP-46 ---------------------------------------------- */
const nip46Dialog = $("nip46Dialog");
let nip46Attempt = null; // tentative en cours : { cancelled, resolve(signer), cancel() }

function setNip46Status(text, isError = false) {
  const status = $("nip46Status");
  status.textContent = text;
  status.classList.toggle("is-error", isError);
}

function nip46ErrorText(error) {
  const code = String(error?.message || "");
  if (code === "NIP46_INVALID_BUNKER") return t("nip46.status.invalidBunker");
  if (code === "NIP46_RELAYS_UNREACHABLE") return t("nip46.status.relaysUnreachable");
  if (code === "SIGNER_TIMEOUT") return t("nip46.status.timeout");
  if (error?.fromSigner) {
    const signerText = t("nip46.status.signerMessage", { message: code || "?" });
    return isRefusal(error) ? t("nip46.status.refused") + "\n" + signerText : signerText;
  }
  if (isRefusal(error)) return t("nip46.status.refused");
  return t("nip46.status.failed", { reason: code || "?" });
}

// Le signer demande une validation sur sa page : ouverture au clic (les navigateurs bloquent les ouvertures automatiques).
async function askAuthUrl(url) {
  const choice = await showMessage({
    tone: "info", title: t("nip46.authTitle"), text: t("nip46.authText"),
    actions: [{ id: "close", label: t("common.close") }, { id: "open", label: t("nip46.authOpen"), primary: true }]
  });
  if (choice === "open") window.open(url, "_blank", "noopener,noreferrer");
}

async function loginWithNip46() {
  const button = $("btnLoginNip46");
  if (button.disabled || nip46Attempt) return;
  button.disabled = true;
  let connection = null;
  let linkWon = false; // true si la connexion s'est faite par le lien nostrconnect://
  try {
    void showMessage({ tone: "busy", title: t("nip46.preparingTitle"), text: t("nip46.preparingText") });
    try { await loadNip46Libraries(); }
    catch {
      await showMessage({ tone: "alert", title: t("nip46.libsMissingTitle"), text: t("nip46.libsMissingText"), actions: OK_ACTION });
      return;
    }
    try { connection = await createNostrConnect({ ...NIP46_CONFIG, onAuthUrl: askAuthUrl }); }
    catch {
      await showMessage({ tone: "alert", title: t("nip46.relaysUnreachableTitle"), text: t("nip46.relaysUnreachableText"), actions: OK_ACTION });
      return;
    }
    hideMessage();

    // QR code et lien nostrconnect://
    const qr = window.qrcode(0, "L");
    qr.addData(connection.uri);
    qr.make();
    $("nip46Qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true, title: t("nip46.qrLabel") });
    $("nip46Open").href = connection.uri;
    $("nip46Bunker").value = "";
    $("nip46BunkerConnect").disabled = false;
    setNip46Status(t("nip46.status.waiting"));

    // Le premier signer connecté (lien ou bunker) l'emporte.
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    cancelled.catch(() => {});
    const chosen = new Promise((resolve, reject) => {
      nip46Attempt = {
        cancelled,
        resolve: candidate => {
          if (nip46Attempt?.done) { candidate.close(); return; }
          nip46Attempt.done = true;
          resolve(candidate);
        },
        cancel: () => { rejectCancelled(new Error("USER_CANCELLED")); reject(new Error("USER_CANCELLED")); }
      };
    });
    nip46Dialog.showModal();
    $("nip46Open").focus();
    connection.waitForSigner(cancelled, () => setNip46Status(t("nip46.status.paired")))
      .then(candidate => {
        if (nip46Attempt && !nip46Attempt.done) linkWon = true;
        if (nip46Attempt) nip46Attempt.resolve(candidate); else candidate.close();
      })
      .catch(error => {
        const code = error?.message;
        if (code === "USER_CANCELLED" || code === "NIP46_CLOSED") return;
        setNip46Status(code === "SIGNER_TIMEOUT" ? t("nip46.status.pairingTimeout") : nip46ErrorText(error), true);
      });

    let candidate;
    try { candidate = await chosen; }
    catch { return; } // annulation
    nip46Attempt = null;
    if (nip46Dialog.open) nip46Dialog.close();
    if (!(await finishLogin(candidate, await candidate.getPublicKey()))) candidate.close();
  } finally {
    nip46Attempt = null;
    if (nip46Dialog.open) nip46Dialog.close();
    // Le lien nostrconnect:// non utilisé est fermé ; une session gagnante reste ouverte via le signer.
    if (connection && !(linkWon && signer)) connection.close();
    $("nip46Qr").replaceChildren();
    button.disabled = false;
  }
}

async function connectWithBunker() {
  const attempt = nip46Attempt;
  const button = $("nip46BunkerConnect");
  if (!attempt || button.disabled) return;
  button.disabled = true;
  setNip46Status(t("nip46.status.bunkerConnecting"));
  try {
    const candidate = await connectBunker($("nip46Bunker").value, { perms: NIP46_CONFIG.perms, onAuthUrl: askAuthUrl }, attempt.cancelled);
    if (nip46Attempt === attempt) attempt.resolve(candidate);
    else candidate.close();
  } catch (error) {
    if (error?.message === "USER_CANCELLED") return;
    if (nip46Attempt === attempt) setNip46Status(nip46ErrorText(error), true);
  } finally {
    button.disabled = false;
  }
}

async function copyNip46Link() {
  try {
    await navigator.clipboard.writeText($("nip46Open").href);
    setNip46Status(t("nip46.status.copied"));
  } catch {
    setNip46Status(t("nip46.status.copyFailed"), true);
  }
}

// Charge le profil et les listes ; en cas d'échec, propose de réessayer ou de revenir à l'écran de connexion.
async function loadAccountWithRetry() {
  for (;;) {
    const loadingStartedAt = performance.now();
    showMessage({ tone: "busy", title: t("loading.busyTitle"), text: t("loading.busyText") });
    try {
      await loadAccount();
      await waitForMinimumDisplay(loadingStartedAt);
      hideMessage();
      $("relayAccordions").hidden = false;
      return true;
    } catch {
      await waitForMinimumDisplay(loadingStartedAt);
      const choice = await showMessage({
        tone: "alert",
        title: t("loading.failTitle"),
        text: t("loading.failText"),
        actions: [{ id: "close", label: t("common.close") }, { id: "retry", label: t("common.retry"), primary: true }]
      });
      if (choice !== "retry") return false;
    }
  }
}

// Interroge les relais avec un nombre limité de connexions simultanées (file d'attente, sans attendre la fin de chaque lot).
async function fetchFromRelays(urls, kinds, concurrency = FETCH_CONCURRENCY) {
  const events = [];
  let successfulResponses = 0, next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const result = await fetchEvents(urls[next++], kinds);
      if (result === null) continue;
      successfulResponses++;
      events.push(...result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  if (!successfulResponses) throw new Error("RELAY_LOAD_FAILED");
  return { events, responded: successfulResponses, total: urls.length };
}

async function loadAccount() {
  // Découverte NIP-65 depuis les relais initiaux.
  // Une seule requête (profil + listes) par relais initial, puis seulement les relais NIP-65 non encore interrogés.
  const kinds = [PROFILE_KIND, ...Object.values(LISTS).map(l => l.kind)];
  const boot = await fetchFromRelays(BOOT_RELAYS, kinds, BOOT_FETCH_CONCURRENCY);
  const events = [...boot.events];
  let responded = boot.responded, total = boot.total;
  const nip65 = latestEvent(events, LISTS.pub.kind);
  const bootUrls = new Set(BOOT_RELAYS);
  const extra = [...new Set((nip65 ? relaysFromEvent(nip65, LISTS.pub) : []).map(r => r.url))]
    .filter(url => !bootUrls.has(url));
  if (extra.length) {
    const more = await fetchFromRelays(extra, kinds).catch(() => null);
    total += extra.length;
    if (more) { events.push(...more.events); responded += more.responded; }
  }

  showProfile(profileFromEvents(events));
  for (const list of Object.values(LISTS)) {
    const latest = latestEvent(events, list.kind);
    list.relays = latest ? relaysFromEvent(latest, list) : [];
    list.extraTags = latest ? extraTagsFromEvent(latest, list) : [];
    list.content = latest && typeof latest.content === "string" ? latest.content : "";
    // found = un événement existant a été lu ; sinon « introuvable » (≠ « n'existe pas » : les relais interrogés ont pu l'ignorer).
    list.found = Boolean(latest);
    list.lookup = { responded, total };
  }
  render();
  void testAll();
}

// Utilisé par toutes les publications pour déterminer les relais d’écriture.
function writableRelayUrls(relays) {
  return relays.filter(relay => relay.write).map(relay => relay.url);
}

// Traduit les réponses techniques les plus fréquentes des relais.
function relayErrorText(msg) {
  const m = String(msg || "").trim();
  if (!m) return t("relayErrors.refused");
  if (/kind not allowed/i.test(m)) return t("relayErrors.kindNotAllowed");
  if (/insecure websocket/i.test(m)) return t("relayErrors.insecure");
  if (/rate.?limit/i.test(m)) return t("relayErrors.rateLimit");
  if (/auth/i.test(m)) return t("relayErrors.auth");
  if (/^blocked/i.test(m)) return t("relayErrors.blocked");
  return m;
}

function relayResultDetails(results) {
  return results.map(r => ({ ok: r.ok, text: r.url + (r.ok ? "" : " — " + relayErrorText(r.msg)) }));
}

function requestPublish(key) {
  if (publishing || !LISTS[key]) return;
  if (!LISTS[key].relays.length) {
    void showMessage({ tone: "alert", title: t("publish.noRelaysTitle"), text: t("publish.noRelaysText"), actions: OK_ACTION });
    return;
  }
  pendingPublishKey = key;
  const unreachable = LISTS[key].relays.filter(r => latencies[r.url]?.err).map(r => r.url);
  const list = LISTS[key];
  let confirmText = t("publish.confirm", { title: list.title });
  if (!list.found) confirmText = t("publish.confirmNotFound", { title: list.title, ...list.lookup });
  else if (!list.dirty) confirmText = t("publish.confirmUnchanged", { title: list.title });
  if (unreachable.length) confirmText += t("publish.confirmUnreachable", { count: unreachable.length, urls: unreachable.join(", ") });
  $("publishConfirmText").textContent = confirmText;
  $("publishConfirm").showModal();
  $("publishNo").focus();
}

async function publish(key) {
  let retry = null;
  do { retry = await publishOnce(key, retry); } while (retry);
}

// Renvoie l’événement signé si l’utilisateur demande de réessayer l’envoi (sans re-signer).
async function publishOnce(key, signedEvent = null) {
  const list = LISTS[key];
  dbg("publishOnce", { key, retry: !!signedEvent, publishing });
  if (!list || publishing || !list.relays.length) return null;
  if (!signedEvent && navigator.onLine === false) {
    await showMessage({ tone: "alert", title: t("publish.offlineTitle"), text: t("publish.offlineText"), actions: OK_ACTION });
    return null;
  }
  publishing = true;
  const buttons = [...document.querySelectorAll("[data-publish-category]")];
  buttons.forEach(button => { button.disabled = true; });
  let progressStartedAt = performance.now();
  let awaitingSignature = !signedEvent;
  try {
    let event = signedEvent;
    if (!event) {
      // Statut non modal : la pop-up du signer reste visible et cliquable.
      const wait = showMessage({ tone: "busy", modal: false, title: t("publish.signingTitle"), text: t("publish.signingText"), actions: [{ id: "cancel", label: t("common.cancel") }] });
      const cancelled = wait.then(choice => choice === "cancel" ? Promise.reject(new Error("USER_CANCELLED")) : new Promise(() => {}));
      cancelled.catch(() => {});
      const unsigned = { kind: list.kind, created_at: Math.floor(Date.now() / 1000), tags: tagsFromList(list), content: list.content };
      dbg("signEvent appelé", { signer: signer?.id, kind: unsigned.kind, created_at: unsigned.created_at, tags: unsigned.tags.length });
      if (!signer) throw new Error("SIGNER_UNAVAILABLE");
      // Une réponse tardive du signer ne doit jamais déclencher une publication : délai et annulation gérés par le signer.
      event = checkSignedEvent(await signer.signEvent(unsigned, cancelled), unsigned, pubkey);
    }
    awaitingSignature = false;
    await waitForMinimumDisplay(progressStartedAt);
    progressStartedAt = performance.now();
    showMessage({ tone: "busy", title: t("publish.sendingTitle"), text: t("publish.sendingText", { title: list.title }) });
    // Relais de l’utilisateur + relais de diffusion, sans doublons.
    const own = [...new Set([
      ...(list.rw ? writableRelayUrls(list.relays) : []),
      ...writableRelayUrls(LISTS.pub.relays)
    ])];
    const ownSet = new Set(own);
    const broadcast = BOOT_RELAYS.filter(url => !ownSet.has(url));
    const results = await Promise.all([...own, ...broadcast].map(url => publishTo(url, event)));
    await waitForMinimumDisplay(progressStartedAt);
    const accepted = results.filter(r => r.ok).length;
    const ownResults = results.filter(r => own.includes(r.url));
    const broadcastResults = results.filter(r => !own.includes(r.url));
    const ownOk = ownResults.filter(r => r.ok).length;
    const broadcastOk = broadcastResults.filter(r => r.ok).length;
    const details = [];
    if (ownResults.length) details.push({ heading: true, text: t("publish.ownHeading", { ok: ownOk, total: ownResults.length }) }, ...relayResultDetails(ownResults));
    if (broadcastResults.length) details.push({ heading: true, text: t("publish.broadcastHeading", { ok: broadcastOk, total: broadcastResults.length }) }, ...relayResultDetails(broadcastResults));
    if (!accepted) {
      const choice = await showMessage({
        tone: "alert", title: t("publish.failedTitle"),
        text: t("publish.failedText"),
        details, actions: [{ id: "close", label: t("common.close") }, { id: "retry", label: t("publish.retrySend"), primary: true }]
      });
      return choice === "retry" ? event : null;
    }
    list.dirty = false;
    list.found = true;
    render();
    const ownWarning = ownResults.length > 0 && ownOk === 0;
    await showMessage({
      tone: ownWarning ? "alert" : "success",
      title: t(ownWarning ? "publish.partialTitle" : "publish.successTitle"),
      text: t("publish.resultText", { accepted, total: results.length }) +
        (ownResults.length
          ? t("publish.resultDetail", { ownOk, ownTotal: ownResults.length, broadcastOk, broadcastTotal: broadcastResults.length })
          : t("publish.resultEnd")) +
        t("publish.resultBroadcastNote") +
        (ownWarning ? t("publish.resultOwnWarning") : ""),
      details, actions: OK_ACTION
    });
    // Avertissement systématique après toute publication acceptée par au moins un relais.
    await showMessage({ tone: "alert", title: list.notice.title, text: list.notice.text, actions: OK_ACTION });
    return null;
  } catch (error) {
    if (error?.message === "USER_CANCELLED") { hideMessage(); return null; }
    await waitForMinimumDisplay(progressStartedAt);
    const msg = String(error?.message || "");
    let alertTitle = t("publish.errors.title");
    let alertText = msg || t("publish.errors.default");
    if (msg === "SIGNED_EVENT_INVALID") alertText = t("publish.errors.invalidEvent");
    else if (msg === "SIGNED_EVENT_MODIFIED") alertText = t("publish.errors.modifiedEvent");
    if (awaitingSignature) {
      if (/context invalidated/i.test(msg)) {
        const choice = await showMessage({
          tone: "alert", title: t("publish.errors.extensionTitle"),
          text: t("publish.errors.extensionText"),
          actions: [{ id: "close", label: t("common.close") }, { id: "reload", label: t("publish.errors.reload"), primary: true }]
        });
        if (choice === "reload") { Object.values(LISTS).forEach(l => { l.dirty = false; }); location.reload(); }
        return null;
      } else if (isRefusal(error)) {
        alertTitle = t("publish.errors.refusedTitle");
        alertText = t("publish.errors.refusedText");
      } else if (msg === "SIGNER_TIMEOUT" || msg === "SIGNER_UNAVAILABLE" || msg === "NIP46_CLOSED" || msg === "NIP46_RELAYS_UNREACHABLE") {
        alertTitle = t("publish.errors.unavailableTitle");
        alertText = t("publish.errors.unavailableText");
      } else if (msg === "SIGNATURE_MISSING") {
        alertTitle = t("publish.errors.missingTitle");
        alertText = t("publish.errors.missingText");
      } else if (/lock|verrouill/i.test(msg)) {
        alertTitle = t("publish.errors.lockedTitle");
        alertText = t("publish.errors.lockedText");
      } else if (error?.fromSigner) {
        alertTitle = t("publish.errors.signerTitle");
        alertText = t("publish.errors.signerText");
      }
    }
    // Message d'origine du signer, affiché séparément et tel quel.
    const details = awaitingSignature && error?.fromSigner && msg
      ? [{ heading: true, text: t("publish.errors.signerMessageHeading") }, { plain: true, text: msg }]
      : undefined;
    await showMessage({ tone: "alert", title: alertTitle, text: alertText, details, actions: OK_ACTION });
    return null;
  } finally {
    publishing = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

async function logout() {
  if (Object.values(LISTS).some(l => l.dirty)) {
    const choice = await showMessage({
      tone: "alert", title: t("logout.title"),
      text: t("logout.text"),
      actions: [{ id: "no", label: t("common.cancel"), defaultFocus: true }, { id: "yes", label: t("logout.confirm"), primary: true }]
    });
    if (choice !== "yes") return;
  }
  // Rechargement complet : le signer est redétecté (window.nostr n’est injecté qu’au chargement)
  // et toutes les données du compte sont effacées de la mémoire.
  Object.values(LISTS).forEach(list => { list.dirty = false; }); // évite l’avertissement du navigateur : la confirmation a déjà été donnée
  location.reload();
}

/* 10. Écouteurs d’événements ------------------------------------------- */
initRelayAccordions();
$("relayModeChoices").querySelectorAll("[data-mode]").forEach(button => {
  button.addEventListener("click", () => selectRelayMode(button.dataset.mode));
});
$("relayModeCancel").addEventListener("click", () => $("relayModeDialog").close());
$("relayModeAdd").addEventListener("click", () => {
  if (!pendingRelay) return;
  const { list, url } = pendingRelay;
  const mode = selectedRelayMode;
  $("relayModeDialog").close();
  commitRelay(list, url, mode);
});
$("relayModeDialog").addEventListener("close", () => { pendingRelay = null; });
$("btnLogin").addEventListener("click", login);
$("btnLoginNip46").addEventListener("click", loginWithNip46);
$("nip46BunkerConnect").addEventListener("click", connectWithBunker);
$("nip46Bunker").addEventListener("keydown", e => { if (e.key === "Enter") connectWithBunker(); });
$("nip46Copy").addEventListener("click", copyNip46Link);
$("nip46Cancel").addEventListener("click", () => nip46Attempt?.cancel());
nip46Dialog.addEventListener("cancel", event => { event.preventDefault(); nip46Attempt?.cancel(); });
$("btnLogout").addEventListener("click", logout);
$("btnAdd").addEventListener("click", () => addRelay($("newUrl").value));
$("newUrl").addEventListener("keydown", e => {
  if (e.key === "Enter") addRelay(e.target.value);
});
$("publishNo").addEventListener("click", () => $("publishConfirm").close());
$("publishConfirm").addEventListener("close", () => { pendingPublishKey = null; });
$("publishYes").addEventListener("click", () => {
  const key = pendingPublishKey;
  dbg("clic Publier", key);
  $("publishConfirm").close();
  if (key) void publish(key);
});
// Révélation au défilement, y compris pour les cartes affichées après connexion
// ou déplacées dans un accordéon. Les éléments masqués restent hors animation.
const revealMotion = matchMedia("(prefers-reduced-motion: reduce)");
const revealCards = [...document.querySelectorAll(".card")];
const revealPage = document.querySelector(".page");
let revealEnterObserver;
let revealLeaveObserver;

function resetCardReveal(card) {
  card.classList.remove("is-entering", "is-visible");
  card.style.removeProperty("--reveal-delay");
}

function configureCardReveal() {
  revealEnterObserver?.disconnect();
  revealLeaveObserver?.disconnect();
  revealCards.forEach(card => {
    resetCardReveal(card);
    card.classList.remove("reveal-ready");
  });
  if (revealMotion.matches || !("IntersectionObserver" in window)) return;

  revealCards.forEach(card => card.classList.add("reveal-ready"));
  revealEnterObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const card = entry.target;
      if (!entry.isIntersecting || card.classList.contains("is-visible")) continue;
      // Les cartes ne sont pas disposées en grille dans cette application.
      card.style.setProperty("--reveal-delay", "0ms");
      card.classList.add("is-entering", "is-visible");
    }
  }, {
    root: revealPage,
    threshold: 0,
    rootMargin: "-136px 0px -64px 0px"
  });
  revealLeaveObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) resetCardReveal(entry.target);
    }
  }, { root: revealPage, threshold: 0 });
  revealCards.forEach(card => {
    revealEnterObserver.observe(card);
    revealLeaveObserver.observe(card);
  });
  syncRelayReveal();
}

// Les relais sont reconstruits par render() : observer chaque nouvelle ligne.
function syncRelayReveal() {
  if (!revealEnterObserver || !revealLeaveObserver || revealMotion.matches) return;
  document.querySelectorAll("#list .relay").forEach(relay => {
    if (relay.classList.contains("reveal-ready")) return;
    relay.classList.add("reveal-ready");
    revealEnterObserver.observe(relay);
    revealLeaveObserver.observe(relay);
  });
}

revealPage.addEventListener("focusin", event => {
  const card = event.target.closest(".card.reveal-ready, .relay.reveal-ready");
  if (!card) return;
  resetCardReveal(card);
  card.classList.add("is-visible");
});
revealMotion.addEventListener("change", configureCardReveal);
configureCardReveal();

window.addEventListener("beforeunload", e => {
  if (Object.values(LISTS).some(l => l.dirty)) e.preventDefault();
});
