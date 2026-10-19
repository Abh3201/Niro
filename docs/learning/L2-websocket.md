# L2: A WebSocket server from scratch

The code is in [`labs/l2-websocket`](../../labs/l2-websocket): under 600 lines on `node:net`, with no WebSocket library. The tests drive it with the `ws` client, and it was also checked by hand against Chromium's own WebSocket.

## It starts as HTTP

A WebSocket is an HTTP/1.1 request that turns into something else. The browser sends a normal `GET` with a few extra headers:

```
GET /chat HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

The server answers `101 Switching Protocols` with `Sec-WebSocket-Accept: base64(sha1(key + GUID))`, where the GUID is a fixed string from the RFC. From the next byte on, both sides speak frames over the same TCP connection.

The accept hash is not security. It proves the server understood that this is a WebSocket request, so a plain HTTP server or a cache can't accidentally "accept" one. See `handshake.ts`, and the test that checks the RFC's own example key.

## Frames

Every message travels in frames. A frame header is 2 to 14 bytes:

- **FIN**: this is the last frame of the message.
- **Opcode**: text, binary, continuation, close, ping or pong.
- **MASK** and a 4-byte key.
- **Length**, in one of three sizes. 0 to 125 fits in the first 7 bits. 126 means "the next 2 bytes hold the length". 127 means "the next 8 bytes hold it".

A large message can be split into a text frame plus continuation frames, and control frames (ping, pong, close) may be sent between them. Control frames themselves are at most 125 bytes and never split, so a ping can always get through in the middle of a 50 MB upload.

### Why clients mask

Every frame from a browser is XORed with a fresh random key. The point isn't secrecy, since the key is sent right next to the data. The point is that a script on a malicious page can't choose the exact bytes that go on the wire. Without masking, a script could write bytes that look like an HTTP request to a confused transparent proxy, and poison its cache (RFC 6455, section 10.3). So the server must reject unmasked client frames, and servers never mask their own.

## TCP delivers bytes, not messages

One `data` event can hold half a header, or three frames and the start of a fourth. The parser in `frame.ts` keeps the bytes it can't use yet in a queue and returns frames as they complete. The property test encodes random frames at every length boundary (125/126, 65535/65536), cuts the stream at random points, and checks that the same frames come out.

## Closing

Either side sends a close frame with a code; the other side answers with its own close frame; then the **server** closes the TCP connection. Closing first leaves the TIME_WAIT state on whoever closes, and it's better on the server than on a client that wants to reconnect.

| Code | Meaning |
|---|---|
| 1000 | Normal |
| 1001 | Going away (server shutting down, tab closed) |
| 1002 | Protocol error: unmasked frame, bad opcode, split control frame |
| 1006 | Never sent. Reported locally when the connection died without a close frame |
| 1007 | A text message wasn't valid UTF-8 |
| 1009 | Message too big |
| 4000–4999 | Yours to define |

## Noticing a dead peer

If someone's laptop lid closes, no FIN or RST arrives. TCP can sit there for hours: keepalive is off by default, and when it's on, Linux waits two hours before the first probe. So the server pings on a timer, and drops a peer that hasn't answered the previous ping (`heartbeatMs`). The simulated network in L3 models this as a random "dead peer timeout" of 0.2 to 2 seconds.

## Defending the server

- **Origin.** Browsers don't apply CORS to WebSockets. Any site can open a socket to your server, and the browser attaches the user's cookies. The server must check `Origin` itself (`allowOrigin`). Skipping this check is called cross-site WebSocket hijacking.
- **Size limits from the header.** A frame header can claim 2^63 bytes for the price of 14. The parser refuses an oversized frame as soon as it reads the length, before buffering anything. The server also caps the total size of a fragmented message.
- **Slow handshakes.** A client that sends one header byte per minute would hold a socket forever. So the handshake has a 10-second timeout and an 8 KB size cap.
- **Backpressure.** `bufferedAmount` is the number of bytes queued but not yet sent. If a client reads slower than you write, it grows without bound. A real server stops sending, or drops the client, past some limit.

## Skipped on purpose

- Compression (`permessage-deflate`). The `ws` client offers it; this server simply doesn't accept, which the protocol allows.
- Subprotocols, and TLS (`wss://`). In production, TLS usually ends at a proxy anyway.
- WebSockets over HTTP/2 (RFC 8441) and HTTP/3 (RFC 9220).
- Rejecting lengths that weren't encoded in the shortest form.
- Failing fast on bad UTF-8 in the middle of a fragmented message. This server checks once the message is complete.

## Try it yourself

1. Run `pnpm --filter @niro/lab-l2-websocket start`. Then follow the comment at the top of `src/echo.ts` to connect from a browser console, and watch the frames in the Network panel (filter by WS, then open Messages).
2. Capture the traffic with `tcpdump -i lo -X port 8080`. Find the `0x81` byte that starts a text frame, then the mask key, then the masked bytes.
3. Add subprotocol negotiation: read `Sec-WebSocket-Protocol`, pick one, and echo it in the 101 response.
4. Write a client that reads one message a second while the server sends 100 a second. Log `bufferedAmount` and watch it climb.
