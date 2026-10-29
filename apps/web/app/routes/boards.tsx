import { BOARD_ID } from "@niro/sync";
import { issueEraseToken, roleOfKey, shareKey } from "@niro/sync/auth";
import { useEffect, useMemo, useRef, useState } from "react";
import { data, Form, redirect, useFetcher, useNavigation } from "react-router";
import { AccountMenu } from "~/accounts/AccountMenu";
import { getUser } from "~/accounts/auth.server";
import {
  type BoardSummary,
  claimBoard,
  cleanTitle,
  createBoard,
  deleteBoard,
  listBoards,
  markErased,
  recordVisit,
  removeFromList,
  renameBoard,
  unerasedBoards,
} from "~/accounts/boards.server";
import { accountsEnabled } from "~/accounts/db.server";
import { MAX_TITLE } from "~/accounts/limits";
import { readKeys } from "~/board/access";
import { getSecret, realtimeUrl } from "~/sharing.server";
import type { Route } from "./+types/boards";

/** Boards from this browser added in one go, at most. */
const MAX_IMPORT = 200;
/** Remembers "Not now" on the offer to add this browser's boards. */
const IMPORT_DISMISSED = "niro:import-dismissed";

async function requireUser(request: Request) {
  if (!accountsEnabled()) throw redirect("/");
  const user = await getUser(request);
  if (!user) throw redirect(`/signin?next=${encodeURIComponent("/boards")}`);
  return user;
}

/** An erase token for each board, for the browser to hand the realtime server. */
const eraseGrants = (boardIds: string[]) =>
  boardIds.map((boardId) => ({ boardId, token: issueEraseToken(getSecret(), boardId) }));

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const [boards, unerased] = await Promise.all([listBoards(user.id), unerasedBoards(user.id)]);
  return {
    viewer: { name: user.name, email: user.email, image: user.image },
    boards,
    // The realtime server's HTTP address, where deleted boards are erased.
    realtimeHttp: realtimeUrl(request).replace(/^ws/, "http"),
    // Deleted before, but not erased yet (the realtime server was asleep, say): try again.
    erase: eraseGrants(unerased),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const boardId = String(form.get("boardId") ?? "");
  const validId = BOARD_ID.test(boardId);

  switch (intent) {
    case "create": {
      const id = await createBoard(user.id, cleanTitle(form.get("title")) ?? undefined);
      return redirect(`/b/${id}#k=${shareKey(getSecret(), id, "edit")}`);
    }
    case "rename": {
      const title = cleanTitle(form.get("title"));
      if (!validId || !title) return data({ error: "Give the board a name." }, 400);
      if (!(await renameBoard(user.id, boardId, title))) {
        return data({ error: "Only the board's owner can rename it." }, 403);
      }
      return { ok: true };
    }
    case "delete": {
      if (!validId || !(await deleteBoard(user.id, boardId))) {
        return data({ error: "Only the board's owner can delete it." }, 403);
      }
      // The list reloads with it under `erase`, and the page erases it.
      return { ok: true };
    }
    case "erased": {
      if (validId) await markErased(user.id, boardId);
      return { ok: true };
    }
    case "remove": {
      if (validId) await removeFromList(user.id, boardId);
      return { ok: true };
    }
    case "claim": {
      if (!validId || !(await claimBoard(user.id, boardId))) {
        return data({ error: "Someone owns this board already." }, 409);
      }
      return { ok: true };
    }
    case "import": {
      let given: unknown;
      try {
        given = JSON.parse(String(form.get("keys") ?? "[]"));
      } catch {
        return data({ error: "Bad list." }, 400);
      }
      if (!Array.isArray(given)) return data({ error: "Bad list." }, 400);
      let added = 0;
      for (const item of given.slice(0, MAX_IMPORT)) {
        const { boardId: id, key } = (item ?? {}) as Record<string, unknown>;
        if (typeof id !== "string" || !BOARD_ID.test(id) || typeof key !== "string") continue;
        // Only a genuine key adds a board: the list grants nothing a link didn't.
        const role = roleOfKey(getSecret(), id, key);
        if (!role) continue;
        await recordVisit(user.id, id, role);
        added++;
      }
      return { added };
    }
    default:
      return data({ error: "Unknown intent." }, 400);
  }
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "My boards · Niro" }];
}

