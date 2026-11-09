# Request relay (optional, free)

This lets the **Create** tab send a request straight to Claude instead of copying text into a chat.
The app posts the request to a small Cloudflare Worker, which files it as a GitHub issue labelled `episode-request`.
Nothing here costs money: Cloudflare Workers' free plan allows 100,000 requests a day, and no card is needed.

## One-time setup (about 15 minutes)

### 1. A GitHub key that can only file issues
1. GitHub > your profile picture > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**.
2. Name: `travel-podcasts relay`. Expiration: the longest offered.
3. Repository access: **Only select repositories** > `fijsurge/travel-podcasts`.
4. Permissions > Repository permissions > **Issues: Read and write**. Leave everything else as it is.
5. Generate, and copy the token (starts with `github_pat_`). You see it only once.

### 2. The Worker
1. Make a free account at <https://dash.cloudflare.com/sign-up>.
2. **Workers & Pages** > **Create** > **Create Worker**. Name it `travel-podcasts-relay` > **Deploy**.
3. **Edit code**. Delete what is there, paste in all of `relay/worker.js`, then **Deploy**.
4. Back on the Worker page: **Settings** > **Variables and Secrets** > **Add**, type **Secret**:
   - `GITHUB_TOKEN` = the token from step 1
   - `FAMILY_CODE` = any phrase you like (at least 12 characters). Everyone who may send requests needs it.
5. Deploy again if Cloudflare asks. Copy the Worker address, like `https://travel-podcasts-relay.yourname.workers.dev`.

### 3. The app
On each phone: **Settings** > **Request relay**. Paste the address and the family code, then tap **Test**.
It should say *Connected*. The Create tab then shows **Send to Claude**.

## How requests get answered
A scheduled Claude task reads the open `episode-request` issues, writes each episode in the house style
(`tools/STYLE.md`), pushes it to `main`, and closes the issue with a comment. The audio is then built by the usual workflow.
The Create tab lists your recent requests and whether they are done.

## Problem reports
The **Report a problem** button (player and walk screen) sends a note through the same Worker, filed as an issue labelled
`episode-feedback` (title starts "Problem report:"). The same scheduled task fixes name pronunciations
(`tools/pronunciations.json`), stop pins (`stops:` in the episode), or script facts, rebuilds only the changed parts,
and closes the issue with a comment.

**Updating the Worker:** when `relay/worker.js` changes, open the Worker in Cloudflare, **Edit code**, replace everything
with the new file, and **Deploy**. Secrets stay as they are. This is optional: with the older Worker, the app still sends reports (as requests titled "Problem report:") and the scheduled task handles them the same way.

## Safety
- The key can only create and read issues in this one repository.
- Requests without the family code are refused. The Worker also refuses other websites and stops at 15 waiting requests (and 15 waiting reports).
- To shut it off, delete the Worker in Cloudflare or revoke the GitHub token.
