/**
 * Who has which boards. A board's content lives on the realtime server;
 * here are only its title, its owner, and the people who opened it while
 * signed in ("members"), with the access their link gave them.
 *
 * Links stay the way in: becoming a member needs a link (or ownership), and
 * then the board opens for you without one, on any device.
 */
import type { Role } from "@niro/sync";
import { nanoid } from "nanoid";
import type pg from "pg";
import { getAuth } from "./auth.server";
import { getPool } from "./db.server";

import { DEFAULT_TITLE, MAX_TITLE } from "./limits";

export { DEFAULT_TITLE };

export interface BoardSummary {
  readonly id: string;
  readonly title: string;
  readonly role: Role;
  /** True when the signed-in person owns it: they can rename and delete it. */
  readonly owned: boolean;
  /** True when nobody owns it (made before accounts, or signed out): an editor can take it. */
  readonly ownerless: boolean;
  /** When this person last opened it, ISO 8601. */
  readonly openedAt: string;
}

export interface BoardInfo {
  readonly ownerId: string | null;
  readonly title: string;
  readonly deleted: boolean;
}

/** The database, once its tables are set up (the first request does that). */
async function db(): Promise<pg.Pool> {
  await getAuth();
  const pool = getPool();
  if (!pool) throw new Error("Accounts need DATABASE_URL.");
  return pool;
}

/** A title as typed, tidied: control characters out, spaces trimmed, at most 80 characters. Null if empty. */
export function cleanTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const clean = [...title]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .replace(/\s+/g, " ");
  return clean === "" ? null : [...clean].slice(0, MAX_TITLE).join("");
}

/** Makes a board owned by `userId`, and returns its id. */
export async function createBoard(userId: string, title = DEFAULT_TITLE): Promise<string> {
  const boardId = nanoid();
  await (await db()).query(
    `WITH info AS (
       INSERT INTO board_info (board_id, owner_id, title) VALUES ($1, $2, $3)
     )
     INSERT INTO board_members (user_id, board_id, role) VALUES ($2, $1, 'edit')`,
    [boardId, userId, title],
  );
  return boardId;
}

export async function getBoardInfo(boardId: string): Promise<BoardInfo | null> {
  const { rows } = await (await db()).query<{
    owner_id: string | null;
    title: string;
    deleted: boolean;
  }>(
    "SELECT owner_id, title, deleted_at IS NOT NULL AS deleted FROM board_info WHERE board_id = $1",
    [boardId],
  );
  const row = rows[0];
  return row ? { ownerId: row.owner_id, title: row.title, deleted: row.deleted } : null;
}

/** The access `userId` has to the board through their account, or null. */
export async function memberRole(userId: string, boardId: string): Promise<Role | null> {
  const { rows } = await (await db()).query<{ role: Role }>(
    `SELECT CASE WHEN i.owner_id = $1 THEN 'edit' ELSE m.role END AS role
     FROM board_info i LEFT JOIN board_members m ON m.board_id = i.board_id AND m.user_id = $1
     WHERE i.board_id = $2 AND i.deleted_at IS NULL AND (i.owner_id = $1 OR m.user_id IS NOT NULL)`,
    [userId, boardId],
  );
  return rows[0]?.role ?? null;
}

/**
 * Records that `userId` opened the board with `role`: it joins their list,
 * keeping the best access they've had. Boards made before accounts get
 * their row here, with nobody as owner. Does nothing for a deleted board.
 */
export async function recordVisit(userId: string, boardId: string, role: Role): Promise<void> {
  await (await db()).query(
    `WITH info AS (
       INSERT INTO board_info (board_id, title) VALUES ($2, $4)
       ON CONFLICT (board_id) DO NOTHING
     )
     INSERT INTO board_members (user_id, board_id, role)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (SELECT 1 FROM board_info WHERE board_id = $2 AND deleted_at IS NOT NULL)
     ON CONFLICT (user_id, board_id) DO UPDATE SET
       opened_at = now(),
       role = CASE WHEN board_members.role = 'edit' THEN 'edit' ELSE EXCLUDED.role END`,
    [userId, boardId, role, DEFAULT_TITLE],
  );
}

/** The boards on `userId`'s list, most recently opened first. */
export async function listBoards(userId: string): Promise<BoardSummary[]> {
  const { rows } = await (await db()).query<{
    id: string;
    title: string;
    role: Role;
    owner_id: string | null;
    opened_at: Date;
  }>(
    `SELECT i.board_id AS id, i.title, m.role, i.owner_id, m.opened_at
     FROM board_members m JOIN board_info i ON i.board_id = m.board_id
     WHERE m.user_id = $1 AND i.deleted_at IS NULL
     ORDER BY m.opened_at DESC
     LIMIT 500`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    role: row.owner_id === userId ? "edit" : row.role,
    owned: row.owner_id === userId,
    ownerless: row.owner_id === null,
    openedAt: row.opened_at.toISOString(),
  }));
}

/** Renames a board its owner owns. False if it isn't theirs. */
export async function renameBoard(userId: string, boardId: string, title: string) {
  const { rowCount } = await (await db()).query(
    `UPDATE board_info SET title = $3
     WHERE board_id = $2 AND owner_id = $1 AND deleted_at IS NULL`,
    [userId, boardId, title],
  );
  return rowCount === 1;
}

/**
 * Makes `userId` the owner of a board nobody owns, if they can edit it.
 * False otherwise.
 */
export async function claimBoard(userId: string, boardId: string): Promise<boolean> {
  const { rowCount } = await (await db()).query(
    `UPDATE board_info SET owner_id = $1
     WHERE board_id = $2 AND owner_id IS NULL AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM board_members
                   WHERE board_id = $2 AND user_id = $1 AND role = 'edit')`,
    [userId, boardId],
  );
  return rowCount === 1;
}

/**
 * Marks a board its owner owns as deleted: from now on no link opens it.
 * Its content stays on the realtime server until `markErased`. False if
 * it isn't theirs.
 */
export async function deleteBoard(userId: string, boardId: string): Promise<boolean> {
  const { rowCount } = await (await db()).query(
    `UPDATE board_info SET deleted_at = now()
     WHERE board_id = $2 AND owner_id = $1 AND deleted_at IS NULL`,
    [userId, boardId],
  );
  return rowCount === 1;
}

/** Records that the realtime server erased a deleted board's content. */
export async function markErased(userId: string, boardId: string): Promise<void> {
  await (await db()).query(
    `UPDATE board_info SET erased_at = now()
     WHERE board_id = $2 AND owner_id = $1 AND deleted_at IS NOT NULL`,
    [userId, boardId],
  );
}

/** Boards `userId` deleted whose content the realtime server hasn't erased yet. */
export async function unerasedBoards(userId: string): Promise<string[]> {
  const { rows } = await (await db()).query<{ board_id: string }>(
    `SELECT board_id FROM board_info
     WHERE owner_id = $1 AND deleted_at IS NOT NULL AND erased_at IS NULL
     LIMIT 20`,
    [userId],
  );
  return rows.map((row) => row.board_id);
}

/** Takes a board someone else owns off `userId`'s list (until they open it again). */
export async function removeFromList(userId: string, boardId: string): Promise<void> {
  await (await db()).query(
    `DELETE FROM board_members m USING board_info i
     WHERE m.user_id = $1 AND m.board_id = $2 AND i.board_id = m.board_id
       AND i.owner_id IS DISTINCT FROM $1`,
    [userId, boardId],
  );
}
