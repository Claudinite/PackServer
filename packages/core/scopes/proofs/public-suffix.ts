/**
 * Suffixes under which unrelated parties register names, so proving one proves nothing about its
 * holder. A single label (a top-level domain) is always a suffix; this lists the multi-label ones
 * that are common in practice: registry second levels and hosting platforms that hand out
 * subdomains. It is a subset of the Public Suffix List, not a copy of it.
 */
const SUFFIXES: ReadonlySet<string> = new Set([
  // Registry second levels
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk", "nhs.uk", "police.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au", "asn.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "school.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ad.jp", "ed.jp", "gr.jp", "lg.jp",
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "com.mx", "org.mx", "gob.mx", "com.ar", "com.co", "com.pe", "com.ve", "com.uy",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in", "gov.in",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "com.hk", "org.hk", "com.tw", "org.tw", "com.sg", "com.my", "com.ph", "com.vn", "co.id", "co.th", "or.th", "co.kr", "or.kr", "ne.kr",
  "co.za", "org.za", "net.za", "gov.za", "ac.za", "co.ke", "co.ug", "co.tz", "com.ng", "com.eg", "com.sa", "com.tr", "org.tr", "gov.tr", "co.il", "org.il", "ac.il", "gov.il",
  "com.ua", "com.pl", "co.at", "or.at", "com.es", "com.pt", "com.gr", "com.ru", "com.de", "co.de", "com.fr", "co.hu", "com.ro", "com.cy",
  // Hosting and platform suffixes (private section of the Public Suffix List)
  "github.io", "githubusercontent.com", "gitlab.io", "bitbucket.io", "pages.dev", "workers.dev", "r2.dev", "web.app", "firebaseapp.com", "appspot.com",
  "herokuapp.com", "herokussl.com", "vercel.app", "now.sh", "netlify.app", "netlify.com", "onrender.com", "fly.dev", "railway.app", "up.railway.app",
  "azurewebsites.net", "azurestaticapps.net", "azureedge.net", "cloudapp.net", "trafficmanager.net", "blob.core.windows.net",
  "cloudfront.net", "amazonaws.com", "s3.amazonaws.com", "elasticbeanstalk.com", "awsapprunner.com", "execute-api.us-east-1.amazonaws.com",
  "run.app", "cloudfunctions.net", "cloudrun.dev", "ondigitalocean.app", "digitaloceanspaces.com",
  "blogspot.com", "blogspot.co.uk", "wordpress.com", "wixsite.com", "weebly.com", "squarespace.com", "webflow.io", "framer.app", "framer.website",
  "tumblr.com", "medium.com", "substack.com", "notion.site", "github.dev", "codespaces.new", "glitch.me", "repl.co", "replit.app", "replit.dev",
  "ngrok.io", "ngrok-free.app", "ngrok.app", "loca.lt", "localtunnel.me", "trycloudflare.com", "surge.sh", "neocities.org", "000webhostapp.com",
  "hf.space", "streamlit.app", "gradio.live", "deno.dev", "val.run", "convex.site", "supabase.co", "vercel.dev", "stackblitz.io", "codesandbox.io", "csb.app",
  "myshopify.com", "bubbleapps.io", "carrd.co", "typedream.app", "super.site", "read.cv", "linktr.ee", "about.me", "dev.to",
  "dyndns.org", "no-ip.org", "ddns.net", "duckdns.org", "hopto.org", "zapto.org", "servebeer.com", "myftp.org",
]);

export type DomainJudgement =
  | { ok: true; domain: string }
  | { ok: false; reason: "format" | "public_suffix"; message: string };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** True when `host` is itself a suffix that unrelated parties register under, or a bare top-level domain. */
export function isPublicSuffix(host: string): boolean {
  return !host.includes(".") || SUFFIXES.has(host);
}

/**
 * The host a person typed, as the host to prove: lower-case, no trailing dot, labels of letters,
 * digits and hyphens. A subdomain is proven as itself (`docs.acme.com` is not `acme.com`).
 */
export function judgeDomain(input: string): DomainJudgement {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (host === "" || host.length > 253 || !labels.every((l) => LABEL.test(l)) || /^[0-9.]+$/.test(host)) {
    return { ok: false, reason: "format", message: "Give a domain name such as acme.com (no scheme, port or path)." };
  }
  if (isPublicSuffix(host)) {
    return { ok: false, reason: "public_suffix", message: `${host} is a public suffix that many unrelated parties register under; prove a domain you own.` };
  }
  return { ok: true, domain: host };
}

/** The label a person registered under the host's public suffix: `acme` for `docs.acme.com` and for `acme.co.uk`. */
export function registrableLabel(host: string): string {
  const labels = host.split(".");
  for (let i = 1; i < labels.length; i++) {
    if (isPublicSuffix(labels.slice(i).join("."))) return labels[i - 1]!;
  }
  return labels[0]!;
}
