# Deploying Niro on Azure App Service (free tier)

This guide runs Niro on Azure App Service's **Free (F1) Linux** plan, the tier that every Azure subscription can use, including **Azure for Students Starter**. Postgres comes from [Neon](https://neon.com)'s free plan, because Azure for Students Starter doesn't include Azure Database for PostgreSQL.

It's good for a demo you open with a few friends. It isn't a real deployment: read [what the free tier allows](#what-the-free-tier-allows) first. For anything more, use the Docker compose setup in [self-hosting.md](self-hosting.md) on a small VM, or a paid App Service plan (B1 or above).

## What you end up with

| Piece | Where | Address |
|---|---|---|
| Web app | App Service, Free Linux plan, built-in Node 24 | `https://<web-name>.azurewebsites.net` |
| Realtime server | Same plan, a second app | `wss://<realtime-name>.azurewebsites.net/ws` |
| Postgres | Neon, free plan | a connection string |

Both apps get HTTPS from `azurewebsites.net` for free. Neither is built on Azure: you build two zip files on your machine and upload them.

## What the free tier allows

From Microsoft's [App Service limits](https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-app-service-limits) and [quotas](https://learn.microsoft.com/azure/app-service/web-sites-monitor):

- **5 WebSockets per instance.** Every browser tab on a board holds one, so at most **5 tabs on boards at once**, across all boards. This is the limit you'll hit first.
- **60 CPU minutes per app per day.** Past that, the app is stopped and answers `403` until midnight UTC. Niro's realtime server is light, so a few people editing for an hour or two should fit; that's an estimate, not a measurement.
- **No Always On.** An app nobody has used for about 20 minutes is unloaded, and the next visit waits for it to start (tens of seconds). The realtime server writes every open board when it's stopped, so nothing is lost; browsers reconnect by themselves.
- **1 GB of memory and 1 GB of disk**, shared by the plan. Niro's two apps take about 80 MB of disk. Step 4 caps the realtime server's open boards at about 250 MB of memory (`NIRO_MAX_OPEN_MB=10`).
- **One instance.** That suits Niro, which allows only one realtime server per database anyway.
- **No custom domain with HTTPS.** Use the `azurewebsites.net` addresses.
- **Starter subscriptions are for development and testing**, and Microsoft may remove the apps if the subscription goes unused for 90 days.
- **No custom containers.** Free Linux plans run built-in runtimes only, which is why this guide uses zip packages instead of Niro's Docker images.

Neon's free plan gives 1 GB per project (a board is a few hundred KB to a few MB) and suspends the database after 5 minutes without queries; the first query after that takes a moment to wake it.

## 1. Make a Postgres database on Neon

1. Sign up at [neon.com](https://neon.com) (no card needed) and create a project in the region closest to your Azure region.
2. Copy the connection string from **Connect**. Use the direct one (host without `-pooler`). It looks like `postgresql://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`; keep `sslmode=require`.

The realtime server creates its tables on first start.

## 2. Build the two packages

On your machine, in a clone of Niro, with Node 22.22 or newer, pnpm 10 and `zip`:

```sh
./deploy/azure/package.sh
```

That makes `out/azure/web.zip` and `out/azure/realtime.zip`. On Windows, run it in WSL.

## 3. Create the apps

You need the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), signed in with `az login`. Pick two names that nobody else on Azure has used, since they become `<name>.azurewebsites.net`.

```sh
RG=niro
LOCATION=centralindia            # any region your subscription allows
WEB=niro-web-yourname
RT=niro-rt-yourname
SECRET=$(openssl rand -hex 32)   # keep this; see "Keep NIRO_SECRET" below
DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require'

# New subscriptions have App Service switched off; this turns it on once (a minute or two).
az provider register --namespace Microsoft.Web --wait
az group create --name $RG --location $LOCATION
az appservice plan create --resource-group $RG --name niro-plan --is-linux --sku F1

az webapp create --resource-group $RG --plan niro-plan --name $RT --runtime "NODE:24-lts"
az webapp create --resource-group $RG --plan niro-plan --name $WEB --runtime "NODE:24-lts"
```

If a region is refused, try another: student subscriptions don't always allow every region.

## 4. Configure and deploy the realtime server

```sh
az webapp config set --resource-group $RG --name $RT \
  --web-sockets-enabled true \
  --startup-file "node dist/index.js"
az webapp config appsettings set --resource-group $RG --name $RT --settings \
  NODE_ENV=production NIRO_SECRET=$SECRET DATABASE_URL="$DATABASE_URL" \
  NIRO_MAX_OPEN_MB=10 SCM_DO_BUILD_DURING_DEPLOYMENT=false
az webapp deploy --resource-group $RG --name $RT --src-path out/azure/realtime.zip --type zip
```

`NIRO_MAX_OPEN_MB=10` keeps the realtime server's open boards to about 250 MB of memory, since the plan's 1 GB is shared by both apps (an open board takes about 25 times its stored size; see [self-hosting.md](self-hosting.md#limits-to-know-about)). The default, 40, is about 1 GB on its own.

Check it: `curl https://$RT.azurewebsites.net/healthz` answers `{"status":"ok"}` (the first call can take a while, as the app starts).

## 5. Configure and deploy the web app

```sh
az webapp config set --resource-group $RG --name $WEB \
  --startup-file "node node_modules/@react-router/serve/bin.cjs build/server/index.js"
az webapp config appsettings set --resource-group $RG --name $WEB --settings \
  NODE_ENV=production NIRO_SECRET=$SECRET PUBLIC_REALTIME_URL=wss://$RT.azurewebsites.net \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false
az webapp deploy --resource-group $RG --name $WEB --src-path out/azure/web.zip --type zip
```

Open `https://$WEB.azurewebsites.net`. You get a new board; its address is the edit link.

## Updating

Pull the new version, run `./deploy/azure/package.sh` again, and repeat the two `az webapp deploy` lines, realtime first. Or let GitHub do it: see the next section. Read [CHANGELOG.md](../CHANGELOG.md) first.

## Deploy automatically from GitHub

[`.github/workflows/deploy-azure.yml`](../.github/workflows/deploy-azure.yml) builds both packages and deploys them each time CI passes on `main`, realtime server first. It does nothing until you set it up, and you can also run it by hand from the **Actions** tab (**Deploy to Azure**, **Run workflow**).

It signs in with each app's publish profile, which needs basic authentication turned on for deployments (new apps may have it off). Run this once, with the names from step 3:

```sh
for app in $RT $WEB; do
  az resource update --resource-group $RG --namespace Microsoft.Web \
    --resource-type basicPublishingCredentialsPolicies --parent sites/$app --name scm \
    --set properties.allow=true
done
az webapp deployment list-publishing-profiles --resource-group $RG --name $RT --xml > realtime.PublishSettings
az webapp deployment list-publishing-profiles --resource-group $RG --name $WEB --xml > web.PublishSettings
```

Then, in the repository on GitHub, **Settings**, **Secrets and variables**, **Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `AZURE_PUBLISH_PROFILE_REALTIME` | the whole of `realtime.PublishSettings` |
| Secret | `AZURE_PUBLISH_PROFILE_WEB` | the whole of `web.PublishSettings` |
| Variable | `AZURE_WEBAPP_REALTIME` | the realtime app's name (`$RT`) |
| Variable | `AZURE_WEBAPP_WEB` | the web app's name (`$WEB`) |

Delete the two `.PublishSettings` files afterwards: each is a password for its app. App settings such as `NIRO_SECRET` stay in Azure; the workflow only uploads code.

## Keep NIRO_SECRET

Both apps must have the same `NIRO_SECRET`, and it must stay the same: it signs every share link, so a new one makes every old link stop working. Save it somewhere safe. The rest of [self-hosting.md's security notes](self-hosting.md#security) apply here too.

## Troubleshooting

| You see | Likely cause |
|---|---|
| The board says it's offline | The browser can't reach the realtime server. Check `PUBLIC_REALTIME_URL` is `wss://<realtime-name>.azurewebsites.net` (no `/ws`), Web sockets is on for the realtime app, and `/healthz` answers. More than 5 tabs open on boards also does this, and so does the realtime server being at `NIRO_MAX_OPEN_MB`. |
| `403 Site Disabled` | An app used its 60 CPU minutes for the day. It comes back at midnight UTC. |
| The first visit takes a long time | The apps were unloaded while idle. Expected on the free tier. |
| Every link stopped working | `NIRO_SECRET` changed on one or both apps. |
| `MissingSubscriptionRegistration ... Microsoft.Web` | App Service isn't registered on the subscription yet. Run `az provider register --namespace Microsoft.Web --wait`, then try again. |
| The realtime app won't start | **Log stream** in the Azure portal shows why. `DATABASE_URL is not set` or a Postgres error means the Neon string is missing or wrong. |
