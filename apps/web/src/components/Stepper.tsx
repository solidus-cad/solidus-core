import { evaluate } from "@solidus-cad/sdk";
import { parameterScope } from "../store.ts";
import { stepValue } from "./step.ts";

export interface StepperProps {
  /** Current text of the field (raw value, possibly an expression). */
  get(): string;
  set(v: string): void;
  /** Increment step, 1 by default. */
  step?: number;
  /** Expression evaluator; by default, the document parameters. */
  evalExpr?(expr: string): { value?: number; error?: string };
  disabled?: boolean;
}

/** Increment arrows attached to a numeric field (step 1 by default). */
export function Stepper(p: StepperProps) {
  const evalExpr = () => p.evalExpr ?? ((expr: string) => {
    try {
      return { value: evaluate(expr, parameterScope()) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  const tap = (dir: number) => {
    if (p.disabled) return;
    const v = stepValue(p.get(), dir * (p.step ?? 1), evalExpr());
    if (v !== null) p.set(v);
  };
  return (
    <span class="stepper" aria-hidden="true">
      <button type="button" class="stepper-btn" tabIndex={-1} disabled={p.disabled} aria-label="+1" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); tap(1); }}>
        ▲
      </button>
      <button type="button" class="stepper-btn" tabIndex={-1} disabled={p.disabled} aria-label="-1" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); tap(-1); }}>
        ▼
      </button>
    </span>
  );
}
