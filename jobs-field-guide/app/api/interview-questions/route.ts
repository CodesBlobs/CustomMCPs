import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { generateInterviewQuestions } from "@/lib/ollama";
import jobsData from "@/data/jobs.json";
import type { Job } from "@/lib/types";

const jobs = jobsData as Job[];

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const jobKey = body?.job_key;

  if (typeof jobKey !== "string" || !jobKey) {
    return NextResponse.json({ error: "job_key is required." }, { status: 400 });
  }

  const job = jobs.find((j) => j.job_key === jobKey);
  if (!job) {
    return NextResponse.json({ error: "Unknown job_key." }, { status: 404 });
  }

  try {
    const cached = await sql`SELECT questions FROM interview_questions WHERE job_key = ${jobKey}`;
    if (cached.length > 0) {
      return NextResponse.json({ questions: cached[0].questions, source: "cache" });
    }

    const questions = await generateInterviewQuestions(job);

    await sql`
      INSERT INTO interview_questions (job_key, job_title, company, questions)
      VALUES (${job.job_key}, ${job.title}, ${job.company}, ${JSON.stringify(questions)}::jsonb)
      ON CONFLICT (job_key) DO UPDATE SET questions = EXCLUDED.questions
    `;

    return NextResponse.json({ questions, source: "generated" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate interview questions.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
