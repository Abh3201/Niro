/**
 * Wire protocol for the L3 sync. JSON text frames, so you can read them in
 * the browser's network panel.
 *
 * client -> server
 *   hello  { clientId, lastSeq }        after every (re)connect
 *   op     { op }                       one local edit
 *
 * server -> client
 *   welcome { acked, ops | snapshot }   reply to hello: what the client missed
 *   op      { op }                      every edit, from everyone, in server order
 */

/** A value in the shared map. `null` deletes the key. */
export type Value = string | number | boolean | null;

/** One edit, as the client made it. `(clientId, clientSeq)` identifies it forever. */
export interface Op {
  readonly clientId: string;
  /** 1, 2, 3... per client: an idempotency key the server uses to drop retries. */
  readonly clientSeq: number;
  readonly key: string;
  readonly value: Value;
}

/** An edit after the server ordered it. `seq` is its position in the one true history. */
export interface SequencedOp extends Op {
  readonly seq: number;
}

export type ClientMessage =
  | { readonly t: "hello"; readonly clientId: string; readonly lastSeq: number }
  | { readonly t: "op"; readonly op: Op };

export type ServerMessage =
  | {
      readonly t: "welcome";
      /** Highest clientSeq of this client the server has applied. */
      readonly acked: number;
      /** Ops after the client's lastSeq, when the server still has them... */
      readonly ops?: readonly SequencedOp[];
      /** ...or the whole state, when it has trimmed them from its log. */
      readonly snapshot?: {
        readonly seq: number;
        readonly entries: ReadonlyArray<[string, Value]>;
      };
    }
  | { readonly t: "op"; readonly op: SequencedOp };

export const encode = (message: ClientMessage | ServerMessage): string => JSON.stringify(message);

export function decode<T extends ClientMessage | ServerMessage>(data: string | Uint8Array): T {
  return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as T;
}
