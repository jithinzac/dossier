import "server-only";

import { z } from "zod";

import { logServerError } from "@/lib/log";
import { htmlText } from "@/lib/posting-fetch";

import type { JobSourceAdapter, RequestContext } from "./adapter";
import { BOARD_PLATFORM_NAMES, type WatchedCompany } from "./boards";
import { cached, remember } from "./cache";
import { countryCodeFor } from "./countries";
import { JobSearchError, jobSearchError } from "./errors";
import { requestJson } from "./http";
import { POSTED_WITHIN, safeLink, type FoundPosting, type SearchPage, type SearchQuery } from "./search";
import { plainText } from "./text";

// Company boards: the public job boards of the companies the user watches,
// on Greenhouse, Lever and Ashby. Free and without a key. None of them can
// be searched, so each board is read whole and the postings are matched
// here: every word of the search in the title, team or company name; the
// place in the location; the country where the posting names one. Checked
// against the live services on 23 October 2026.

const BASES = {
  greenhouse: "https://boards-api.greenhouse.io/v1/boards",
  lever: "https://api.lever.co/v0/postings",
  leverEu: "https://api.eu.lever.co/v0/postings",
  ashby: "https://api.ashbyhq.com/posting-api/job-board",
} as const;

const PAGE_SIZE = 20;
/** Boards read at once. */
const CONCURRENCY = 8;
/** Lever and Ashby send every posting whole; a big company's board runs to several MB. */
const BOARD_MAX_BYTES = 20 * 1024 * 1024;

/** A posting from a board, with what's matched here but not shown. */
type BoardPosting = {
  posting: FoundPosting;
  /** ISO code in lower case, when the board names one; "" otherwise. */
  country: string;
  /** Department and team, for matching. */
  team: string;
};

const maybeText = z.string().nullish().catch(null);
const maybeNumber = z.coerce.number().nullish().catch(null);

function baseFor(company: WatchedCompany, context: RequestContext): string {
  const key = company.platform === "lever" && company.eu ? "leverEu" : company.platform;
  return context.baseUrl ? `${context.baseUrl}/${key === "leverEu" ? "lever-eu" : key}` : BASES[key];
}

const boardUrl = (company: WatchedCompany, context: RequestContext, path = "") => new URL(`${baseFor(company, context)}/${encodeURIComponent(company.slug)}${path}`);

/** The country a location names ("Berlin, Germany", "London, UK"), or "". */
function countryIn(location: string): string {
  const parts = location.split(/[,·|/()]/).map((part) => part.trim());
  for (const part of parts.reverse()) {
    const code = countryCodeFor(part);
    if (code) return code;
  }
  return "";
}

const saysRemote = (text: string) => /\bremote\b/i.test(text);

const isoDate = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

const externalId = (company: WatchedCompany, id: string) => `${company.platform}:${company.slug}:${id}`.slice(0, 500);

// ─── Greenhouse ──────────────────────────────────────────────────────────────
// The list carries no descriptions (with them a big board runs over 10 MB);
// a posting's comes from its own endpoint, HTML escaped once more.

const greenhouseJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: maybeText,
  company_name: maybeText,
  absolute_url: maybeText,
  location: z.object({ name: maybeText }).nullish().catch(null),
  first_published: maybeText,
  updated_at: maybeText,
  departments: z
    .array(z.object({ name: maybeText }))
    .nullish()
    .catch(null),
});
const greenhouseListSchema = z.object({ jobs: z.array(z.unknown()) });
const greenhouseDetailsSchema = z.object({ content: maybeText });

function fromGreenhouse(company: WatchedCompany, job: z.output<typeof greenhouseJobSchema>): BoardPosting {
  const place = plainText(job.location?.name);
  const posting: FoundPosting = {
    source: "COMPANY_BOARDS",
    externalId: externalId(company, job.id),
    title: plainText(job.title).slice(0, 500),
    company: (plainText(job.company_name) || company.name).slice(0, 300),
    place: place.slice(0, 300),
    remote: saysRemote(place) ? true : null,
    salary: "",
    postedAt: isoDate(job.first_published) ?? isoDate(job.updated_at),
    url: safeLink(job.absolute_url).slice(0, 2000),
    via: "Greenhouse",
    description: "",
    complete: false,
  };
  return { posting, country: countryIn(place), team: (job.departments ?? []).map((department) => department.name ?? "").join(" ") };
}

// ─── Lever ───────────────────────────────────────────────────────────────────

