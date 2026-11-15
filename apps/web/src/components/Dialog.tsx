import { createSignal, For, Show } from "solid-js";

export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
}

interface DialogSpec {
  title: string;
  text: string;
  buttons: DialogButton[];
  /** Choice returned by Escape or a click outside the dialog. */
  dismiss: string;
  resolve: (id: string) => void;
}

const [dialog, setDialog] = createSignal<DialogSpec | null>(null);

export function showDialog(title: string, text: string): void {
  void ask(title, text, [{ id: "ok", label: "OK", primary: true }], "ok");
}

/** Multi-choice dialog: returns the identifier of the clicked button (`dismiss` if closed otherwise). */
export function ask(title: string, text: string, buttons: DialogButton[], dismiss: string): Promise<string> {
  dialog()?.resolve(dialog()!.dismiss);
  return new Promise((resolve) =>
    setDialog({
      title,
      text,
      buttons,
      dismiss,
      resolve: (id) => {
        setDialog(null);
        resolve(id);
      },
    }),
  );
}

export function Dialog() {
  return (
    <Show when={dialog()}>
      {(d) => (
        <div class="dialog-backdrop" onClick={() => d().resolve(d().dismiss)}>
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={d().title}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Application shortcuts must not act behind the dialog.
              e.stopPropagation();
              if (e.key === "Escape") d().resolve(d().dismiss);
            }}
          >
            <h2>{d().title}</h2>
            <p>{d().text}</p>
            <div class="dialog-actions">
              <For each={d().buttons}>
                {(b) => (
                  <button class="btn" classList={{ primary: b.primary }} onClick={() => d().resolve(b.id)} ref={(el) => b.primary && queueMicrotask(() => el.focus())}>
                    {b.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
