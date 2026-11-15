import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { actionById, type ShortcutAction } from "../keymap/registry.ts";
import { capturing } from "../keymap/keymap.ts";
import { activeContext, activeScopes } from "../keymap/scopes.ts";
import { CARDINALS, gestureCount, gesturesEnabled, sectorAt, slotsFor, toGestureContext } from "./gestures.ts";

/** Minimal drag before the wheel opens (below it, the right click keeps its context menu). */
const OPEN_PX = 10;
/** Dead radius at the center: no command targeted. */
const DEAD_PX = 22;
/** Icon radius; beyond RADIUS + PASS_PX, the targeted command fires without releasing the button (as in SolidWorks). */
const RADIUS = 84;
const PASS_PX = 60;

/** Areas where a right-button drag opens the wheel: 3D view and drawing sheet, outside UI elements. */
const inZone = (target: EventTarget | null): boolean => {
  const el = target as Element | null;
  if (!el?.closest?.(".viewport, .drawing-area")) return false;
  return !el.closest("button, input, select, textarea, .sk-ui, .s3-ui");
};

interface Item {
  slot: number;
  action: ShortcutAction;
  enabled: boolean;
}

interface Open {
  x: number;
  y: number;
  items: Item[];
}

/** Fallback for a command without an icon: initials of the label ("Vue de face" → "VF"). */
const initials = (label: string): string =>
  label
    .split(/[\s'’-]+/)
    .filter((w) => w.length > 2 || /^[A-Z0-9]/.test(w))
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .slice(0, 2) || label.slice(0, 2);

const ANGLE = (slot: number) => (slot * Math.PI) / 4; // 0 = haut, sens horaire

export function GestureMenu() {
  const [menu, setMenu] = createSignal<Open | null>(null);
  const [selected, setSelected] = createSignal<number | null>(null);
  let start: { x: number; y: number } | null = null;
  /** The context menu of the right click that follows a gesture is swallowed. */
  let swallowContext = false;

  const itemsNow = (): Item[] => {
    const scopes = activeScopes();
    const slots = slotsFor(toGestureContext(activeContext()));
    const used = gestureCount() === 4 ? CARDINALS : [0, 1, 2, 3, 4, 5, 6, 7];
    return used.flatMap((slot) => {
      const action = slots[slot] ? actionById(slots[slot]!) : undefined;
      if (!action) return [];
      return [{ slot, action, enabled: scopes.includes(action.scope) && (action.enabled?.() ?? true) }];
    });
  };

  const close = () => {
    start = null;
    setMenu(null);
    setSelected(null);
  };

  const run = (slot: number | null) => {
    const item = menu()?.items.find((i) => i.slot === slot);
    close();
    if (item?.enabled) item.action.run();
  };

  onMount(() => {
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 2 || !gesturesEnabled() || capturing() || !inZone(ev.target)) return;
      start = { x: ev.clientX, y: ev.clientY };
      swallowContext = false;
    };

    const onMove = (ev: PointerEvent) => {
      if (!start) return;
      if (!(ev.buttons & 2)) return close();
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const d = Math.hypot(dx, dy);
      let m = menu();
      if (!m) {
        if (d < OPEN_PX) return;
        const items = itemsNow();
        if (!items.length) return;
        m = { ...start, items };
        setMenu(m);
        swallowContext = true;
      }
      const slot = d < DEAD_PX ? null : sectorAt(dx, dy, gestureCount());
      const hit = m.items.some((i) => i.slot === slot) ? slot : null;
      setSelected(hit);
      if (hit !== null && d > RADIUS + PASS_PX) run(hit);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.button !== 2 || !start) return;
      if (menu()) run(selected());
      else close();
    };

    const onContext = (ev: MouseEvent) => {
      if (!swallowContext) return;
      swallowContext = false;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && menu()) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        close();
      }
    };

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("contextmenu", onContext, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    });
  });

  return (
    <Show when={menu()}>
      {(m) => (
        <div class="gesture-menu" style={{ left: `${m().x}px`, top: `${m().y}px` }} aria-hidden="true">
          <div class="gesture-hub" />
          <Show when={m().items.find((i) => i.slot === selected())}>{(i) => <div class="gesture-caption">{i().action.label()}</div>}</Show>
          <For each={m().items}>
            {(item) => (
              <div
                class="gesture-item"
                classList={{ active: selected() === item.slot, disabled: !item.enabled }}
                style={{
                  left: `${Math.sin(ANGLE(item.slot)) * RADIUS}px`,
                  top: `${-Math.cos(ANGLE(item.slot)) * RADIUS}px`,
                }}
              >
                <Show when={item.action.icon} fallback={<span class="gesture-glyph">{initials(item.action.label())}</span>}>
                  <span class="icon" innerHTML={item.action.icon!} />
                </Show>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
