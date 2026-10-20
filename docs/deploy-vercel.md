# Deploying Niro's web app on Vercel

Vercel can serve Niro's **web app** (the pages and the `/api/token` endpoint) on your own domain, with HTTPS, on its free Hobby plan. It can't run the **realtime server**: that needs long-lived WebSockets and a single process that holds open boards in memory, and Vercel Functions are short-lived and spread over many instances. So the realtime server stays where it is, for example on Azure as in [deploy-azure.md](deploy-azure.md), and the web app on Vercel points browsers at it.

| Piece | Where | Address |
|---|---|---|
| Web app | Vercel, React Router preset | `https://board.example.com` (your domain) |
| Realtime server | Azure App Service (or any server) | `wss://<realtime-name>.azurewebsites.net` |
| Postgres | Neon | used only by the realtime server |

The web app only needs two settings: `NIRO_SECRET`, the same one the realtime server has, and `PUBLIC_REALTIME_URL`. It never talks to Postgres or to the realtime server itself; browsers do.

## What to know first

- **Share links keep working.** A link's key is signed over the board id with `NIRO_SECRET`, not over the domain, so `https://<web-name>.azurewebsites.net/b/<id>#k=...` works on your domain once you swap the part before `/b/`.
- **Each domain is a separate browser storage.** The copy of a board a browser keeps for offline use, and its light or dark choice, belong to the domain. Boards still load from the realtime server on the new domain; only edits made offline and never synced stay behind on the old one.
- **The realtime server keeps its own limits.** On Azure's free tier that is still 5 board tabs at once and 60 CPU minutes a day; see [what the free tier allows](deploy-azure.md#what-the-free-tier-allows). Moving the web app off Azure does free the web app's share of those minutes and memory.
- **Hobby is for non-commercial use**, per [Vercel's fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines).
- **Vercel's React Router preset (`@vercel/react-router`) is not used.** Its current release (1.3.7) supports React Router 7 only ([vercel/vercel#16730](https://github.com/vercel/vercel/issues/16730)). Vercel builds Niro without it and prints `The vercelPreset() Preset was not detected`; that warning is expected. The preset only adds per-route function settings and bundle splitting, which Niro doesn't need.

## 1. Create the Vercel project

1. On [vercel.com](https://vercel.com), **Add New**, **Project**, and import your Niro repository from GitHub.
2. **Root Directory**: `apps/web`. Vercel then picks **React Router** as the framework (also set in [`apps/web/vercel.json`](../apps/web/vercel.json)). Leave the build and install commands as they are; Vercel installs the whole pnpm workspace.
3. **Environment Variables**, for Production:

   | Name | Value |
   |---|---|
   | `NIRO_SECRET` | the same value the realtime server has (see [Keep NIRO_SECRET](deploy-azure.md#keep-niro_secret)) |
   | `PUBLIC_REALTIME_URL` | `wss://<realtime-name>.azurewebsites.net` (no `/ws`, no trailing `/`) |

4. **Deploy**. Because `apps/web/vercel.json` turns off Vercel's own Git deploys (step 3 explains why), Vercel may create the project without deploying it. That's fine; step 3 deploys it.

Optional: **Settings**, **Functions**, **Function Region**, and pick the one closest to your realtime server and users (for example Mumbai, `bom1`, for Azure's Central India). Only `/api/token` and the first page load run there.

## 2. Add your domain

**Settings**, **Domains**, **Add**, and type your domain (a subdomain such as `board.example.com` is simplest). Vercel shows the DNS record to create at your domain's registrar: a `CNAME` for a subdomain, an `A` record for the bare domain. Use the values that page shows. Vercel issues the HTTPS certificate once DNS resolves.

Nothing changes on the realtime server: it accepts WebSockets and image requests from any page that has a valid board token.

## 3. Deploy from GitHub after CI

The same workflow that deploys the realtime server, [`.github/workflows/deploy-azure.yml`](../.github/workflows/deploy-azure.yml) (**Deploy** in the **Actions** tab), deploys the web app to Vercel each time CI passes on `main`, after the realtime server. That's why Vercel's Git deploys are off: they would ship the web app on every push, before CI passed and before the realtime server it talks to.

1. Make a token: Vercel **Account Settings**, **Tokens**, **Create**, scoped to the team or account that owns the project.
2. Find the ids: in the project, **Settings**, **General**, copy **Project ID**; in the team or account **Settings**, copy its **ID** (`team_...`).
3. In the repository on GitHub, **Settings**, **Secrets and variables**, **Actions**, add:

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `VERCEL_TOKEN` | the token |
   | Variable | `VERCEL_ORG_ID` | the team or account id |
   | Variable | `VERCEL_PROJECT_ID` | the project id |

4. **Actions**, **Deploy**, **Run workflow** for the first deploy.

To stop deploying the web app to Azure, delete the `AZURE_WEBAPP_WEB` variable; the realtime server keeps deploying. You can then stop or delete the Azure web app.

## Troubleshooting

| You see | Likely cause |
|---|---|
| The board says it's offline | `PUBLIC_REALTIME_URL` is wrong or the realtime server is asleep or at a limit. See [deploy-azure.md's troubleshooting](deploy-azure.md#troubleshooting). |
| "This link doesn't give access to the board" | `NIRO_SECRET` on Vercel differs from the realtime server's. |
| The page shows an error and the function logs say `NIRO_SECRET` | The variable isn't set for Production, or was added after the last deploy. Run the workflow again. |
| The workflow's Vercel step says the project isn't found | `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` don't match the token's scope. |
