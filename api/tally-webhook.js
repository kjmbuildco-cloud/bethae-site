// Bethae — Tally form submission -> Supabase sync
// Deployed as a Vercel serverless function at /api/tally-webhook
//
// Requires these environment variables to be set in the Vercel project
// (Project Settings -> Environment Variables), then redeploy:
//   SUPABASE_URL          e.g. https://xxxxx.supabase.co
//   SUPABASE_SERVICE_KEY  the "service_role" key from Supabase
//                         (Project Settings -> API in Supabase)
//   RESEND_API_KEY        for the welcome email (optional -- logs and
//                         skips the email if missing, everything else
//                         still works)
//   FROM_EMAIL             optional, defaults to "Bethae <stories@bethae.com>"
//   GH_DISPATCH_TOKEN      (added 2026-07-24) a GitHub PAT with Actions:write
//                         on kjmbuildco-cloud/bedtime-stories, used to fire
//                         the fully-automated first-story workflow the
//                         instant onboarding completes. Optional -- if unset,
//                         the family/children are still saved normally and
//                         this step just logs and no-ops (first story would
//                         then need the existing manual `generate --now`
//                         stopgap instead).
//   GH_REPO                optional, defaults to "kjmbuildco-cloud/bedtime-stories"
//
// Until Supabase vars are set, this function safely no-ops: it logs why it
// couldn't write, but still returns 200 so Tally doesn't retry forever.
// No signups are lost in the meantime -- Tally keeps every submission
// in its own Submissions tab and still emails a notification per entry.
//
// Multi-kid submissions (added 7/24): the form supports up to MAX_CHILDREN
// kids in one submission. Child 1's fields keep their original labels
// (e.g. "First name -- as they like to hear it") for backward compatibility.
// Each additional child's fields must have " (Child 2)", " (Child 3)", etc.
// appended to the same question text in Tally -- see getChildField below.
// A child slot with no name answered is treated as "not used" and skipped
// (except child 1, which always produces a row, defaulting to "Unknown"
// if somehow left blank, to match the original single-child behavior).
//
// Onboarding-complete signal (added 7/24, handoff Goal 1): today this whole
// handler runs as ONE atomic request -- family + all children are written
// together, so there's no window where a family exists without its
// children on this path. We still record families.onboarding_completed_at
// explicitly (rather than inferring it from "children exist"), because a
// future Stripe-driven signup flow may create the family record separately
// from a later "add your kids" step, and this timestamp is what makes the
// automated first-story trigger correct and idempotent either way.

const MAX_CHILDREN = 4;

// A matcher is either a plain substring (current behavior) or a RegExp --
// use RegExp for short/generic words (like "age") that could otherwise
// false-match inside unrelated labels (e.g. "age" inside "encourage").
function labelMatches(label, m) {
  if (m instanceof RegExp) return m.test(label);
  return label.includes(m);
}

function getField(fields, matchers) {
  for (const m of matchers) {
    const f = fields.find(
      (fd) => fd.label && labelMatches(fd.label.toLowerCase(), m)
    );
    if (f) return f;
  }
  return null;
}

