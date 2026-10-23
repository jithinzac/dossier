import { z } from "zod";

// Company boards: the companies the user watches on Greenhouse, Lever and
// Ashby, whose public job boards are searched instead of an index. Each is
// added from its careers page link. Shared by the server and Settings.

export const BOARD_PLATFORMS = ["greenhouse", "lever", "ashby"] as const;
export type BoardPlatform = (typeof BOARD_PLATFORMS)[number];

export const BOARD_PLATFORM_NAMES: Record<BoardPlatform, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };

/** How many companies can be watched: each is one request per search. */
export const MAX_WATCHED_COMPANIES = 100;

export const watchedCompanySchema = z.object({
  platform: z.enum(BOARD_PLATFORMS),
  /** The board's name on its platform, as in jobs.lever.co/<slug>. */
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  /** As Settings shows it. */
  name: z.string().trim().min(1).max(100),
  /** A Lever board hosted in the EU (jobs.eu.lever.co), which has its own API. */
  eu: z.boolean().optional(),
});
export type WatchedCompany = z.output<typeof watchedCompanySchema>;

/** Identifies a watched company, whatever its name. */
export const companyKey = (company: Pick<WatchedCompany, "platform" | "slug">) => `${company.platform}:${company.slug.toLowerCase()}`;

/** "acme-corp" as "Acme Corp", until the board says its own name. */
export function nameFromSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 100);
}

/** The board's own page, for a link in Settings. */
export function boardLink(company: WatchedCompany): string {
  const slug = encodeURIComponent(company.slug);
  if (company.platform === "greenhouse") return `https://job-boards.greenhouse.io/${slug}`;
  if (company.platform === "lever") return `https://jobs.${company.eu ? "eu." : ""}lever.co/${slug}`;
  return `https://jobs.ashbyhq.com/${slug}`;
}

/**
 * The company a careers page link points at: boards.greenhouse.io/acme,
 * job-boards.greenhouse.io/acme/jobs/123, jobs.lever.co/acme,
 * jobs.ashbyhq.com/acme, or their API addresses. Null when it isn't one.
 */
export function companyFromLink(link: string): WatchedCompany | null {
  const trimmed = link.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);

  const make = (platform: BoardPlatform, slug: string | null | undefined, eu = false): WatchedCompany | null => {
    const company = { platform, slug: slug ?? "", name: nameFromSlug(slug ?? "") || "?", ...(eu ? { eu } : {}) };
    return watchedCompanySchema.safeParse(company).success ? company : null;
  };

  if (host === "greenhouse.io" || host.endsWith(".greenhouse.io")) {
    if (host.startsWith("boards-api.")) return segments[0] === "v1" && segments[1] === "boards" ? make("greenhouse", segments[2]) : null;
    // The embedded board: boards.greenhouse.io/embed/job_board?for=acme
    if (segments[0] === "embed") return make("greenhouse", url.searchParams.get("for"));
    return make("greenhouse", segments[0]);
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return make("lever", segments[0], host === "jobs.eu.lever.co");
  if (host === "api.lever.co" || host === "api.eu.lever.co") {
    return segments[0] === "v0" && segments[1] === "postings" ? make("lever", segments[2], host === "api.eu.lever.co") : null;
  }
  if (host === "jobs.ashbyhq.com") return make("ashby", segments[0]);
  if (host === "api.ashbyhq.com") return segments[0] === "posting-api" && segments[1] === "job-board" ? make("ashby", segments[2]) : null;
  return null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
