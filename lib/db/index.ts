// Neon HTTP-backed Drizzle client, lazily initialised so importing this module
// (e.g. during `next build` config collection) never requires DATABASE_URL.
// The connection is created on first query.

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleDb | null = null;

function init(): DrizzleDb {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Add it to .env.local (Neon connection string) and run `npm run db:push`.',
    );
  }
  const sql = neon(connectionString);
  return drizzle(sql, { schema });
}

// Proxy defers connection until a query method is actually accessed.
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    if (!_db) _db = init();
    const value = Reflect.get(_db as object, prop, receiver);
    return typeof value === 'function' ? value.bind(_db) : value;
  },
});

export { schema };
