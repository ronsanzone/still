import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { Config, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { ChatFailure, Chats } from "./chat.ts";
import { ModelCatalog } from "./models.ts";
import {
  ChatId,
  CreateChat,
  Branch,
  Grant,
  SendMessage,
} from "../shared/contracts.ts";
import { BuilderAdmission } from "../shared/builder.ts";

const runtime = ManagedRuntime.make(
  Chats.layer.pipe(Layer.provideMerge(ModelCatalog.layer)),
);

const internalToken = await runtime.runPromise(
  Config.String("STILL_INTERNAL_TOKEN").pipe(Config.withDefault("")),
);

const production = await runtime.runPromise(
  Config.String("STILL_PRODUCTION").pipe(Config.withDefault("")),
);

const release = await runtime.runPromise(
  Config.String("STILL_RELEASE").pipe(Config.withDefault("development")),
);

function owner(request: IncomingMessage) {
  return (
    Boolean(internalToken) &&
    request.headers["x-still-internal"] === internalToken
  );
}

function json<A>(response: ServerResponse, status: number, value: A) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

const body = Effect.fn("Http.body")(function* (request: IncomingMessage) {
  if (
    !request.headers["content-type"]?.startsWith("application/json") ||
    request.headers["sec-fetch-site"] === "cross-site"
  ) {
    return yield* new ChatFailure({
      message: "Same-origin JSON requests are required.",
      status: 403,
    });
  }

  const raw = yield* Effect.tryPromise({
    try: async () => {
      let text = "";
      request.setEncoding("utf8");

      for await (const chunk of request) {
        text += chunk;

        if (Buffer.byteLength(text) > 70000)
          throw new Error("Request too large");
      }

      return text;
    },
    catch: () =>
      new ChatFailure({
        message: "Request could not be read (maximum 70 KB).",
        status: 400,
      }),
  });

  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  )(raw);
});

const route = Effect.fn("Http.route")(function* (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
) {
  const chats = yield* Chats;

  if (pathname === "/api/builder/chat" && request.method === "POST") {
    if (!owner(request))
      return yield* new ChatFailure({
        message: "Builder requires explicit supervisor authorization.",
        status: 403,
      });

    const input = yield* Schema.decodeUnknownEffect(BuilderAdmission)(
      yield* body(request),
    );

    json(response, 201, yield* chats.builder(input));

    return;
  }

  if (pathname.startsWith("/api/builder/"))
    return yield* new ChatFailure({
      message:
        "Builder controls require npm run host with a protected Linux supervisor and dedicated app identity. The development server is chat-only.",
      status: 503,
    });

  if (pathname === "/api/bootstrap" && request.method === "GET") {
    const catalog = yield* ModelCatalog;
    json(response, 200, {
      models: catalog.choices,
      chats: yield* chats.list(),
    });

    return;
  }

  if (pathname === "/api/chats" && request.method === "POST") {
    const input = yield* Schema.decodeUnknownEffect(CreateChat)(
      yield* body(request),
    );

    json(response, 201, yield* chats.create(input.model));

    return;
  }

  if (pathname === "/api/work" && request.method === "GET") {
    json(response, 200, yield* chats.work());

    return;
  }

  const parts = /^\/api\/chats\/(\d+)\/(events|messages|stop|kit|branch)$/.exec(
    pathname,
  );

  if (!parts)
    return yield* new ChatFailure({ message: "Not found.", status: 404 });
  const id = yield* Schema.decodeUnknownEffect(ChatId)(Number(parts[1]));

  if ((yield* chats.builderCandidate(id)) && !owner(request))
    return yield* new ChatFailure({
      message:
        "This Still candidate requires supervisor authorization. Release controls are not yet available in this client.",
      status: 403,
    });

  if (parts[2] === "events" && request.method === "GET") {
    yield* chats.watch(id).pipe(
      Stream.runForEach((snapshot) =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              if (!response.headersSent)
                response.writeHead(200, {
                  "content-type": "text/event-stream",
                  "cache-control": "no-cache, no-transform",
                  connection: "keep-alive",
                  "x-accel-buffering": "no",
                });
              response.write(
                `data: ${JSON.stringify(snapshot)}\n\n`,
                (error) => (error ? reject(error) : resolve()),
              );
            }),
          catch: () =>
            new ChatFailure({ message: "Stream disconnected.", status: 499 }),
        }),
      ),
    );

    return;
  }

  if (request.method !== "POST")
    return yield* new ChatFailure({
      message: "Method not allowed.",
      status: 405,
    });
  const input = yield* body(request);

  if (parts[2] === "kit") {
    json(
      response,
      202,
      yield* chats.kit(
        id,
        yield* Schema.decodeUnknownEffect(Grant)(input),
        owner(request),
      ),
    );

    return;
  }

  if (parts[2] === "branch") {
    json(
      response,
      202,
      yield* chats.branch(id, yield* Schema.decodeUnknownEffect(Branch)(input)),
    );

    return;
  }

  if (parts[2] === "messages") {
    json(
      response,
      202,
      yield* chats.send(
        id,
        yield* Schema.decodeUnknownEffect(SendMessage)(input),
      ),
    );

    return;
  }

  if (parts[2] === "stop") {
    yield* chats.stop(id);
    json(response, 200, { id });

    return;
  }

  return yield* new ChatFailure({ message: "Not found.", status: 404 });
});