const leverPostingSchema = z.object({
  id: z.string().min(1),
  text: maybeText,
  hostedUrl: maybeText,
  createdAt: maybeNumber,
  country: maybeText,
  workplaceType: maybeText,
  descriptionPlain: maybeText,
  additionalPlain: maybeText,
  lists: z
    .array(z.object({ text: maybeText, content: maybeText }))
    .nullish()
    .catch(null),
  categories: z
    .object({ location: maybeText, allLocations: z.array(z.string()).nullish().catch(null), department: maybeText, team: maybeText })
    .nullish()
    .catch(null),
  salaryRange: z.object({ min: maybeNumber, max: maybeNumber, currency: maybeText, interval: maybeText }).nullish().catch(null),
});
type LeverPosting = z.output<typeof leverPostingSchema>;

const LEVER_INTERVALS: Record<string, string> = { "per-year-salary": "a year", "per-month-salary": "a month", "per-week-salary": "a week", "per-hour-wage": "an hour" };

function leverSalary(range: LeverPosting["salaryRange"]): string {
  if (!range || (!range.min && !range.max)) return "";
  const amount = (value: number) => Math.round(value).toLocaleString("en-US");
  const { min, max } = range;
  const span = min && max && min !== max ? `${amount(min)}–${amount(max)}` : amount((min || max)!);
  return [range.currency, span, LEVER_INTERVALS[range.interval ?? ""]].filter(Boolean).join(" ");
}

function leverDescription(posting: LeverPosting): string {
  const lists = (posting.lists ?? []).map((list) => [plainText(list.text), htmlText(list.content ?? "")].filter(Boolean).join("\n"));
  return [posting.descriptionPlain?.trim(), ...lists, posting.additionalPlain?.trim()].filter(Boolean).join("\n\n");
}

function fromLever(company: WatchedCompany, lever: LeverPosting): BoardPosting {
  const locations = lever.categories?.allLocations?.length ? lever.categories.allLocations : [lever.categories?.location ?? ""];
  const place = [...new Set(locations.map((location) => location.trim()).filter(Boolean))].slice(0, 2).join(" / ");
  const workplace = lever.workplaceType?.toLowerCase();
  const description = leverDescription(lever).slice(0, 100_000);
  const posting: FoundPosting = {
    source: "COMPANY_BOARDS",
    externalId: externalId(company, lever.id),
    title: plainText(lever.text).slice(0, 500),
    company: company.name.slice(0, 300),
    place: place.slice(0, 300),
    remote: workplace === "remote" ? true : workplace === "onsite" || workplace === "hybrid" ? false : saysRemote(place) ? true : null,
    salary: leverSalary(lever.salaryRange).slice(0, 200),
    postedAt: isoDate(lever.createdAt),
    url: safeLink(lever.hostedUrl).slice(0, 2000),
    via: "Lever",
    description,
    complete: description.length > 0,
  };
  const country = lever.country && /^[a-z]{2}$/i.test(lever.country) ? lever.country.toLowerCase() : countryIn(place);
  return { posting, country, team: [lever.categories?.department, lever.categories?.team].filter(Boolean).join(" ") };
}

// ─── Ashby ───────────────────────────────────────────────────────────────────

const ashbyJobSchema = z.object({
  id: z.string().min(1),
  title: maybeText,
  department: maybeText,
  team: maybeText,
  location: maybeText,
  secondaryLocations: z
    .array(z.object({ location: maybeText }))
    .nullish()
    .catch(null),
  publishedAt: maybeText,
  isListed: z.boolean().nullish().catch(null),
  isRemote: z.boolean().nullish().catch(null),
  workplaceType: maybeText,
  address: z
    .object({ postalAddress: z.object({ addressCountry: maybeText }).nullish().catch(null) })
    .nullish()
    .catch(null),
  jobUrl: maybeText,
  descriptionPlain: maybeText,
  compensation: z
    .object({ scrapeableCompensationSalarySummary: maybeText, compensationTierSummary: maybeText })
    .nullish()
    .catch(null),
});
type AshbyJob = z.output<typeof ashbyJobSchema>;
const ashbyListSchema = z.object({ jobs: z.array(z.unknown()) });

