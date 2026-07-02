"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import JobCard from "@/components/JobCard";
import type { Job } from "@/lib/types";

const SALARY_TIERS = [
  { label: "Any", value: 0 },
  { label: "$80k+", value: 80000 },
  { label: "$120k+", value: 120000 },
  { label: "$160k+", value: 160000 },
];

export default function FieldGuide({ jobs }: { jobs: Job[] }) {
  const [search, setSearch] = useState("");
  const [activeType, setActiveType] = useState("__all__");
  const [activeSalary, setActiveSalary] = useState(0);
  const [activeKeyword, setActiveKeyword] = useState("__all__");

  const keywordOrder = useMemo(() => [...new Set(jobs.map((j) => j.keyword))], [jobs]);
  const allTypes = useMemo(
    () => [...new Set(jobs.flatMap((j) => j.job_types))].sort(),
    [jobs],
  );

  const specimenNumber = useMemo(() => {
    const map = new Map<string, number>();
    jobs.forEach((j, i) => map.set(j.job_key, i + 1));
    return map;
  }, [jobs]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return keywordOrder
      .filter((keyword) => activeKeyword === "__all__" || activeKeyword === keyword)
      .map((keyword) => {
        const jobsInGroup = jobs.filter((j) => j.keyword === keyword);
        const matched = jobsInGroup.filter((job) => {
          const matchesSearch =
            !q || job.title.toLowerCase().includes(q) || job.company.toLowerCase().includes(q);
          const matchesType = activeType === "__all__" || job.job_types.includes(activeType);
          const matchesSalary = activeSalary === 0 || (job.salary_min ?? 0) >= activeSalary;
          return matchesSearch && matchesType && matchesSalary;
        });
        return { keyword, total: jobsInGroup.length, matched };
      })
      .filter((g) => g.matched.length > 0);
  }, [jobs, keywordOrder, search, activeType, activeSalary, activeKeyword]);

  const visibleTotal = groups.reduce((sum, g) => sum + g.matched.length, 0);

  return (
    <>
      <header className="relative overflow-hidden border-b-[6px] border-brass bg-gradient-to-b from-walnut-2 to-walnut px-7 pt-14 pb-11 text-paper shadow-[inset_0_-14px_22px_-18px_rgba(0,0,0,0.6)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-sm border border-brass-bright/55 bg-black/20 px-3 py-1 font-(family-name:--font-data) text-[0.7rem] tracking-[0.18em] text-brass-bright uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-brass-bright shadow-[0_0_6px_rgba(216,181,101,0.8)]" />
              Field survey · Sydney NSW · Jul 2026
            </div>
            <h1 className="max-w-[14ch] font-(family-name:--font-display) text-[clamp(2.1rem,4.4vw,3.4rem)] leading-[1.05] font-semibold">
              Field Guide to the Sydney Job Market
            </h1>
            <p className="mt-2.5 max-w-[46ch] font-(family-name:--font-body) text-[1.02rem] text-paper/70 italic">
              One hundred postings collected live from Indeed, five specimens each across twenty occupations
              &mdash; browse the drawer below.
            </p>
          </div>
          <div className="text-right font-(family-name:--font-data)">
            <span className="block text-[2.6rem] font-semibold text-brass-bright">{visibleTotal}</span>
            <span className="text-[0.68rem] tracking-[0.14em] text-paper/60 uppercase">specimens shown</span>
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-20 border-b border-ink/15 bg-paper px-7 py-3.5 shadow-[0_8px_18px_-14px_rgba(0,0,0,0.4)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <label className="flex min-w-0 flex-1 basis-60 items-center gap-2 rounded-sm border border-ink/30 bg-white px-3 py-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="shrink-0 opacity-55">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search title or employer…"
              autoComplete="off"
              className="w-full bg-transparent font-(family-name:--font-data) text-[0.85rem] text-ink outline-none placeholder:text-ink-muted/70"
            />
          </label>

          <div className="flex min-w-0 flex-wrap basis-full items-center gap-1.5">
            <span className="mr-0.5 font-(family-name:--font-data) text-[0.62rem] tracking-[0.12em] text-ink-muted uppercase">
              Type
            </span>
            <Chip active={activeType === "__all__"} onClick={() => setActiveType("__all__")}>
              All
            </Chip>
            {allTypes.map((t) => (
              <Chip key={t} active={activeType === t} onClick={() => setActiveType(t)}>
                {t}
              </Chip>
            ))}
          </div>

          <div className="flex min-w-0 flex-wrap basis-full items-center gap-1.5">
            <span className="mr-0.5 font-(family-name:--font-data) text-[0.62rem] tracking-[0.12em] text-ink-muted uppercase">
              Salary
            </span>
            {SALARY_TIERS.map((tier) => (
              <Chip key={tier.value} active={activeSalary === tier.value} onClick={() => setActiveSalary(tier.value)}>
                {tier.label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="mx-auto mt-2.5 flex max-w-6xl gap-1.5 overflow-x-auto pb-0.5">
          <KeywordChip active={activeKeyword === "__all__"} onClick={() => setActiveKeyword("__all__")}>
            All occupations
          </KeywordChip>
          {keywordOrder.map((k) => (
            <KeywordChip key={k} active={activeKeyword === k} onClick={() => setActiveKeyword(k)}>
              {k}
            </KeywordChip>
          ))}
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-7 pt-9 pb-24">
        <LayoutGroup>
          {groups.length === 0 && (
            <div className="py-16 text-center font-(family-name:--font-data) text-[0.85rem] text-ink-muted">
              No specimens match this combination. Try clearing a filter.
            </div>
          )}

          {groups.map((group) => (
            <section key={group.keyword} className="mb-9">
              <div className="relative mb-4 inline-flex items-baseline gap-2.5 rounded-r-[10px] rounded-l-sm bg-ink py-2 pr-4.5 pl-4 text-paper">
                <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-brass" />
                <h2 className="font-(family-name:--font-display) text-[1.15rem] font-semibold">{group.keyword}</h2>
                <span className="font-(family-name:--font-data) text-[0.7rem] text-brass-bright">
                  {group.matched.length} of {group.total}
                </span>
              </div>

              <motion.div layout className="grid grid-cols-[repeat(auto-fill,minmax(258px,1fr))] gap-4">
                <AnimatePresence mode="popLayout">
                  {group.matched.map((job) => (
                    <JobCard key={job.job_key} job={job} specimenNumber={specimenNumber.get(job.job_key)!} />
                  ))}
                </AnimatePresence>
              </motion.div>
            </section>
          ))}
        </LayoutGroup>
      </main>

      <footer className="px-5 pt-6 pb-10 text-center font-(family-name:--font-data) text-[0.68rem] tracking-wide text-ink-muted">
        Collected via curl_cffi + live cookies, bypassing Cloudflare · parse_indeed_jobs.py · for personal research
        use only
      </footer>
    </>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 font-(family-name:--font-data) text-[0.72rem] whitespace-nowrap transition-colors ${
        active
          ? "border-moss bg-moss text-paper"
          : "border-ink/28 bg-transparent text-ink hover:border-brass"
      }`}
    >
      {children}
    </button>
  );
}

function KeywordChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-sm border px-2.5 py-1 font-(family-name:--font-data) text-[0.68rem] whitespace-nowrap transition-colors ${
        active ? "border-ink bg-ink text-paper" : "border-ink/22 bg-ink/[0.04] text-ink-muted"
      }`}
    >
      {children}
    </button>
  );
}
