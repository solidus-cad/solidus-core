/**
 * Keyboard shortcuts: representation of key combinations.
 *
 * Canonical format: modifiers in the order `Ctrl+Alt+Shift+Key`
 * (e.g. "Ctrl+Shift+Z", "F", "Delete", "F2"). `Ctrl` also covers `Meta` (⌘ on Mac).
 * Two-key sequence (FreeCAD style): two combos separated by a space ("V F").
 */

/** Minimal keyboard event (tests pass plain objects). */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Maximum delay between the two keys of a sequence (ms). */
export const SEQUENCE_MS = 800;

/** Combinations reserved by the browser: rejected as input. */
export const RESERVED: string[] = ["Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+Shift+T", "Ctrl+Tab", "F11", "F12"];

const MODIFIERS = ["Ctrl", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Modifier aliases (case- and accent-insensitive). */
const MOD_ALIASES: Record<string, Modifier> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Ctrl",
  meta: "Ctrl",
  "⌘": "Ctrl",
  "⌃": "Ctrl",
  alt: "Alt",
  option: "Alt",
  "⌥": "Alt",
  shift: "Shift",
  maj: "Shift",
};

/** Named key aliases (French and English, case- and accent-insensitive). */
const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  echap: "Escape",
  enter: "Enter",
  return: "Enter",
  entree: "Enter",
  tab: "Tab",
  delete: "Delete",
  del: "Delete",
  suppr: "Delete",
  backspace: "Backspace",
  "retour arriere": "Backspace",
  space: "Space",
  espace: "Space",
  arrowup: "ArrowUp",
  haut: "ArrowUp",
  "fleche haut": "ArrowUp",
  arrowdown: "ArrowDown",
  bas: "ArrowDown",
  "fleche bas": "ArrowDown",
  arrowleft: "ArrowLeft",
  gauche: "ArrowLeft",
  "fleche gauche": "ArrowLeft",
  arrowright: "ArrowRight",
  droite: "ArrowRight",
  "fleche droite": "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
};

/** Named keys accepted as is (standardized ev.key). */
const NAMED = /^(Escape|Enter|Tab|Delete|Backspace|Space|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|CapsLock|F\d{1,2})$/;

const normalize = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Parses a simple combination ("Ctrl+Shift+Z"); null if invalid. */
function parseSingle(text: string): string | null {
  const tokens = text
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const token of tokens) {
    const n = normalize(token);
    const mod = MOD_ALIASES[n];
    if (mod) {
      if (mods.has(mod)) return null;
      mods.add(mod);
      continue;
    }
    if (key !== null) return null; // two keys in the same combination
    const alias = KEY_ALIASES[n];
    if (alias) {
      key = alias;
      continue;
    }
    if (/^[a-z]$/.test(n) || /^[0-9]$/.test(n)) {
      key = n.toUpperCase();
      continue;
    }
    if (/^f\d{1,2}$/.test(n)) {
      key = "F" + n.slice(1);
      continue;
    }
    if (NAMED.test(token)) {
      key = token;
      continue;
    }
    return null;
  }
  if (key === null) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}

/** Parses a shortcut: a combination, or a "V F" sequence (two keys). null if invalid. */
export function parseCombo(text: string): string | null {
  const parts = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const parsed = parts.map(parseSingle);
  if (parsed.some((p) => p === null)) return null;
  return parsed.join(" ");
}

/** Main key of an event: digits via `code` (AZERTY), letters via `key`. */
function mainKey(ev: KeyEventLike): string | null {
  const code = ev.code ?? "";
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!; // AZERTY: ev.key would give "&", "é"…
  if (/^Key[A-Z]$/.test(code) && /^[a-zA-Z]$/.test(ev.key)) return ev.key.toUpperCase(); // L stays L in AZERTY
  if (ev.key === " ") return "Space";
  if (ev.key.length === 1) return ev.key;
  if (NAMED.test(ev.key)) return ev.key;
  return null; // "Dead", "Unidentified", modificateur…
}

/** Canonical combination of an event, or null (modifier alone, dead key…). */
export function eventToCombo(ev: KeyEventLike): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(ev.key)) return null;
  const main = mainKey(ev);
  if (main === null) return null;
  const mods: string[] = [];
  if (ev.ctrlKey || ev.metaKey) mods.push("Ctrl"); // Meta (⌘) = Ctrl
  if (ev.altKey) mods.push("Alt");
  if (ev.shiftKey) mods.push("Shift");
  return [...mods, main].join("+");
}

const isMac = (): boolean => {
  try {
    const nav = navigator as Navigator | undefined;
    return /mac/i.test(nav?.platform ?? nav?.userAgent ?? "");
  } catch {
    return false;
  }
};

/** Localized label of a single key. */
function formatKey(key: string, lang: "fr" | "en"): string {
  const map: Record<string, [string, string]> = {
    Delete: ["Suppr", "Del"],
    Escape: ["Échap", "Esc"],
    Enter: ["Entrée", "Enter"],
    Space: ["Espace", "Space"],
    Backspace: ["Retour arr.", "Backspace"],
    Tab: ["Tab", "Tab"],
    CapsLock: ["Verr maj", "Caps"],
    ArrowUp: ["↑", "↑"],
    ArrowDown: ["↓", "↓"],
    ArrowLeft: ["←", "←"],
    ArrowRight: ["→", "→"],
    Home: ["Début", "Home"],
    End: ["Fin", "End"],
    PageUp: ["Page↑", "PageUp"],
    PageDown: ["Page↓", "PageDown"],
    Insert: ["Inser", "Insert"],
  };
  const hit = map[key];
  if (hit) return lang === "fr" ? hit[0] : hit[1];
  return key; // lettres, chiffres, F1…
}

/** Displayable label of a shortcut ("Ctrl+Maj+Z" in fr, "⌘+Shift+Z" on Mac…). */
export function formatCombo(combo: string, lang: "fr" | "en" = "fr"): string {
  const mac = isMac();
  return combo
    .split(" ")
    .map((part) =>
      part
        .split("+")
        .map((token) => {
          if (token === "Ctrl") return mac ? "⌘" : "Ctrl";
          if (token === "Alt") return mac ? "⌥" : "Alt";
          if (token === "Shift") return lang === "fr" ? "Maj" : "Shift";
          return formatKey(token, lang);
        })
        .join(mac ? "" : "+"),
    )
    .join(" ");
}

/** Desktop app (Tauri): the browser does not intercept Ctrl+1…9. */
const isDesktop = (): boolean => {
  try {
    return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  } catch {
    return false;
  }
};

/** Combination captured by the browser before the page (Ctrl+1…9 = switch tab): inoperative on the web. */
export const browserBlocked = (combo: string): boolean => !isDesktop() && combo.split(" ").some((c) => /^Ctrl\+[1-9]$/.test(c));

/** Combination reserved by the browser. */
export const isReserved = (combo: string): boolean => RESERVED.includes(combo);

/** Valid shortcut (syntax + not reserved). */
export const validateCombo = (combo: string): boolean => parseCombo(combo) !== null && !isReserved(combo);
