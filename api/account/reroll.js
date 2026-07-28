// Bethae -- P3 (self-serve reroll trigger): let a logged-in customer ask
// for tonight's story to be regenerated, exposing the existing
// generate_and_send.py "reroll" command (and its already-deployed weekly
// cap) rather than building a second reroll mechanism.
//
// POST /api/account/reroll
// Header: Authorization: Bearer <supabase access_token>
// Body:   { child_id }
//
// What this does:
// - Verifies the bearer token and looks up the caller's family, exactly
//   like every other account/* endpoint.
// - Confirms the requested child actually belongs to that family (403
//   otherwise) -- a customer can only reroll their own kid's story.
// - Re-checks the weekly cap here too (same rule generate_and_send.py's
//   cmd_reroll already enforces server-side: REROLL_WEEKLY_CAP rerolls per
//   family per rolling 7 days) so the customer gets an immediate, friendly
//   "you're out of rerolls this week" response instead of silently firing
//   a workflow that will just exit non-zero. This is a UX nicety, not the
//   real enforcement -- cmd_reroll's own check is still what actually
//   protects API spend, since this endpoint's count could theoretically
//   race with a near-simultaneous request.
// - Confirms there's actually a story to reroll for this child tonight
//   (approved or sent, delivered on the family's own local "today" --
//   same story_children join cmd_reroll itself uses) before dispatching,
//   so a customer doesn't get a false "requested!" for a night with
//   nothing generated yet.
// - Dispatches the existing `reroll.yml` GitHub Actions workflow (already
//   built for the Phase 3 A/B harness -- reused as-is here, not duplicated)
//   via workflow_dispatch, passing child_id as the input it already
//   expects. Reuses the same GH_DISPATCH_TOKEN / GH_REPO env vars already
//   configured in Vercel for the onboarding dispatch in tally-webhook.js --
//   no new secrets needed.
//
// This is intentionally fire-and-forget from the customer's point of view:
// the workflow itself takes real time (checkout, pip install, an actual
// Claude API call), so the response here just confirms the request was
// accepted, not that the new story has landed yet.

const REROLL_WEEKLY_CAP = 2; // matches generate_and_send.py's REROLL_WEEKLY_CAP default

async function getVerifiedUser(supabaseUrl, apikey, accessToken) {
  const res = await fetch(supabaseUrl + '/auth/v1/user', {
    headers: { apikey: apikey, Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function findFamilyByEmail(supabaseUrl, serviceKey, email) {
  const url =
    supabaseUrl +
    '/rest/v1/families?email=ilike.' +
    encodeURIComponent(email) +
    '&select=id,email,timezone';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) throw new Error('Supabase families lookup failed: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

async function findChildById(supabaseUrl, serviceKey, childId) {
  const url =
    supabaseUrl +
    '/rest/v1/children?id=eq.' +
    encodeURIComponent(childId) +
    '&select=id,family_id,name';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) throw new Error('Supabase child lookup failed: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

async function countRerollsThisWeek(supabaseUrl, serviceKey, familyId) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const url =
    supabaseUrl +
    '/rest/v1/stories?family_id=eq.' +
    familyId +
    '&is_reroll=eq.true&generated_at=gte.' +
    encodeURIComponent(weekAgo) +
    '&select=id';
  const res = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      Prefer: 'count=exact',
    },
  });
  if (!res.ok) throw new Error('Supabase reroll-count lookup failed: ' + res.status);
  const range = res.headers.get('content-range'); // e.g. "0-1/2"
  if (range && range.includes('/')) {
    const total = range.split('/')[1];
    const n = parseInt(total, 10);
    if (Number.isFinite(n)) return n;
  }
  const rows = await res.json();
  return rows.length;
}

// Same idea as generate_and_send.py's family_local_today: today's date in
// the family's own timezone, as YYYY-MM-DD.
function familyLocalToday(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

async function findTonightsStory(supabaseUrl, serviceKey, childId, todayIso) {
  const url =
    supabaseUrl +
    '/rest/v1/story_children?child_id=eq.' +
    encodeURIComponent(childId) +
    '&select=stories!inner(id,deliver_on,status)';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) throw new Error('Supabase story_children lookup failed: ' + res.status);
  const rows = await res.json();
  const match = rows.find(
    (row) =>
      row.stories &&
      row.stories.deliver_on === todayIso &&
      (row.stories.status === 'approved' || row.stories.status === 'sent')
  );
  return match ? match.stories : null;
}

async function dispatchRerollWorkflow(childId) {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO || 'kjmbuildco-cloud/bedtime-stories';
  if (!token) {
    throw new Error(
      'GH_DISPATCH_TOKEN not set -- cannot dispatch the reroll workflow. ' +
        'Fix: add a GitHub PAT (Actions:write) as GH_DISPATCH_TOKEN in Vercel env vars ' +
        '(same one already used for onboarding dispatch).'
    );
  }
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/reroll.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { child_id: childId } }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`reroll.yml dispatch failed: ${res.status} ${text}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, reason: 'method not allowed, use POST' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- cannot process reroll.');
    return res.status(500).json({ ok: false, reason: 'server not configured' });
  }

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!accessToken) {
    return res.status(401).json({ ok: false, reason: 'missing bearer token' });
  }

  const childId = (req.body || {}).child_id;
  if (!childId) {
    return res.status(400).json({ ok: false, reason: 'child_id is required' });
  }

  try {
    const user = await getVerifiedUser(
      SUPABASE_URL,
      SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY,
      accessToken
    );
    if (!user || !user.email) {
      return res.status(401).json({ ok: false, reason: 'invalid or expired session' });
    }

    const family = await findFamilyByEmail(SUPABASE_URL, SUPABASE_SERVICE_KEY, user.email);
    if (!family) {
      return res.status(404).json({ ok: false, reason: 'no matching family for this email' });
    }

    const child = await findChildById(SUPABASE_URL, SUPABASE_SERVICE_KEY, childId);
    if (!child) {
      return res.status(404).json({ ok: false, reason: 'no such child' });
    }
    if (child.family_id !== family.id) {
      console.error('reroll: ownership mismatch', {
        attempted_by_family: family.id,
        child_family: child.family_id,
        child_id: childId,
      });
      return res.status(403).json({ ok: false, reason: 'this child does not belong to your account' });
    }

    const rerollCount = await countRerollsThisWeek(SUPABASE_URL, SUPABASE_SERVICE_KEY, family.id);
    if (rerollCount >= REROLL_WEEKLY_CAP) {
      return res.status(429).json({
        ok: false,
        reason: `You've used all ${REROLL_WEEKLY_CAP} re-rolls for this week. New ones unlock next week.`,
      });
    }

    const today = familyLocalToday(family.timezone);
    const tonight = await findTonightsStory(SUPABASE_URL, SUPABASE_SERVICE_KEY, childId, today);
    if (!tonight) {
      return res.status(404).json({
        ok: false,
        reason: "Tonight's story isn't ready yet for this child -- nothing to re-roll right now.",
      });
    }

    await dispatchRerollWorkflow(childId);

    console.log('reroll requested', { family_id: family.id, child_id: childId, story_id: tonight.id });
    return res.status(200).json({
      ok: true,
      message: `Got it -- ${child.name}'s new story is being written now. Check back in a few minutes.`,
      rerolls_used: rerollCount + 1,
      rerolls_cap: REROLL_WEEKLY_CAP,
    });
  } catch (err) {
    console.error('reroll error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
