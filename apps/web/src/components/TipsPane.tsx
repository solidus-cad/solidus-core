import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { t } from "../i18n.ts";
import { contributions } from "../host.ts";
import { TIPS } from "./tips.ts";
import { ExampleCards } from "./ExampleCards.tsx";

const LIBRARY_TAB = "right.library";

const url = (path: string) => `${import.meta.env.BASE_URL}${path}`;

/** Drawn once per launch: coming back to the tab shows the same tip. */
const [index, setIndex] = createSignal(Math.floor(Math.random() * TIPS.length));
const step = (delta: number) => setIndex((i) => (i + delta + TIPS.length) % TIPS.length);

/** Default tab of the right panel: a bubble pointing at one of the other tabs, then a tip (sponsored or not). */
export function TipsPane(props: { legend: { tab: string; icon: string; label: () => string; text: () => string }; anchor: HTMLElement; onOpen: (tab: string) => void }) {
  const tip = () => TIPS[index()]!;
  let bubble!: HTMLButtonElement;
  // The bubble's tip sits under the centre of the tab, measured because the tabs have unequal widths.
  const place = () => {
    const tab = props.anchor.getBoundingClientRect();
    bubble.style.setProperty("--tip-x", `${tab.left + tab.width / 2 - bubble.getBoundingClientRect().left}px`);
  };
  createEffect(place);
  onMount(() => {
    const observer = new ResizeObserver(place);
    observer.observe(bubble);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div class="tips-pane">
      <button ref={bubble} class="tips-legend-row" onClick={() => props.onOpen(props.legend.tab)}>
        <span class="tips-legend-icon" innerHTML={props.legend.icon} />
        <span class="tips-legend-text">
          <strong>{props.legend.label()}</strong>
          <small>{props.legend.text()}</small>
        </span>
      </button>
      <article class="tip-card">
        <span class="label">{t("tip.label")}</span>
        <Show when={tip().image}>{(src) => <img class="tip-image" src={url(src())} alt={t(tip().title)} />}</Show>
        <strong class="tip-title">{t(tip().title)}</strong>
        <p class="tip-text">{t(tip().text)}</p>
        <Show when={tip().sponsor}>
          {(s) => (
            <a class="tip-sponsor" href={s().url} target="_blank" rel="noopener noreferrer sponsored">
              <small>{t("tip.sponsoredBy")}</small>
              <Show when={s().logo} fallback={<strong>{s().name}</strong>}>
                {(logo) => <img src={url(logo())} alt={s().name} />}
              </Show>
            </a>
          )}
        </Show>
        <div class="tip-nav">
          <button class="icon-btn" title={t("tip.previous")} aria-label={t("tip.previous")} onClick={() => step(-1)}>
            ‹
          </button>
          <span class="tip-count">
            {index() + 1} / {TIPS.length}
          </span>
          <button class="icon-btn" title={t("tip.next")} aria-label={t("tip.next")} onClick={() => step(1)}>
            ›
          </button>
        </div>
      </article>
      {/* Library tab (account module): shortcut under the tip, above the examples. */}
      <Show when={contributions("rightTabs").some((c) => c.id === LIBRARY_TAB)}>
        <button class="link-btn tips-library" onClick={() => props.onOpen(LIBRARY_TAB)}>
          {t("tip.toLibrary")} →
        </button>
      </Show>
      {/* Example assemblies: one click opens the assembly, its parts open on their own from its tree. */}
      <section class="tips-examples">
        <span class="label">{t("ex.title")}</span>
        <ExampleCards />
      </section>
    </div>
  );
}
