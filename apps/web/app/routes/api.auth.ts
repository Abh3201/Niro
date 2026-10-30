import { getAuth } from "~/accounts/auth.server";
import { accountsEnabled } from "~/accounts/db.server";
import type { Route } from "./+types/api.auth";

/** Better Auth's endpoints (`/api/auth/*`): sign-in, the Google callback, sign-out, the session. */
async function handle(request: Request): Promise<Response> {
  if (!accountsEnabled())
    return new Response("Accounts aren't set up on this server.", { status: 404 });
  return (await getAuth()).handler(request);
}

export const loader = ({ request }: Route.LoaderArgs) => handle(request);
export const action = ({ request }: Route.ActionArgs) => handle(request);