function fromAshby(company: WatchedCompany, job: AshbyJob): BoardPosting {
  const locations = [job.location ?? "", ...(job.secondaryLocations ?? []).map((location) => location.location ?? "")];
  const place = [...new Set(locations.map((location) => location.trim()).filter(Boolean))].slice(0, 2).join(" / ");
  const workplace = job.workplaceType?.toLowerCase();
  const description = (job.descriptionPlain ?? "").trim().slice(0, 100_000);
  const country = countryCodeFor(job.address?.postalAddress?.addressCountry ?? "") || countryIn(place);
  const posting: FoundPosting = {
    source: "COMPANY_BOARDS",
    externalId: externalId(company, job.id),
    title: plainText(job.title).slice(0, 500),
    company: company.name.slice(0, 300),
    place: place.slice(0, 300),
    // "Hybrid" postings say isRemote too: only a remote workplace counts.
    remote: workplace === "remote" ? true : workplace === "hybrid" || workplace === "onsite" ? false : job.isRemote || saysRemote(place) ? true : null,
    salary: (job.compensation?.scrapeableCompensationSalarySummary ?? job.compensation?.compensationTierSummary ?? "").trim().slice(0, 200),
    postedAt: isoDate(job.publishedAt),
    url: safeLink(job.jobUrl).slice(0, 2000),
    via: "Ashby",
    description,
    complete: description.length > 0,
  };
  return { posting, country, team: [job.department, job.team].filter(Boolean).join(" ") };
}

// ─── Reading boards ──────────────────────────────────────────────────────────

/** Every posting on a company's board; throws a JobSearchError when the board can't be read. */
async function readBoard(company: WatchedCompany, context: RequestContext): Promise<BoardPosting[]> {
  const ask = (url: URL) => requestJson("COMPANY_BOARDS", url, { signal: context.signal, maxBytes: BOARD_MAX_BYTES });
  const unexpected = (url: URL) => jobSearchError("changed", "COMPANY_BOARDS", { detail: `${url.pathname}: unexpected answer` });
  const each = <T, R>(items: unknown[], schema: z.ZodType<T>, map: (item: T) => R) =>
    items.flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [map(parsed.data)] : [];
    });

  if (company.platform === "greenhouse") {
    const url = boardUrl(company, context, "/jobs");
    const answer = greenhouseListSchema.safeParse(await ask(url));
    if (!answer.success) throw unexpected(url);
    return each(answer.data.jobs, greenhouseJobSchema, (job) => fromGreenhouse(company, job));
  }
  if (company.platform === "lever") {
    const url = boardUrl(company, context);
    url.searchParams.set("mode", "json");
    const answer = z.array(z.unknown()).safeParse(await ask(url));
    if (!answer.success) throw unexpected(url);
    return each(answer.data, leverPostingSchema, (posting) => fromLever(company, posting));
  }
  const url = boardUrl(company, context);
  url.searchParams.set("includeCompensation", "true");
  const answer = ashbyListSchema.safeParse(await ask(url));
  if (!answer.success) throw unexpected(url);
  return each(answer.data.jobs, ashbyJobSchema, (job) => (job.isListed === false ? null : fromAshby(company, job))).filter((posting) => posting !== null);
}

/** Runs `work` on every item, `limit` at a time, in order. */
async function inBatches<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type BoardResult = { company: WatchedCompany; postings: BoardPosting[] } | { company: WatchedCompany; error: JobSearchError };

async function readBoards(companies: readonly WatchedCompany[], context: RequestContext): Promise<BoardResult[]> {
  return inBatches(companies, CONCURRENCY, async (company) => {
    try {
      return { company, postings: await readBoard(company, context) };
    } catch (error) {
      if (!(error instanceof JobSearchError)) throw error;
      return { company, error };
    }
  });
}

// ─── Matching ────────────────────────────────────────────────────────────────

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** The search's words, keeping "c++" and "c#" whole. */
const wordsOf = (keywords: string) =>
  fold(keywords)
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, ""))
    .filter(Boolean);

/** Whether a posting fits the search; `now` is for "Posted within". */
export function matches({ posting, country, team }: BoardPosting, query: SearchQuery, now = Date.now()): boolean {
  const haystack = fold(`${posting.title} ${team} ${posting.company}`);
  if (!wordsOf(query.keywords).every((word) => haystack.includes(word))) return false;
  if (query.remoteOnly && posting.remote !== true) return false;
  // A remote posting can be done from the place, but not always from another country.
  if (query.place && posting.remote !== true && !fold(posting.place).includes(fold(query.place))) return false;
  if (query.country && country && country !== query.country) return false;
  const days = POSTED_WITHIN.find((option) => option.value === query.postedWithin)?.days;
  if (days && posting.postedAt && Date.parse(posting.postedAt) < now - days * 86_400_000) return false;
  return true;
}

