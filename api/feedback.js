// Bethae -- story feedback (thumbs up/down) -> Supabase
// GET /api/feedback?story_id=&tester_id=&rating=up|down
//
// Logs a row to the Supabase `story_feedback` table via the REST API,
// then redirects to a static thank-you page. On "down", redirects into
// the reason-chip flow (see /api/feedback-reason.js).
//
// Reuses the SUPABASE_URL / SUPABASE_SERVICE_KEY env vars already
// configured for api/tally-webhook.js -- no new secrets needed.
//
// Public, unauthenticated endpoint -- acceptable for the current small
// closed tester group. To harden later: verify a `sig` query param
// (HMAC of story_id+tester_id+rating) before writing, and/or add rate
// limiting keyed on tester_id.

async function insertRow(supabaseUrl, serviceKey, table, row) {
  const res = await fetch(supabaseUrl + '/rest/v1/' + table, {
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
          throw new Error('Supabase insert into ' + table + ' failed: ' + res.status + ' ' + text);
    }
    const rows = await res.json();
    return rows[0];
}

module.exports = async (req, res) => {
    const q = req.query || {};
    const story_id = q.story_id;
    const tester_id = q.tester_id;
    const rating = q.rating;

    if (!story_id || !tester_id || (rating !== 'up' && rating !== 'down')) {
          res.writeHead(302, { Location: '/feedback-error.html?reason=bad_params' });
          return res.end();
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
          console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- feedback not logged.', { story_id, tester_id, rating });
          res.writeHead(302, { Location: '/feedback-error.html?reason=not_configured' });
          return res.end();
    }

    try {
          await insertRow(SUPABASE_URL, SUPABASE_SERVICE_KEY, 'story_feedback', {
                  story_id: String(story_id),
                  tester_id: String(tester_id),
                  rating: String(rating),
          });
    } catch (err) {
          console.error('story_feedback insert failed', err);
          res.writeHead(302, { Location: '/feedback-error.html?reason=write_failed' });
          return res.end();
    }

    if (rating === 'up') {
          res.writeHead(302, { Location: '/feedback-thanks.html?rating=up' });
          return res.end();
    }

    const params = new URLSearchParams({
          rating: 'down',
          story_id: String(story_id),
          tester_id: String(tester_id),
    });
              res.writeHead(302, { Location: '/feedback-thanks.html?' + params.toString() });
    return res.end();
};
