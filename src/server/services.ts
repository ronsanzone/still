import { Layer } from "effect";
import webPush from "web-push";
import { attachmentsConfigLayer } from "../kernel/attachments.ts";
import { SearchProvider } from "../kernel/search.ts";
import { webPushLayer } from "../kernel/push.ts";

export const ChatServices = Layer.mergeAll(
  attachmentsConfigLayer,
  SearchProvider.layer,
  webPushLayer(webPush),
);
