import type { TKey } from "../i18n.ts";

/** Company paying for a tip. Files stay in `public/tips/`: nothing is loaded from the sponsor's servers. */
export interface TipSponsor {
  name: string;
  /** Path relative to the site root, e.g. `tips/acme.svg`; the name is displayed without it. */
  logo?: string;
  url: string;
}

export interface Tip {
  id: string;
  title: TKey;
  text: TKey;
  /** Screenshot, path relative to the site root, e.g. `tips/gestures.webp`. */
  image?: string;
  sponsor?: TipSponsor;
}

export const TIPS: Tip[] = [
  { id: "gestures", title: "tip.gestures.title", text: "tip.gestures.text" },
  { id: "shortcuts", title: "tip.shortcuts.title", text: "tip.shortcuts.text" },
  { id: "checkpoints", title: "tip.checkpoints.title", text: "tip.checkpoints.text" },
  { id: "parameters", title: "tip.parameters.title", text: "tip.parameters.text" },
  { id: "family", title: "tip.family.title", text: "tip.family.text" },
  { id: "section", title: "tip.section.title", text: "tip.section.text" },
  { id: "interference", title: "tip.interference.title", text: "tip.interference.text" },
  { id: "mass", title: "tip.mass.title", text: "tip.mass.text" },
  { id: "colors", title: "tip.colors.title", text: "tip.colors.text" },
  { id: "dragPart", title: "tip.dragPart.title", text: "tip.dragPart.text" },
  { id: "search", title: "tip.search.title", text: "tip.search.text" },
  { id: "preview", title: "tip.preview.title", text: "tip.preview.text" },
  { id: "marks", title: "tip.marks.title", text: "tip.marks.text" },
];
