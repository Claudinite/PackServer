export type FlagValue = boolean | number | string | null;

export type FlagRetirement =
  /** Never removed; the reason says why the flag outlives its rollout. */
  | { permanent: string }
  /** Removed within two releases of being fully on; `fullyOnIn` is the release version it reached everyone in, null until then. */
  | { fullyOnIn: string | null };

export interface FlagDef {
  key: string;
  type: "boolean" | "number" | "string";
  /** What a reader uses when the table holds no row, or none it can trust. */
  default: FlagValue;
  /** Honoured only with a MAC under the admin-only key. */
  security: boolean;
  /** The value a tap on "on" writes; absent when the flag needs a value from a person. */
  on?: FlagValue;
  off: FlagValue;
  retire: FlagRetirement;
}

export const LAUNCH_FLAG = "launch.flag";
export const NEW_PACK_KILL_SWITCH = "new_pack_kill_switch";
export const INDEX_REGENERATION_FROZEN = "index_regeneration_frozen";
export const CN_MIN_ADOPT_VERSION = "cn_min_adopt_version";
export const STAGED_PUBLISHING_THRESHOLD = "staged_publishing_declared_threshold";

/** The flags the registry reads. The kill switch and the freeze are flags too, so one table and one audit trail hold every switch. */
export const FLAG_DEFS = [
  { key: LAUNCH_FLAG, type: "boolean", default: false, security: false, on: true, off: false, retire: { permanent: "switches the release pipeline and the gate ladder between pre-launch and launch" } },
  { key: NEW_PACK_KILL_SWITCH, type: "boolean", default: false, security: true, on: true, off: false, retire: { permanent: "the first action of a publish-flood page" } },
  { key: INDEX_REGENERATION_FROZEN, type: "boolean", default: false, security: true, on: true, off: false, retire: { permanent: "the first action of an index-signature page" } },
  { key: CN_MIN_ADOPT_VERSION, type: "string", default: null, security: false, off: null, retire: { fullyOnIn: null } },
  { key: STAGED_PUBLISHING_THRESHOLD, type: "number", default: 100, security: false, on: 100, off: null, retire: { fullyOnIn: null } },
] as const satisfies readonly FlagDef[];

export type KnownFlag = (typeof FLAG_DEFS)[number]["key"];

export const flagDef = (key: string): FlagDef | undefined => (FLAG_DEFS as readonly FlagDef[]).find((d) => d.key === key);

/** Whether `value` is one the flag can hold; a threshold is a whole number, a version a plain semver. */
export function validFlagValue(def: FlagDef, value: unknown): value is FlagValue {
  if (value === null) return def.key !== LAUNCH_FLAG && def.type !== "boolean";
  if (typeof value !== def.type) return false;
  if (def.key === CN_MIN_ADOPT_VERSION) return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
  if (def.key === STAGED_PUBLISHING_THRESHOLD) return Number.isInteger(value) && (value as number) >= 0;
  return true;
}

const parts = (version: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return [major, minor, patch];
};

/** Releases between two versions, each step of any component counting once. */
export function releasesSince(from: string, to: string): number {
  const [a, b] = [parts(from), parts(to)];
  return Math.max(0, b[0] - a[0]) + Math.max(0, b[1] - a[1]) + Math.max(0, b[2] - a[2]);
}

/** Flags that have been fully on for more than two releases and so should be gone. */
export function overdueFlags(defs: readonly FlagDef[], currentVersion: string): string[] {
  return defs.filter((d) => "fullyOnIn" in d.retire && d.retire.fullyOnIn !== null && releasesSince(d.retire.fullyOnIn, currentVersion) > 2).map((d) => d.key);
}
