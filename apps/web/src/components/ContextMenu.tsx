import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
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
          style={{ left: `${Math.min(m().x, window.innerWidth - 200)}px`, top: `${Math.min(m().y, window.innerHeight - m().items.length * 30 - 10)}px` }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <For each={m().items}>
            {(item) => (
              <li>
                <button
                  classList={{ danger: !!item.danger }}
                  onClick={() => {
                    setMenu(null);
                    item.run();
                  }}
                >
                  {item.label}
                </button>
              </li>
            )}
          </For>
        </ul>
      )}
    </Show>
  );
}
