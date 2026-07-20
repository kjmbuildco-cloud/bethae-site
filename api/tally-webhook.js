// Bethae -- Tally form submission -> Supabase sync
// Deployed as a Vercel serverless function at /api/tally-webhook
//
// Requires two environment variables set in the Vercel project
// (Project Settings -> Environment Variables), then redeploy:
//   SUPABASE_URL           e.g. https://xxxxx.supabase.co
//   SUPABASE_SERVICE_KEY   the service_role key from Supabase
//                          (Project Settings -> API in Supabase)
//
// Until those are set, this function safely no-ops: it logs why it
// couldn't write, but still returns 200 so Tally doesn't retry forever.
// No signups are lost in the meantime -- Tally keeps every submission
// in its own Submissions tab and still emails a notification per entry.

function getField(fields, matchers) {
    for (const m of matchers) {
          const f = fields.find(
                  (fd) => fd.label && fd.label.toLowerCase().includes(m)
                );
          if (f) return f;
    }
    return null;
}

function fieldValueText(f) {
    if (!f) return null;
    const val = f.value;
    if (val == null) return null;
    if (Array.isArray(val)) {
          if (f.options && Array.isArray(f.options)) {
                  const texts = val.map((v) => {
                            const opt = f.options.find((o) => o.id === v);
                            return opt ? opt.text : v;
                  });
                  return texts.filter(Boolean).join(', ');
          }
          return val.filter(Boolean).join(', ');
    }
    return String(val).trim();
}

function splitList(text) {
    if (!text) return [];
    return text
      .split(/,|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
}
function mapTimezone(text) {
  if (!text) return 'America/Chicago';
  const t = text.toLowerCase();
  if (t.includes('eastern')) return 'America/New_York';
  if (t.includes('central')) return 'America/Chicago';
  if (t.includes('mountain')) return 'America/Denver';
  if (t.includes('pacific')) return 'America/Los_Angeles';
  return 'America/Chicago';
}

function mapDeliveryTime(text) {
  if (!text) return '18:00:00';
  const t = text.toLowerCase();
  if (t.includes('5pm')) return '17:00:00';
  if (t.includes('6pm')) return '18:00:00';
  if (t.includes('7pm')) return '19:00:00';
  if (t.includes('8pm')) return '20:00:00';
  return '18:00:00';
}

function mapLength(text) {
  if (!text) return 5;
  const m = text.match(/(\d+)/);
  if (!m) return 5;
  const n = parseInt(m[1], 10);
  return [3, 5, 8].includes(n) ? n : 5;
}

function mapSiblingMode(text) {
  if (!text) return 'per_kid';
  const t = text.toLowerCase();
  if (t.includes('one story')) return 'shared';
  if (t.includes('separate')) return 'per_kid';
  return 'per_kid';
}

function mapMode(text) {
  if (!text) return 'standalone';
  const t = text.toLowerCase();
  if (t.includes('ongoing') || t.includes('chapter')) return 'serialized';
  return 'standalone';
}
async function upsertFamily(supabaseUrl, serviceKey, familyData) {
  const res = await fetch(supabaseUrl + '/rest/v1/families?on_conflict=email', {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([familyData]),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase family upsert failed: ' + res.status + ' ' + text);
  }
  const rows = await res.json();
  return rows[0];
}

async function insertChild(supabaseUrl, serviceKey, childData) {
  const res = await fetch(supabaseUrl + '/rest/v1/children', {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([childData]),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase child insert failed: ' + res.status + ' ' + text);
  }
  const rows = await res.json();
  return rows[0];
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, note: 'Bethae Tally webhook endpoint. Expects POST from Tally.' });
    return;
  }

  try {
    const payload = req.body || {};
    const fields = (payload.data && payload.data.fields) || [];
    const submissionId = payload.data && payload.data.submissionId;

  if (!Array.isArray(fields) || fields.length === 0) {
    console.error('Tally webhook: no fields in payload', JSON.stringify(payload).slice(0, 500));
    return res.status(200).json({ ok: false, reason: 'no fields in payload' });
  }

  const emailField = getField(fields, ['your email', 'email']);
    const tzField = getField(fields, ['time zone']);
    const timeField = getField(fields, ['what time', 'story arrive']);
    const styleField = getField(fields, ['story style']);
    const siblingField = getField(fields, ['one story starring', 'separate story']);
    const childNameField = getField(fields, ['first name']);
    const ageField = getField(fields, ['age']);
    const genderField = getField(fields, ['gender']);
    const interestsField = getField(fields, ['favorite things']);
    const avoidField = getField(fields, ['keep out']);
    const peopleField = getField(fields, ['people or pets']);
    const valuesField = getField(fields, ['values you']);
    const lengthField = getField(fields, ['read-aloud length', 'read aloud length']);

  const email = fieldValueText(emailField);
    if (!email) {
      console.error('Tally webhook: no email found on submission', submissionId);
      return res.status(200).json({ ok: false, reason: 'no email field found' });
    }

  const familyData = {
    email: email,
    timezone: mapTimezone(fieldValueText(tzField)),
    delivery_time: mapDeliveryTime(fieldValueText(timeField)),
    sibling_mode: mapSiblingMode(fieldValueText(siblingField)),
  };

  const ageRaw = fieldValueText(ageField);
    const ageParsed = ageRaw ? parseInt(ageRaw, 10) : NaN;

  const childData = {
    name: fieldValueText(childNameField) || 'Unknown',
    age: Number.isFinite(ageParsed) ? ageParsed : 6,
    gender: fieldValueText(genderField) ? fieldValueText(genderField).toLowerCase() : null,
    interests: splitList(fieldValueText(interestsField)),
    avoid_list: splitList(fieldValueText(avoidField)),
    include_people: splitList(fieldValueText(peopleField)),
    values_focus: splitList(fieldValueText(valuesField)),
    bible_option: false,
    mode: mapMode(fieldValueText(styleField)),
    length_minutes: mapLength(fieldValueText(lengthField)),
  };

  if (!Number.isFinite(ageParsed)) {
    console.error('Tally webhook: age missing/unparseable, defaulted to 6. Check this submission manually.', { email: email, submissionId: submissionId, ageRaw: ageRaw });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set in Vercel env vars -- submission NOT written to Supabase yet.', { email: email, submissionId: submissionId });
    return res.status(200).json({ ok: false, reason: 'supabase env vars not configured' });
  }

  const family = await upsertFamily(SUPABASE_URL, SUPABASE_SERVICE_KEY, familyData);
    const child = await insertChild(SUPABASE_URL, SUPABASE_SERVICE_KEY, Object.assign({}, childData, { family_id: family.id }));

  console.log('Tally submission synced to Supabase', { submissionId: submissionId, family_id: family.id, child_id: child.id, email: email });

  return res.status(200).json({ ok: true, family_id: family.id, child_id: child.id });
  } catch (err) {
    console.error('Tally webhook error:', err);
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
