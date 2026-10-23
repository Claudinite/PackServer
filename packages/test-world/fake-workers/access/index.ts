import { WorkerEntrypoint } from "cloudflare:workers";
import type { AccessIdentityClaims } from "@packserver/ports";
import { FakeAccessIdentity } from "@packserver/ports/fakes";
import { handleControl } from "../control";

const access = new FakeAccessIdentity();

/** Stands in for Cloudflare Access: verifies an assertion against a test key, so a forged header is a real negative. */
export default class FakeAccess extends WorkerEntrypoint {
  verify(assertion: string) {
    return access.verify(assertion);
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      assert: (claims: AccessIdentityClaims) => access.assert(claims),
      reset: () => undefined,
    });
  }
}
