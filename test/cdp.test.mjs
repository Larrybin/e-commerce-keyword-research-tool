import assert from "node:assert/strict";
import test from "node:test";
import { chromeWebSocketEndpointFromDevToolsActivePort } from "../src/lib/cdp.mjs";

test("chromeWebSocketEndpointFromDevToolsActivePort builds endpoint from active port file path", () => {
  assert.equal(
    chromeWebSocketEndpointFromDevToolsActivePort("9222", "/devtools/browser/test"),
    "ws://127.0.0.1:9222/devtools/browser/test"
  );
});

test("chromeWebSocketEndpointFromDevToolsActivePort preserves explicit websocket URLs", () => {
  assert.equal(
    chromeWebSocketEndpointFromDevToolsActivePort("9222", "ws://127.0.0.1:9222/devtools/browser/test"),
    "ws://127.0.0.1:9222/devtools/browser/test"
  );
});
