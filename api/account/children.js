// Bethae -- P2 (self-serve profile edit): list the logged-in family's
// children and their editable story-profile fields.
//
// GET /api/account/children
// Header: Authorization: Bearer <supabase access_token>
//
// Returns: { ok:true, family: {id,email,timezone,delivery_time,status},
//            children: [{id,name,age,gender,interests,avoid_list,
//                        include_people,values_focus,length_minutes,mode}] }
//
// Same ownership model as claim-family.js: the bearer token is verified
// server-side against Supabase Auth, then the family is looked up by that
// verified email -- never by anything the client claims in the request.

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
    '&select=id,email,timezone,delivery_time,status';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase families lookup failed: ' + res.status + ' ' + text);
  }
  const rows = await res.json();
  return rows[0] || null;
}

async function findChildrenByFamily(supabaseUrl, serviceKey, familyId) {
  const url =
    supabaseUrl +
    '/rest/v1/children?family_id=eq.' +
    familyId +
    '&select=id,name,age,gender,interests,avoid_list,include_people,values_focus,length_minutes,mode&order=created_at.asc';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase children lookup failed: ' + res.status + ' ' + text);
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
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- cannot list children.');
    return res.status(500).json({ ok: false, reason: 'server not configured' });
  }

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!accessToken) {
    return res.status(401).json({ ok: false, reason: 'missing bearer token' });
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

    const children = await findChildrenByFamily(SUPABASE_URL, SUPABASE_SERVICE_KEY, family.id);

    return res.status(200).json({ ok: true, family, children });
  } catch (err) {
    console.error('account/children error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
