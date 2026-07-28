// Bethae -- one-time "claim" step linking a Supabase Auth identity to an
// existing families row.
//
// POST /api/auth/claim-family
// Header: Authorization: Bearer <supabase access_token>  (from the
                                                                //         signInWithOtp/verifyOtp flow in login.html)
// Body:   none needed -- the verified token is the only input that matters.
//
// What this does, and deliberately does NOT do:
// - Verifies the bearer token server-side against Supabase Auth itself
//   (GET /auth/v1/user) -- never trusts an email or id passed in the
//   request body, since that would let anyone claim any family.
// - Looks up the *existing* families row whose email matches the verified
//   user's email (case-insensitive). This endpoint never creates a new
//   family -- signup still only happens via the Tally webhook.
// - If that family's auth_user_id is still null, sets it to the verified
//   user's id (the one-time "claim"). If it's already set to this same
//   user, this is a no-op success -- every login after the first calls
//   this again safely and harmlessly.
// - If the family's auth_user_id is already set to a DIFFERENT user id,
//   refuses with 409. Shouldn't happen given the partial unique index on
//   families(auth_user_id), but this is the intentional belt-and-suspenders
//   check on top of that DB constraint.
// - If no families row matches this email at all, returns 404. This is the
//   real gate that keeps this a "existing customers only" flow -- see the
//   note below about why Supabase Auth's own create_user:false flag can't
//   be the thing enforcing that.
//
// IMPORTANT correction vs. the original P1 design doc: that doc recommended
// calling signInWithOtp with shouldCreateUser:false so Supabase Auth itself
// would refuse unknown emails. That doesn't work here -- every existing
// family was created by the Tally webhook writing straight to `families`
// with the service-role key, which never touches Supabase Auth at all. So
// on day one, `auth.users` is completely empty; with create_user:false, IT
// WOULD REJECT EVERY REAL CUSTOMER'S FIRST LOGIN, since Supabase Auth has
// never seen any of these emails before. login.html therefore requests
// codes with create_user left at its default (true), and this endpoint is
// what actually enforces "existing customers only" -- by requiring a
// matching families row, not by gating at the Supabase Auth layer. A
// stranger who's never signed up can still request and use a code (a real
                                                                      // but harmless side effect -- Supabase creates them an auth identity), but
// they hit a 404 here and never see any family's data.
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_KEY, same as every other
// endpoint in this project. SUPABASE_ANON_KEY is optional -- if unset,
// this falls back to using the service key to verify the bearer token,
// which works fine (verifying a token just needs *a* valid project key).

async function getVerifiedUser(supabaseUrl, apikey, accessToken) {
  const res = await fetch(supabaseUrl + '/auth/v1/user', {
                                          headers: {
                                            apikey: apikey,
                                            Authorization: 'Bearer ' + accessToken,
                                          },
                                        });
  if (!res.ok) return null;
  return await res.json();
}

async function findFamilyByEmail(supabaseUrl, serviceKey, email) {
  const url =
    supabaseUrl +
    '/rest/v1/families?email=ilike.' +
    encodeURIComponent(email) +
    '&select=id,email,auth_user_id';
  const res = await fetch(url, {
                                 headers: {
                                   apikey: serviceKey,
                                   Authorization: 'Bearer ' + serviceKey,
                                 },
                               });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase families lookup failed: ' + res.status + ' ' + text);
  }
  const rows = await res.json();
  return rows[0] || null;
}

async function setFamilyAuthUserId(supabaseUrl, serviceKey, familyId, authUserId) {
  const res = await fetch(
                              supabaseUrl + '/rest/v1/families?id=eq.' + familyId + '&auth_user_id=is.null',
                              {
                                method: 'PATCH',
                                headers: {
                                  apikey: serviceKey,
                                  Authorization: 'Bearer ' + serviceKey,
                                  'Content-Type': 'application/json',
                                  Prefer: 'return=representation',
                                },
                                body: JSON.stringify({ auth_user_id: authUserId }),
                              }
                            );
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase families claim update failed: ' + res.status + ' ' + text);
  }
  return await res.json();
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
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- cannot claim family.');
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
      return res.status(404).json({
                                          ok: false,
                                          reason: 'no matching family for this email',
                                        });
    }

    if (family.auth_user_id && family.auth_user_id !== user.id) {
      console.error('claim-family: family already linked to a different auth user', {
                             family_id: family.id,
                             existing_auth_user_id: family.auth_user_id,
                             attempted_auth_user_id: user.id,
                           });
      return res.status(409).json({
                                          ok: false,
                                          reason: 'this family is already linked to a different account',
                                        });
    }

    if (!family.auth_user_id) {
      await setFamilyAuthUserId(SUPABASE_URL, SUPABASE_SERVICE_KEY, family.id, user.id);
      console.log('claim-family: linked family to auth user', {
                           family_id: family.id,
                           auth_user_id: user.id,
                           email: user.email,
                         });
    }

    return res.status(200).json({ ok: true, family_id: family.id, email: user.email });
  } catch (err) {
    console.error('claim-family error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
