import {
  SignAndWriteRootRequest, SignAndWriteRootResponse, SignPrivateEntriesRequest, SignPrivateEntriesResponse, SignScopeIndexRequest, SignScopeIndexResponse,
} from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import { signAndWritePrivateEntries, signAndWriteRootDocument, signAndWriteScopeIndex } from "../sign/documents";

type Parsed<S extends { parse(value: unknown): unknown }> = ReturnType<S["parse"]>;

/**
 * What the coordinators in `publish` call over the service binding (docs/architecture/workers-trust-boundaries.md):
 * they hand over an unsigned document and the validator, the only holder of the signing key, signs
 * it, writes it and answers with its hash and serial. Requests are parsed again here; a caller is
 * not trusted to have built a valid document.
 */
export const signEntrypoints = (rt: ValidatorRuntime) => ({
  async signScopeIndex(request: unknown): Promise<Parsed<typeof SignScopeIndexResponse>> {
    return SignScopeIndexResponse.parse(await signAndWriteScopeIndex(rt, SignScopeIndexRequest.parse(request)));
  },
  async signPrivateEntries(request: unknown): Promise<Parsed<typeof SignPrivateEntriesResponse>> {
    return SignPrivateEntriesResponse.parse({ entries: await signAndWritePrivateEntries(rt, SignPrivateEntriesRequest.parse(request)) });
  },
  async signAndWriteRoot(request: unknown): Promise<Parsed<typeof SignAndWriteRootResponse>> {
    return SignAndWriteRootResponse.parse(await signAndWriteRootDocument(rt, SignAndWriteRootRequest.parse(request)));
  },
});
