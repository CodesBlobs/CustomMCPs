import FieldGuide from "@/components/FieldGuide";
import jobsData from "@/data/jobs.json";
import type { Job } from "@/lib/types";

export default function Home() {
  return <FieldGuide jobs={jobsData as Job[]} />;
}