// Same idea as getField, but scoped to one child's block of questions.
// Child 1 matches the plain (unsuffixed) label; child 2+ matches only
// labels carrying that child's "(Child N)" marker.
function getChildField(fields, matchers, childIndex) {
  const marker = childIndex > 1 ? `child ${childIndex}` : null;
  for (const m of matchers) {
    const f = fields.find((fd) => {
      if (!fd.label) return false;
      const label = fd.label.toLowerCase();
      if (!labelMatches(label, m)) return false;
      const hasChildMarker = /\(child\s*\d+\)/.test(label);
      return marker ? label.includes(marker) : !hasChildMarker;
    });
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
  return 'America/Chicago'; // "Other" or unrecognized
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

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDeliveryTime(time24) {
  if (!time24) return 'this evening';
  const [hStr, mStr] = time24.split(':');
  let h = parseInt(hStr, 10);
  if (!Number.isFinite(h)) return 'this evening';
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr || '00'} ${ampm}`;
}

function timezoneLabel(tz) {
  const map = {
    'America/New_York': 'Eastern',
    'America/Chicago': 'Central',
    'America/Denver': 'Mountain',
    'America/Los_Angeles': 'Pacific',
  };
  return map[tz] || '';
}

// "Emma" / "Emma and Jack" / "Emma, Jack, and Sam"
function joinNames(names) {
  const clean = (names || []).filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

// Bethae-branded welcome/thank-you email, sent right after a Tally
// submission is synced to Supabase. Reuses the site's Cranberry/Amber
// palette and "Little moments. Lasting connection." motto. One combined
// email per family submission, naming every kid on this signup.
function buildWelcomeEmailHtml({ childNames, deliveryTime, timezone }) {
  const names = (childNames || []).filter(Boolean);
  const isMultiple = names.length > 1;
  const nameList = escapeHtml(joinNames(names) || 'your child');
  const possessive = isMultiple ? 'their' : `${nameList}'s`;
  const pronounVerb = isMultiple ? "they'll" : "it'll";
  const pronounLoves = isMultiple ? 'they love' : `${nameList} loves`;
  const storyWord = isMultiple ? 'stories' : 'story';
  const timeLabel = escapeHtml(deliveryTime);
  const tzLabel = timezone ? ` ${escapeHtml(timezone)}` : '';
  return `
<div style="background:#FFF8F2;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2B2230;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(43,34,48,0.06);">
    <div style="background:#E0567A;background:linear-gradient(135deg,#E0567A,#C43D60);padding:32px 32px 24px;text-align:center;">
      <img src="https://www.bethae.com/favicon-192x192.png" width="56" height="56" alt="Bethae" style="border-radius:50%;display:block;margin:0 auto 12px;border:0;">
      <div style="color:#FFF8F2;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;">Bethae</div>
    </div>
    <div style="padding:32px;">
      <h1 style="font-size:20px;margin:0 0 16px;color:#2B2230;">Welcome to Bethae!</h1>
      <p style="font-size:15px;line-height:1.6;color:#5C5260;margin:0 0 16px;">
        Thank you for signing up to test Bethae with ${nameList}. We're so glad you're here.
      </p>
      <p style="font-size:15px;line-height:1.6;color:#5C5260;margin:0 0 16px;">
        Here's what happens next: we're writing ${possessive} first personalized ${storyWord} now, and ${pronounVerb} land right in this inbox before bedtime &mdash; around ${timeLabel}${tzLabel}. Each story is built around the things ${pronounLoves}, so keep an eye out for some familiar favorites.
      </p>
      <p style="font-size:15px;line-height:1.6;color:#5C5260;margin:0 0 16px;">
        We're still early in testing this, so if a story ever misses the mark, just reply to this email &mdash; we read every note.
      </p>
      <div style="border-top:1px solid #F5A94E;margin:24px 0;"></div>
      <p style="font-family:Georgia,'Times New Roman',serif;font-style:italic;color:#C43D60;font-size:16px;text-align:center;margin:0;">
        Little moments. Lasting connection.
      </p>
    </div>
  </div>
  <p style="text-align:center;color:#5C5260;font-size:12px;margin-top:20px;">Bethae &middot; stories@bethae.com</p>
</div>`;
}

// Fire-and-log: a Resend failure here should never block the Supabase sync
// or cause Tally to retry. Returns the Resend message id, or null if the
// email wasn't sent (env vars missing, or Resend returned an error).
// childNames: array of one or more kid first names from this submission.
async function sendWelcomeEmail(toEmail, childNames, deliveryTime, timezone) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || 'Bethae <stories@bethae.com>';
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set in Vercel env vars -- welcome email NOT sent.', { toEmail });
    return null;
  }
  const names = (childNames || []).filter(Boolean);
  const isMultiple = names.length > 1;
  const nameList = joinNames(names);
  const html = buildWelcomeEmailHtml({
    childNames: names,
    deliveryTime: formatDeliveryTime(deliveryTime),
    timezone: timezoneLabel(timezone),
  });
  const subjectPossessive = nameList ? `${nameList}'s` : "your child's";
  const subjectTail = isMultiple ? 'first stories are on their way' : 'first story is on its way';
  const subject = `Welcome to Bethae — ${subjectPossessive} ${subjectTail}`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [toEmail], subject, html }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('Welcome email send failed:', res.status, text);
      return null;
    }
    const data = await res.json();
    return data.id || null;
  } catch (err) {
    console.error('Welcome email error (non-fatal):', err);
    return null;
  }
}

