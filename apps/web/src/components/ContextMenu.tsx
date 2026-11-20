import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

/** Margin kept between the menu and the window edges (px). */
const EDGE = 6;

export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  /** Colour choices shown after the label (clicking the label runs `run`). */
  swatches?: { color: string; title: string; active?: boolean; run: () => void }[];
}

const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);

export function openContextMenu(ev: MouseEvent, items: MenuItem[]): void {
  ev.preventDefault();
  setMenu({ x: ev.clientX, y: ev.clientY, items });
}

export function ContextMenu() {
  onMount(() => {
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    onCleanup(() => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    });
  });

  return (
    <Show when={menu()}>
      {(m) => (
        <ul
          class="menu-popup context"
          style={{ left: `${m().x}px`, top: `${m().y}px`, "max-height": `${window.innerHeight - 2 * EDGE}px` }}
          ref={(el) =>
            // Real size once laid out: the menu opens upwards / leftwards when it would leave the window.
            requestAnimationFrame(() => {
              const r = el.getBoundingClientRect();
              const x = m().x + r.width > window.innerWidth - EDGE ? Math.max(EDGE, m().x - r.width) : m().x;
              const y = m().y + r.height > window.innerHeight - EDGE ? Math.max(EDGE, Math.min(m().y - r.height, window.innerHeight - EDGE - r.height)) : m().y;
              el.style.left = `${x}px`;
              el.style.top = `${y}px`;
            })
          }
          onPointerDown={(e) => e.stopPropagation()}
        >
          <For each={m().items}>
            {(item) => (
              <li classList={{ "has-swatches": !!item.swatches }}>
                <button
                  classList={{ danger: !!item.danger }}
                  onClick={() => {
                    setMenu(null);
                    item.run();
                  }}
                >
                  {item.label}
                </button>
                <Show when={item.swatches}>
                  {(sw) => (
                    <span class="menu-swatches">
                      <For each={sw()}>
                        {(c) => (
                          <button
                            class="menu-swatch"
                            classList={{ active: !!c.active }}
                            style={{ "--swatch": c.color }}
                            title={c.title}
                            aria-label={`${item.label} — ${c.title}`}
                            onClick={() => {
                              setMenu(null);
                              c.run();
                            }}
                          />
                        )}
                      </For>
                    </span>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      )}
    </Show>
  );
}
