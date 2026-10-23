import { stubModule } from "../errors";
import type { Archive, Publisher, Version } from "../types";

export interface ArchiveOpts {
  version?: string;
  minEngineVersion?: string;
  files?: Record<string, string>;
}

/** Archives, the probe publisher and the delivery path. */
export interface PublishingModule {
  archive(fixture: string, opts?: ArchiveOpts): Archive;
  probe: { publisher(): Promise<Publisher> };
  delivery: { serveInstead(version: Version, archive: Archive): void };
}

export const createPublishing = (): PublishingModule => ({
  archive: stubModule<Pick<PublishingModule, "archive">>("world").archive,
  probe: stubModule("probe"),
  delivery: stubModule("delivery"),
});
