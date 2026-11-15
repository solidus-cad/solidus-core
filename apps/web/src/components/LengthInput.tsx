import { createSignal, type JSX } from "solid-js";
import { decodeLen, encodeLen, lenEvaluator, lenStep, toUnit } from "../units.ts";
import { parameterScope } from "../store.ts";
import { Stepper } from "./Stepper.tsx";

export interface LengthInputProps {
  /** Stored expression (mm, or with a unit suffix). */
  value: string;
  /** Receives the expression to store (`encodeLen` of the typed text). */
  onValue(expr: string): void;
  onKeyDown?: JSX.EventHandler<HTMLInputElement, KeyboardEvent>;
  onBlur?: () => void;
  ref?: (el: HTMLInputElement) => void;
  class?: string;
  disabled?: boolean;
  /** Expression scope for the arrows (default: document parameters). */
  scope?: () => ReadonlyMap<string, number>;
  /** Evaluator of a stored expression (mm), instead of `scope`. */
  evalExpr?: (expr: string) => { value?: number; error?: string };
  /** Without the increment arrows. */
  noStepper?: boolean;
}

/**
 * Text field of a length in the display unit, with increment arrows: shows `decodeLen(value)`, stores
 * `encodeLen(text)`. While typing, the field keeps the typed text (no rewriting of an incomplete number).
 */
export function LengthInput(p: LengthInputProps) {
  const [draft, setDraft] = createSignal<string | null>(null);
  let input: HTMLInputElement | undefined;
  const shown = () => draft() ?? decodeLen(p.value);
  return (
    <>
      <input
        ref={(el) => {
          input = el;
          p.ref?.(el);
        }}
        class={p.class}
        value={shown()}
        disabled={p.disabled}
        spellcheck={false}
        onInput={(e) => {
          const v = e.currentTarget.value;
          setDraft(v);
          p.onValue(encodeLen(v));
        }}
        onKeyDown={(e) => p.onKeyDown?.(e)}
        onBlur={() => {
          setDraft(null);
          p.onBlur?.();
        }}
      />
      {!p.noStepper && (
        <Stepper
          get={() => input?.value ?? shown()}
          set={(v) => {
            if (document.activeElement === input) setDraft(v);
            p.onValue(encodeLen(v));
          }}
          step={lenStep()}
          evalExpr={
            p.evalExpr
              ? (x: string) => {
                  const r = p.evalExpr!(encodeLen(x));
                  return r.value === undefined ? r : { value: toUnit(r.value) };
                }
              : lenEvaluator(p.scope ?? parameterScope)
          }
          disabled={p.disabled}
        />
      )}
    </>
  );
}
