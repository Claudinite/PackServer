// The strings IT-OPS-003 greps for: they belong to the test world and must never reach a deployed configuration or bundle.
// docs/testing/operations.md names the same list; check-bindings.test.ts holds the two together.
export const TEST_STRINGS = [
  "fake-",
  "whsec_test",
  "oidc.test",
  "TEST_MODE",
  "fireAlarm",
  "1x00000000000000000000AA",
  "1x00000000000000000000BB",
  "1x0000000000000000000000000000000AA",
];
