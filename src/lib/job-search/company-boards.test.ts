import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch, type FakeRequest } from "@/lib/ai/test-http";

import type { WatchedCompany } from "./boards";
import { clearJobSearchCache } from "./cache";
import { checkBoard, companyBoards } from "./company-boards";
import { EMPTY_QUERY, type SearchQuery } from "./search";

vi.mock("@/lib/log", () => ({ logServerError: vi.fn() }));

const now = Date.now();
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

const stripe: WatchedCompany = { platform: "greenhouse", slug: "stripe", name: "Stripe" };
const spotify: WatchedCompany = { platform: "lever", slug: "spotify", name: "Spotify" };
const clickhouse: WatchedCompany = { platform: "ashby", slug: "clickhouse", name: "ClickHouse" };
const companies = [stripe, spotify, clickhouse];

const greenhouseJobs = {
  jobs: [
    {
      id: 101,
      title: "Backend Engineer, Payments",
      company_name: "Stripe",
      absolute_url: "https://stripe.com/jobs/search?gh_jid=101",
      location: { name: "Dublin, Ireland" },
      first_published: daysAgo(2),
      updated_at: daysAgo(1),
      departments: [{ name: "Engineering" }],
    },
    { id: 102, title: "Account Executive", company_name: "Stripe", absolute_url: "https://stripe.com/jobs/search?gh_jid=102", location: { name: "Berlin, Germany" }, first_published: daysAgo(3) },
    { id: 103, title: "Software Engineer", company_name: "Stripe", absolute_url: "https://stripe.com/jobs/search?gh_jid=103", location: { name: "Remote in Germany" }, first_published: daysAgo(40) },
  ],
  meta: { total: 3 },
};

const leverPostings = [
  {
    id: "lv-1",
    text: "Senior Backend Engineer",
    hostedUrl: "https://jobs.lever.co/spotify/lv-1",
    createdAt: Date.parse(daysAgo(1)),
    country: "DE",
    workplaceType: "hybrid",
    descriptionPlain: "Join the platform team.",
    lists: [{ text: "What you'll do", content: "<li>Build services</li><li>Own reliability</li>" }],
    additionalPlain: "We're an equal opportunity employer.",
    categories: { location: "Berlin", allLocations: ["Berlin", "Hamburg"], department: "Engineering", team: "Platform" },
    salaryRange: { min: 80000, max: 100000, currency: "EUR", interval: "per-year-salary" },
  },
  { id: "lv-2", text: "Agency Lead", hostedUrl: "https://jobs.lever.co/spotify/lv-2", createdAt: Date.parse(daysAgo(5)), country: "FR", workplaceType: "onsite", categories: { location: "Paris" } },
];

const ashbyJobs = {
  jobs: [
    {
      id: "ab-1",
      title: "Senior Cloud Software Engineer",
      department: "Engineering",
      team: "Cloud",
      location: "Germany",
      secondaryLocations: [],
      publishedAt: daysAgo(4),
      isListed: true,
      isRemote: true,
      workplaceType: "Remote",
      address: { postalAddress: { addressCountry: "Germany" } },
      jobUrl: "https://jobs.ashbyhq.com/clickhouse/ab-1",
      descriptionPlain: "About the team\n\nWe build ClickHouse Cloud.",
      compensation: { scrapeableCompensationSalarySummary: "€90K - €120K", compensationTierSummary: "€90K – €120K • Offers Equity" },
    },
    { id: "ab-2", title: "Hidden Backend Role", isListed: false, jobUrl: "https://jobs.ashbyhq.com/clickhouse/ab-2" },
  ],
};

/** Answers each platform with its board; `fail` lists the paths that answer 404. */
function boards(fail: string[] = []) {
  return stubFetch((request: FakeRequest) => {
    const path = `${request.url.hostname}${request.url.pathname}`;
    if (fail.some((part) => path.includes(part))) return json({ status: 404, error: "Job not found" }, { status: 404 });
    if (path === "boards-api.greenhouse.io/v1/boards/stripe/jobs") return json(greenhouseJobs);
    if (path === "boards-api.greenhouse.io/v1/boards/stripe/jobs/101") return json({ id: 101, content: "&lt;h2&gt;Who we are&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Payments&lt;/li&gt;&lt;/ul&gt;" });
    if (path === "boards-api.greenhouse.io/v1/boards/stripe") return json({ name: "Stripe, Inc.", content: "" });
    if (path === "api.lever.co/v0/postings/spotify") return json(leverPostings);
    if (path === "api.ashbyhq.com/posting-api/job-board/clickhouse") return json(ashbyJobs);
    return json({}, { status: 404 });
  });
}

const query = (patch: Partial<SearchQuery>): SearchQuery => ({ ...EMPTY_QUERY, country: "de", ...patch });

beforeEach(() => clearJobSearchCache());
afterEach(() => vi.unstubAllGlobals());

