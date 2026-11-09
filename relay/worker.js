// Travel Podcasts relay: a Cloudflare Worker (free plan) that turns a request from the app into a GitHub issue.
// Claude reads the open issues labelled "episode-request", writes each episode, and closes the issue when it is published.
//
// Two secrets must be set on the Worker (Settings > Variables and Secrets):
//   GITHUB_TOKEN  fine-grained GitHub token for this one repository, permission "Issues: Read and write" only
//   FAMILY_CODE   any phrase you choose; the app sends it with every request so strangers cannot use the relay
const REPO = 'fijsurge/travel-podcasts';
const SITE = 'https://fijsurge.github.io';
const LABEL = 'episode-request';
const FEEDBACK_LABEL = 'episode-feedback';
const MAX_OPEN = 15;      // refuse new requests while this many are still waiting
const MAX_TEXT = 6000;    // characters

function reply(body, status, extra) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': SITE,
      'Access-Control-Allow-Headers': 'Content-Type, X-Family-Code',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin',
    }, extra || {}),
  });
}

// Compare without stopping at the first different character.
function same(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function gh(env, path, init) {
  return fetch('https://api.github.com' + path, Object.assign({}, init, {
    headers: Object.assign({
      'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'travel-podcasts-relay',
    }, init && init.body ? { 'Content-Type': 'application/json' } : {}),
  }));
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return reply(null, 204);
    if (req.method !== 'POST') return reply({ ok: true, service: 'travel-podcasts relay' }, 200);

    const origin = req.headers.get('Origin');
    if (origin && origin !== SITE) return reply({ ok: false, error: 'This address only accepts requests from the Travel Podcasts app.' }, 403);
    if (!env.GITHUB_TOKEN || !env.FAMILY_CODE) return reply({ ok: false, error: 'The relay is not finished: GITHUB_TOKEN and FAMILY_CODE must both be set as secrets.' }, 500);
    if (!same(req.headers.get('X-Family-Code'), env.FAMILY_CODE)) return reply({ ok: false, error: 'The family code is wrong.' }, 401);

    let data;
    try { data = await req.json(); } catch (e) { return reply({ ok: false, error: 'The request was not readable.' }, 400); }
    if (data && data.ping) return reply({ ok: true, message: 'Connected.', feedback: true }, 200);

    const feedback = !!(data && data.kind === 'feedback');
    const label = feedback ? FEEDBACK_LABEL : LABEL;
    const text = String((data && data.text) || '').trim();
    const title = String((data && data.title) || (feedback ? 'Problem report' : 'New episode')).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (text.length < (feedback ? 10 : 20)) return reply({ ok: false, error: 'The request is too short.' }, 400);
    if (text.length > MAX_TEXT) return reply({ ok: false, error: 'The request is too long.' }, 413);

    const open = await gh(env, '/repos/' + REPO + '/issues?labels=' + label + '&state=open&per_page=' + (MAX_OPEN + 1));
    if (!open.ok) return reply({ ok: false, error: 'GitHub did not accept the relay key (' + open.status + ').' }, 502);
    if ((await open.json()).length >= MAX_OPEN) return reply({ ok: false, error: 'There are already ' + MAX_OPEN + (feedback ? ' reports' : ' requests') + ' waiting. Try again once some are done.' }, 429);

    const made = await gh(env, '/repos/' + REPO + '/issues', {
      method: 'POST',
      body: JSON.stringify({ title: (feedback ? 'Problem report: ' : 'Episode request: ') + title, body: text, labels: [label] }),
    });
    if (!made.ok) return reply({ ok: false, error: 'GitHub refused the request (' + made.status + '). The key needs Issues: Read and write.' }, 502);
    const issue = await made.json();
    return reply({ ok: true, number: issue.number, url: issue.html_url }, 200);
  },
};
