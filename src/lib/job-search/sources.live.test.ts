import { describe, expect, it } from "vitest";

import { adzuna } from "./adzuna";
import { arbeitsagentur } from "./arbeitsagentur";
import { checkBoard, companyBoards } from "./company-boards";
import { EMPTY_QUERY } from "./search";

// Checks against the real Adzuna, Arbeitsagentur and company board services,
// skipped unless asked for. The Arbeitsagentur and the company boards need no
// key and cost nothing; Adzuna spends two calls from the day's allowance:
//
//   JOBS_LIVE=arbeitsagentur docker/bin/yarn vitest run src/lib/job-search/sources.live.test.ts
//   JOBS_LIVE=boards docker/bin/yarn vitest run src/lib/job-search/sources.live.test.ts
//   JOBS_LIVE=adzuna ADZUNA_TEST_APP_ID=… ADZUNA_TEST_KEY=… docker/bin/yarn vitest run src/lib/job-search/sources.live.test.ts

const live = new Set((process.env.JOBS_LIVE ?? "").split(",").map((name) => name.trim()));
const adzunaKey = { appId: process.env.ADZUNA_TEST_APP_ID ?? "", key: process.env.ADZUNA_TEST_KEY ?? "" };
const query = { ...EMPTY_QUERY, keywords: "Softwareentwickler", place: "Hamburg", country: "de", radiusKm: 25 as const };

describe.runIf(live.has("arbeitsagentur"))("Arbeitsagentur (live)", { timeout: 30_000 }, () => {
  it("finds postings near a place, a second page, and the whole text of one", async () => {
    const page = await arbeitsagentur.search(query, {}, null);
    expect(page.postings.length).toBeGreaterThan(0);
    expect(page.postings.every((posting) => posting.title && posting.url.startsWith("https://"))).toBe(true);
    expect(page.next).toBe("page:2");
    expect((await arbeitsagentur.search(query, {}, page.next)).postings.length).toBeGreaterThan(0);
    expect((await arbeitsagentur.details(page.postings[0], {}))?.length).toBeGreaterThan(100);
  });
});

describe.runIf(live.has("adzuna") && adzunaKey.appId && adzunaKey.key)("Adzuna (live)", { timeout: 30_000 }, () => {
  it("finds postings near a place, and a second page", async () => {
    const page = await adzuna.search({ ...query, keywords: "software developer" }, adzunaKey, null);
    expect(page.postings.length).toBeGreaterThan(0);
    expect(page.postings.every((posting) => posting.title && !posting.complete)).toBe(true);
    expect((await adzuna.search({ ...query, keywords: "software developer" }, adzunaKey, page.next)).postings.length).toBeGreaterThan(0);
  });
});

describe.runIf(live.has("boards"))("Company boards (live)", { timeout: 60_000 }, () => {
  // Boards of companies that hire steadily on each platform; swap one out if it moves.
  const companies = [
    { platform: "greenhouse" as const, slug: "stripe", name: "Stripe" },
    { platform: "lever" as const, slug: "spotify", name: "Spotify" },
    { platform: "ashby" as const, slug: "clickhouse", name: "ClickHouse" },
  ];

  it("reads every board, finds postings, and the whole text of a Greenhouse one", async () => {
    await companyBoards.test({ companies });
    const page = await companyBoards.search({ ...EMPTY_QUERY, keywords: "engineer", country: "" }, { companies }, null);
    expect(new Set(page.postings.map((posting) => posting.via)).size).toBeGreaterThan(0);
    expect(page.postings.every((posting) => posting.title && posting.url.startsWith("https://"))).toBe(true);
    const greenhouse = (await companyBoards.search({ ...EMPTY_QUERY, keywords: "engineer", country: "" }, { companies: [companies[0]!] }, null)).postings[0]!;
    expect((await companyBoards.details(greenhouse, { companies }))?.length).toBeGreaterThan(100);
    expect(await checkBoard(companies[0]!)).toBe("Stripe");
  });
});
