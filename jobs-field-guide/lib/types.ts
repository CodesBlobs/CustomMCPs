export interface Job {
  keyword: string;
  job_key: string;
  title: string;
  company: string;
  company_rating: number | null;
  location: string;
  job_types: string[];
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_period: string | null;
  posted: string | null;
  sponsored: boolean;
  snippet: string;
  description: string;
  url: string;
}
