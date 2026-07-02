import { neon } from "@neondatabase/serverless";

// Neon's serverless driver talks to Postgres over HTTP instead of a pooled
// TCP connection, so it works cleanly across isolated serverless function
// invocations (Vercel) without exhausting connections the way a global
// `pg.Pool` singleton can under concurrent cold starts.
export const sql = neon(process.env.DATABASE_URL!);
