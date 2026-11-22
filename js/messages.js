/* Textes de l'application : chargés depuis data/messages.json.
   t("clé.sous-clé", { variable }) renvoie le texte, en remplaçant {variable}. */

let messages = {};

export function setMessages(data) {
  messages = data || {};
}

// Renvoie la valeur brute (texte, objet ou liste) d'une clé.
export function msg(key) {
  return key.split(".").reduce((node, part) => node?.[part], messages);
}

// Renvoie un texte, avec remplacement des variables {nom}. Clé introuvable : la clé elle-même (repérable à l'écran).
export function t(key, vars = {}) {
  const value = msg(key);
  if (typeof value !== "string") {
    console.warn("Message introuvable :", key);
    return key;
  }
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
