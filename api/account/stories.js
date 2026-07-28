// Bethae -- P4 (non-Stripe piece): let a logged-in customer read past
// stories, since the full text is already sitting in the `stories` table
// (per the P2-P4 brainstorm doc) -- this is a read-only archive view, no
// new storage needed.
//
// GET /api/account/stories?child_id=<optional>
// Header: Authorization: Bearer <supabase access_token>
//
// Returns the family's most recent sent/approved stories (default 60,
// newest first), each with which child(ren) it was for. Optional
// child_id query param narrows to just one kid's archive.
//
// Same ownership model as every other account/* endpoint: bearer token
// verified server-side, family looked up by that verified email, and the
// story query is scoped to that family's own family_id -- never anything
// the client could pass in to see another family's stories.

const PAGE_SIZE = 60;

async function getVerifiedUser(supabaseUrl, apikey, accessToken) {
  const res = await fetch(supabaseUrl + '/auth/v1/user', {
    headers: { apikey: apikey, Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function findFamilyByEmail(supabaseUrl, serviceKey, email) {
  const url =
    supabaseUrl + '/rest/v1/families?email=ilike.' + encodeURIComponent(email) + '&select=id,email';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) throw new Error('Supabase families lookup failed: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

async function findChildIdsForFamily(supabaseUrl, serviceKey, familyId) {
  const url =
    supabaseUrl + '/rest/v1/children?family_id=eq.' + familyId + '&select=id,name';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) throw new Error('Supabase children lookup failed: ' + res.status);
  return await res.json();
}

async function findStories(supabaseUrl, serviceKey, familyId) {
  const url =
    supabaseUrl +
    '/rest/v1/stories?family_id=eq.' +
    familyId +
    '&status=in.(approved,sent)' +
    '&select=id,title,body,summary,deliver_on,chapter_number,is_reroll,sent_at,story_children(child_id)' +
    '&order=deliver_on.desc' +
    '&limit=' +
    PAGE_SIZE;
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase stories lookup failed: ' + res.status + ' ' + text);
  }
  return await res.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, reason: 'method not allowed, use GET' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- cannot list stories.');
    return res.status(500).json({ ok: false, reason: 'server not configured' });
  }

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!accessToken) {
    return res.status(401).json({ ok: false, reason: 'missing bearer token' });
  }

  const filterChildId = (req.query && req.query.child_id) || null;

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

    const children = await findChildIdsForFamily(SUPABASE_URL, SUPABASE_SERVICE_KEY, family.id);
    const nameById = Object.fromEntries(children.map((c) => [c.id, c.name]));

    if (filterChildId && !nameById[filterChildId]) {
      return res.status(403).json({ ok: false, reason: 'this child does not belong to your account' });
    }

    let stories = await findStories(SUPABASE_URL, SUPABASE_SERVICE_KEY, family.id);

    stories = stories
      .map((s) => ({
        id: s.id,
        title: s.title,
        body: s.body,
        summary: s.summary,
        deliver_on: s.deliver_on,
        chapter_number: s.chapter_number,
        is_reroll: s.is_reroll,
        sent_at: s.sent_at,
        children: (s.story_children || [])
          .map((sc) => nameById[sc.child_id])
          .filter(Boolean),
        child_ids: (s.story_children || []).map((sc) => sc.child_id),
      }))
      .filter((s) => !filterChildId || s.child_ids.includes(filterChildId));

    return res.status(200).json({ ok: true, stories });
  } catch (err) {
    console.error('account/stories error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
