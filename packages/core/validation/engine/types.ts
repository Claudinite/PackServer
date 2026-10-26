import type { Tree } from "../../canonical/index.ts";
import type { Promoted } from "../manifest/preinstall.ts";

/** Lookups the static rules need; each is injected so the rules stay pure. */
export interface StaticRulePorts {
  /** Full ids (`@scope/name`) of packs popular enough to be worth impersonating. */
  popularPacks(): Promise<readonly string[]>;
  /** Scopes (without the `@`) that belong to a verified publisher. */
  verifiedScopes(): Promise<readonly string[]>;
  /** First labels of proven domains, with the scope that proved each. */
  provenDomainLabels(): Promise<readonly { label: string; scope: string }[]>;
  /**
   * Whether the publishing principal may read the named pack. Unreadable and nonexistent packs
   * must answer alike; the rules treat them alike.
   */
  canRead(pack: string): Promise<boolean>;
}

export interface StaticRuleInput {
  tree: Tree;
  /** The pack id the upload is for, `@scope/name`. */
  pack: string;
  /** The newest version already published for this pack, if any. */
  newestVersion: string | null;
  /** The capabilities and manifest of the previous promoted version, when there is one. */
  previous?: Promoted | null;
  rulesVersion: string;
}
