/**
 * Usage rights: the interface that modules (CAM, kinematics, computation, quoting...) use to ask
 * "am I allowed X?" without knowing the implementation (token signed by a server, local license, open build...).
 *
 * A module never reads a token and never contacts a license server: it calls `ctx.license`.
 * The application plugs its implementation in (`setLicenseBackend`, apps/web/src/license.ts); the open build grants everything.
 */

/** Requested right: a paid feature ("cam", "quote"...) or a paid plugin (manifest identifier). */
export type Entitlement = { feature: string } | { plugin: string };

/** Why a right is denied (message to display left to the module). */
export type LicenseDenial =
  /** No valid license obtained (not signed in, server unreachable for too long). */
  | "no-license"
  /** License expired (offline period exceeded, inconsistent clock). */
  | "expired"
  /** Valid license, but the plan does not include this right. */
  | "not-in-plan"
  /** Token taken by another device (token-based license). */
  | "seat-unavailable";

export interface LicenseDecision {
  granted: boolean;
  /** Present when `granted` is false. */
  reason?: LicenseDenial;
  /** End of validity of the current decision without renewal (Unix ms), if known. */
  validUntil?: number;
}

export interface LicenseProvider {
  /** Implementation identifier ("token", "open"...), for diagnostics. */
  readonly kind: string;
  /** Immediate answer (no network): is the right granted now? */
  can(e: Entitlement): boolean;
  /** Same question, with the reason in case of denial. */
  decide(e: Entitlement): LicenseDecision;
  /**
   * Runs `run` if the right is granted; otherwise explains the denial to the user (offers, sign-in...)
   * and may call `run` again once the right is obtained.
   */
  require(e: Entitlement, run: () => void): void;
  /** Subscribes to license changes (renewal, expiration, account change). Returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/** Provider of the open build and of the tests: everything is granted. */
export const openLicenseProvider: LicenseProvider = {
  kind: "open",
  can: () => true,
  decide: () => ({ granted: true }),
  require: (_e, run) => run(),
  onChange: () => () => undefined,
};

/** Provider that denies everything (module loaded without a host application, lock tests). */
export const closedLicenseProvider: LicenseProvider = {
  kind: "closed",
  can: () => false,
  decide: () => ({ granted: false, reason: "no-license" }),
  require: () => undefined,
  onChange: () => () => undefined,
};

/** Reading shortcuts. */
export const feature = (id: string): Entitlement => ({ feature: id });
export const plugin = (id: string): Entitlement => ({ plugin: id });
