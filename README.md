# ActionFi Partnership Verification Bot (V1)

Cross-server membership verification, campaign management, role assignment,
eligibility tracking, and reporting — for ActionFi's partnership campaigns.

Stack: **Node.js + Discord.js v14 + PostgreSQL (Prisma) + Railway**.

## What it does

- Admins create a **campaign** (e.g. "ActionFi x Kora") requiring membership
  in 2+ Discord servers.
- A verification embed with a **Verify Membership** button gets posted in
  each participating server.
- Members who belong to every required server get a campaign role and are
  added to the eligibility list.
- The bot keeps watching: if someone leaves a required server, their role
  and eligibility are automatically revoked.
- Admins can view stats, list members, export eligible members (CSV / Excel
  / PDF), recheck everyone on demand, repost the embed, end, and archive
  campaigns.
- All activity for a server funnels into one configured log channel.
- Access to the campaign system is controlled per-server or globally by the
  bot owner; partner servers only ever need to invite the bot.

## Commands

| Command | Who | Purpose |
|---|---|---|
| `/setup log-channel` | Server admin | Set the single log channel |
| `/campaign create` | Admin w/ campaign access | Start the campaign creation wizard |
| `/campaign list` | Admin | List campaigns for this server |
| `/campaign view` | Admin | Full campaign details |
| `/campaign stats` | Admin | Campaign statistics |
| `/campaign members` | Admin | Recent tracked members |
| `/campaign export` | Admin | Export eligible members (CSV/Excel/PDF) |
| `/campaign recheck` | Admin | Force a full eligibility recheck |
| `/campaign repost` | Admin | Post/repost the verification embed |
| `/campaign end` | Admin | Stop accepting verifications |
| `/campaign archive` | Admin | Archive an ended campaign |
| `/partner-access global/server/status` | Bot owner only | Access control |

Campaign creation is a short wizard (buttons + modals) since it needs an
arbitrary number of servers: add each required server, pick which server
holds the role (auto-created or existing), set the verification window,
then **Finish & Create**.

## Local setup

1. **Discord application**: create one at
   https://discord.com/developers/applications, add a bot, copy the
   **token** and **application (client) ID**. Under OAuth2 → URL Generator,
   check `bot` + `applications.commands`, and these bot permissions:
   `Manage Roles`, `View Channels`, `Send Messages`, `Embed Links`,
   `Attach Files`. Use the generated URL to invite the bot to your servers
   (the bot's role must sit above any role it needs to assign/remove).

2. **Enable the "Server Members Intent"** for the bot in the Developer
   Portal (Bot tab) — required to check cross-server membership.

3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`,
   `DISCORD_CLIENT_ID`, `DATABASE_URL`, `OWNER_IDS`, `HOME_GUILD_ID`.

4. Install dependencies and generate the Prisma client:
   ```bash
   npm install
   ```

5. Create the database schema (local Postgres or a Railway Postgres you're
   pointing at from your machine):
   ```bash
   npx prisma migrate dev --name init
   ```

6. Register slash commands (re-run this any time command definitions change):
   ```bash
   npm run deploy-commands
   ```

7. Start the bot:
   ```bash
   npm start
   ```

## Deploying on Railway

1. Push this project to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, select the repo.
3. **Add a PostgreSQL plugin** to the project (`+ New → Database →
   PostgreSQL`).
4. On the bot service's **Variables** tab, add:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `OWNER_IDS`
   - `HOME_GUILD_ID`
   - `DATABASE_URL` → set this to `${{Postgres.DATABASE_URL}}` so Railway
     injects the Postgres plugin's connection string automatically.
5. Railway will detect Node via Nixpacks and use `railway.json`'s deploy
   command, which runs `prisma migrate deploy` before starting the bot —
   so migrations apply automatically on every deploy. No manual DB step
   needed after the first deploy.
6. After the first successful deploy, run command registration once from
   your machine (or a one-off Railway shell) pointed at the same
   `DISCORD_TOKEN`/`DISCORD_CLIENT_ID`:
   ```bash
   npm run deploy-commands
   ```
7. Invite the bot to ActionFi's server and each partner server using the
   OAuth2 URL from step 1 above.

That's the whole deploy — one service, one Postgres plugin, no extra
infrastructure.

## Notes on V1 scope

- The raffle itself is intentionally **not** part of this bot — its job
  ends at producing a clean, verified eligibility export.
- Eligibility is rechecked in real time when someone leaves a required
  server, and swept periodically (`RECHECK_INTERVAL_MINUTES`, default 60)
  to catch anything missed while the bot was offline.
- Campaign creation drafts live in memory for 15 minutes; if a wizard
  session times out, just run `/campaign create` again.