export default function Boards({ loaderData }: Route.ComponentProps) {
  const { viewer, boards, realtimeHttp, erase } = loaderData;
  const navigation = useNavigation();
  const creating = navigation.formData?.get("intent") === "create";
  const owned = boards.filter((board) => board.owned);
  const shared = boards.filter((board) => !board.owned);

  // Finish erasing boards deleted earlier whose content is still on the realtime server.
  useEraser(realtimeHttp, erase);

  return (
    <main className="page boards-page">
      <header className="boards-header">
        <a href="/boards" className="brand">
          Niro
        </a>
        <div className="boards-actions">
          <Form method="post">
            <button
              type="submit"
              name="intent"
              value="create"
              className="primary-button"
              disabled={creating}
              data-testid="new-board"
            >
              {creating ? "Creating…" : "New board"}
            </button>
          </Form>
          <AccountMenu viewer={viewer} />
        </div>
      </header>
      <ImportOffer known={boards} />
      <section aria-labelledby="mine">
        <h2 id="mine">My boards</h2>
        {owned.length === 0 ? (
          <p className="hint" data-testid="no-boards">
            No boards yet. Make one with New board.
          </p>
        ) : (
          <BoardGrid boards={owned} testId="my-boards-list" />
        )}
      </section>
      {shared.length > 0 && (
        <section aria-labelledby="shared">
          <h2 id="shared">Shared with me</h2>
          <BoardGrid boards={shared} testId="shared-boards-list" />
        </section>
      )}
    </main>
  );
}

function BoardGrid({ boards, testId }: { boards: readonly BoardSummary[]; testId: string }) {
  return (
    <ul className="board-grid" data-testid={testId}>
      {boards.map((board) => (
        <BoardCard key={board.id} board={board} />
      ))}
    </ul>
  );
}

const ROLE_LABEL = { edit: "Can edit", view: "Can view" } as const;

