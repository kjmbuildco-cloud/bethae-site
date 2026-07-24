// Bethae -- dislike-reason chip -> Supabase
// GET /api/feedback-reason?story_id=&tester_id=&reason=too_scary|not_like_kid|boring|other
//
// Fired by one of the 4 tappable reason chips shown on the "thumbs down"
// thank-you page. Logs a row to `story_feedback_reasons`, then redirects
// to a page with an optional (never required) free-text box, passing the
// new row's id through so the free-text step updates the exact row.
//
// Reuses SUPABASE_URL / SUPABASE_SERVICE_KEY -- no new secrets needed.

const VALID_REASONS = ['too_scary', 'not_like_kid', 'boring', 'other'];

async function insertReason(supabaseUrl, serviceKey, row) {
  const res = await fetch(supabaseUrl + '/rest/v1/story_feedback_reasons', {
        method: 'POST',
        headers: {
                apikey: serviceKey,
                Authorization: 'Bearer ' + serviceKey,
                'Content-Type': 'application/json',
                Prefer: 'return=representation',
        },
        body: JSON.stringify([row]),
  });
    if (!res.ok) {
          const text = await res.text();
          throw new Error('Supabase insert into story_feedback_reasons failed: ' + res.status + ' ' + text);
    }
    const rows = await res.json();
    return rows[0];
}

module.exports = async (req, res) => {
    const q = req.query || {};
    const story_id = q.story_id;
    const tester_id = q.tester_id;
    const reason = q.reason;

    if (!story_id || !tester_id || VALID_REASONS.indexOf(reason) === -1) {
          res.writeHead(302, { Location: '/feedback-error.html?reason=bad_params' });
          return res.end();
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
          console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- reason not logged.', { story_id, tester_id, reason });
          res.writeHead(302, { Location: '/feedback-error.html?reason=not_configured' });
          return res.end();
    }

    let row;
    try {
          row = await insertReason(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
                  story_id: String(story_id),
                  tester_id: String(tester_id),
                  reason: String(reason),
          });
    } catch (err) {
          console.error('story_feedback_reasons insert failed', err);
          res.writeHead(302, { Location: '/feedback-error.html?reason=write_failed' });
          return res.end();
    }

    const params = new URLSearchParams({ reason_id: String(row.id) });
    res.writeHead(302, { Location: '/feedback-thanks-reason.html?' + params.toString() });
    return res.end();
};
