const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TABLE = 'chantier_manager_state';
const ROW_ID = 'main';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — cannot start without a database connection.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function saveState(req, res) {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    await pool.query(
      `INSERT INTO ${TABLE} (id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`,
      [ROW_ID, data]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Erreur de sauvegarde:', e.message);
    res.status(500).json({ error: e.message });
  }
}

const app = express();
app.use(express.json({ limit: '20mb' })); // les documents/photos en base64 peuvent être volumineux

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const r = await pool.query(`SELECT data FROM ${TABLE} WHERE id = $1`, [ROW_ID]);
    res.json({ data: r.rows.length ? r.rows[0].data : null });
  } catch (e) {
    console.error('Erreur de lecture:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/state', saveState);
app.post('/api/state', saveState); // alias utilisé par navigator.sendBeacon (POST uniquement) à la fermeture de l'onglet

app.use(express.static(ROOT));
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

ensureTable()
  .then(() => {
    app.listen(PORT, () => console.log('CHANTIER MANAGER listening on port ' + PORT + ' (PostgreSQL connected)'));
  })
  .catch((e) => {
    console.error('Échec d\'initialisation de la base de données:', e.message);
    process.exit(1);
  });
