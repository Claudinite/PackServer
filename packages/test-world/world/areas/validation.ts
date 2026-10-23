import { stubModule } from "../errors";
import type { Archive, ValidationRun, Version } from "../types";

/** The validation spine: runs, the published rule list, and the faked screen and sandbox. */
export interface ValidationModule {
  validation: { completes(version: Version): Promise<ValidationRun>; of(version: Version): Promise<ValidationRun> };
  rules: { list(): Promise<ReadonlyArray<{ id: string; class: "fail" | "hold" | "warn" }>> };
  proseScreen: { script(o: { file?: string; probabilities: Record<string, number> }): void; releaseModel(model: string): void };
  sandbox: { script(archive: Archive, o: { exitCode: number; egressAttempts?: string[]; loads?: false | "newest-engine-only" }): Promise<void> };
}

export const createValidation = (): ValidationModule => ({
  validation: stubModule("validation"),
  rules: stubModule("rules"),
  proseScreen: stubModule("proseScreen"),
  sandbox: stubModule("sandbox"),
});
