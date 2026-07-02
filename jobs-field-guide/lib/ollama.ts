import type { Job } from "@/lib/types";

const OLLAMA_ENDPOINT = "https://ollama.com/v1/chat/completions";
const MODEL = "gpt-oss:20b";

export async function generateInterviewQuestions(job: Job): Promise<string[]> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new Error("OLLAMA_API_KEY is not configured.");
  }

  const description = (job.description || job.snippet || "").slice(0, 2000);

  const response = await fetch(OLLAMA_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You write tailored interview questions for a job seeker preparing for a specific role. " +
            "Base the questions on concrete details from the job title, company, and description " +
            "(technologies, responsibilities, seniority, industry context) rather than generic advice. " +
            "Respond with ONLY a JSON array of exactly 4 question strings. No markdown, no preamble, no explanation.",
        },
        {
          role: "user",
          content: `Job title: ${job.title}\nCompany: ${job.company}\nDescription: ${description}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("Could not parse questions from model response.");
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed) || !parsed.every((q) => typeof q === "string")) {
    throw new Error("Model response was not a JSON array of strings.");
  }

  return parsed as string[];
}
