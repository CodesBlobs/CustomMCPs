import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
CREATE TABLE IF NOT EXISTS interview_questions (
  id SERIAL PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  job_title TEXT NOT NULL,
  company TEXT NOT NULL,
  questions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const client = await pool.connect();
try {
  await client.query(sql);
  console.log("Migration applied: interview_questions table ready.");
  const { rows } = await client.query("SELECT count(*)::int AS n FROM interview_questions");
  console.log("Current row count:", rows[0].n);
} finally {
  client.release();
  await pool.end();
}
