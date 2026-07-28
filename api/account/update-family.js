// Bethae -- P4 (non-Stripe pieces): let a logged-in customer edit their
// own family-level settings -- delivery time, timezone, and a pause
// toggle -- without Kyle's involvement.
//
// PATCH /api/account/update-family
// Header: Authorization: Bearer <supabase access_token>
// Body:   { delivery_time?, timezone?, paused? }
//         delivery_time: one of "17:00:00" | "18:00:00" | "19:00:00" | "20:00:00"
//           (same 5/6/7/8pm options already offered on the Tally signup form --
//           kept to this fixed set rather than free-form time so it stays
//           compatible with the existing hourly generate/send cron design).
//         timezone: one of the 4 IANA zones the pipeline already maps to
//           (America/New_York, America/Chicago, America/Denver,
//           America/Los_Angeles).
//         paused: true | false -- maps to families.status ("paused" vs
//           "active"). Deliberately the ONLY status transition this
//           endpoint allows: "canceled" is a billing action that belongs
//           to the Stripe Customer Portal once P7 exists, not a field a
//           customer can quietly flip here. A family already in status
//           "canceled" cannot be toggled back to "active" through this
//           endpoint either -- that's a business decision, not a UI toggle.
//
// Same ownership model as every other account/* endpoint: bearer token
// verified server-side, family looked up by that verified email, and the
// PATCH is scoped to that family's own row by id.

const ALLOWED_DELIVERY_TIMES = ['17:00:00', '18:00:00', '19:00:00', '20:00:00'];
const ALLOWED_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
];

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
    '&select=id,email,status,timezone,delivery_time';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) throw new Error('Supabase families lookup failed: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

async function updateFamily(supabaseUrl, serviceKey, familyId, patch) {
  const res = await fetch(supabaseUrl + '/rest/v1/families?id=eq.' + familyId, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase family update failed: ' + res.status + ' ' + text);
  }
  return await res.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'PATCH') {
    res.status(405).json({ ok: false, reason: 'method not allowed, use PATCH' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- cannot update family.');
    return res.status(500).json({ ok: false, reason: 'server not configured' });
  }

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!accessToken) {
    return res.status(401).json({ ok: false, reason: 'missing bearer token' });
  }

  const body = req.body || {};
  const patch = {};

  if (body.delivery_time !== undefined) {
    if (!ALLOWED_DELIVERY_TIMES.includes(body.delivery_time)) {
      return res.status(400).json({
        ok: false,
        reason: `delivery_time must be one of: ${ALLOWED_DELIVERY_TIMES.join(', ')}`,
      });
    }
    patch.delivery_time = body.delivery_time;
  }

  if (body.timezone !== undefined) {
    if (!ALLOWED_TIMEZONES.includes(body.timezone)) {
      return res.status(400).json({
        ok: false,
        reason: `timezone must be one of: ${ALLOWED_TIMEZONES.join(', ')}`,
      });
    }
    patch.timezone = body.timezone;
  }

  if (body.paused !== undefined) {
    if (typeof body.paused !== 'boolean') {
      return res.status(400).json({ ok: false, reason: 'paused must be true or false' });
    }
    patch._paused = body.paused; // resolved to families.status after we know current status
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, reason: 'no editable fields were provided' });
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

    if ('_paused' in patch) {
      if (family.status === 'canceled') {
        return res.status(409).json({
          ok: false,
          reason: 'This account is canceled -- pausing/unpausing does not apply. Contact stories@bethae.com.',
        });
      }
      patch.status = patch._paused ? 'paused' : 'active';
      delete patch._paused;
    }

    const updated = await updateFamily(SUPABASE_URL, SUPABASE_SERVICE_KEY, family.id, patch);
    return res.status(200).json({ ok: true, family: updated[0] || null });
  } catch (err) {
    console.error('update-family error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
