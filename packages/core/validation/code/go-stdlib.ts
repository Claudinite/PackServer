/** The Go 1.24 standard library, by import path. A path with no dot that is not listed here is not standard. */
export const GO_STDLIB: ReadonlySet<string> = new Set(
  `archive/tar archive/zip bufio bytes cmp compress/bzip2 compress/flate compress/gzip compress/lzw compress/zlib container/heap
container/list container/ring context crypto crypto/aes crypto/cipher crypto/des crypto/dsa crypto/ecdh crypto/ecdsa crypto/ed25519
crypto/elliptic crypto/fips140 crypto/hkdf crypto/hmac crypto/md5 crypto/mlkem crypto/pbkdf2 crypto/rand crypto/rc4 crypto/rsa
crypto/sha1 crypto/sha256 crypto/sha3 crypto/sha512 crypto/subtle crypto/tls crypto/x509 crypto/x509/pkix database/sql
database/sql/driver debug/buildinfo debug/dwarf debug/elf debug/gosym debug/macho debug/pe debug/plan9obj embed encoding
encoding/ascii85 encoding/asn1 encoding/base32 encoding/base64 encoding/binary encoding/csv encoding/gob encoding/hex
encoding/json encoding/pem encoding/xml errors expvar flag fmt go/ast go/build go/build/constraint go/constant go/doc
go/doc/comment go/format go/importer go/parser go/printer go/scanner go/token go/types go/version hash hash/adler32
hash/crc32 hash/crc64 hash/fnv hash/maphash html html/template image image/color image/color/palette image/draw image/gif
image/jpeg image/png index/suffixarray io io/fs io/ioutil iter log log/slog log/syslog maps math math/big math/bits
math/cmplx math/rand math/rand/v2 mime mime/multipart mime/quotedprintable net net/http net/http/cgi net/http/cookiejar
net/http/fcgi net/http/httptest net/http/httptrace net/http/httputil net/http/pprof net/mail net/netip net/rpc
net/rpc/jsonrpc net/smtp net/textproto net/url os os/exec os/signal os/user path path/filepath plugin reflect regexp
regexp/syntax runtime runtime/cgo runtime/coverage runtime/debug runtime/metrics runtime/pprof runtime/race runtime/trace
slices sort strconv strings structs sync sync/atomic syscall testing testing/fstest testing/iotest testing/quick
testing/slogtest testing/synctest text/scanner text/tabwriter text/template text/template/parse time unicode unicode/utf16
unicode/utf8 unique unsafe weak`.split(/\s+/),
);

/** Standard packages that open connections. */
export const GO_NETWORK = new Set(["net", "net/rpc", "net/rpc/jsonrpc", "net/smtp", "net/textproto", "crypto/tls", "syscall", "log/syslog"]);
export const isGoNetwork = (spec: string): boolean => GO_NETWORK.has(spec) || spec === "net/http" || spec.startsWith("net/http/");

export const CHECK_SDK_ROOT = "claudinite.com/checksdk";
export const JS_SDK = "@claudinite/sdk";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The public check SDK or anything beneath it, written plainly. */
export function isCheckSdk(spec: string): boolean {
  if (spec === CHECK_SDK_ROOT) return true;
  if (!spec.startsWith(CHECK_SDK_ROOT + "/")) return false;
  return spec.slice(CHECK_SDK_ROOT.length + 1).split("/").every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
}

/** The engine SDK or a plainly written subpath of it. */
export function isEngineSdk(spec: string): boolean {
  if (spec === JS_SDK) return true;
  if (!spec.startsWith(JS_SDK + "/")) return false;
  return spec.slice(JS_SDK.length + 1).split("/").every((s) => SEGMENT.test(s) && !/^\.+$/.test(s));
}
