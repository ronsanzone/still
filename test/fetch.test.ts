import { createServer, request, type RequestOptions } from "node:http";
import { expect, it } from "vitest";
import { Predicate } from "effect";
import {
  network,
  publicAddress,
  readUrl,
  webUrl,
  urlKey,
} from "../src/kernel/fetch.ts";

it("treats scheme, www., default port, trailing slash and fragment variants as one page", () => {
  const key = urlKey("https://sqlite.org/releaselog/current.html");

  for (const variant of [
    "https://www.sqlite.org/releaselog/current.html",
    "http://sqlite.org/releaselog/current.html",
    "https://SQLite.org:443/releaselog/current.html#top",
    "https://www.sqlite.org/releaselog/current.html/",
  ])
    expect(urlKey(variant)).toBe(key);

  expect(urlKey("https://www.sqlite.org/")).toBe(urlKey("https://sqlite.org"));

  // Different hosts, paths, queries and ports stay distinct.
  for (const other of [
    "https://docs.sqlite.org/releaselog/current.html",
    "https://sqlite.org/releaselog/3_50_1.html",
    "https://sqlite.org/releaselog/current.html?x=1",
    "https://sqlite.org:8443/releaselog/current.html",
    "https://wwwsqlite.org/releaselog/current.html",
  ])
    expect(urlKey(other)).not.toBe(key);
});

it("rejects private, metadata, tailnet, reserved and mapped addresses including alternate encodings", async () => {
  for (const host of [
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "0.1.2.3",
    "10.2.3.4",
    "172.31.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.100",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[fc00::1]",
    "[fe80::1]",
    "[2002:7f00:1::]",
    "224.1.1.1",
    "255.255.255.255",
  ])
    expect(() => webUrl(`http://${host}/`)).toThrow();

  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com",
    "http://user:pass@example.com",
  ])
    expect(() => webUrl(url)).toThrow();
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  expect(network.idleMs).toBe(60000);
  await expect(
    readUrl("http://private.test", undefined, {
      ...network,
      resolve: async () => [{ address: "10.0.0.1", family: 4 }],
    }),
  ).rejects.toThrow("DNS answer blocked");
  await expect(
    readUrl("http://mixed.test", undefined, {
      ...network,
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "::1", family: 6 },
      ],
    }),
  ).rejects.toThrow("DNS answer blocked");
  await expect(
    readUrl("http://hung-dns.test", undefined, {
      ...network,
      idleMs: 20,
      resolve: () => new Promise(() => {}),
    }),
  ).rejects.toThrow("timed out");
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    readUrl("http://cancelled.test", cancelled.signal, {
      ...network,
      resolve: () => new Promise(() => {}),
    }),
  ).rejects.toThrow("cancelled");
});

it("pins checked DNS, rechecks redirects, refuses unknown URLs and closes hung connections", async () => {
  const seen: string[] = [];

  const server = createServer((req, res) => {
    seen.push(req.url ?? "");

    if (req.url === "/private") {
      res.writeHead(302, { location: "http://169.254.169.254/secret" });
      res.end();
    } else if (req.url === "/cross") {
      res.writeHead(302, { location: "http://other.test/answer" });
      res.end();
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: "/answer" });
      res.end();
    } else if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
    } else if (req.url === "/hung") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("started");
    } else if (req.url !== "/no-headers") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("complete public answer");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || Predicate.isString(address))
    throw new Error("Missing test port");
  let resolutions = 0;
  const pins: string[] = [];

  const transport = {
    idleMs: 60,
    resolve: async () => {
      resolutions += 1;

      return [{ address: "93.184.216.34", family: 4 }];
    },
    request: (url: URL, options: RequestOptions) => {
      const local = new URL(url);
      local.port = String(address.port);

      return request(local, {
        ...options,
        lookup: (host, opts, callback) => {
          // Test-only dial mapping. Production's checked lookup is exercised, then mapped to the fixture socket.
          if (!options.lookup) throw new Error("Unpinned request");
          options.lookup(host, { ...opts, all: false }, (error, checked) => {
            if (error || !Predicate.isString(checked))
              throw new Error("Missing pinned IP");
            pins.push(checked);

            if (opts.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          });
        },
      });
    },
  };

  try {
    const result = await readUrl(
      "http://public.test/answer",
      undefined,
      transport,
    );

    expect(result.bytes.toString()).toBe("complete public answer");
    expect(resolutions).toBe(1);
    expect(pins).toEqual(["93.184.216.34"]);
    await expect(
      readUrl("http://public.test/private", undefined, transport),
    ).rejects.toThrow("address blocked");
    expect(seen).not.toContain("/secret");

    const redirect = await readUrl(
      "http://public.test/redirect",
      undefined,
      transport,
    );

    expect(redirect.url).toBe("http://public.test/answer");
    await expect(
      readUrl("http://public.test/loop", undefined, transport),
    ).rejects.toThrow("loop");
    await expect(
      readUrl("http://public.test/hung", undefined, transport),
    ).rejects.toThrow();
    await expect(
      readUrl("http://public.test/no-headers", undefined, transport),
    ).rejects.toThrow();
    let rebinding = 0;
    await expect(
      readUrl("http://public.test/redirect", undefined, {
        ...transport,
        resolve: async () => [
          {
            address: ++rebinding === 1 ? "93.184.216.34" : "127.0.0.1",
            family: 4,
          },
        ],
      }),
    ).rejects.toThrow("DNS answer blocked");
    expect(rebinding).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