function BoardCard({ board }: { board: BoardSummary }) {
  const fetcher = useFetcher<typeof action>();
  const [renaming, setRenaming] = useState(false);
  const pending = fetcher.formData?.get("intent");
  const title =
    pending === "rename" ? String(fetcher.formData?.get("title") ?? board.title) : board.title;
  const answer = fetcher.data;
  // Hidden as soon as it's asked for; the list reloads without it.
  if (pending === "delete" || pending === "remove") return null;

  return (
    <li className="board-card" data-testid="board-card" data-board-id={board.id}>
      <a
        href={`/b/${board.id}`}
        className="board-card-open"
        // The title below is the same link, for the keyboard.
        tabIndex={-1}
        data-testid="board-card-open"
      >
        <span className="board-card-thumb" aria-hidden="true">
          {[...title][0]?.toUpperCase() ?? "?"}
        </span>
        <span className="visually-hidden">Open {title}</span>
      </a>
      <div className="board-card-body">
        {renaming ? (
          <fetcher.Form
            method="post"
            onSubmit={() => setRenaming(false)}
            className="board-card-rename"
          >
            <input type="hidden" name="intent" value="rename" />
            <input type="hidden" name="boardId" value={board.id} />
            <input
              className="text-field"
              name="title"
              aria-label="Board name"
              defaultValue={title}
              maxLength={MAX_TITLE}
              required
              // biome-ignore lint/a11y/noAutofocus: opened by Rename, to type the new name.
              autoFocus
              data-testid="rename-input"
              onFocus={(event) => event.target.select()}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenaming(false);
              }}
            />
            <button type="submit" className="card-action">
              Save
            </button>
          </fetcher.Form>
        ) : (
          <a href={`/b/${board.id}`} className="board-card-title" data-testid="board-card-title">
            {title}
          </a>
        )}
        <p className="board-card-meta">
          {board.owned ? "Owner" : ROLE_LABEL[board.role]} · opened{" "}
          <time dateTime={board.openedAt} suppressHydrationWarning>
            {ago(board.openedAt)}
          </time>
        </p>
        {answer && "error" in answer && (
          <p className="form-error" role="alert">
            {answer.error}
          </p>
        )}
        <div className="board-card-actions">
          {board.owned && !renaming && (
            <button
              type="button"
              className="card-action"
              onClick={() => setRenaming(true)}
              data-testid="rename-board"
            >
              Rename
            </button>
          )}
          {board.owned && (
            <button
              type="button"
              className="card-action danger"
              data-testid="delete-board"
              onClick={() => {
                const ok = window.confirm(
                  `Delete "${title}"? Its links stop working for everyone, and it can't be brought back.`,
                );
                if (ok) fetcher.submit({ intent: "delete", boardId: board.id }, { method: "post" });
              }}
            >
              Delete
            </button>
          )}
          {!board.owned && board.ownerless && board.role === "edit" && (
            <button
              type="button"
              className="card-action"
              data-testid="claim-board"
              onClick={() =>
                fetcher.submit({ intent: "claim", boardId: board.id }, { method: "post" })
              }
            >
              Make it mine
            </button>
          )}
          {!board.owned && (
            <button
              type="button"
              className="card-action"
              data-testid="remove-board"
              title="Take it off this list. The board stays; opening its link again brings it back."
              onClick={() =>
                fetcher.submit({ intent: "remove", boardId: board.id }, { method: "post" })
              }
            >
              Remove from list
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Asks the realtime server to erase each of these deleted boards, with the
 * erase tokens the web app gave, then records which ones it did. A board
 * the server couldn't erase now stays listed for the next visit.
 */
function useEraser(
  realtimeHttp: string,
  grants: readonly { boardId: string; token: string }[] | null,
) {
  const fetcher = useFetcher();
  const submit = useRef(fetcher.submit);
  submit.current = fetcher.submit;
  useEffect(() => {
    if (!grants || grants.length === 0) return;
    for (const { boardId, token } of grants) {
      fetch(`${realtimeHttp}/erase/${encodeURIComponent(boardId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      })
        .then((response) => {
          if (response.ok) submit.current({ intent: "erased", boardId }, { method: "post" });
        })
        .catch(() => {
          // Asleep or offline: the next visit to this page tries again.
        });
    }
  }, [realtimeHttp, grants]);
}

/**
 * Offers to add the boards this browser has keys for (from before signing
 * in, or from before accounts existed) to the list.
 */
function ImportOffer({ known }: { known: readonly BoardSummary[] }) {
  const fetcher = useFetcher<typeof action>();
  const [found, setFound] = useState<{ boardId: string; key: string }[]>([]);
  const [dismissed, setDismissed] = useState(true);
  const knownIds = useMemo(() => new Set(known.map((board) => board.id)), [known]);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(IMPORT_DISMISSED) === "1");
      const keys: { boardId: string; key: string }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        const boardId = name?.startsWith("niro:keys:") ? name.slice("niro:keys:".length) : null;
        if (!boardId || !BOARD_ID.test(boardId) || knownIds.has(boardId)) continue;
        const { edit, view } = readKeys(boardId);
        const key = edit ?? view;
        if (key) keys.push({ boardId, key });
      }
      setFound(keys.slice(0, MAX_IMPORT));
    } catch {
      // No storage: nothing to offer.
    }
  }, [knownIds]);

  const answer = fetcher.data;
  if (answer && "added" in answer) {
    return (
      <p className="import-offer" role="status" data-testid="import-done">
        Added {answer.added} {answer.added === 1 ? "board" : "boards"} from this browser.
      </p>
    );
  }
  if (dismissed || found.length === 0) return null;
  const count = found.length;
  return (
    <div className="import-offer" data-testid="import-offer">
      <span>
        This browser has opened {count} {count === 1 ? "board" : "boards"} that{" "}
        {count === 1 ? "isn't" : "aren't"} on your list.
      </span>
      <button
        type="button"
        className="primary-button"
        data-testid="import-boards"
        disabled={fetcher.state !== "idle"}
        onClick={() =>
          fetcher.submit({ intent: "import", keys: JSON.stringify(found) }, { method: "post" })
        }
      >
        Add {count === 1 ? "it" : "them"}
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(IMPORT_DISMISSED, "1");
          } catch {
            // Offered again next time.
          }
        }}
      >
        Not now
      </button>
    </div>
  );
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or a date. */
function ago(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) {
    const days = Math.floor(seconds / 86_400);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  return new Date(iso).toLocaleDateString();
}
