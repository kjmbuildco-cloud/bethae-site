// Bethae -- lightweight ops view backend (2026-08-02, updated 2026-08-09).
//
// GET /api/ops/summary?key=<OPS_VIEW_SECRET>
//
// Answers the three things worth checking at a glance without opening
// Supabase directly: signups this week, family counts by status
// (active/paused/canceled), and any stories currently sitting in a
// flagged state (needs_attention / gate_failed / flagged_repeat).
// MRR is deliberately NOT included -- Stripe billing isn't built yet, so
// there's no real revenue number to show; the response says so explicitly
// instead of silently omitting it.
//
// 2026-08-09: also surfaces family counts by customer_type (tester /
// founding_tester / beta_customer / customer / etc). customer_type is a
// free-text field, not a fixed enum, so this breaks down whatever values
// actually exist rather than assuming a closed list -- new categories
// added later show up automatically with no code change needed here.
//
// Same fetch-based Supabase REST pattern as api/account/*.js (no
// @supabase/supabase-js dependency, service-role key, server-side only).
//
// Access control: this endpoint reads family emails, so it fails CLOSED,
// not open, on missing config -- unlike some of this project's other
// env-var gaps (e.g. DIGEST_EMAIL), which are designed to degrade
// gracefully because they only gate an outbound alert. A misconfigured
// secret here would otherwise mean anyone with the URL sees real
// customer data, so: no OPS_VIEW_SECRET set => always 503, never a silent
// unauthenticated read.

async function fetchFromSupabase(supabaseUrl, serviceKey, path) {
const res = await fetch(supabaseUrl + path, {
headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
});
if (!res.ok) {
const text = await res.text();
throw new Error('Supabase request failed: ' + res.status + ' ' + text);
}
return await res.json();
}

const FLAGGED_STORY_STATUSES = ['needs_attention', 'gate_failed', 'flagged_repeat'];

module.exports = async (req, res) => {
if (req.method !== 'GET') {
res.status(405).json({ ok: false, reason: 'method not allowed, use GET' });
return;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPS_VIEW_SECRET = process.env.OPS_VIEW_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPS_VIEW_SECRET) {
// Fail closed -- see note above. Also true if OPS_VIEW_SECRET was
// simply never set yet (expected until Kyle adds it in Vercel).
res.status(503).json({ ok: false, reason: 'ops view not configured' });
return;
}

const providedKey = (req.query && req.query.key) || '';
if (!providedKey || providedKey !== OPS_VIEW_SECRET) {
res.status(401).json({ ok: false, reason: 'unauthorized' });
return;
}

try {
const families = await fetchFromSupabase(
SUPABASE_URL,
SUPABASE_SERVICE_KEY,
'/rest/v1/families?select=id,email,status,customer_type,created_at'
);

const now = new Date();
const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

const familyStatusCounts = {};
const customerTypeCounts = {};
const signupsThisWeek = [];
for (const f of families) {
const st = f.status || 'unknown';
familyStatusCounts[st] = (familyStatusCounts[st] || 0) + 1;
const ct = f.customer_type || 'unknown';
customerTypeCounts[ct] = (customerTypeCounts[ct] || 0) + 1;
const created = f.created_at ? new Date(f.created_at) : null;
if (created && created >= weekAgo) {
signupsThisWeek.push({ email: f.email, created_at: f.created_at, status: f.status, customer_type: f.customer_type });
}
}
signupsThisWeek.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

const familyEmailById = {};
for (const f of families) familyEmailById[f.id] = f.email;

const statusFilter = FLAGGED_STORY_STATUSES.join(',');
const stuckStoriesRaw = await fetchFromSupabase(
SUPABASE_URL,
SUPABASE_SERVICE_KEY,
'/rest/v1/stories?status=in.(' + statusFilter + ')&select=id,family_id,deliver_on,status,created_at&order=deliver_on.desc'
);
const stuckStories = stuckStoriesRaw.map((s) => ({
story_id: s.id,
family_email: familyEmailById[s.family_id] || 'family ' + s.family_id,
deliver_on: s.deliver_on,
status: s.status,
}));

res.status(200).json({
ok: true,
generated_at: now.toISOString(),
family_status_counts: familyStatusCounts,
customer_type_counts: customerTypeCounts,
total_families: families.length,
signups_this_week: { count: signupsThisWeek.length, families: signupsThisWeek },
stuck_stories: { count: stuckStories.length, stories: stuckStories },
mrr_note: 'Not applicable yet -- Stripe billing is not built, so there is no real revenue figure to show.',
});
} catch (err) {
console.error('ops/summary error:', err);
res.status(500).json({ ok: false, error: String((err && err.message) || err) });
}
};
