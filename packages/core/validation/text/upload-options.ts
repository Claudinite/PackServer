// Long options of the HTTP tools, sorted, for resolving an unambiguous prefix the way the tools do.
export const CURL_LONG = (
  "abstract-unix-socket alt-svc anyauth append aws-sigv4 basic ca-native cacert capath cert cert-status " +
  "cert-type ciphers compressed compressed-ssh config connect-timeout connect-to continue-at cookie cookie-jar " +
  "create-dirs create-file-mode crlf crlfile curves data data-ascii data-binary data-raw data-urlencode " +
  "delegation digest disable disable-eprt disable-epsv disallow-username-in-url dns-interface dns-ipv4-addr " +
  "dns-ipv6-addr dns-servers doh-cert-status doh-insecure doh-url dump-header egd-file engine etag-compare " +
  "etag-save expect100-timeout fail fail-early fail-with-body false-start form form-escape form-string " +
  "ftp-account ftp-alternative-to-user ftp-create-dirs ftp-method ftp-pasv ftp-port ftp-pret ftp-skip-pasv-ip " +
  "ftp-ssl-ccc ftp-ssl-ccc-mode ftp-ssl-control get globoff happy-eyeballs-timeout-ms haproxy-clientip " +
  "haproxy-protocol head header help hostpubmd5 hostpubsha256 hsts http0 http1 http2 http2-prior-knowledge http3 " +
  "http3-only ignore-content-length include insecure interface ipfs-gateway ipv4 ipv6 json junk-session-cookies " +
  "keepalive-time key key-type krb libcurl limit-rate list-only local-port location location-trusted " +
  "login-options mail-auth mail-from mail-rcpt mail-rcpt-allowfails manual max-filesize max-redirs max-time " +
  "metalink negotiate netrc netrc-file netrc-optional next no-alpn no-buffer no-clobber no-keepalive no-npn " +
  "no-progress-meter no-sessionid noproxy ntlm ntlm-wb oauth2-bearer output output-dir parallel " +
  "parallel-immediate parallel-max pass path-as-is pinnedpubkey post301 post302 post303 preproxy progress-bar " +
  "proto proto-default proto-redir proxy proxy-anyauth proxy-basic proxy-ca-native proxy-cacert proxy-capath " +
  "proxy-cert proxy-cert-type proxy-ciphers proxy-crlfile proxy-digest proxy-header proxy-http2 proxy-insecure " +
  "proxy-key proxy-key-type proxy-negotiate proxy-ntlm proxy-pass proxy-pinnedpubkey proxy-service-name " +
  "proxy-ssl-allow-beast proxy-ssl-auto-client-cert proxy-tls13-ciphers proxy-tlsauthtype proxy-tlspassword " +
  "proxy-tlsuser proxy-tlsv1 proxy-user proxy1 proxytunnel pubkey quote random-file range rate raw referer " +
  "remote-header-name remote-name remote-name-all remote-time remove-on-error request request-target resolve " +
  "retry retry-all-errors retry-connrefused retry-delay retry-max-time sasl-authzid sasl-ir service-name " +
  "show-error silent socks4 socks4a socks5 socks5-basic socks5-gssapi socks5-gssapi-nec socks5-gssapi-service " +
  "socks5-hostname speed-limit speed-time ssl ssl-allow-beast ssl-auto-client-cert ssl-no-revoke ssl-reqd " +
  "ssl-revoke-best-effort sslv2 sslv3 stderr styled-output suppress-connect-headers tcp-fastopen tcp-nodelay " +
  "telnet-option tftp-blksize tftp-no-options time-cond tls-max tls13-ciphers tlsauthtype tlspassword tlsuser " +
  "tlsv1 tr-encoding trace trace-ascii trace-config trace-ids trace-time unix-socket upload-file url url-query " +
  "use-ascii user user-agent variable verbose version write-out xattr"
).split(" ");

export const WGET_LONG = (
  "accept accept-regex adjust-extension append-output ask-password auth-no-challenge background backup-converted " +
  "backups base bind-address body-data body-file ca-certificate ca-directory certificate certificate-type " +
  "ciphers compression config connect-timeout content-disposition content-on-error continue convert-file-only " +
  "convert-links crl-file cut-dirs debug default-page delete-after directory-prefix dns-timeout domains " +
  "exclude-directories exclude-domains execute follow-ftp follow-tags force-directories force-html ftp-password " +
  "ftp-user ftps-clear-data-connection ftps-fallback-to-ftp ftps-implicit ftps-resume-ssl header help hsts-file " +
  "http-password http-user https-only ignore-case ignore-length ignore-tags include-directories inet4-only " +
  "inet6-only input-file keep-session-cookies level limit-rate load-cookies local-encoding max-redirect method " +
  "mirror no-cache no-check-certificate no-clobber no-config no-cookies no-directories no-dns-cache no-glob " +
  "no-host-directories no-hsts no-http-keep-alive no-if-modified-since no-iri no-netrc no-parent no-passive-ftp " +
  "no-proxy no-remove-listing no-use-server-timestamps no-verbose no-warc-compression no-warc-digests " +
  "no-warc-keep-log output-document output-file page-requisites password pinnedpubkey post-data post-file " +
  "prefer-family preserve-permissions private-key private-key-type progress protocol-directories proxy-password " +
  "proxy-user quiet quota random-file random-wait read-timeout recursive referer regex-type reject reject-regex " +
  "rejected-log relative remote-encoding report-speed restrict-file-names retr-symlinks retry-connrefused " +
  "retry-on-host-error retry-on-http-error save-cookies save-headers secure-protocol server-response " +
  "show-progress span-hosts spider start-pos strict-comments timeout timestamping tries trust-server-names " +
  "unlink use-askpass user user-agent verbose version wait waitretry warc-cdx warc-dedup warc-file warc-header " +
  "warc-max-size warc-tempdir xattr"
).split(" ");
