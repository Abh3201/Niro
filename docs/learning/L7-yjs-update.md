# L7: Decoding a Yjs update by hand

Every edit on a Niro board leaves the browser as a Yjs update: a few dozen bytes for a keystroke, a few hundred for a new sticky note. Boards are stored as these updates too. This lab reads one byte by byte, with no help from Yjs, to see what a CRDT actually sends.

Code: [`labs/l7-yjs-update`](../../labs/l7-yjs-update). `decodeUpdate` reads an update into plain objects; `explain` prints every value next to the bytes it came from. The tests check the decoder against Yjs's own `Y.decodeUpdate` on hand-picked documents (every content type, nested types, XML, subdocuments, deletes, gaps) and on 200 random runs of three people editing and syncing in random order. Breaking any one rule of the format (string lengths in bytes rather than UTF-16 units, losing the sign of an integer, dropping a byte-order mark, ignoring the map-key flag) makes them fail.

## Two lists

An update (format v1, what `Y.encodeStateAsUpdate` returns and what Niro sends and stores) is:

1. **Structs, grouped by client.** Every client (each open copy of a document) numbers what it inserts with a counter, its clock. Inserting "hi" makes one struct with id (client, 5) covering clocks 5 and 6. A client's structs are consecutive, so a group writes the client and the first clock once, and every struct after that knows its own id by adding up lengths.
2. **A delete set.** Ranges of ids that are deleted: (client, from clock, length). Deleting never edits a struct inside an update; it's said separately, which is what makes deletes cheap to merge.

## Reading the bytes

Here is client 300 typing "hi", setting `m.k = 1`, then deleting the "h", as `explain` prints it:

```
01     clients with structs: 1
03     client group 1 / structs: 3
ac 02  client group 1 / client: 300
00     client group 1 / first clock: 0
01     client group 1 / struct 1 / info: 1
01     client group 1 / struct 1 / parent is a root type (1) or an item (0): 1
01 74  client group 1 / struct 1 / root type name: "t"
01     client group 1 / struct 1 / content / deleted length: 1
84     client group 1 / struct 2 / info: 132
ac 02  client group 1 / struct 2 / origin / client: 300
00     client group 1 / struct 2 / origin / clock: 0
01 69  client group 1 / struct 2 / content / text: "i"
28     client group 1 / struct 3 / info: 40
01     client group 1 / struct 3 / parent is a root type (1) or an item (0): 1
01 6d  client group 1 / struct 3 / root type name: "m"
01 6b  client group 1 / struct 3 / map key: "k"
01     client group 1 / struct 3 / content / values: 1
7d 01  client group 1 / struct 3 / content / value 1: 1
01     clients with deletes: 1
ac 02  delete group 1 / client: 300
01     delete group 1 / ranges: 1
00     delete group 1 / from clock: 0
01     delete group 1 / length: 1
```

Things to notice:

- **Numbers are variable-length.** Seven bits a byte, lowest first, the top bit meaning "more follows". 300 is `ac 02`: 0x2c + 128 × 2. A small clock costs one byte. A real client id is a random 32-bit number, so it costs five, every time it's written.
- **The info byte packs four things.** The low 5 bits say what the item holds (4 text, 8 values, 7 a nested type, 1 deleted...). The top bits say which optional fields follow: 0x80 an origin, 0x40 a right origin, 0x20 a map key. `84` is "text, with an origin"; `28` is "values, with a map key".
- **Origins replace positions.** An item records the items that were on its left and right when it was inserted, not an index, which would shift as others type. That's how Yjs places concurrent inserts the same way everywhere (L4 shows what goes wrong with only a left origin).
- **The parent is written only when there's no origin.** "i" doesn't say it belongs to text `t`: its origin does, so the parent can be found from there. Only the first item in a list, and every map entry (which has no neighbours), names its parent.
- **A deleted item keeps its place but drops its content.** Struct 1 was "h"; now it's "1 deleted", so others can still find "i"'s origin. When a whole nested type is deleted, Yjs goes further and replaces it with a GC struct: just a length.
- **Values are self-describing.** Map values and array elements use lib0's encoding: a tag byte, then the value. `7d 01` is "integer, 1"; `77` starts a string, `7e` is null.

[`decode.test.ts`](../../labs/l7-yjs-update/src/decode.test.ts) also writes an update by hand, 12 bytes, and applies it to a Yjs document: it reads "hi". Yjs writes the exact same 12 bytes for the same edit.

## Where a sticky note's bytes go

[`bytes.test.ts`](../../labs/l7-yjs-update/src/bytes.test.ts) adds one sticky note through Niro's own `DocStore`, types into it and moves it, and sorts every byte by what it's for:

| Update | Bytes | Values | Keys | Ids | Info, counts, flags, root names |
|---|---|---|---|---|---|
| Add a sticky note | 237 | 48 | 84 | 66 | 39 |
| Type "Ship v0.1" | 27 | 10 | | 12 | 5 |
| Move it | 28 | 4 | | 17 | 7 |

- **Keys are the biggest part of a new shape.** Each field is its own map entry, so the field names (`type`, `rotation`, `parentId`...) and the 21-character shape id travel as text. Short field names would save bytes on every shape, but they'd make the stored document harder to read and need a schema change; not worth it at this size.
- **Ids are the next biggest.** Each of the note's ten fields names its parent, the note's map, as (client, clock): 6 bytes, ten times over.
- **A move is 4 bytes of news in a 28-byte update.** The rest says where the new value goes and that the old one is deleted, naming the five-byte client again in the delete set.

Yjs has a second format, v2, that stores each column (all the clients, all the clocks, all the keys) together and run-length encodes it. Measured here:

| | v1 | v2 |
|---|---|---|
| Add a sticky note | 237 | 168 |
| Type "Ship v0.1" | 27 | 34 |
| Move it | 28 | 35 |
| Whole 10,000-shape benchmark board | 3.14 MB (0.91 MB gzipped) | 2.08 MB (0.56 MB gzipped) |

v2 loses on the small updates that make up almost all live traffic, and wins by a third on a whole board. So Niro keeps v1 on the wire. Storing snapshots as v2 would shrink the database and the first load of a big board; that's a possible change to storage (decision 0003), not made here.

## What surprised me

- How little of an update is the content. Moving a shape is 4 bytes of news and 24 of bookkeeping. CRDTs buy merge-anywhere by naming everything by id, and the ids are the cost.
- Random 32-bit client ids are why. A client id of 1 would save four bytes everywhere it appears. Yjs picks random ones because two clients that picked the same id would corrupt the document, and there's no server to hand them out.
- Deleted text stays as a placeholder forever (L6 measured the tombstones). Its content goes, so a deleted secret isn't in the next full update; but the update that typed it is still in Postgres until the board is compacted, and in each browser's copy. Deleting isn't erasing.
- The format is simple enough to read in an afternoon. About 450 lines, comments included, decode everything Yjs 13 writes in v1, and the tests show they agree with Yjs on every update tried.
