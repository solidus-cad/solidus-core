import { createEffect, createRoot, createSignal, on } from "solid-js";

export type Theme = "light" | "dark";

const KEY = "cad.theme";
const query = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

const stored = (): Theme | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
};

/** Explicit user choice; `null` = follow the system. */
let override = stored();
const system = (): Theme => (query?.matches ? "dark" : "light");

const [theme, setThemeSignal] = createSignal<Theme>(override ?? system());
export { theme };

/** Accent color: [light, dark]; `label` for the accents provided by a module (the core ones are named by i18n `accent.<id>`). */
export interface Accent {
  id: string;
  light: string;
  dark: string;
  label?: () => string;
}
export type AccentId = string;

/** Accents of the core. The first one is the default (no CSS override). */
const CORE_ACCENTS: readonly Accent[] = [
  { id: "blue", light: "#2f6fd6", dark: "#5b94ec" },
  { id: "teal", light: "#0f8b8d", dark: "#35c0c2" },
  { id: "green", light: "#2f9e5b", dark: "#4cbf7c" },
];

const AKEY = "cad.accent";
const storedAccent = (): AccentId => {
  try {
    return localStorage.getItem(AKEY) ?? "blue";
  } catch {
    return "blue";
  }
};
const [accent, setAccentSignal] = createSignal<AccentId>(storedAccent());
export { accent };

/**
 * Additional themes ("skins") provided by a module: overlay on a base theme (`data-skin` on the root element, styles of
 * the module), including the drawing sheet (paper and line). The module decides which skins and accents are offered or
 * locked; without a module, the application has the light and dark themes and every accent.
 */
export interface Skin {
  id: string;
  base: Theme;
  paper: string;
  ink: string;
  label: () => string;
  /** Tooltip of the theme while it is locked. */
  lockHint?: () => string;
}

export interface ThemeProvider {
  skins: readonly Skin[];
  /** Offered in the Appearance window (otherwise hidden). */
  skinOffered(id: string): boolean;
  skinLocked(id: string): boolean;
  /** Extra accents, after those of the core; `accentLocked` may lock them (the default accent is never locked). */
  accents?: readonly Accent[];
  accentLocked?(id: AccentId): boolean;
  /** Tooltip of a locked accent. */
  accentLockHint?: () => string;
  /** Reactive source: the theme is re-applied when it changes (rights obtained or lost). */
  watch?: () => unknown;
}

const [provider, setProvider] = createSignal<ThemeProvider | null>(null);
export function registerThemeProvider(p: ThemeProvider): void {
  setProvider(p);
}
export const themeProvider = provider;

export const SKINS = (): readonly Skin[] => provider()?.skins ?? [];
/** Accents offered: those of the core, then those of the theme module. */
export const ACCENTS = (): readonly Accent[] => [...CORE_ACCENTS, ...(provider()?.accents ?? [])];
export const accentLocked = (id: AccentId): boolean => id !== "blue" && !!provider()?.accentLocked?.(id);
export const skinLocked = (id: string): boolean => provider()?.skinLocked(id) ?? true;
export const skinOffered = (id: string): boolean => provider()?.skinOffered(id) ?? false;

export type SkinId = string;
/** Choice of the Appearance selector: base theme or additional theme. */
export type ThemeChoice = Theme | SkinId;

const SKEY = "cad.skin";
const storedSkin = (): SkinId | null => {
  try {
    return localStorage.getItem(SKEY) ?? (localStorage.getItem("cad.blueprint") === "1" ? "blueprint" : null);
  } catch {
    return null;
  }
};
const [skinChosen, setSkinChosen] = createSignal<SkinId | null>(storedSkin());
/** Active additional theme (chosen, provided and unlocked), otherwise null. */
export const skin = (): SkinId | null => {
  const id = skinChosen();
  return id && SKINS().some((k) => k.id === id) && !skinLocked(id) ? id : null;
};
export const themeChoice = (): ThemeChoice => skin() ?? theme();

/** Drawing sheet: paper and line, on screen (CSS variables) and in print. */
export const sheetColors = () => SKINS().find((k) => k.id === skin()) ?? { paper: "#ffffff", ink: "#000000" };

const apply = () => {
  const sk = SKINS().find((k) => k.id === skin());
  const th = sk ? sk.base : (override ?? system());
  setThemeSignal(th);
  const root = document.documentElement;
  root.dataset.theme = th;
  if (sk) {
    root.dataset.skin = sk.id;
    root.style.setProperty("--sheet-paper", sk.paper);
    root.style.setProperty("--sheet-ink", sk.ink);
  } else {
    delete root.dataset.skin;
    root.style.removeProperty("--sheet-paper");
    root.style.removeProperty("--sheet-ink");
  }
  // Locked accent (code removed, plan ended): default accent.
  const a = ACCENTS().find((x) => x.id === accent() && !accentLocked(x.id)) ?? CORE_ACCENTS[0]!;
  if (a.id === "blue") {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-soft");
  } else {
    root.style.setProperty("--accent", th === "dark" ? a.dark : a.light);
    root.style.setProperty("--accent-soft", "color-mix(in srgb, var(--accent) " + (th === "dark" ? 22 : 13) + "%, var(--panel))");
  }
};

/** Re-applies the theme (rights changed: themes and accents unlocked or locked). */
export const refreshTheme = apply;

export function setAccent(id: AccentId) {
  setAccentSignal(id);
  try {
    localStorage.setItem(AKEY, id);
  } catch {
    /* storage unavailable */
  }
  apply();
}

/** Call before the first render; then follows system changes as long as no explicit choice exists. */
export function initTheme() {
  apply();
  createRoot(() => createEffect(on(() => [provider(), provider()?.watch?.()], apply, { defer: true })));
  query?.addEventListener("change", () => {
    if (!override) apply();
  });
}

function chooseSkin(id: SkinId | null) {
  setSkinChosen(id);
  try {
    if (id) localStorage.setItem(SKEY, id);
    else localStorage.removeItem(SKEY);
    localStorage.removeItem("cad.blueprint"); // previous setting (Blueprint theme only)
  } catch {
    /* storage unavailable */
  }
}

function chooseBase(th: Theme) {
  override = th;
  try {
    localStorage.setItem(KEY, th);
  } catch {
    /* storage unavailable: the choice applies for the session */
  }
}

/** Appearance selector: light, dark or additional theme (no visible effect until unlocked). */
export function setThemeChoice(c: ThemeChoice) {
  if (c === "light" || c === "dark") {
    chooseBase(c);
    chooseSkin(null);
  } else chooseSkin(c);
  apply();
}

/** Toggles light/dark; leaves the additional theme if active. */
export function toggleTheme() {
  setThemeChoice(theme() === "dark" ? "light" : "dark");
}
