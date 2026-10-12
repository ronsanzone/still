import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const denied = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();

globalV6.addSubnet("2000::", 3, "ipv6");

for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  denied.addSubnet(address, prefix, "ipv6");

export function publicAddress(address: string) {
  const family = isIP(address);

  return family === 4
    ? !denied.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !denied.check(address, "ipv6");
}

export function webUrl(value: string) {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only credential-free HTTP(S) URLs are allowed");
  url.hash = "";
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host) && !publicAddress(host))
    throw new Error("Private or reserved address blocked");

  return url;
}

/**
 * Provenance identity for a page. Scheme, a leading "www.", default ports, a
 * trailing slash and the fragment do not change which page is meant; host,
 * path, query and non-default ports do. DNS and address checks still apply to
 * whichever variant is fetched.
 */
export function urlKey(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, "");
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname.replace(/(.)\/$/, "$1");

  return `${host}${port}${path}${url.search}`;
}

// Injectable network functions are test boundaries, never URL-controlled policy switches.
export const network = {
  resolve: (host: string) => lookup(host, { all: true, verbatim: true }),
  request: (url: URL, options: Parameters<typeof httpRequest>[1]) =>
    (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options),
  idleMs: 60000,
};

export async function readUrl(
  value: string,
  signal?: AbortSignal,
  transport = network,
  headers: Record<string, string> = {},
) {
  let url = webUrl(value);
  const visited = new Set<string>();

  while (true) {
    if (visited.has(url.href)) throw new Error("Redirect loop blocked");
    visited.add(url.href);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // Bound DNS and connect/TLS as well as idle reads; slow streaming is not a size cap.
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) abort();

    const timer = setTimeout(
      () => controller.abort(new Error("Connection timeout")),
      transport.idleMs,
    );

    try {
      const addresses = await Promise.race([
        isIP(host)
          ? Promise.resolve([{ address: host, family: isIP(host) }])
          : transport.resolve(host),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new Error("Fetch cancelled"));
          else
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("Fetch cancelled or timed out")),
              { once: true },
            );
        }),
      ]);

      if (
        !addresses.length ||
        addresses.some((item) => !publicAddress(item.address))
      )
        throw new Error("Private or reserved DNS answer blocked");
      const pinned = addresses[0];

      if (!pinned) throw new Error("No DNS answer");

      const response = await new Promise<{
        status: number;
        location?: string;
        type: string;
        bytes: Buffer;
      }>((resolve, reject) => {
        const request = transport.request(url, {
          agent: false,
          signal: controller.signal,
          headers: {
            "user-agent": "Still/1 research",
            "accept-encoding": "identity",
            ...headers,
          },
          // Preserve URL hostname for Host/SNI/certificate verification; connect only to the checked IP.
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        });

        request.on("error", reject);
        request.setTimeout(transport.idleMs, () =>
          request.destroy(new Error("Idle socket timeout")),
        );
        request.on("response", (incoming) => {
          clearTimeout(timer);
          incoming.on("error", reject);
          incoming.on("aborted", () => reject(new Error("Response aborted")));
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              location: incoming.headers.location,
              type: incoming.headers["content-type"] ?? "",
              bytes: Buffer.concat(chunks),
            }),
          );
        });
        request.end();
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location) throw new Error("Redirect without location");
        const next = webUrl(new URL(response.location, url).href);

        url = next;
        // Do not leak any credential header on redirects, including within the search adapter.
        headers = {};
        continue;
      }

      if (response.status < 200 || response.status >= 300)
        throw new Error(`Fetch failed (${response.status})`);

      return { url: url.href, ...response };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
