import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { matchesOf, type Doc } from "./doc.ts";

// A gap inside one shell command: any character, with a backslash taking the next one (so a line continuation
// continues the command). Every alternative starts differently, so there is one way to match and the bound holds.
const GAP = String.raw`(?:[^\n\\]|\\[^\n]|\\\r?\n){0,200}?`;

// Files that hold credentials.
const FILE = String.raw`(?:(?:(?:~|\$\{?HOME\}?|/home/[\w.-]{1,32}|/root)[/\\])?\.(?:ssh|aws|npmrc|netrc|gnupg)(?![\w-])|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|(?<![\w.-])\.env(?![\w-]|\.(?:example|sample|template)))`;
// Variables that hold credentials, and the whole environment.
const VARIABLE = String.raw`(?:\$\{?[A-Z0-9_]{0,30}(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]{0,30}\}?|\$\(\s{0,4}(?:env|printenv)\s{0,4}\)|` + "`" + String.raw`\s{0,4}(?:env|printenv)\s{0,4}` + "`" + ")";
const TARGET = `(?:${FILE}|${VARIABLE})`;

const DATA_FLAG = String.raw`(?<![\w-])(?:-d|--data(?:-binary|-raw|-urlencode|-ascii)?|-F|--form|--form-string|-T|--upload-file|--post-file|--post-data|--body-file|--json)`;
const READ = String.raw`\$\(\s{0,4}(?:cat|<|base64|xxd)\s{0,4}`;
const SENDER = String.raw`\b(?:curl|wget)\b`;
const SINK = String.raw`\b(?:nc|ncat|netcat|socat|curl|wget)\b`;

const PATTERNS: readonly RegExp[] = [
  // curl -d @file, --data "$(cat file)", -F f=@.env, -T file, --post-file=file, -d "token=$NPM_TOKEN"
  new RegExp(`${SENDER}${GAP}${DATA_FLAG}(?:\\s{1,8}|=)(?:\\\\\\r?\\n\\s{0,8})?["']?(?:[\\w.-]{1,20}=)?@?["']?(?:${READ})?${TARGET}`, "g"),
  // a credential file read by command substitution anywhere in the command: headers, URLs
  new RegExp(`${SENDER}${GAP}${READ}${FILE}`, "g"),
  // cat file | nc host port
  new RegExp(`\\b(?:cat|base64|tar|gzip|xxd|echo|printf)\\b[^\\n|;]{0,100}${TARGET}[^\\n|;]{0,60}\\|[^\\n]{0,60}${SINK}`, "g"),
  // nc host port < file
  new RegExp(`\\b(?:nc|ncat|netcat)\\b[^\\n<|;]{0,100}<\\s{0,4}${FILE}`, "g"),
  // env | curl ..., printenv | nc ...
  new RegExp(`\\b(?:env|printenv)\\s{0,4}\\|[^\\n]{0,60}${SINK}`, "g"),
  // scp and rsync of a credential file to a remote host
  new RegExp(`\\b(?:scp|rsync|sftp)\\b${GAP}${FILE}${GAP}[\\w.-]{1,40}@[\\w.-]{1,80}:`, "g"),
  // PowerShell
  new RegExp(`\\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\\b${GAP}-(?:Body|InFile)${GAP}${FILE}`, "gi"),
];

/**
 * Commands that send a credential file or secret variable somewhere. Runs over the masked text of every
 * file and every fence: a code sample that does this is the attack, not an example.
 */
export function uploadFindings(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    for (const re of PATTERNS) {
      for (const m of matchesOf(re, d.safe)) {
        out.push(make("text.credential-upload", { file: d.file, line: d.lineAt(m.index), quote: excerpt(d.safe, m.index, m[0].length), hint: "This command sends a credential file or secret to a network destination. Remove it." }));
      }
    }
  }
  return out;
}
