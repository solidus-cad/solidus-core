import type { MenuItem } from "../components/ContextMenu.tsx";
import { t } from "../i18n.ts";
import { activeSection, toggleCut } from "../section.ts";
import { startSketch3D } from "../sketch3d/session.ts";
import { hasModuleAction, runModuleAction } from "../host.ts";
import { canPasteComponents, componentAt, copySelection, copyToClipboard, cutToClipboard, deleteSelection, editInPlace, editPartInContext, partDoc, pasteFromClipboard, pickComponent, setFlexible, updateComponent, ws } from "../workspace.ts";
import { openReplaceDialog } from "./ReplaceDialog.tsx";

/**
 * Context menu of an occurrence (assembly tree and 3D view): `path` is the top-level occurrence
 * or the part of a sub-assembly ("occurrence/part"). `rename`: in-place renaming (tree only).
 */
export function componentMenuItems(path: string, rename?: () => void): MenuItem[] {
  const c = componentAt(path);
  if (!c) return [];
  if (!ws.selection.includes(path)) pickComponent(path, false);
  const top = !path.includes("/");
  const part = !c.assemblyId && !!c.partId;
  const items: MenuItem[] = [];
  // Opening first: alone in its tab, or in place among the other parts.
  items.push({ label: c.assemblyId ? t("asm.openSub") : t("asm.open"), run: () => editPartInContext(path) });
  if (part && !c.skeleton) items.push({ label: t("asm.editInPlace"), run: () => editInPlace(path) });
  // Hide: top-level occurrence (a sub-assembly part belongs to it).
  if (top) items.push({ label: c.hidden ? t("asm.show") : t("asm.hide"), run: () => updateComponent(c.id, { hidden: !c.hidden }) });
  if (top && !c.skeleton) items.push({ label: `${t("asm.replace")}…`, run: () => openReplaceDialog(c.id) });
  if (!top) return items;

  if (c.assemblyId) items.push({ label: c.flexible ? t("asm.makeRigid") : t("asm.makeFlexible"), run: () => setFlexible(c.id, !c.flexible) });
  if (rename) items.push({ label: t("tree.rename"), run: rename });
  items.push({ label: c.fixed ? t("asm.unfix") : t("asm.fix"), run: () => updateComponent(c.id, { fixed: !c.fixed }) });
  if (!c.assemblyId) items.push({ label: c.skeleton ? t("asm.unskeleton") : t("asm.markSkeleton"), run: () => updateComponent(c.id, c.skeleton ? { skeleton: false } : { skeleton: true, fixed: true }) });
  if (c.skeleton) items.push({ label: t("s3d.new"), run: () => startSketch3D(undefined, c.id) });
  if (partDoc(c.partId)?.frameSource && hasModuleAction("frame.start")) {
    items.push({ label: t("frm.edit"), run: () => runModuleAction("frame.start", c.id) }, { label: t("frm.cutList"), run: () => runModuleAction("frame.cutList", c.partId) });
  }
  const section = activeSection();
  if (section) items.push({ label: section.excluded.includes(c.id) ? t("sec.doCut") : t("sec.noCut"), run: () => toggleCut(c.id) });
  items.push({ label: t("asm.clipCopy"), run: copyToClipboard }, { label: t("asm.cut"), run: cutToClipboard });
  if (canPasteComponents()) items.push({ label: t("asm.paste"), run: () => void pasteFromClipboard() });
  items.push({ label: t("asm.duplicate"), run: copySelection }, { label: t("tree.delete"), run: deleteSelection, danger: true });
  return items;
}
