import { t, type TKey } from "../i18n.ts";
import { registerCommon, type CommonAction } from "./registry.ts";

const common = (id: string, label: TKey, defaults: string[], members: string[]): CommonAction => ({ id: `common.${id}`, label: () => t(label), defaults, members });

/**
 * Actions repeated across several workbenches: their shortcut is set once (category
 * "Common to workbenches") and each workbench follows it, unless it overrides it locally.
 */
export const COMMON_ACTIONS: CommonAction[] = [
  common("undo", "cmd.undo", ["Ctrl+Z"], ["edit.undo", "sketch.undo", "sketch3d.undo", "assembly.undo", "frame.undo", "drawing.undo", "cam.undo", "quote.undo"]),
  common("redo", "cmd.redo", ["Ctrl+Y", "Ctrl+Shift+Z"], ["edit.redo", "sketch.redo", "sketch3d.redo", "assembly.redo", "frame.redo", "drawing.redo", "cam.redo", "quote.redo"]),
  common("delete", "tree.delete", ["Delete", "Backspace"], ["sketch.delete", "sketch3d.delete", "assembly.delete", "drawing.delete"]),
  common("select", "sk.select", ["S"], ["sketch.select", "sketch3d.select", "drawing.select"]),
  common("dimension", "sk.dim", ["D"], ["sketch.dim", "sketch3d.dimension", "drawing.dimension"]),
  common("line", "sk.line", ["L"], ["sketch.line", "sketch3d.line", "drawing.line"]),
  common("rect", "sk.rect", ["R"], ["sketch.rect", "drawing.rect"]),
  common("circle", "sk.circle", ["C"], ["sketch.circle", "drawing.circle"]),
  common("arc", "sk.arc", ["A"], ["sketch.arc", "drawing.arc"]),
];

registerCommon(COMMON_ACTIONS);
