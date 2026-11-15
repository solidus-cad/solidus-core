import { createSignal } from "solid-js";
import { openLicenseProvider, type LicenseProvider } from "@solidus-cad/sdk";

/**
 * Usage rights of the application. The core has no license of its own: without a license module, everything is granted
 * (`openLicenseProvider`). A module (official builds) plugs its implementation with `setLicenseBackend` from its
 * `activate`, before the first render; the functions below then delegate to it. Modules ask for their rights through
 * `ctx.license` (the provider below), which follows the backend.
 */

/** Paid feature identifier ("drawing", "cam", "motion", "utilities"…). */
export type Feature = string;

export interface LicenseBackend {
  provider: LicenseProvider;
  /** Premium plan (themes, extra accents…). */
  hasPremiumPlan?(): boolean;
  /** Commercial use allowed (drawing printouts without watermark…). */
  commercialUse?(): boolean;
  /** Explains why `f` is locked and offers to obtain it; `run` is called once the right is obtained. */
  explainLocked?(f: Feature, run?: () => void): void | Promise<void>;
}

const [backend, setBackend] = createSignal<LicenseBackend | null>(null);

export function setLicenseBackend(b: LicenseBackend): void {
  setBackend(b);
}

const provider = (): LicenseProvider => backend()?.provider ?? openLicenseProvider;

/** Is the feature usable? (reactive when the backend is) */
export const hasFeature = (f: Feature): boolean => provider().can({ feature: f });
export const hasPlugin = (id: string): boolean => provider().can({ plugin: id });
export const hasPremiumPlan = (): boolean => backend()?.hasPremiumPlan?.() ?? true;
export const commercialUse = (): boolean => backend()?.commercialUse?.() ?? true;

/** Explains why `f` is locked (nothing to explain without a license module). */
export async function explainLocked(f: Feature, run?: () => void): Promise<void> {
  await backend()?.explainLocked?.(f, run);
}

/** Runs `run` if the feature is active, otherwise explains why it is locked. */
export function requireFeature(f: Feature, run: () => void): void {
  provider().require({ feature: f }, run);
}

/** Provider handed to the extensions (`ctx.license`): always the current backend. */
export const licenseProvider: LicenseProvider = {
  get kind() {
    return provider().kind;
  },
  can: (e) => provider().can(e),
  decide: (e) => provider().decide(e),
  require: (e, run) => provider().require(e, run),
  onChange: (listener) => provider().onChange(listener),
};
