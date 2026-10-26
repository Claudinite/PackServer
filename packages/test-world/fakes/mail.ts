import { TEST_MAIL_URL } from "@packserver/ports";
import type { FakeMail } from "@packserver/ports/fakes";
import type { NetHandler } from "./net";

/** What `env.test` Workers post instead of sending: the message lands in the same inbox the World reads. */
export function mailHandler(mail: FakeMail): NetHandler {
  return async (request) => {
    if (request.method !== "POST" || request.url !== TEST_MAIL_URL) return undefined;
    return Response.json(await mail.send((await request.json()) as Parameters<FakeMail["send"]>[0]));
  };
}