/** Every posting on the boards that fits the search, newest first; kept for half an hour so later pages don't read the boards again. */
async function matching(query: SearchQuery, companies: readonly WatchedCompany[], context: RequestContext): Promise<FoundPosting[]> {
  const key = `boards:${companies.map((company) => `${company.platform}:${company.slug}`).join(",")}:${JSON.stringify(query)}`;
  const hit = cached<FoundPosting[]>(key);
  if (hit) return hit;

  const boards = await readBoards(companies, context);
  const failed = boards.filter((board) => "error" in board);
  for (const board of failed) logServerError("job search", new Error(board.error.detail ?? board.error.message));
  if (failed.length === boards.length && failed[0]) throw failed[0].error;

  const now = Date.now();
  const found = boards
    .flatMap((board) => ("postings" in board ? board.postings : []))
    .filter((found) => matches(found, query, now))
    .map((found) => found.posting)
    .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
  remember(key, found);
  return found;
}

async function searchPage(query: SearchQuery, companies: readonly WatchedCompany[], next: string | null, context: RequestContext = {}): Promise<SearchPage> {
  const page = next?.startsWith("page:") ? Math.max(1, Number(next.slice("page:".length)) || 1) : 1;
  const found = await matching(query, companies, context);
  return { postings: found.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), next: page * PAGE_SIZE < found.length ? `page:${page + 1}` : null };
}

/** A Greenhouse posting's description, from its own endpoint; null for the others, which come whole. */
async function details(posting: FoundPosting, companies: readonly WatchedCompany[], context: RequestContext = {}): Promise<string | null> {
  const [platform, slug, ...rest] = posting.externalId.split(":");
  const id = rest.join(":");
  if (platform !== "greenhouse" || !slug || !id) return posting.description || null;
  const company = companies.find((entry) => entry.platform === "greenhouse" && entry.slug === slug) ?? { platform: "greenhouse" as const, slug, name: slug };
  try {
    const answer = greenhouseDetailsSchema.safeParse(await requestJson("COMPANY_BOARDS", boardUrl(company, context, `/jobs/${encodeURIComponent(id)}`), { signal: context.signal }));
    const text = answer.success ? htmlText(answer.data.content ?? "").slice(0, 100_000) : "";
    return text || null;
  } catch (error) {
    if (error instanceof JobSearchError) return null;
    throw error;
  }
}

/**
 * Whether a company's board answers, for adding it in Settings: its name
 * when the board says it (Greenhouse does), else null. Throws a
 * JobSearchError, worded for the screen, when the board can't be read.
 */
export async function checkBoard(company: WatchedCompany, context: RequestContext = {}): Promise<string | null> {
  const where = `${BOARD_PLATFORM_NAMES[company.platform]} has no job board at that link. Check it on the company's careers page.`;
  try {
    if (company.platform === "greenhouse") {
      const answer = z.object({ name: maybeText }).safeParse(await requestJson("COMPANY_BOARDS", boardUrl(company, context), { signal: context.signal }));
      return answer.success ? plainText(answer.data.name).slice(0, 100) || null : null;
    }
    await readBoard(company, context);
    return null;
  } catch (error) {
    if (error instanceof JobSearchError && error.problem === "changed") throw new JobSearchError("changed", where, error.detail);
    throw error;
  }
}

export const companyBoards: JobSourceAdapter<"COMPANY_BOARDS"> = {
  source: "COMPANY_BOARDS",
  search: (query, { companies }, next, context) => searchPage(query, companies, next, context),
  details: (posting, { companies }, context) => details(posting, companies, context),
  /** Reads every board, and names the ones that can't be read. */
  test: async ({ companies }, context = {}) => {
    const failed = (await readBoards(companies, context)).filter((board) => "error" in board);
    if (failed.length === 0) return;
    const names = failed.map(({ company }) => `${company.name} (${BOARD_PLATFORM_NAMES[company.platform]})`);
    const detail = failed.map((board) => board.error.detail).join("; ");
    throw new JobSearchError(
      failed.length === companies.length && failed.every((board) => board.error.problem === "unavailable") ? "unavailable" : "changed",
      `${names.length === 1 ? "This board" : "These boards"} can't be read: ${names.join(", ")}. Check ${names.length === 1 ? "its link" : "their links"} below, or remove ${names.length === 1 ? "it" : "them"}.`,
      detail,
    );
  },
};
