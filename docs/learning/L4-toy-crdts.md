# L4: CRDTs by hand

The code is in [`labs/l4-toy-crdts`](../../labs/l4-toy-crdts): a last-writer-wins map ([`lww-map.ts`](../../labs/l4-toy-crdts/src/lww-map.ts)) and a text type, RGA ([`rga.ts`](../../labs/l4-toy-crdts/src/rga.ts)), both on Lamport clocks ([`clock.ts`](../../labs/l4-toy-crdts/src/clock.ts)). Under 300 lines in all, comments included. Niro uses Yjs for the real thing; this lab is about what Yjs does for us.

## What problem a CRDT solves

L3 built sync around a server that puts every edit in one order. That works, but every edit has to go through the server before anyone else can agree on it. A CRDT (conflict-free replicated data type) drops the need for an agreed order: each replica applies edits whenever they arrive, in whatever order, and replicas that have seen the same edits end up the same. No server decides anything; it only passes edits on and stores them.

That only works if applying edits is:

- **commutative**: A then B ends the same as B then A;
- **idempotent**: applying an edit twice is the same as once, so a resend after a dropped connection is harmless;
- **associative** (for merging whole states): merging a with b, then c, is the same as a with (b merged with c).

Something with those three properties is a *join semilattice*, and "merge" is its join: like `max`, or set union. Most of designing a CRDT is finding a way to phrase the data so that applying an edit is a join.

## Timestamps: Lamport clocks

To say "the last write wins", replicas have to agree which write was last. Wall clocks can't do that: computers' clocks drift, and a phone with its clock five minutes fast wins every conflict for five minutes. The test "loses a later edit to a clock that runs fast" plays this out: b's clock is fast, a renames a title a minute *after* seeing b's edit, and a's rename is lost on both replicas. Both still agree, so the map is still a valid CRDT; it's just wrong about what happened.

A Lamport clock (Leslie Lamport, 1978) is a counter per peer. Each edit gets the next count; on seeing someone else's stamp, a peer moves its counter up to it. So an edit made after seeing another always has a bigger stamp. Two edits made without knowing of each other are *concurrent*: either could win, as long as everyone picks the same one, so ties go to the bigger peer id. The stamp `(counter, peer)` is unique per edit, and every pair has a winner.

Lamport stamps only promise "if A could have known about B, then A > B". They don't say whether two stamps are concurrent (that takes a vector clock, one counter per peer). A last-writer-wins map doesn't need to know.

## The map

Each key keeps the write with the biggest stamp. An incoming write is applied if its stamp beats the stored one, and ignored otherwise. "Keep the biggest" is a join, so order and repeats don't matter.

Two details matter:

- **A delete is a write too**: the value becomes "deleted", with a stamp, and stays as a *tombstone*. If the key were just removed, an older write arriving later would find nothing to lose to, and bring the key back.
- **The state is the ops.** The map is a set of entries, each one the latest write to its key. Sending ops and sending state are the same thing, so catching up after time offline is "send me your entries".

Each Niro shape is close to this already: Yjs keeps one value per field of a `Y.Map`. One difference showed up when we tried it (Yjs 13.6.33): Yjs settles concurrent writes by the bigger *client id*, not the bigger counter, even when the other client had made more edits. An edit made after seeing another still always wins, which is the part users notice.

## Text: why last-writer-wins isn't enough

Text can't be one value: two people typing in the same sticky note would overwrite each other, which is why P4a puts text in `Y.Text`. And positions don't work as names: "insert at 5" means different places on two replicas once either has typed.

RGA (replicated growable array, Roh et al., 2011) names every character by its stamp, which never changes:

- **insert** says "this character, stamped `id`, goes right after the character stamped `after`" (or at the start);
- **delete** says "the character stamped `target` is gone". It stays in the list as a tombstone, because someone may be typing after it right now.

The one rule: a new character goes right after its anchor, but *after any characters already there with a bigger stamp*. Those were typed concurrently with it, or later, after seeing it, and they take the spot nearer the anchor. Why that converges: a character typed after seeing a run has a bigger stamp than the run's start (the Lamport promise), so skipping "everything bigger" skips whole runs at once. Every replica ends up with the same order, whatever order the inserts came in. The test "keeps two words typed at the same spot whole" shows it: "cat" and "dog" typed into "[]" at once come out "[dogcat]" everywhere, not "[dcoagt]".

### Ops that arrive early

An op names characters; it can't be applied before they exist. A network that reorders (and the property tests' network does, on purpose) delivers "delete X" before "insert X". RGA holds such an op back and applies it once what it names turns up. This is *causal delivery*, and it's why `Y.Doc` keeps a "pending structs" list for updates that arrive with gaps.

### A weakness we could see

Type a word backwards (each letter at the start, before the last) while someone else does the same, and RGA shuffles the two words: "abc" and "xyz" become "xaybzc". Each letter's anchor is "the start", so all six are siblings, ordered by stamp alone. The test "interleaves words typed backwards" pins this down.

Yjs (its algorithm is YATA) stores what each character was typed *before* as well as after. We ran the same two cases through Yjs 13.6.33: words stay whole whichever way they're typed ("abcxyz"). That's what the extra field buys. Interleaving has a whole paper to itself: Weidner, Gentle and Kleppmann, "The Art of the Fugue" (2023), on which text CRDTs can and can't interleave.

## How it's tested

Example tests can't cover "any order, any duplicates". So [`net.ts`](../../labs/l4-toy-crdts/src/net.ts) has a deliberately unkind network: every op goes to every peer, and fast-check decides when each one arrives, in what order, and whether it arrives twice. A run is a random list of steps (a peer edits, or an op reaches a peer), then everything left is delivered. Properties checked over hundreds of random runs:

- **convergence**: all replicas end with the same map, and the same text;
- **the merge is a semilattice**: commutative, associative, idempotent, on random states from one history (two different writes can't share a stamp, so the generator mustn't invent that either; our first generator did, and the property failed);
- **RGA is a string when alone**: with one peer, RGA edits match plain string slicing exactly.

Each was checked against a deliberately broken version: drop the "skip bigger stamps" rule, skip smaller ones instead, apply duplicates twice, forget to move the clock forward, drop early deletes, forget tombstones, or break ties by nothing. Every one fails at least one test.

## What it costs

- **Tombstones.** Every character ever typed stays, deleted or not: 100 characters typed and deleted leave 100 nodes ("keeps every deleted character"). That's the cost L6 measured in Yjs, which merges runs of tombstones to keep it down.
- **Metadata per character.** Each character carries a stamp and an anchor. Yjs stores runs typed together as one item, so the cost is per run rather than per character.
- **Speed.** This RGA finds characters by walking a list: fine for a lab, quadratic for a long document. Real implementations use trees or skip lists, and Yjs caches the last positions looked up.

## What surprised me

- Convergence and correctness are different things. The wall-clock map converges perfectly, on the wrong value.
- A bad test generator can break a CRDT property all by itself: a random "history" that gives two different writes the same stamp isn't a history any real peer could make.
- One extra field (the right origin) is the difference between RGA shuffling words and Yjs keeping them whole.