async function upsertFamily(supabaseUrl, serviceKey, familyData) {
  const res = await fetch(`${supabaseUrl}/rest/v1/families?on_conflict=email`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([familyData]),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase family upsert failed: ${res.status} ${text}`);
  }
  const rows = await res.json();
  return rows[0];
}

// Inserts one or more children in a single request (one row per kid on
// this submission, all sharing the same family_id already merged in).
async function insertChildren(supabaseUrl, serviceKey, childDataArray) {
  const res = await fetch(`${supabaseUrl}/rest/v1/children`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(childDataArray),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase children insert failed: ${res.status} ${text}`);
  }
  return await res.json();
}

// Idempotently marks onboarding complete: only writes onboarding_completed_at
// if it is currently null. Returns true ONLY if THIS call is the one that
// actually set it (i.e. it was previously unset) -- that return value is
// what gates whether we fire the one-time automated first-story dispatch
// below, so a retried webhook call or duplicate Tally submission for the
// same family can never trigger it twice.
async function markOnboardingComplete(supabaseUrl, serviceKey, familyId) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/families?id=eq.${familyId}&onboarding_completed_at=is.null`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ onboarding_completed_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    console.error('markOnboardingComplete failed (non-fatal):', res.status, text);
    return false;
  }
  const rows = await res.json();
  return rows.length > 0;
}

// Fire-and-log: dispatches the `onboard` GitHub Actions workflow, which runs
// `generate_and_send.py onboard --family <email>` (generate immediately,
// send immediately if it clears the gate, no local-time-of-day wait). A
// dispatch failure here never blocks the webhook's response to Tally --
// worst case, the family still gets their first story via the existing
// manual `generate --now --family` stopgap.
async function triggerOnboardingGeneration(email) {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO || 'kjmbuildco-cloud/bedtime-stories';
  if (!token) {
    console.error(
      'GH_DISPATCH_TOKEN not set -- skipping automatic first-story dispatch for',
      email,
      `. Fix: add a GitHub PAT (Actions:write on ${repo}) as GH_DISPATCH_TOKEN in ` +
        'Vercel env vars. Until then, first stories still need the manual ' +
        '"generate --now --family" workflow_dispatch stopgap.'
    );
    return;
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/onboard.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { family: email } }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error('Onboarding workflow dispatch failed (non-fatal):', res.status, text);
      return;
    }
    console.log('Dispatched onboard.yml workflow for', email);
  } catch (err) {
    console.error('Onboarding workflow dispatch error (non-fatal):', err);
  }
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
    const lengthField = getField(fields, ['read-aloud length', 'read aloud length']);
    // "Values you'd love..." is one shared family-level question (like story
    // style and read-aloud length), not duplicated per child in the form --
    // applied to every kid on this submission.
    const valuesField = getField(fields, ['values you']);
    const sharedValuesFocus = splitList(fieldValueText(valuesField));

    const email = fieldValueText(emailField);
    if (!email) {
      console.error('Tally webhook: no email found on submission', submissionId);
      return res.status(200).json({ ok: false, reason: 'no email field found' });
    }

    const familyData = {
      email,
      timezone: mapTimezone(fieldValueText(tzField)),
      delivery_time: mapDeliveryTime(fieldValueText(timeField)),
      sibling_mode: mapSiblingMode(fieldValueText(siblingField)),
    };

    // Walk child slots 1..MAX_CHILDREN. Child 1 always produces a row
    // (defaulting to "Unknown" if the name is somehow missing, matching
    // the original single-child behavior). Slots 2+ are only included if
    // that slot's name field was actually answered -- an empty slot means
    // this family didn't use it, not an error.
    const children = [];
    for (let i = 1; i <= MAX_CHILDREN; i++) {
      const name = fieldValueText(getChildField(fields, ['first name'], i));
      if (!name && i > 1) continue;
      if (!name && i === 1) {
        console.error('Tally webhook: no child name found on submission (child 1)', { email, submissionId });
      }

      const ageRaw = fieldValueText(getChildField(fields, [/\bage\b/i], i));
      const ageParsed = ageRaw ? parseInt(ageRaw, 10) : NaN;
      if (!Number.isFinite(ageParsed)) {
        console.error(`Tally webhook: age missing/unparseable for child ${i}, defaulted to 6. Check this submission manually.`, { email, submissionId, ageRaw });
      }

      const genderVal = fieldValueText(getChildField(fields, ['gender'], i));

      children.push({
        name: name || 'Unknown',
        age: Number.isFinite(ageParsed) ? ageParsed : 6,
        gender: genderVal ? genderVal.toLowerCase() : null,
        interests: splitList(fieldValueText(getChildField(fields, ['favorite things'], i))),
        avoid_list: splitList(fieldValueText(getChildField(fields, ['keep out'], i))),
        include_people: splitList(fieldValueText(getChildField(fields, ['people or pets'], i))),
        values_focus: sharedValuesFocus,
        bible_option: false,
        mode: mapMode(fieldValueText(styleField)),
        length_minutes: mapLength(fieldValueText(lengthField)),
      });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.error(
        'SUPABASE_URL / SUPABASE_SERVICE_KEY not set in Vercel env vars -- submission NOT written to Supabase yet.',
        { email, submissionId }
      );
      return res.status(200).json({ ok: false, reason: 'supabase env vars not configured' });
    }

    const family = await upsertFamily(SUPABASE_URL, SUPABASE_SERVICE_KEY, familyData);
    const insertedChildren = await insertChildren(
      SUPABASE_URL,
      SUPABASE_SERVICE_KEY,
      children.map((c) => ({ ...c, family_id: family.id }))
    );

    console.log('Tally submission synced to Supabase', {
      submissionId,
      family_id: family.id,
      child_ids: insertedChildren.map((c) => c.id),
      child_count: insertedChildren.length,
      email,
    });

    // Onboarding is complete once family + at least one child both exist --
    // true right here, atomically, on this form's single-submission path.
    // markOnboardingComplete only returns true the first time this fires
    // for a given family, so the dispatch below is safe even if Tally (or
    // a client retry) calls this webhook more than once for the same email.
    let onboardingJustCompleted = false;
    if (insertedChildren.length > 0) {
      onboardingJustCompleted = await markOnboardingComplete(
        SUPABASE_URL,
        SUPABASE_SERVICE_KEY,
        family.id
      );
    }
    if (onboardingJustCompleted) {
      await triggerOnboardingGeneration(email);
    }

    const welcomeEmailId = await sendWelcomeEmail(
      email,
      children.map((c) => c.name),
      familyData.delivery_time,
      familyData.timezone
    );
    if (welcomeEmailId) {
      console.log('Welcome email sent', { email, welcomeEmailId });
    }

    return res.status(200).json({
      ok: true,
      family_id: family.id,
      child_ids: insertedChildren.map((c) => c.id),
      onboarding_just_completed: onboardingJustCompleted,
      welcome_email_id: welcomeEmailId,
    });
  } catch (err) {
    console.error('Tally webhook error:', err);
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
