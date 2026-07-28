// Bethae -- P2 (self-serve profile edit): update one child's story-profile
// fields, scoped to the logged-in family that actually owns that child.
//
// PATCH /api/account/update-child
// Header: Authorization: Bearer <supabase access_token>
// Body:   { child_id, name?, age?, gender?, interests?, avoid_list?,
//           include_people?, values_focus?, length_minutes? }
//         Array fields accept either a real array or a comma/newline
//         separated string (matches how the Tally webhook already parses
//         these same fields, so the UI can reuse a plain textarea).
//
// Deliberately NOT editable here: `mode` (standalone/serialized) and
// `bible_option` -- not part of P2's stated field list, and switching a
// serialized child mid-arc has real continuity implications the design
// doc didn't ask for. Keeping this endpoint to exactly the fields a
// customer would reasonably expect to tweak themselves.
//
// Ownership model (same as claim-family.js and account/children.js): the
// bearer token is verified server-side, the family is looked up by that
// verified email, and the child's family_id must match that family's id
// before any write happens -- a customer can never edit a child that
// isn't theirs, even if they somehow guess another family's child id.

const ALLOWED_LENGTHS = [3, 5, 8];

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

async function findChildById(supabaseUrl, serviceKey, childId) {
  const url =
    supabaseUrl +
    '/rest/v1/children?id=eq.' +
    encodeURIComponent(childId) +
    '&select=id,family_id';
  const res = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!res.ok) throw new Error('Supabase child lookup failed: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

async function updateChild(supabaseUrl, serviceKey, childId, patch) {
  const res = await fetch(supabaseUrl + '/rest/v1/children?id=eq.' + encodeURIComponent(childId), {
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
    throw new Error('Supabase child update failed: ' + res.status + ' ' + text);
  }
  return await res.json();
}

// Accepts a real array, or falls back to splitting a string on commas/
// newlines -- same convention as tally-webhook.js's splitList, so the
// account.html UI can post either shape.
function toList(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/,|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
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
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- cannot update child.');
    return res.status(500).json({ ok: false, reason: 'server not configured' });
  }

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!accessToken) {
    return res.status(401).json({ ok: false, reason: 'missing bearer token' });
  }

  const body = req.body || {};
  const childId = body.child_id;
  if (!childId) {
    return res.status(400).json({ ok: false, reason: 'child_id is required' });
  }

  // Build the patch, validating each field that was actually sent rather
  // than assuming every field is present (a partial edit -- e.g. just
  // updating interests -- should not require resending everything else).
  const patch = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ ok: false, reason: 'name cannot be empty' });
    if (name.length > 200) return res.status(400).json({ ok: false, reason: 'name is too long' });
    patch.name = name;
  }

  if (body.age !== undefined) {
    const age = Number.parseInt(body.age, 10);
    if (!Number.isFinite(age) || age < 0 || age > 17) {
      return res.status(400).json({ ok: false, reason: 'age must be a whole number 0-17' });
    }
    patch.age = age;
  }

  if (body.gender !== undefined) {
    const gender = body.gender == null ? null : String(body.gender).trim().toLowerCase() || null;
    patch.gender = gender;
  }

  if (body.interests !== undefined) {
    const interests = toList(body.interests);
    if (!interests || interests.length === 0) {
      return res.status(400).json({
        ok: false,
        reason: 'interests cannot be empty -- these drive every story, at least one is required',
      });
    }
    if (interests.length > 10) {
      return res.status(400).json({ ok: false, reason: 'please keep it to 10 interests or fewer' });
    }
    patch.interests = interests;
  }

  if (body.avoid_list !== undefined) {
    patch.avoid_list = toList(body.avoid_list) || [];
  }

  if (body.include_people !== undefined) {
    patch.include_people = toList(body.include_people) || [];
  }

  if (body.values_focus !== undefined) {
    patch.values_focus = toList(body.values_focus) || [];
  }

  if (body.length_minutes !== undefined) {
    const minutes = Number.parseInt(body.length_minutes, 10);
    if (!ALLOWED_LENGTHS.includes(minutes)) {
      return res.status(400).json({ ok: false, reason: 'length_minutes must be 3, 5, or 8' });
    }
    patch.length_minutes = minutes;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, reason: 'no editable fields were provided' });
  }

  patch.updated_at = new Date().toISOString();

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
      console.error('update-child: ownership mismatch', {
        attempted_by_family: family.id,
        child_family: child.family_id,
        child_id: childId,
      });
      return res.status(403).json({ ok: false, reason: 'this child does not belong to your account' });
    }

    const updated = await updateChild(SUPABASE_URL, SUPABASE_SERVICE_KEY, childId, patch);
    return res.status(200).json({ ok: true, child: updated[0] || null });
  } catch (err) {
    console.error('update-child error:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
