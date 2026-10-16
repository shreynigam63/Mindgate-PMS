// The client's name and logo (16 Oct, from QA: "MGS Name & Logo is missing
// on Login Page & Dashboard"). Shown beside "Agentic PMS" on the sign-in
// page and in the top bar; set by HR on Settings → Company branding.
//
// GET is public because the sign-in page shows it before anyone signs in.
// It carries nothing but the name and the picture HR chose to show.
//
// The logo is kept as a data URL in core.admin_settings ('brand'): one row,
// in the one backup, at most ~300 KB. PNG, JPEG, WEBP or SVG. An SVG is only
// ever drawn through <img>, where a browser runs no script in it.
const db = require('./db');
const logger = require('./logger');
const { holdsPermission } = require('./permissions');

const KEY = 'brand';
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_LOGO = 300 * 1024;

async function brandOf(tenantId) {
  const row = (await db.query(`SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key=$2`, [tenantId, KEY])).rows[0];
  const v = (row && row.value) || {};
  return { name: v.name || null, logo: v.logo || null };
}

async function getBrand(req, res) {
  try {
    res.set('Cache-Control', 'no-cache');
    res.json(await brandOf(req.tenantId));
  } catch (e) {
    logger.warn('brand read failed', { error: e.message });
    res.json({ name: null, logo: null });
  }
}

// PUT {name?, logo?}: logo is a data URL, or null to remove it.
async function putBrand(req, res) {
  try {
    const hr = (await holdsPermission(req.user, 'pms_admin')) || (await holdsPermission(req.user, 'people_admin'));
    if (!hr) return res.status(403).json({ error: 'Only HR changes the company branding.', needs: 'pms_admin' });
    const b = req.body || {};
    const cur = await brandOf(req.user.tenant_id);
    const next = { ...cur };
    if (b.name !== undefined) next.name = String(b.name || '').trim().slice(0, 80) || null;
    if (b.logo !== undefined) {
      if (b.logo === null || b.logo === '') next.logo = null;
      else {
        const m = String(b.logo).match(/^data:([a-z+/]+);base64,([A-Za-z0-9+/=]+)$/);
        if (!m || !TYPES.includes(m[1])) return res.status(422).json({ error: 'The logo must be a PNG, JPG, WEBP or SVG image.' });
        if (Math.floor(m[2].length * 3 / 4) > MAX_LOGO) return res.status(422).json({ error: 'The logo must be 300 KB or smaller.' });
        next.logo = b.logo;
      }
    }
    await db.query(
      `INSERT INTO core.admin_settings (tenant_id, key, value, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [req.user.tenant_id, KEY, JSON.stringify(next)]);
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details) VALUES ($1,$2,'BRAND_UPDATED','tenant',$1,$3)`,
      [req.user.tenant_id, req.user.email, JSON.stringify({ name: next.name, logo: next.logo ? 'set' : null })]).catch(() => {});
    res.json({ ok: true, ...next });
  } catch (e) {
    logger.error('brand save failed', { error: e.message });
    res.status(500).json({ error: 'Could not save the branding.' });
  }
}

module.exports = { getBrand, putBrand, brandOf };
