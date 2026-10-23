import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { matchesOf, type Doc } from "./doc.ts";

// A bounded gap inside one command. It stops at the next word that starts a new command of the same family, so a
// run of repeated command words costs each character once. A backslash takes the next character, which keeps a
// line continuation inside the command.
const gap = (stop: string) => String.raw`(?:(?!${stop})(?:[^\n\\]|\\[^\n]|\\\r?\n)){0,200}?`;
// PowerShell paths use the backslash, so its gap takes every character.
const plainGap = (stop: string) => String.raw`(?:(?!${stop})[^\n]){0,200}?`;
const flatGap = (stop: string, not: string) => String.raw`(?:(?!${stop})[^\n${not}]){0,100}?`;

const SSH_DIR = String.raw`\.ssh(?![\w-])(?![/\\](?:config|known_hosts|authorized_keys)(?![\w.-])|[/\\][\w.-]{0,60}\.pub(?![\w-]))`;
const OTHER_DIRS = String.raw`\.(?:aws|npmrc|netrc|gnupg)(?![\w-])`;
const KEY = String.raw`id_(?:rsa|ed25519|ecdsa|dsa)(?![\w-]|\.pub(?![\w-]))`;
const ENV_FILE = String.raw`\.env(?![\w-]|\.(?:example|sample|template))`;
// Files that hold credentials, wherever they sit.
const FILE = String.raw`(?<![\w.-])(?:${SSH_DIR}|${OTHER_DIRS}|${KEY}|${ENV_FILE})`;
// The whole environment.
const ENVALL = String.raw`(?:\$\(\s{0,4}(?:env|printenv)\s{0,4}\)|` + "`" + String.raw`\s{0,4}(?:env|printenv)\s{0,4}` + "`" + ")";
const TARGET = `(?:${FILE}|${ENVALL})`;
// Any path prefix, taken only at the spot where a value begins.
const PFX = String.raw`[^\s"'<>|;&()]{0,120}?`;

const DATA_FLAG = String.raw`(?<![\w-])(?:-[a-z]{0,6}[dft]|--data(?:-binary|-raw|-urlencode|-ascii)?|--form(?:-string)?|--upload-file|--post-file|--post-data|--body-file|--json)`;
const READ = String.raw`\$\(\s{0,4}(?:cat|<|base64|xxd|gzip|tar)\s{0,4}(?:-[\w=-]{1,12}\s{1,4}){0,3}`;
const SENDER = String.raw`\b(?:curl|wget)\b`;
const SINK = String.raw`\b(?:nc|ncat|netcat|socat|curl|wget|ssh)\b`;
const READERS = String.raw`\b(?:cat|base64|tar|gzip|xxd|echo|printf)\b`;
const REMOTE = String.raw`\b(?:nc|ncat|netcat|ssh|socat)\b`;
const COPIERS = String.raw`\b(?:scp|rsync|sftp)\b`;
const POWERSHELL = String.raw`\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`;

const PATTERNS: readonly RegExp[] = [
  // curl -d @file, --data "$(cat file)", -F f=@.env, -sd @.env, -d@.env, -T file, --post-file=file
  new RegExp(`${SENDER}${gap(SENDER)}${DATA_FLAG}(?:\\s{1,8}|=)?(?:\\\\\\r?\\n\\s{0,8})?["']?(?:[\\w.-]{1,20}=)?@?["']?(?:${READ})?${PFX}${TARGET}`, "gi"),
  // a credential file read by command substitution anywhere in the command: headers, URLs
  new RegExp(`${SENDER}${gap(SENDER)}${READ}${PFX}${FILE}`, "gi"),
  // curl ... < file, curl ... <<< "$(cat file)"
  new RegExp(`${SENDER}${gap(SENDER)}<{1,3}\\s{0,4}["']?(?:${READ}${PFX}${FILE}|${ENVALL}|${PFX}${FILE})`, "gi"),
  // cat file | nc host port
  new RegExp(`${READERS}${flatGap(READERS, "|;")}${TARGET}[^\\n|;]{0,60}\\|[^\\n]{0,60}${SINK}`, "gi"),
  // nc host port < file, ssh host 'cat > k' < file
  new RegExp(`${REMOTE}${flatGap(REMOTE, "<|;")}<\\s{0,4}["']?${PFX}${FILE}`, "gi"),
  // env | curl ..., printenv | nc ...
  new RegExp(`\\b(?:env|printenv)\\b\\s{0,4}\\|[^\\n]{0,60}${SINK}`, "gi"),
  // scp and rsync of a credential file to a remote host
  new RegExp(`${COPIERS}${gap(COPIERS)}${FILE}${gap(COPIERS)}[\\w.-]{1,40}@[\\w.-]{1,80}:`, "gi"),
  // PowerShell
  new RegExp(`${POWERSHELL}${plainGap(POWERSHELL)}-(?:Body|InFile)${plainGap(POWERSHELL)}${FILE}`, "gi"),
];

// A document with none of these cannot hold a hit, so the patterns never run on it.
const ANCHOR = /\.(?:ssh|aws|npmrc|netrc|gnupg|env)(?![\w-])|\bid_(?:rsa|ed25519|ecdsa|dsa)|\b(?:env|printenv)\b/i;

/**
 * Commands that send a credential file or the whole environment somewhere. A secret variable is not a hit:
 * it travels to the service it belongs to in ordinary use, and no check can tell where. Runs over the masked
 * text of every file and every fence: a code sample that does this is the attack, not an example.
 */
export function uploadFindings(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    if (!ANCHOR.test(d.safe)) continue;
    for (const re of PATTERNS) {
      for (const m of matchesOf(re, d.safe)) {
        out.push(make("text.credential-upload", { file: d.file, line: d.lineAt(m.index), quote: excerpt(d.safe, m.index, m[0].length), hint: "This command sends a credential file or the whole environment to a network destination. Remove it." }));
      }
    }
  }
  return out;
}
