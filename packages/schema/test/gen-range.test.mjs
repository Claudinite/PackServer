import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isContractMigration } from "../../core/selftest/schema-range.ts";
import { CONTRACT_NAME, renderRange } from "../scripts/gen-range.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function range(files) {
  const dir = mkdtempSync(join(tmpdir(), "range-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  const text = renderRange(dir);
  return [/SCHEMA_MIN = "(\d+)"/.exec(text)[1], /SCHEMA_MAX = "(\d+)"/.exec(text)[1]];
}

const A = "20260101000000_foundation_tables.sql";
const B = "20260102000000_packs_expand.sql";
const C = "20260103000000_packs_contract.sql";

describe("IT-OPS-011 range generation", () => {
  it("requires the newest expand when the head is an expand", () => {
    expect(range({ [A]: "x", [B]: "x" })).toEqual(["20260102000000", "20260102000000"]);
  });

  it("requires the newest expand, not the contract, when the head is a contract", () => {
    expect(range({ [A]: "x", [B]: "x", [C]: `-- contract-of: ${B}\nx` })).toEqual(["20260102000000", "20260103000000"]);
  });
});

describe("IT-OPS-011 how a build recognises a contract", () => {
  // The self-test judges a database ahead of its build by names alone, so the build's reading and the checker's must agree.
  it.each([
    "20261026000000_search_contract_drop.sql",
    "20261026000000_search_contract.sql",
    "20261026000000_search_old_contract.sql",
    "20261026000000_search_old_contract_columns.sql",
    "20261026000000_contract_contract.sql",
    "20261026000000_contract_table.sql",
    "20261026000000_contracts_table.sql",
    "20261026000000_search_subcontract.sql",
    "20261026000000_search_index.sql",
    "junk.sql",
  ])("reads %s the same way in the build and in the checker", (name) => {
    expect(isContractMigration(name)).toBe(CONTRACT_NAME.test(name));
  });
});