describe("Company boards search", () => {
  it("reads each board once, from its platform's public API", async () => {
    const requests = boards();
    await companyBoards.search(query({ keywords: "engineer" }), { companies }, null);
    expect(requests.map(({ url }) => `${url.origin}${url.pathname}${url.search}`).sort()).toEqual([
      "https://api.ashbyhq.com/posting-api/job-board/clickhouse?includeCompensation=true",
      "https://api.lever.co/v0/postings/spotify?mode=json",
      "https://boards-api.greenhouse.io/v1/boards/stripe/jobs",
    ]);
  });

  it("keeps postings with every word in the title, team or company, in the country, newest first", async () => {
    boards();
    const page = await companyBoards.search(query({ keywords: "backend engineer" }), { companies }, null);
    // Dublin is in Ireland, Paris in France, and the hidden Ashby posting isn't listed.
    expect(page.postings.map((posting) => posting.externalId)).toEqual(["lever:spotify:lv-1"]);
    expect(page.next).toBeNull();

    const byCompany = await companyBoards.search(query({ keywords: "clickhouse" }), { companies }, null);
    expect(byCompany.postings.map((posting) => posting.title)).toEqual(["Senior Cloud Software Engineer"]);
  });

  it("maps each platform to the shared shape", async () => {
    boards();
    const { postings } = await companyBoards.search(query({ keywords: "engineer", country: "" }), { companies }, null);
    expect(postings.find((posting) => posting.via === "Lever")).toEqual({
      source: "COMPANY_BOARDS",
      externalId: "lever:spotify:lv-1",
      title: "Senior Backend Engineer",
      company: "Spotify",
      place: "Berlin / Hamburg",
      remote: false,
      salary: "EUR 80,000–100,000 a year",
      postedAt: expect.any(String),
      url: "https://jobs.lever.co/spotify/lv-1",
      via: "Lever",
      description: "Join the platform team.\n\nWhat you'll do\n- Build services\n- Own reliability\n\nWe're an equal opportunity employer.",
      complete: true,
    });
    expect(postings.find((posting) => posting.via === "Ashby")).toMatchObject({
      company: "ClickHouse",
      place: "Germany",
      remote: true,
      salary: "€90K - €120K",
      complete: true,
    });
    expect(postings.find((posting) => posting.externalId === "greenhouse:stripe:101")).toMatchObject({
      company: "Stripe",
      place: "Dublin, Ireland",
      remote: null,
      description: "",
      complete: false,
    });
  });

  it("filters by place, remote and how recent", async () => {
    boards();
    const hamburg = await companyBoards.search(query({ keywords: "engineer", place: "hamburg" }), { companies }, null);
    // Remote postings count for any place in the country.
    expect(hamburg.postings.map((posting) => posting.externalId).sort()).toEqual(["ashby:clickhouse:ab-1", "greenhouse:stripe:103", "lever:spotify:lv-1"]);

    const remote = await companyBoards.search(query({ keywords: "engineer", remoteOnly: true, postedWithin: "month" }), { companies }, null);
    expect(remote.postings.map((posting) => posting.externalId)).toEqual(["ashby:clickhouse:ab-1"]);
  });

  it("pages through the matches without reading the boards again", async () => {
    const many = { jobs: Array.from({ length: 25 }, (_, index) => ({ id: index + 1, title: `Engineer ${index + 1}`, location: { name: "Berlin" }, first_published: daysAgo(index) })) };
    const requests = stubFetch(() => json(many));
    const first = await companyBoards.search(query({ keywords: "engineer" }), { companies: [stripe] }, null);
    expect(first.postings).toHaveLength(20);
    expect(first.postings[0]?.title).toBe("Engineer 1");
    expect(first.next).toBe("page:2");
    const second = await companyBoards.search(query({ keywords: "engineer" }), { companies: [stripe] }, first.next);
    expect(second.postings.map((posting) => posting.title)).toEqual(["Engineer 21", "Engineer 22", "Engineer 23", "Engineer 24", "Engineer 25"]);
    expect(second.next).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("skips a board that can't be read, and fails only when none can", async () => {
    boards(["/spotify"]);
    const page = await companyBoards.search(query({ keywords: "engineer" }), { companies }, null);
    expect(page.postings.map((posting) => posting.via).sort()).toEqual(["Ashby", "Greenhouse"]);

    clearJobSearchCache();
    boards(["/stripe", "/spotify", "/clickhouse"]);
    await expect(companyBoards.search(query({ keywords: "engineer" }), { companies }, null)).rejects.toMatchObject({ problem: "changed" });
  });

  it("goes to the end-to-end tests' fake when told to", async () => {
    const requests = stubFetch(() => json([]));
    await companyBoards.search(query({ keywords: "x" }), { companies: [{ ...spotify, eu: true }] }, null, { baseUrl: "http://127.0.0.1:3998/company_boards" });
    expect(requests[0]?.url.href).toBe("http://127.0.0.1:3998/company_boards/lever-eu/spotify?mode=json");
  });
});

describe("Company boards details", () => {
  it("fetches a Greenhouse posting's description, unescaped, and leaves the whole ones as they are", async () => {
    boards();
    const { postings } = await companyBoards.search(query({ keywords: "payments", country: "" }), { companies }, null);
    const greenhouse = postings.find((posting) => posting.externalId === "greenhouse:stripe:101")!;
    expect(await companyBoards.details(greenhouse, { companies }, {})).toBe("Who we are\n- Payments");
    const lever = { ...greenhouse, externalId: "lever:spotify:lv-1", description: "Whole text", complete: true };
    expect(await companyBoards.details(lever, { companies }, {})).toBe("Whole text");
  });
});

describe("Company boards checks", () => {
  it("takes Greenhouse's own name for a board, and refuses one that isn't there", async () => {
    boards(["/nosuch"]);
    expect(await checkBoard(stripe)).toBe("Stripe, Inc.");
    expect(await checkBoard(clickhouse)).toBeNull();
    await expect(checkBoard({ platform: "lever", slug: "nosuch", name: "Nosuch" })).rejects.toThrow("Lever has no job board at that link.");
  });

  it("names the boards that can't be read when testing", async () => {
    boards(["/spotify"]);
    await expect(companyBoards.test({ companies })).rejects.toThrow("This board can't be read: Spotify (Lever).");
    boards();
    await expect(companyBoards.test({ companies })).resolves.toBeUndefined();
  });
});
