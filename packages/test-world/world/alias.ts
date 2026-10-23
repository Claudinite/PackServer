import { FakeRng } from "@packserver/ports/fakes";

function seedOf(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Names are invented and aliased: `acme` in a scenario is `acme-7f3a` in the system, so two
 * scenarios sharing one storage never collide, and output reads as the scenario wrote it.
 */
export class Aliases {
  private readonly table = new Map<string, string>();
  private readonly rng: FakeRng;

  constructor(title: string) {
    this.rng = new FakeRng(seedOf(title));
  }

  alias(name: string): string {
    let aliased = this.table.get(name);
    if (!aliased) {
      aliased = `${name}-${Math.floor(this.rng.float() * 0xffff).toString(16).padStart(4, "0")}`;
      this.table.set(name, aliased);
    }
    return aliased;
  }

  /** Puts the scenario's words back into text the system produced. */
  unalias(text: string): string {
    let out = text;
    for (const [name, aliased] of this.table) out = out.split(aliased).join(name);
    return out;
  }
}
