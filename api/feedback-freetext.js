// Bethae -- optional free-text note on a dislike reason -> Supabase
// POST /api/feedback-freetext   body: reason_id, note
//
// Reuses SUPABASE_URL / SUPABASE_SERVICE_KEY -- no new secrets needed.

async function updateNote(supabaseUrl, serviceKey, reasonId, note) {
  const res = await fetch(
    supabaseUrl + '/rest/v1/story_feedback_reasons?id=eq.' + encodeURIComponent(reasonId),
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ note: note }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase note update failed: ' + res.status + ' ' + text);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(302, { Location: '/feedback-error.html?reason=bad_method' });
    return res.end();
  }

  const body = req.body || {};
  const reason_id = body.reason_id;
  const note = (body.note || '').toString().trim();

  if (!reason_id) {
    res.writeHead(302, { Location: '/feedback-error.html?reason=bad_params' });
    return res.end();
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (note.length > 0 && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      await updateNote(SUPABASE_URL, SUPABASE_SERVICE_KEY, reason_id, note);
    } catch (err) {
      console.error('freetext note update failed', err);
    }
  }

  res.writeHead(302, { Location: '/feedback-thanks.html?final=1' });
  return res.end();
};
