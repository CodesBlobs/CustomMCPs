"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Job } from "@/lib/types";

function salaryStamp(job: Job): string | null {
  if (!job.salary_text) return null;
  return job.salary_text
    .replace(" a year", "/yr")
    .replace(" a month", "/mo")
    .replace(" an hour", "/hr");
}

type QuestionsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; questions: string[] };

export default function JobCard({ job, specimenNumber }: { job: Job; specimenNumber: number }) {
  const [open, setOpen] = useState(false);
  const [questionsState, setQuestionsState] = useState<QuestionsState>({ status: "idle" });
  const stamp = salaryStamp(job);
  const hasRating = job.company_rating !== null && job.company_rating > 0;

  async function loadQuestions() {
    if (questionsState.status === "loaded") {
      setQuestionsState({ status: "idle" });
      return;
    }
    setQuestionsState({ status: "loading" });
    try {
      const res = await fetch("/api/interview-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_key: job.job_key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to generate questions.");
      setQuestionsState({ status: "loaded", questions: data.questions });
    } catch (error) {
      setQuestionsState({
        status: "error",
        message: error instanceof Error ? error.message : "Something went wrong.",
      });
    }
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="relative rounded-sm border border-ink/15 bg-paper-2 px-4 pt-6 pb-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_10px_18px_-16px_rgba(0,0,0,0.5)] transition-[border-color,box-shadow] hover:border-brass hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_14px_26px_-16px_rgba(0,0,0,0.55)]"
    >
      <span
        aria-hidden
        className="absolute left-1/2 -top-[7px] h-3 w-3 -translate-x-1/2 rounded-full shadow-[0_2px_4px_rgba(0,0,0,0.4)]"
        style={{
          background:
            "radial-gradient(circle at 35% 30%, var(--color-brass-bright), var(--color-brass) 55%, #7a5f2a 100%)",
        }}
      />

      <div className="mb-2.5 flex items-start justify-between font-(family-name:--font-data) text-[0.68rem] text-ink-muted">
        <span>N&deg;{String(specimenNumber).padStart(3, "0")}</span>
        {job.sponsored && (
          <span className="rounded-sm border border-stamp px-1.5 py-0.5 text-[0.6rem] tracking-wide text-stamp uppercase">
            Featured
          </span>
        )}
      </div>

      <h3 className="mb-1.5 font-(family-name:--font-display) text-[1.06rem] leading-tight font-semibold text-ink">
        {job.title}
      </h3>
      <p className="mb-3 text-[0.86rem] text-ink-muted">
        {hasRating && <span className="font-semibold text-stamp">★ {job.company_rating!.toFixed(1)}</span>}
        {hasRating && " · "}
        {job.company} &mdash; {job.location || "Location n/a"}
      </p>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {job.job_types.length ? (
          job.job_types.map((t) => (
            <span
              key={t}
              className="rounded-sm bg-moss px-2 py-0.5 font-(family-name:--font-data) text-[0.62rem] tracking-wide text-paper uppercase"
            >
              {t}
            </span>
          ))
        ) : (
          <span className="rounded-sm border border-dashed border-ink-muted/50 px-2 py-0.5 font-(family-name:--font-data) text-[0.62rem] tracking-wide text-ink-muted uppercase">
            type unspecified
          </span>
        )}
      </div>

      <p className="mb-3.5 line-clamp-3 text-[0.88rem] leading-relaxed text-ink">
        {job.snippet || "No summary available."}
      </p>

      <div className="flex items-center justify-between border-t border-dashed border-ink/25 pt-3">
        <span
          className={`inline-block rounded-[3px] border-[1.5px] px-2 py-0.5 font-(family-name:--font-data) text-[0.78rem] font-semibold ${
            stamp ? "-rotate-2 border-stamp text-stamp opacity-90" : "-rotate-1 border-ink-muted/40 text-ink-muted"
          }`}
        >
          {stamp ?? "not listed"}
        </span>
        <span className="font-(family-name:--font-data) text-[0.7rem] text-ink-muted">{job.posted}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="font-(family-name:--font-data) text-[0.72rem] text-ink underline decoration-brass underline-offset-[3px] cursor-pointer"
          aria-expanded={open}
        >
          {open ? "▾ Hide full listing" : "▸ Read full listing"}
        </button>

        <button
          type="button"
          onClick={loadQuestions}
          disabled={questionsState.status === "loading"}
          className="font-(family-name:--font-data) text-[0.72rem] text-moss underline decoration-moss underline-offset-[3px] cursor-pointer disabled:cursor-wait disabled:opacity-60"
          aria-expanded={questionsState.status === "loaded"}
        >
          {questionsState.status === "loading"
            ? "Generating…"
            : questionsState.status === "loaded"
              ? "▾ Hide interview questions"
              : "▸ Interview questions"}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {questionsState.status === "loaded" && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <ol className="mt-2.5 list-decimal space-y-2 border-t border-ink/15 pt-2.5 pl-4 text-[0.86rem] leading-relaxed text-ink marker:text-moss marker:font-(family-name:--font-data)">
              {questionsState.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          </motion.div>
        )}
      </AnimatePresence>

      {questionsState.status === "error" && (
        <p className="mt-2.5 text-[0.78rem] text-stamp">{questionsState.message}</p>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="mt-2.5 max-h-64 overflow-y-auto border-t border-ink/15 pt-2.5 pr-1 text-[0.86rem] leading-relaxed text-ink">
              {job.description || job.snippet || "No further detail collected."}
            </div>
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2.5 inline-block font-(family-name:--font-data) text-[0.72rem] text-stamp border-b border-stamp"
            >
              View original posting on Indeed ↗
            </a>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}
