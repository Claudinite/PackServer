import { AdminResponse, RELEASE_HEADER, type AdminRequest } from "@packserver/schema";

/** The judge's calls into the admin internal API; the contract allows it quarantine, the kill switch, `telemetry_mode` and acknowledge only. */
export interface AdminClient {
  call(request: AdminRequest): Promise<AdminResponse>;
}

export const ADMIN_INTERNAL_URL = "https://admin.internal/internal/call";
export const ADMIN_CALLER_HEADER = "X-PackServer-Caller";

/** What the service binding to the admin Worker offers the client. */
export interface AdminTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export function adminClient(binding: AdminTransport, releaseId: string): AdminClient {
  return {
    async call(request) {
      const response = await binding.fetch(ADMIN_INTERNAL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", [ADMIN_CALLER_HEADER]: "judge", [RELEASE_HEADER]: releaseId },
        body: JSON.stringify(request),
      });
      return AdminResponse.parse(await response.json());
    },
  };
}