const port = await runtime.runPromise(
  Config.Int("PORT").pipe(Config.withDefault(3000)),
);

await runtime.runPromise(Chats);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (pathname === "/healthz") {
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const chats = yield* Chats;
          yield* chats.list();
          json(response, 200, {
            status: "ready",
            release,
            extensions: chats.extensions,
          });
        }),
      )
      .catch(() => json(response, 503, { status: "unavailable", release }));

    return;
  }

  if (!pathname.startsWith("/api/")) {
    if (vite) vite.middlewares(request, response);
    else {
      const root = resolve("dist");
      const file = resolve(root, `.${pathname}`);

      if (!file.startsWith(`${root}${sep}`) && file !== root) {
        json(response, 404, { message: "Not found." });

        return;
      }

      const asset = extname(file) ? file : resolve(root, "index.html");
      void readFile(asset)
        .then((content) => {
          response.writeHead(200, {
            "content-type": asset.endsWith(".js")
              ? "text/javascript"
              : asset.endsWith(".css")
                ? "text/css"
                : asset.endsWith(".svg")
                  ? "image/svg+xml"
                  : "text/html",
            "cache-control": "no-store",
          });
          response.end(content);
        })
        .catch(() => json(response, 404, { message: "Not found." }));
    }

    return;
  }

  const controller = new AbortController();
  response.once("close", () => controller.abort());

  const handled = route(request, response, pathname).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.sync(() =>
        json(response, 400, {
          message: "Invalid request. Check the message and model selection.",
        }),
      ),
    ),
    Effect.catchTag("ChatFailure", (error) =>
      Effect.sync(() => {
        if (response.headersSent) response.end();
        else json(response, error.status, { message: error.message });
      }),
    ),
  );

  void runtime.runPromise(handled, { signal: controller.signal }).catch(() => {
    if (controller.signal.aborted) return;

    if (!response.headersSent)
      json(response, 500, { message: "Unexpected server failure." });
    else response.end();
  });
});

const vite = production
  ? undefined
  : await (
      await import("vite")
    ).createServer({
      server: {
        middlewareMode: true,
        allowedHosts: [".onamp.dev"],
        cors: false,
        hmr: { server },
      },
      appType: "spa",
    });

server.listen(port, "127.0.0.1", () =>
  console.log(`Still ready on port ${port}`),
);

let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close();
  await vite?.close();
  await runtime.dispose();
}

process.once("SIGTERM", () => {
  void close();
});

process.once("SIGINT", () => {
  void close();
});
