/** The harness is down or a seam is missing; a business refusal is never this. */
export class InfrastructureError extends Error {
  override readonly name = "InfrastructureError";
}

/** A World verb whose area has not landed yet. */
export class NotImplemented extends Error {
  override readonly name = "NotImplemented";
  constructor(readonly verb: string) {
    super(`${verb} is not implemented: the area that owns it has not filled its World module`);
  }
}

/**
 * A stubbed module: every verb, at any depth, throws `NotImplemented` naming its path, so
 * `world.personas.youngUser()` fails as `personas.youngUser`. An area task replaces the stub.
 */
export function stubModule<T extends object>(area: string): T {
  const at = (path: string): object =>
    new Proxy(function () {}, {
      get(_target, key) {
        if (typeof key !== "string" || key === "then") return undefined;
        return at(`${path}.${key}`);
      },
      apply() {
        throw new NotImplemented(path);
      },
    });
  return new Proxy({} as T, {
    get(_target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      return at(`${area}.${key}`);
    },
  });
}
