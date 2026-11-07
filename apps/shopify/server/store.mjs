import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

// One connector process/replica per database. Leases also prevent concurrent requests in that process.
export class Store {
  constructor(path, key) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.key = key;
    this.owner = randomUUID();
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations (
        key TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
        tendr_id TEXT, done INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
        lease_owner TEXT, lease_until INTEGER, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operations_pending ON operations(done, updated);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
    // Detect an incorrect encryption key before accepting any traffic.
    if (!this.get('key-check')) this.set('key-check', { ok: true });
    // Bearer return tokens must not appear in plaintext indexes or backups.
    if (this.db.prepare('PRAGMA user_version').get().user_version < 1) {
      for (const row of this.db.prepare('SELECT key,payload FROM operations').all()) {
        this.db
          .prepare('UPDATE operations SET token=? WHERE key=?')
          .run(this.tokenHash(this.open(row.payload).token), row.key);
      }
      this.db.exec('PRAGMA user_version=1');
    }
  }
  tokenHash(token) {
    return createHash('sha256').update(String(token)).digest('hex');
  }
  seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open(value) {
    const bytes = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
    );
  }
  get(key) {
    const row = this.db.prepare('SELECT payload FROM settings WHERE key=?').get(key);
    return row ? this.open(row.payload) : null;
  }
  set(key, value) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',
      )
      .run(key, this.seal(value));
  }
  delete(key) {
    this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
  }
  operation(key) {
    const row = this.db.prepare('SELECT payload FROM operations WHERE key=?').get(key);
    return row ? this.open(row.payload) : null;
  }
  byToken(token) {
    const row = this.db
      .prepare('SELECT payload FROM operations WHERE token=?')
      .get(this.tokenHash(token));
    return row ? this.open(row.payload) : null;
  }
  insert(op) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO operations(key,token,kind,updated,payload) VALUES (?,?,?,?,?)',
      )
      .run(op.key, this.tokenHash(op.token), op.kind, Date.now(), this.seal(op));
    return this.operation(op.key);
  }
  save(op) {
    this.db
      .prepare('UPDATE operations SET tendr_id=?,done=?,updated=?,payload=? WHERE key=?')
      .run(op.tendrId || null, op.done || op.review ? 1 : 0, Date.now(), this.seal(op), op.key);
  }
  claim(key) {
    return (
      this.db
        .prepare(
          'UPDATE operations SET lease_owner=?,lease_until=? WHERE key=? AND (lease_until IS NULL OR lease_until < ?)',
        )
        .run(this.owner, Date.now() + 120_000, key, Date.now()).changes === 1
    );
  }
  release(key) {
    this.db
      .prepare(
        'UPDATE operations SET lease_owner=NULL,lease_until=NULL WHERE key=? AND lease_owner=?',
      )
      .run(key, this.owner);
  }
  list({ pending = false, limit = 100 } = {}) {
    return this.db
      .prepare(
        `SELECT payload FROM operations ${pending ? 'WHERE done=0' : ''} ORDER BY updated ASC LIMIT ?`,
      )
      .all(limit)
      .map((row) => this.open(row.payload));
  }
  close() {
    this.db.close();
  }
}
