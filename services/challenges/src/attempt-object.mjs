import { DurableObject } from 'cloudflare:workers';
import { AttemptService, RETENTION } from './attempt.mjs';

export class AttemptObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.service = new AttemptService(ctx.storage.sql, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rate (id INTEGER PRIMARY KEY, window INTEGER, count INTEGER)');
  }
  async create(id) {
    const response = await this.service.create(id);
    if (response.status === 201) await this.ctx.storage.setAlarm(Date.now() + RETENTION);
    return { status: response.status, body: await response.json() };
  }
  async read(access) {
    const response = await this.service.read(access);
    return { status: response.status, body: await response.json() };
  }
  async verify(access, data) {
    const response = await this.service.verify(access, data);
    return { status: response.status, body: await response.json() };
  }
  async allowIssue() {
    const window = Math.floor(Date.now() / 60_000);
    const row = this.ctx.storage.sql.exec(`INSERT INTO rate VALUES (1, ?, 1)
      ON CONFLICT(id) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END,
      window = excluded.window RETURNING count`, window).one();
    await this.ctx.storage.setAlarm(Date.now() + RETENTION);
    return row.count <= 10;
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
