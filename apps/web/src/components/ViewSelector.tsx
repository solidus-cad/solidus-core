import type { Viewer } from "@solidus-cad/viewer";
import { t } from "../i18n.ts";
import { openContextMenu } from "./ContextMenu.tsx";

type Face = "front" | "back" | "left" | "right" | "top" | "bottom";

export interface AngledView {
  faces: Face[];
  /** Direction from the target to the camera (Z-up coordinate system). */
  dir: { x: number; y: number; z: number };
}

const SIGNS = [-1, 0, 1];

/** Views looking at 2 faces (12 views at 45°), then at 3 faces (8 isometric views). */
export function angledViews(): AngledView[] {
  const views: AngledView[] = [];
  for (const y of SIGNS) {
    for (const x of SIGNS) {
      for (const z of SIGNS) {
        const faces: (Face | null)[] = [y < 0 ? "front" : y > 0 ? "back" : null, x < 0 ? "left" : x > 0 ? "right" : null, z > 0 ? "top" : z < 0 ? "bottom" : null];
        const named = faces.filter((f): f is Face => f !== null);
        if (named.length >= 2) views.push({ faces: named, dir: { x, y, z } });
      }
    }
  }
  return views.sort((a, b) => a.faces.length - b.faces.length);
}

/**
 * Views the orientation cube does not offer. Keep this a flat text list, with no 3D drawing and nothing that follows the
 * camera (design rule of the orientation cube, see `packages/viewer/src/viewcube.ts`).
 */
export function ViewSelector(props: { viewer: Viewer }) {
  const open = (e: MouseEvent) =>
    openContextMenu(
      e,
      angledViews().map((v) => ({
        label: v.faces.map((f) => t(`cube.${f}`)).join(" + "),
        run: () => props.viewer.lookAlong(v.dir, { x: 0, y: 0, z: 1 }),
      })),
    );

  return (
    <button title={t("view.others")} aria-haspopup="menu" onClick={open}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M5 7h14M5 12h14M5 17h14" />
      </svg>
      {t("view.others")}
    </button>
  );
}
