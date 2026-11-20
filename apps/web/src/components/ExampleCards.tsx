import { For } from "solid-js";
import { t } from "../i18n.ts";
import { EXAMPLES, exampleBusy, exampleUrl, openExample } from "../docfiles/examples.ts";

/** The example assemblies, one click each (tips pane, end of the guided tour). `onOpened`: after a successful opening. */
export function ExampleCards(props: { onOpened?: () => void }) {
  return (
    <div class="example-cards">
      <For each={EXAMPLES.filter((ex) => ex.card)}>
        {(ex) => (
          <button
            class="example-card"
            title={t("ex.open")}
            disabled={exampleBusy() !== null}
            aria-busy={exampleBusy() === ex.id}
            onClick={() => void openExample(ex).then((id) => id && props.onOpened?.())}
          >
            <img src={exampleUrl(ex.card!.thumb)} alt="" loading="lazy" width="480" height="360" />
            <span>{exampleBusy() === ex.id ? t("ex.opening") : t(ex.card!.title)}</span>
          </button>
        )}
      </For>
    </div>
  );
}
