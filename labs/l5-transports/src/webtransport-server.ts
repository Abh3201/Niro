import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameReader, frame } from "./frames";
import { type ChatHub, type ChatMessage, hello } from "./hub";
import { parsePost } from "./server";

/**
 * WebTransport: HTTP/3 over QUIC, over UDP. A session carries any number of
 * independent streams (and unreliable datagrams), so one lost packet stalls
 * only its own stream. The chat uses one stream each way, framed by length.
 *
 * Node has no HTTP/3 server of its own yet; this uses
 * @fails-components/webtransport and its prebuilt QUIC library (Google's
 * quiche). Without that library, or without `openssl` to make the
 * certificate, it returns null and the other transports carry on.
 */
export interface WebTransportServer {
  readonly url: string;
  /**
   * SHA-256 of the certificate. Browsers accept a self-signed certificate
   * for WebTransport only by this hash (`serverCertificateHashes`), and only
   * if it's ECDSA and valid for at most 14 days.
   */
  readonly certificateHash: Uint8Array;
  close(): Promise<void>;
}

import type { WebTransportSession } from "@fails-components/webtransport";

type Module = typeof import("@fails-components/webtransport");

async function load(): Promise<Module | null> {
  try {
    const module = await import("@fails-components/webtransport");
    await module.quicheLoaded;
    return module;
  } catch {
    return null;
  }
}

export async function startWebTransport(hub: ChatHub): Promise<WebTransportServer | null> {
  const module = await load();
  const certificate = module && makeCertificate();
  if (!module || !certificate) return null;
  const server = new module.Http3Server({
    port: 0,
    host: "127.0.0.1",
    secret: crypto.randomUUID(),
    cert: certificate.cert,
    privKey: certificate.key,
    // The chat doesn't use datagrams; the library's types require a mode anyway.
    defaultDatagramsReadableMode: "bytes",
  });
  server.startServer();
  await server.ready;
  const address = server.address();
  if (!address) throw new Error("WebTransport server has no address");
  const port = address.port;

  void (async () => {
    const sessions = server.sessionStream("/chat").getReader();
    for (;;) {
      const { value: session, done } = await sessions.read();
      if (done) return;
      void serveSession(hub, session).catch(() => {});
    }
  })();

  return {
    url: `https://127.0.0.1:${port}/chat`,
    certificateHash: certificate.hash,
    async close() {
      server.stopServer();
      await server.closed.catch(() => {});
    },
  };
}

async function serveSession(hub: ChatHub, session: WebTransportSession) {
  await session.ready;
  // The client opens one stream both ways; posts come up it, messages go down.
  const { value: stream } = await session.incomingBidirectionalStreams.getReader().read();
  if (!stream) return;
  const writer = stream.writable.getWriter();
  const encode = (m: ChatMessage) => frame(new TextEncoder().encode(JSON.stringify(m)));
  const stop = hub.listen((message) => void writer.write(encode(message)).catch(() => {}));
  session.closed.finally(stop);
  await writer.write(encode(hello(hub)));
  const frames = new FrameReader(64 * 1024);
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const bytes of frames.push(value)) {
        const post = parsePost(new TextDecoder().decode(bytes));
        if (post) hub.post(post.from, post.text);
      }
    }
  } finally {
    stop();
  }
}

/** A throwaway ECDSA P-256 certificate for 127.0.0.1, valid for 10 days, made with openssl. */
function makeCertificate(): { cert: string; key: string; hash: Uint8Array } | null {
  const dir = mkdtempSync(join(tmpdir(), "niro-l5-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "10",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const key = readFileSync(join(dir, "key.pem"), "utf8");
    const hash = createHash("sha256").update(new X509Certificate(cert).raw).digest();
    return { cert, key, hash: new Uint8Array(hash) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
