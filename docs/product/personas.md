# Personas

From the Claudinite persona study (Claudinite primer, §Personas). Each row names what the persona
demands of a registry and where the spec answers it.

## Buyers: people who adopt packs for their repositories

| Persona | Situation | What they need from the registry | Answered by |
|---|---|---|---|
| Marcus, platform engineer | 300 engineers, a central platform team | An allowlist of publishers and domains his repositories may adopt from; private packs for internal standards; an audit trail | `verified_*` facts with caller-side policy ([requirements/cn-client-contract.md](../requirements/cn-client-contract.md)); private packs ([requirements/private-packs.md](../requirements/private-packs.md)); Team audit log |
| Dana, engineering manager | Several teams, wants consistency without policing | Knowing a pack is maintained and what adopting it changes | Pre-install manifest, pack score, `published_at`, declaring-repo counts |
| Jordan, startup CTO | Small team, moves fast | Find the pack for a task from inside a session and adopt in one step | MCP discovery ([requirements/mcp.md](../requirements/mcp.md)); adopt panel |
| Grace, agency owner | Many client repositories | Pin versions per client; take updates on her own schedule | Exact versions, immutability, repo-owned update timing |
| Elena, indie developer | 15 repositories alone | Free to use, cheap to trust, nothing to maintain | Free reads; the score and report explain themselves |
| Sam, AppSec approver | Approves what enters repositories | A manifest of what a pack does to a repo before adoption, signed versions, a readable report, revocation that bites | Pre-install manifest above the README, Ed25519-signed index, public validation reports, security revocation disabling executable parts |

## Publishers

| Persona | Situation | What they need | Answered by |
|---|---|---|---|
| Rafael, OSS maintainer | Publishes a pack for his project's users | Publishing from his repository with no stored secret; an open format; OSS publishing that costs next to nothing; a report he can fix from | Trusted publishing, `cn lint` parity with the registry, $1 per pack with credits in bundles, located findings |
| Carmen, company publisher | Publishes her company's packs, some private | Her company's name proven on the page; private packs her repositories can read without secrets; a team that can publish without her | Scope proofs and Verified Publisher, allowlists proven by Actions OIDC, org roles and staged approval |

## Agents

A Claude Code session is a first-class reader: it searches by task, reads the manifest and the raw
signals, and proposes `cn adopt`. It never fetches a pack into a session and never calls a write
tool unless the person's credentials allow it.

## The operator

Ariel runs PackServer alone. Every page must be answerable from a phone with one tap, every
release must decide itself through gates, and every irreversible step must wait for a timer and a
fresh passkey rather than a second person.
