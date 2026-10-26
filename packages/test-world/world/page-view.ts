/** What a scenario may know about a rendered pack page: its visible text and a few named regions, never its markup. */
export interface PackPageView {
  status: number;
  /** Visible text, with styles and scripts removed. */
  text: string;
  /** The text of each status line that leads the page. */
  statusLines: string[];
  /** The lines of the adopt block. */
  adopt: string[];
  /** The pre-install manifest line, absent when the page shows none. */
  manifest: string | null;
  /** Whether the page carries the private-pack lock. */
  lock: boolean;
  links: Array<{ text: string; href: string; rel: string | null }>;
  /** The rendered README region as markup, for sanitiser checks. */
  readmeHtml: string | null;
  /** The Contents tab's files in the order shown, by part. */
  files: Array<{ path: string; part: string }>;
  /** Every section anchor the Contents tab offers. */
  anchors: string[];
  /** The Contents tab's rendered text of one file. */
  fileText(path: string): string | null;
  /** The trust drawer's text. */
  trust: string;
  headers: Record<string, string>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e] ?? "");
const strip = (html: string): string => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const withoutCode = (html: string): string => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, "");

function regions(html: string, open: RegExp): string[] {
  return [...html.matchAll(open)].map((m) => m[1] ?? "");
}

export function viewOfPackPage(status: number, html: string, headers: Record<string, string>): PackPageView {
  const body = withoutCode(html);
  const links = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    text: strip(m[2] ?? ""),
    href: /href="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "",
    rel: /rel="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? null,
  }));
  const adopt = /<div class="adopt">([\s\S]*?)<\/div>/.exec(body)?.[1];
  const manifest = /<p class="manifest">([\s\S]*?)<\/p>/.exec(body)?.[1];
  const files = [...body.matchAll(/<section class="part"><h2>([^<]*)<\/h2>([\s\S]*?)<\/section>/g)].flatMap((m) =>
    [...(m[2] ?? "").matchAll(/<h3>([^<]*)<\/h3>/g)].map((f) => ({ path: decode(f[1] ?? ""), part: m[1] ?? "" })),
  );
  return {
    status,
    text: strip(body),
    statusLines: regions(body, /<p class="status-line[^"]*"[^>]*>([\s\S]*?)<\/p>/g).map(strip),
    adopt: adopt === undefined ? [] : [...adopt.matchAll(/<(?:pre|p)\b[^>]*>([\s\S]*?)<\/(?:pre|p)>/g)].map((m) => strip(m[1] ?? "")),
    manifest: manifest === undefined ? null : strip(manifest),
    lock: /aria-label="Private"/.test(body),
    links,
    readmeHtml: /<div class="readme">([\s\S]*?)<\/div><aside/.exec(body)?.[1] ?? /<div class="readme">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? null,
    files,
    anchors: regions(body, /data-section="([^"]*)"/g).map(decode),
    fileText(path) {
      const found = [...body.matchAll(/<pre data-path="([^"]*)"><code>([\s\S]*?)<\/code><\/pre>/g)].filter((m) => decode(m[1] ?? "") === path);
      return found.length === 0 ? null : found.map((m) => decode(m[2] ?? "")).join("");
    },
    trust: strip(/<aside class="drawer"[\s\S]*?<\/aside>/.exec(body)?.[0] ?? ""),
    headers,
  };
}

/** A README with every kind of active content the site must strip and one outbound link, labelled `docs`, it must keep. */
export const hostileReadme = [
  "<script>alert(1)</script>",
  '<img src="x" onclick="boom()">',
  '<iframe src="https://evil.example"></iframe>',
  "[click](javascript:alert(1))",
  "[docs](https://example.com/docs)",
  "",
].join("\n\n");
