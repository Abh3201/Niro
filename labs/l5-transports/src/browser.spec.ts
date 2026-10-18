import { expect, test } from "@playwright/test";
import { frame } from "./frames";
import { ChatHub } from "./hub";
import { startServers } from "./server";

/**
 * The browser's own WebTransport (Chromium's) against the lab's Node
 * server: the Node client in transports.test.ts proves the server, this
 * proves it speaks what a browser speaks. Runs with `pnpm e2e`.
 */
test("Chromium chats over WebTransport", async ({ page }) => {
  const hub = new ChatHub();
  const servers = await startServers(hub);
  try {
    const wt = servers.webtransport;
    if (!wt) {
      expect(process.env.CI, "the QUIC library must be installed in CI").toBeFalsy();
      return test.skip(true, "the QUIC library isn't installed here");
    }
    const posted: string[] = [];
    hub.listen((m) => posted.push(`${m.from}: ${m.text}`));
    // WebTransport needs a secure context; http://127.0.0.1 is one.
    await page.route("**/page", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>L5</title>" }),
    );
    await page.goto(`${servers.http1}/page`);
    const received = await page.evaluate(
      async ({ url, hash, join, post }) => {
        const transport = new WebTransport(url, {
          serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(hash) }],
        });
        await transport.ready;
        const stream = await transport.createBidirectionalStream();
        const writer = stream.writable.getWriter();
        await writer.write(new Uint8Array(join));
        await writer.write(new Uint8Array(post));
        // Two messages back: the hello, then the post. Cut them out by length.
        const reader = stream.readable.getReader();
        let bytes = new Uint8Array(0);
        const texts: string[] = [];
        while (texts.length < 2) {
          const { value, done } = await reader.read();
          if (done) break;
          const joined = new Uint8Array(bytes.length + value.length);
          joined.set(bytes);
          joined.set(value, bytes.length);
          bytes = joined;
          for (;;) {
            if (bytes.length < 4) break;
            const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
            if (bytes.length < 4 + size) break;
            texts.push(JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + size))).text);
            bytes = bytes.slice(4 + size);
          }
        }
        transport.close();
        return texts;
      },
      {
        url: wt.url,
        hash: [...wt.certificateHash],
        join: [...frame(new Uint8Array(0))],
        post: [
          ...frame(new TextEncoder().encode(JSON.stringify({ from: "chromium", text: "hi" }))),
        ],
      },
    );
    // "2 here": the browser, and this test listening for posts.
    expect(received).toEqual(["2 here", "hi"]);
    expect(posted).toEqual(["chromium: hi"]);
  } finally {
    await servers.close();
  }
});
