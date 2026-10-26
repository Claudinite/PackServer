import { WorkerEntrypoint } from "cloudflare:workers";
import type { AccessIdentityClaims } from "@packserver/ports";
import { FakeAccessIdentity } from "@packserver/ports/fakes";
import { handleControl } from "../control";
import { NEVER_EXPIRES_S, TEST_ACCESS_AUDIENCE } from "./audience";

const access = new FakeAccessIdentity();

/** Stands in for Cloudflare Access: verifies an assertion against a test key, so a forged header is a real negative. */
export default class FakeAccess extends WorkerEntrypoint {
  verify(assertion: string) {
    return access.verify(assertion);
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      assert: (claims: AccessIdentityClaims) => access.assert({ aud: [TEST_ACCESS_AUDIENCE], exp: NEVER_EXPIRES_S, ...claims }),
      reset: () => undefined,
    });
  }
}
