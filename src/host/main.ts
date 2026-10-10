import {
  createServer,
  request as forward,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { Config, Effect, ManagedRuntime, Schema } from "effect";
import {
  BuilderAdmission,
  BuilderStart,
  VersionAction,
  VersionId,
} from "../shared/builder.ts";
import { BuilderFailure, Releases } from "./releases.ts";

const runtime = ManagedRuntime.make(Releases.layer);

const releases = await runtime.runPromise(Releases);

const port = await runtime.runPromise(
  Config.Int("PORT").pipe(Config.withDefault(3000)),
);

const ownerSession = randomUUID();

function authorized(request: IncomingMessage) {
  const token = request.headers["x-still-owner"];

  const cookie = request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .includes(`still-owner=${ownerSession}`);

  return (
    Boolean(cookie) ||
    (!Array.isArray(token) && releases.host.authorize(token ?? ""))
  );
}

function json<A>(response: ServerResponse, status: number, value: A) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

const readBody = Effect.fn("Builder.body")(function* (
  request: IncomingMessage,
) {
  if (
    !request.headers["content-type"]?.startsWith("application/json") ||
    request.headers["sec-fetch-site"] === "cross-site"
  )
    return yield* new BuilderFailure({
      message: "Same-origin JSON is required.",
      status: 403,
    });

  return yield* Effect.tryPromise({
    try: async () => {
      let text = "";

      for await (const chunk of request) {
        text += chunk;

        if (Buffer.byteLength(text) > 70000)
          throw new Error("Request exceeds 70 KB");
      }

      return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
        text,
      );
    },
    catch: () =>
      new BuilderFailure({
        message: "Invalid JSON request (maximum 70 KB).",
        status: 400,
      }),
  });
});

const route = Effect.fn("Builder.route")(function* (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
) {
  if (!authorized(request))
    return yield* new BuilderFailure({
      message: "An explicit owner token is required for Builder.",
      status: 401,
    });
  const ownerToken = request.headers["x-still-owner"];

  if (
    request.method === "POST" &&
    (Array.isArray(ownerToken) || !releases.host.authorize(ownerToken ?? ""))
  )
    return yield* new BuilderFailure({
      message:
        "Owner token header is required for explicit Builder actions; a preview/session cookie cannot activate code.",
      status: 401,
    });

  if (path === "/api/builder/status" && request.method === "GET") {
    response.setHeader(
      "set-cookie",
      `still-owner=${ownerSession}; HttpOnly; SameSite=Strict; Path=/${request.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`,
    );
    json(response, 200, releases.host.status());

    return;
  }

  if (request.method !== "POST")
    return yield* new BuilderFailure({ message: "Not found.", status: 404 });
  const input = yield* readBody(request);

  if (path === "/api/builder/create") {
    const decoded = yield* Schema.decodeUnknownEffect(BuilderStart)(input);
    const candidate = yield* releases.create(decoded.requestId);

    const admission = yield* Schema.decodeUnknownEffect(BuilderAdmission)({
      ...decoded,
      candidate: candidate.id,
    });

    const receipt = yield* Effect.tryPromise({
      try: async () => {
        const result = await fetch(
          `http://127.0.0.1:${releases.host.appPort}/api/builder/chat`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-still-internal": releases.host.internalToken,
            },
            body: JSON.stringify(admission),
          },
        );

        const data = await result.json();

        if (!result.ok) {
          const problem = Schema.decodeUnknownSync(
            Schema.Struct({ message: Schema.String }),
          )(data);

          throw new BuilderFailure({
            message: problem.message,
            status: result.status,
          });
        }

        return data;
      },
      catch: (error) =>
        error instanceof BuilderFailure
          ? error
          : new BuilderFailure({
              message:
                "Builder admission failed. Reconnect and replay the same request ID.",
              status: 502,
            }),
    });

    json(
      response,
      201,
      yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Number }))(
        receipt,
      ),
    );

    return;
  }

  if (path === "/api/builder/validate") {
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ candidate: VersionId }),
    )(input);

    json(response, 200, yield* releases.validate(decoded.candidate));

    return;
  }

  if (path === "/api/builder/activate") {
    const decoded = yield* Schema.decodeUnknownEffect(VersionAction)(input);
    json(response, 200, yield* releases.activate(decoded));

    return;
  }

  return yield* new BuilderFailure({ message: "Not found.", status: 404 });
});

function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  preview: boolean,
) {
  const headers = { ...request.headers };
  delete headers["x-still-owner"];
  delete headers["x-still-internal"];

  if (!preview && authorized(request))
    headers["x-still-internal"] = releases.host.internalToken;

  const forwarded = forward(
    {
      hostname: "127.0.0.1",
      port: preview ? releases.host.previewPort : releases.host.appPort,
      method: request.method,
      path: preview
        ? request.url?.replace(/^\/builder-preview\/[a-f0-9]{64}/, "") || "/"
        : request.url,
      headers,
    },
    (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    },
  );

  forwarded.on("error", () => {
    if (!response.headersSent)
      json(response, 503, {
        message:
          "Release is restarting. Supervisor and owner controls remain available.",
      });
    else response.end();
  });
  response.once("close", () => forwarded.destroy());
  request.pipe(forwarded);
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  if (path.startsWith("/api/builder/") && path !== "/api/builder/chat") {
    // Durable admission/checks/activation are not cancelled when the browser disconnects.
    void runtime
      .runPromise(
        route(request, response, path).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.sync(() =>
              json(response, 400, { message: "Invalid Builder request." }),
            ),
          ),
          Effect.catchTag("BuilderFailure", (error) =>
            Effect.sync(() =>
              json(response, error.status, { message: error.message }),
            ),
          ),
        ),
      )
      .catch(() => {
        if (!response.headersSent)
          json(response, 500, { message: "Supervisor operation failed." });
      });

    return;
  }

  if (path === "/api/builder/chat") {
    json(response, 403, { message: "Builder admission is supervisor-only." });

    return;
  }

  const preview = path.startsWith("/builder-preview/");

  if (preview && !authorized(request)) {
    json(response, 401, { message: "Preview requires the owner token." });

    return;
  }

  if (
    preview &&
    !releases.host
      .status()
      .candidates.some(
        (candidate) => candidate.preview && path.startsWith(candidate.preview),
      )
  ) {
    json(response, 410, {
      message:
        "This preview version is no longer running. Validate the exact candidate again.",
    });

    return;
  }

  proxy(request, response, preview);
});

server.listen(port, "127.0.0.1", () =>
  console.log(`Still supervisor ready on port ${port}`),
);

async function close() {
  server.closeAllConnections();
  server.close();
  await runtime.dispose();
}

process.once("SIGTERM", () => {
  void close();
});

process.once("SIGINT", () => {
  void close();
});
