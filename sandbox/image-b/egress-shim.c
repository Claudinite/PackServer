// LD_PRELOAD shim for sandbox B: records connect, sendto, sendmsg and name-resolution attempts of
// any dynamically linked process that runs pack content (bash /dev/tcp, getent, ...) as JSON
// lines on the descriptor named by B_EGRESS_FD, and refuses them. The container has no network
// either way; the record is what turns an attempt into evidence. Statically linked programs do
// not load it.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void record(const char *kind, const char *target) {
	const char *fdenv = getenv("B_EGRESS_FD");
	int fd = fdenv ? atoi(fdenv) : 3;
	char clean[160];
	size_t n = 0;
	for (const char *p = target; *p && n < sizeof clean - 1; p++) {
		unsigned char c = (unsigned char)*p;
		clean[n++] = (c >= 0x20 && c < 0x7f && c != '"' && c != '\\') ? (char)c : '?';
	}
	clean[n] = 0;
	char line[256];
	int len = snprintf(line, sizeof line, "{\"kind\":\"%s\",\"target\":\"%s\"}\n", kind, clean);
	if (len > 0) {
		ssize_t ignored = write(fd, line, (size_t)len);
		(void)ignored;
	}
}

// Returns 1 and fills `out` for an internet address; unix-domain peers are local IPC, not egress.
static int describe(const struct sockaddr *addr, char *out, size_t size) {
	char host[INET6_ADDRSTRLEN];
	if (!addr) return 0;
	if (addr->sa_family == AF_INET) {
		const struct sockaddr_in *a = (const struct sockaddr_in *)addr;
		inet_ntop(AF_INET, &a->sin_addr, host, sizeof host);
		snprintf(out, size, "%s:%d", host, ntohs(a->sin_port));
		return 1;
	}
	if (addr->sa_family == AF_INET6) {
		const struct sockaddr_in6 *a = (const struct sockaddr_in6 *)addr;
		inet_ntop(AF_INET6, &a->sin6_addr, host, sizeof host);
		snprintf(out, size, "[%s]:%d", host, ntohs(a->sin6_port));
		return 1;
	}
	return 0;
}

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
	char target[128];
	(void)fd;
	(void)len;
	if (describe(addr, target, sizeof target)) {
		record("connect", target);
		errno = ECONNREFUSED;
		return -1;
	}
	errno = ENETUNREACH;
	return -1;
}

ssize_t sendto(int fd, const void *buf, size_t n, int flags, const struct sockaddr *addr, socklen_t len) {
	char target[128];
	(void)fd;
	(void)buf;
	(void)n;
	(void)flags;
	(void)len;
	if (describe(addr, target, sizeof target)) {
		record("udp", target);
		errno = ECONNREFUSED;
		return -1;
	}
	errno = ENOTCONN;
	return -1;
}

ssize_t sendmsg(int fd, const struct msghdr *msg, int flags) {
	char target[128];
	(void)fd;
	(void)flags;
	if (msg && describe((const struct sockaddr *)msg->msg_name, target, sizeof target)) {
		record("udp", target);
		errno = ECONNREFUSED;
		return -1;
	}
	errno = ENOTCONN;
	return -1;
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
	(void)service;
	(void)hints;
	(void)res;
	record("dns", node ? node : "");
	return EAI_FAIL;
}

struct hostent *gethostbyname(const char *name) {
	record("dns", name ? name : "");
	h_errno = NO_RECOVERY;
	return NULL;
}

struct hostent *gethostbyname2(const char *name, int af) {
	(void)af;
	record("dns", name ? name : "");
	h_errno = NO_RECOVERY;
	return NULL;
}

int gethostbyname_r(const char *name, struct hostent *ret, char *buf, size_t buflen, struct hostent **result, int *h_errnop) {
	(void)ret;
	(void)buf;
	(void)buflen;
	record("dns", name ? name : "");
	*result = NULL;
	*h_errnop = NO_RECOVERY;
	return ECONNREFUSED;
}

int gethostbyname2_r(const char *name, int af, struct hostent *ret, char *buf, size_t buflen, struct hostent **result, int *h_errnop) {
	(void)af;
	return gethostbyname_r(name, ret, buf, buflen, result, h_errnop);
}
