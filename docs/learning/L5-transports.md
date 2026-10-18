# L5: One chat, five transports

Niro sends everything over one WebSocket. This lab builds the same tiny chat room on every transport a browser app could reasonably use, puts them all in one room, and measures what each costs, to see why.

Code: [`labs/l5-transports`](../../labs/l5-transports). One Node process serves the room (`ChatHub`) on:

| Transport | Underneath | Both ways on one connection? | In browsers |
|---|---|---|---|
| WebSocket | One TCP connection, upgraded from HTTP/1.1, then framed messages | Yes | Everywhere |
| Server-sent events + POST | A response that never ends (`text/event-stream`), and a request per post | No: down on one, up on others | Everywhere |
| Connect, HTTP/1.1 | `Watch`, a streaming response, and `Send`, a request per post | No | Everywhere, with `@connectrpc/connect-web` |
| Connect / gRPC, HTTP/2 | `Talk`: one HTTP/2 stream, posts up and messages down | Yes | No (see below) |
| WebTransport | HTTP/3 over QUIC over UDP; a session holds many independent streams | Yes | Chrome, Edge, Firefox, and Safari since 26.4 ([source](https://www.utsubo.com/blog/frontier-web-apis-2026-production-ready)) |

The Connect server speaks three protocols from one handler: Connect's own, gRPC and gRPC-Web. Google's `@grpc/grpc-js` client, loading the `.proto` at run time with no generated code, talks to it like any gRPC server.

The tests ([`transports.test.ts`](../../labs/l5-transports/src/transports.test.ts)) give each transport two clients that must see each other's posts in order. Then one client of every kind joins the same room, and all of them must see every post with the same ids in the same order. [`browser.spec.ts`](../../labs/l5-transports/src/browser.spec.ts) runs with `pnpm e2e` and has Chromium's own `WebTransport` chat with the Node server.

## What each costs

Measured by [`measure.test.ts`](../../labs/l5-transports/src/measure.test.ts) on one machine over loopback, through a relay that counts every byte. Each post is "hello, room" (11 bytes), sent one at a time and waited for, 500 times after a warm-up:

| Transport | Bytes to connect | Bytes up per post | Bytes down per post | Round trip p50 (ms) | p99 (ms) |
|---|---|---|---|---|---|
| WebSocket | 418 | 40 | 68 | 0.05 | 0.17 |
| Server-sent events + POST | 483 | 261 | 272 | 0.59 | 3.72 |
| Connect, HTTP/1.1 | 513 | 273 | 196 | 0.95 | 3.91 |
| Connect, HTTP/2 | 293 | 31 | 41 | 0.09 | 0.87 |
| gRPC (Connect client) | 270 | 31 | 41 | 0.06 | 0.35 |
| gRPC (grpc-js client) | 301 | 31 | 41 | 0.07 | 0.39 |
| WebTransport (HTTP/3) | 9,978 | 74 | 100 | 0.12 | 0.38 |

Where the bytes go:

- **WebSocket, 40 up**: 34 bytes of JSON (`{"from":"me","text":"hello, room"}`) and a 6-byte frame header: 2 bytes of length and flags, and 4 bytes of mask, which browsers must add to everything they send (L2). Down is 2 bytes of header and a longer JSON message with its id and time.
- **HTTP/1.1 posts, ~260 up**: every post is a whole HTTP request, headers and all, and its response comes back with headers too. The messages coming down the open SSE or Connect response are cheap; it's the posting that costs.
- **gRPC and Connect on HTTP/2, 31 up**: a 9-byte HTTP/2 frame header, a 5-byte gRPC prefix (a compression flag and a length), and 17 bytes of protobuf. Protobuf skips the field names that JSON repeats in every message, so it's the smallest on the wire.
- **WebTransport, 74 up**: QUIC encrypts every packet, adding a header and a 16-byte authentication tag, and acknowledgements travel as packets of their own. Connecting costs ~10 KB because QUIC always runs TLS 1.3: the certificate travels, and the first packets are padded to 1,200 bytes so a forged source address can't be used to amplify an attack.

The TCP rows have no TLS here, so they flatter TCP: with HTTPS each would add a TLS handshake (a few KB, mostly the certificate), and every record would carry its own tag. The latencies are loopback numbers: they show the cost of each stack's code, not of a network. On a real network the round trip dominates them all.

## What I learned

- **Messages need edges.** TCP and QUIC streams are bytes with no boundaries: two writes can arrive as one read, or one as two. WebSocket frames carry a length, SSE ends an event with a blank line, gRPC puts a 5-byte prefix on each message, and on a raw WebTransport stream you add your own ([`frames.ts`](../../labs/l5-transports/src/frames.ts): 4 bytes of length). Both the SSE parser and the framer are property-tested by cutting their input at random points.
- **"Sent" isn't "arrived".** The first version of the ordering test had Alice and Bob post one after the other from separate connections, and it failed on the streaming transports. `send` resolving means the post was handed to a socket, or only queued on a stream; two connections race, and the server's order is whatever arrives first. The fix was to make Bob wait until he had seen Alice's posts before answering, which is all any chat can promise. Niro's sync never relies on cross-connection order: Yjs merges in any order.
- **Browsers can't do real gRPC.** gRPC needs HTTP trailers and full control of HTTP/2 streams, which `fetch` doesn't expose; that's why gRPC-Web and Connect exist. Even then, a browser can't hold a request and a response open together on one stream: per [Chrome's docs](https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests?hl=en), a streaming request body is rejected on HTTP/1.x, and "the response never becomes available until the request body has been fully sent". So in a browser, `Talk` isn't possible, and `Watch` + `Send` is the pattern: the HTTP/1.1 rows above.
- **HTTP/1.1 limits a browser to 6 connections per host.** Each open SSE stream holds one, so a seventh tab of the same site stalls. HTTP/2 multiplexes streams on one connection and removes the limit.
- **Head-of-line blocking is TCP's.** On every TCP row, one lost packet holds up everything behind it on that connection, every stream included, until it's resent. QUIC orders bytes per stream, so a loss stalls only its own stream, and WebTransport adds datagrams that are never resent at all. Loopback doesn't lose packets, so this isn't measured here.
- **Node can serve WebTransport, with help.** Node 22, which Niro runs, has no HTTP/3 server; an experimental `node:quic` module is in progress upstream. This lab uses `@fails-components/webtransport`, which wraps Google's QUIC library (quiche) and ships it prebuilt for Linux (glibc), macOS and Windows. It's an optional dependency here: on Alpine (musl) there's no prebuilt binary, the install step fails quietly, and the lab carries on without WebTransport. Browsers accept a self-signed certificate for WebTransport only by its SHA-256 hash, and only if it's ECDSA and valid for at most 14 days.

## What it means for Niro

WebSocket stays. It's the cheapest per message after protobuf-over-HTTP/2, works in every browser and through every proxy, and gives both directions on one connection. Niro's messages are already binary (Yjs updates), so protobuf's advantage over JSON doesn't apply.

The one thing worth revisiting is cursors. They are presence, they change 20 times a second, and an old cursor position is worthless once a newer one exists. Today a lost packet makes the next cursor wait behind it on the WebSocket's TCP connection. On WebTransport they could go as datagrams that are never resent, with document updates on a reliable stream beside them. That needs an HTTP/3 server in production, a UDP port through every proxy, and a WebSocket fallback for networks that block UDP, so it's an idea for after v0.1, not a plan.
