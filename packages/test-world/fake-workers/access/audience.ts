/** The audience the admin Worker's `env.test` expects; a drift guard in the admin Worker's tests keeps the two equal. */
export const TEST_ACCESS_AUDIENCE = "admin-access-audience-test";
/** An expiry far past any scenario's clock: an assertion that does not name one never lapses. */
export const NEVER_EXPIRES_S = 4_102_444_800;
