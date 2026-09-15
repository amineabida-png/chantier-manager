const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const ORGS_TABLE = 'chantier_manager_orgs';
const STATE_TABLE = 'chantier_manager_state';
const USERS_TABLE = 'chantier_manager_users';
const AUDIT_TABLE = 'chantier_manager_audit_log';
const COUNTERS_TABLE = 'chantier_manager_counters';
const LEGACY_ROW_ID = 'main';
const SESSION_SECRET = process.env.SESSION_SECRET;
const ROLES = ['admin', 'comptable', 'chef_chantier'];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — cannot start without a database connection.');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET is not set — cannot start without a session signing secret.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ===================== SCHEMA ===================== */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${ORGS_TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE ${USERS_TABLE} ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES ${ORGS_TABLE}(id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
      id SERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      username TEXT,
      name TEXT,
      summary TEXT NOT NULL
    )
  `);
  await pool.query(`ALTER TABLE ${AUDIT_TABLE} ADD COLUMN IF NOT EXISTS org_id TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${COUNTERS_TABLE} (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function newUid() {
  return 'usr_' + crypto.randomBytes(12).toString('hex');
}
function newOrgId() {
  return 'org_' + crypto.randomBytes(12).toString('hex');
}

/* ===================== MIGRATION VERS LE MULTI-TENANT =====================
   Historiquement l'application était mono-tenant : une seule ligne d'état
   (id='main'), pas de notion d'organisation. Cette migration, idempotente,
   rattache les données/comptes existants à une organisation créée pour
   l'occasion, la première fois qu'elle rencontre des comptes sans org_id. */
async function migrateToMultiTenant() {
  const orphans = await pool.query(`SELECT id, username FROM ${USERS_TABLE} WHERE org_id IS NULL`);
  if (orphans.rows.length === 0) return;

  const stateR = await pool.query(`SELECT data FROM ${STATE_TABLE} WHERE id = $1`, [LEGACY_ROW_ID]);
  const legacyData = stateR.rows.length ? stateR.rows[0].data : null;
  const orgName = (legacyData && legacyData.settings && legacyData.settings.company && legacyData.settings.company.name)
    || 'Organisation principale';

  const orgId = newOrgId();
  await pool.query(`INSERT INTO ${ORGS_TABLE} (id, name) VALUES ($1, $2)`, [orgId, orgName]);

  await pool.query(`UPDATE ${USERS_TABLE} SET org_id = $1 WHERE org_id IS NULL`, [orgId]);
  await pool.query(`UPDATE ${AUDIT_TABLE} SET org_id = $1 WHERE org_id IS NULL`, [orgId]);

  if (stateR.rows.length) {
    await pool.query(
      `INSERT INTO ${STATE_TABLE} (id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET data = $2`,
      [orgId, legacyData]
    );
    await pool.query(`DELETE FROM ${STATE_TABLE} WHERE id = $1`, [LEGACY_ROW_ID]);
  }

  const counters = await pool.query(`SELECT name, value FROM ${COUNTERS_TABLE} WHERE name NOT LIKE '%:%'`);
  for (const row of counters.rows) {
    await pool.query(
      `INSERT INTO ${COUNTERS_TABLE} (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = ${COUNTERS_TABLE}.value + EXCLUDED.value`,
      [`${orgId}:${row.name}`, row.value]
    );
    await pool.query(`DELETE FROM ${COUNTERS_TABLE} WHERE name = $1`, [row.name]);
  }

  console.log(`Migration multi-tenant : ${orphans.rows.length} compte(s) rattaché(s) à l'organisation "${orgName}" (${orgId})`);
}

async function seedInitialAdmin() {
  const r = await pool.query(`SELECT count(*)::int AS n FROM ${USERS_TABLE}`);
  if (r.rows[0].n > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn('Aucun utilisateur et ADMIN_PASSWORD absent — aucun compte admin créé. Définissez ADMIN_USERNAME/ADMIN_PASSWORD et redéployez.');
    return;
  }
  const orgId = newOrgId();
  await pool.query(`INSERT INTO ${ORGS_TABLE} (id, name) VALUES ($1, $2)`, [orgId, 'Organisation principale']);
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO ${USERS_TABLE} (id, username, password_hash, name, role, org_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [newUid(), username, hash, 'Administrateur', 'admin', orgId]
  );
  console.log(`Compte admin initial créé : ${username}`);
}

/* ===================== SESSION (cookie signé, sans stockage serveur) ===================== */
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

/* ===================== PROTECTION ANTI-BRUTEFORCE (mémoire) ===================== */
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function isLocked(username) {
  const a = loginAttempts.get(username);
  return !!(a && a.lockedUntil && a.lockedUntil > Date.now());
}
function registerFailure(username) {
  const a = loginAttempts.get(username) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  loginAttempts.set(username, a);
}
function registerSuccess(username) {
  loginAttempts.delete(username);
}

/* ===================== MIDDLEWARES AUTH ===================== */
function requireAuth(req, res, next) {
  const payload = verifySession(req.cookies && req.cookies.session);
  if (!payload) return res.status(401).json({ error: 'unauthorized' });
  req.user = payload;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

/* ===================== JOURNAL D'AUDIT ===================== */
const AUDIT_COLLECTIONS = ['clients', 'projects', 'quotes', 'invoices', 'expenses', 'employees', 'materials', 'situations', 'documents', 'journal'];
function summarizeDiff(oldData, newData) {
  const parts = [];
  AUDIT_COLLECTIONS.forEach((c) => {
    const oldArr = (oldData && Array.isArray(oldData[c])) ? oldData[c] : [];
    const newArr = (newData && Array.isArray(newData[c])) ? newData[c] : [];
    const oldById = new Map(oldArr.map((x) => [x.id, x]));
    const newIds = new Set(newArr.map((x) => x.id));
    let added = 0, removed = 0, modified = 0;
    newArr.forEach((x) => {
      const prevItem = oldById.get(x.id);
      if (!prevItem) added++;
      else if (JSON.stringify(prevItem) !== JSON.stringify(x)) modified++;
    });
    oldArr.forEach((x) => { if (!newIds.has(x.id)) removed++; });
    if (added || removed || modified) {
      const bits = [];
      if (added) bits.push(`+${added}`);
      if (removed) bits.push(`-${removed}`);
      if (modified) bits.push(`~${modified}`);
      parts.push(`${c} (${bits.join('/')})`);
    }
  });
  if (oldData && newData && JSON.stringify(oldData.settings) !== JSON.stringify(newData.settings)) {
    parts.push('paramètres');
  }
  return parts.length ? parts.join(', ') : null;
}
async function logAudit(user, summary) {
  await pool.query(
    `INSERT INTO ${AUDIT_TABLE} (username, name, summary) VALUES ($1,$2,$3)`,
    [user ? user.username : null, user ? user.name : null, summary]
  );
}

/* ===================== APP ===================== */
const app = express();
app.use(express.json({ limit: '20mb' })); // documents/photos en base64
app.use(cookieParser());

const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: true, maxAge: SESSION_MAX_AGE_MS };

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---- Authentification ---- */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis.' });
  if (isLocked(username)) return res.status(429).json({ error: 'Trop de tentatives échouées. Réessayez dans quelques minutes.' });
  try {
    const r = await pool.query(`SELECT * FROM ${USERS_TABLE} WHERE username = $1`, [username]);
    const u = r.rows[0];
    const ok = u && await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      registerFailure(username);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    registerSuccess(username);
    const payload = { id: u.id, username: u.username, name: u.name, role: u.role, orgId: u.org_id, exp: Date.now() + SESSION_MAX_AGE_MS };
    res.cookie('session', signSession(payload), COOKIE_OPTS);
    await logAudit(payload, 'Connexion');
    res.json({ user: { id: u.id, username: u.username, name: u.name, role: u.role } });
  } catch (e) {
    console.error('Erreur de connexion:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ---- Inscription : crée une nouvelle organisation + son premier compte admin ---- */
app.post('/api/auth/signup', async (req, res) => {
  const { orgName, username, password, name } = req.body || {};
  if (!orgName || !username || !password || !name) {
    return res.status(400).json({ error: 'Tous les champs sont requis.' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (4 caractères minimum).' });
  try {
    const orgId = newOrgId();
    await pool.query(`INSERT INTO ${ORGS_TABLE} (id, name) VALUES ($1, $2)`, [orgId, orgName]);
    const hash = await bcrypt.hash(password, 10);
    const userId = newUid();
    await pool.query(
      `INSERT INTO ${USERS_TABLE} (id, username, password_hash, name, role, org_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, username, hash, name, 'admin', orgId]
    );
    const payload = { id: userId, username, name, role: 'admin', orgId, exp: Date.now() + SESSION_MAX_AGE_MS };
    res.cookie('session', signSession(payload), COOKIE_OPTS);
    await logAudit(payload, `Création de l'organisation "${orgName}"`);
    res.json({ user: { id: userId, username, name, role: 'admin' } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Cet identifiant existe déjà.' });
    console.error('Erreur d\'inscription:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session', COOKIE_OPTS);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username, name: req.user.name, role: req.user.role } });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Mot de passe invalide (4 caractères minimum).' });
  }
  try {
    const r = await pool.query(`SELECT * FROM ${USERS_TABLE} WHERE id = $1`, [req.user.id]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(oldPassword, u.password_hash))) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE ${USERS_TABLE} SET password_hash = $1 WHERE id = $2`, [hash, u.id]);
    await logAudit(req.user, 'Changement de mot de passe');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---- Gestion des comptes (admin uniquement, scopé à l'organisation) ---- */
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, username, name, role, created_at FROM ${USERS_TABLE} WHERE org_id = $1 ORDER BY created_at ASC`,
    [req.user.orgId]
  );
  res.json({ users: r.rows });
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password || !name || !ROLES.includes(role)) {
    return res.status(400).json({ error: 'Champs invalides.' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (4 caractères minimum).' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const id = newUid();
    await pool.query(
      `INSERT INTO ${USERS_TABLE} (id, username, password_hash, name, role, org_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, username, hash, name, role, req.user.orgId]
    );
    await logAudit(req.user, `Création du compte "${username}" (${role})`);
    res.json({ id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Cet identifiant existe déjà.' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const countR = await pool.query(
      `SELECT count(*)::int AS n FROM ${USERS_TABLE} WHERE role = 'admin' AND org_id = $1`,
      [req.user.orgId]
    );
    const target = await pool.query(
      `SELECT username, role FROM ${USERS_TABLE} WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.orgId]
    );
    if (!target.rows.length) return res.status(404).json({ error: 'Compte introuvable.' });
    if (target.rows[0].role === 'admin' && countR.rows[0].n <= 1) {
      return res.status(400).json({ error: 'Impossible de supprimer le dernier compte administrateur.' });
    }
    await pool.query(`DELETE FROM ${USERS_TABLE} WHERE id = $1 AND org_id = $2`, [req.params.id, req.user.orgId]);
    await logAudit(req.user, `Suppression du compte "${target.rows[0].username}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---- Journal d'audit (admin uniquement, scopé à l'organisation) ---- */
app.get('/api/audit', requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  const r = await pool.query(
    `SELECT id, at, username, name, summary FROM ${AUDIT_TABLE} WHERE org_id = $1 ORDER BY at DESC LIMIT $2`,
    [req.user.orgId, limit]
  );
  res.json({ entries: r.rows });
});

/* ---- Numérotation séquentielle atomique (devis / factures), scopée à l'organisation ---- */
app.get('/api/next-number', requireAuth, async (req, res) => {
  const prefixes = { quote: 'DEV', invoice: 'FAC' };
  const prefix = prefixes[req.query.type];
  if (!prefix) return res.status(400).json({ error: 'type invalide' });
  const year = new Date().getFullYear();
  const key = req.user.orgId + ':' + req.query.type + '-' + year;
  try {
    const r = await pool.query(
      `INSERT INTO ${COUNTERS_TABLE} (name, value) VALUES ($1, 1)
       ON CONFLICT (name) DO UPDATE SET value = ${COUNTERS_TABLE}.value + 1
       RETURNING value`,
      [key]
    );
    const n = r.rows[0].value;
    res.json({ number: `${prefix}-${year}-${String(n).padStart(4, '0')}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---- État de l'application ---- */
const CHEF_CHANTIER_HIDDEN = ['clients', 'quotes', 'invoices', 'expenses', 'situations'];
function redactForRole(role, data) {
  if (role !== 'chef_chantier' || !data) return data;
  const redacted = Object.assign({}, data);
  CHEF_CHANTIER_HIDDEN.forEach((key) => { if (Array.isArray(redacted[key])) redacted[key] = []; });
  return redacted;
}
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT data FROM ${STATE_TABLE} WHERE id = $1`, [req.user.orgId]);
    const data = r.rows.length ? r.rows[0].data : null;
    res.json({ data: redactForRole(req.user.role, data) });
  } catch (e) {
    console.error('Erreur de lecture:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Le chef de chantier n'a, côté UI, accès qu'à ces collections. L'état étant sauvegardé
// en un seul bloc JSON, on protège ici les autres collections contre toute écriture
// (accidentelle ou via un client modifié / la console du navigateur) en réappliquant
// systématiquement les valeurs déjà en base pour tout ce qui n'est pas autorisé à ce rôle.
const CHEF_CHANTIER_WRITABLE = ['projects', 'materials', 'employees', 'documents', 'journal'];
function restrictForRole(role, incoming, previous) {
  if (role !== 'chef_chantier') return incoming;
  const safe = Object.assign({}, incoming);
  Object.keys(previous || {}).forEach((key) => {
    if (!CHEF_CHANTIER_WRITABLE.includes(key)) safe[key] = previous[key];
  });
  return safe;
}
async function saveState(req, res) {
  try {
    let data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'invalid body' });
    const prev = await pool.query(`SELECT data FROM ${STATE_TABLE} WHERE id = $1`, [req.user.orgId]);
    const prevData = prev.rows[0] && prev.rows[0].data;
    data = restrictForRole(req.user.role, data, prevData);
    await pool.query(
      `INSERT INTO ${STATE_TABLE} (id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`,
      [req.user.orgId, data]
    );
    const summary = summarizeDiff(prevData, data);
    if (summary) await logAudit(req.user, summary);
    res.json({ ok: true });
  } catch (e) {
    console.error('Erreur de sauvegarde:', e.message);
    res.status(500).json({ error: e.message });
  }
}
app.put('/api/state', requireAuth, saveState);
app.post('/api/state', requireAuth, saveState); // alias pour navigator.sendBeacon (POST uniquement) à la fermeture de l'onglet

/* ---- Fichiers statiques ---- */
app.use(express.static(ROOT));
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

if (require.main === module) {
  ensureSchema()
    .then(migrateToMultiTenant)
    .then(seedInitialAdmin)
    .then(() => {
      app.listen(PORT, () => console.log('CHANTIER MANAGER listening on port ' + PORT + ' (PostgreSQL connected)'));
    })
    .catch((e) => {
      console.error('Échec d\'initialisation:', e.message);
      process.exit(1);
    });
}

module.exports = {
  app, pool, ensureSchema, migrateToMultiTenant, seedInitialAdmin,
  ORGS_TABLE, STATE_TABLE, USERS_TABLE, AUDIT_TABLE, COUNTERS_TABLE, LEGACY_ROW_ID,
};
