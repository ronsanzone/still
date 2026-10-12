import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { readUrl } from "./fetch.ts";

export const SearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.String,
});

export class SearchFailure extends Schema.TaggedError<SearchFailure>()(
  "SearchFailure",
  { message: Schema.String },
) {}

export class SearchProvider extends Context.Service<
  SearchProvider,
  {
    readonly search: (
      query: string,
    ) => Effect.Effect<
      readonly Schema.Schema.Type<typeof SearchResult>[],
      SearchFailure
    >;
  }
>()("still/SearchProvider") {
  static readonly layer = Layer.effect(
    SearchProvider,
    Effect.gen(function* () {
      const key = yield* Config.option(Config.Redacted("BRAVE_SEARCH_API_KEY"));

      return SearchProvider.of({
        search: Effect.fn("SearchProvider.search")(function* (query) {
          if (Option.isNone(key))
            return yield* new SearchFailure({
              message:
                "Search needs BRAVE_SEARCH_API_KEY; no fallback provider is enabled.",
            });
          const url = new URL("https://api.search.brave.com/res/v1/web/search");
          url.searchParams.set("q", query);

          const response = yield* Effect.tryPromise({
            try: (signal) =>
              readUrl(url.href, signal, undefined, {
                "X-Subscription-Token": Redacted.value(key.value),
              }),
            catch: () =>
              new SearchFailure({ message: "Search request failed" }),
          });

          const data = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                web: Schema.optionalKey(
                  Schema.Struct({
                    results: Schema.Array(
                      Schema.Struct({
                        title: Schema.String,
                        url: Schema.String,
                        description: Schema.String,
                      }),
                    ),
                  }),
                ),
              }),
            ),
          )(response.bytes.toString("utf8")).pipe(
            Effect.mapError(
              () => new SearchFailure({ message: "Invalid search response" }),
            ),
          );

          return (data.web?.results ?? []).map((item) => ({
            title: item.title,
            url: item.url,
            snippet: item.description,
          }));
        }),
      });
    }),
  );
}
