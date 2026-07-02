import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const jobs = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "jobs.json"), "utf8"));
const questions = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "interview_questions.json"), "utf8"));

const jobByKey = new Map(jobs.map((j) => [j.job_key, j]));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

let inserted = 0;
try {
  for (const [jobKey, qs] of Object.entries(questions)) {
    const job = jobByKey.get(jobKey);
    if (!job) {
      console.warn("No job found for key", jobKey);
      continue;
    }
    await client.query(
      `INSERT INTO interview_questions (job_key, job_title, company, questions)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (job_key) DO UPDATE SET questions = EXCLUDED.questions`,
      [jobKey, job.title, job.company, JSON.stringify(qs)],
    );
    inserted++;
  }
  console.log(`Seeded ${inserted} question sets.`);
  const { rows } = await client.query("SELECT count(*)::int AS n FROM interview_questions");
  console.log("Total rows in table:", rows[0].n);
} finally {
  client.release();
  await pool.end();
}
