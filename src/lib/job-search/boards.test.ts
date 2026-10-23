import { describe, expect, it } from "vitest";

import { boardLink, companyFromLink, companyKey, nameFromSlug } from "./boards";

describe("companyFromLink", () => {
  it.each([
    ["https://boards.greenhouse.io/stripe", { platform: "greenhouse", slug: "stripe" }],
    ["https://job-boards.greenhouse.io/stripe/jobs/8172510?gh_src=x", { platform: "greenhouse", slug: "stripe" }],
    ["job-boards.eu.greenhouse.io/acme-corp", { platform: "greenhouse", slug: "acme-corp" }],
    ["https://boards.greenhouse.io/embed/job_board?for=acme", { platform: "greenhouse", slug: "acme" }],
    ["https://boards-api.greenhouse.io/v1/boards/acme/jobs", { platform: "greenhouse", slug: "acme" }],
    ["https://jobs.lever.co/spotify/f7eb82ce-b57e-4dc0-b84a-7f7ec05bf66e", { platform: "lever", slug: "spotify" }],
    ["https://jobs.eu.lever.co/acme", { platform: "lever", slug: "acme", eu: true }],
    ["https://api.lever.co/v0/postings/acme?mode=json", { platform: "lever", slug: "acme" }],
    ["https://jobs.ashbyhq.com/clickhouse/db498a8c-c8d8-405b-b86a-0943a5122e7d", { platform: "ashby", slug: "clickhouse" }],
    ["https://api.ashbyhq.com/posting-api/job-board/clickhouse", { platform: "ashby", slug: "clickhouse" }],
  ])("reads %s", (link, company) => {
    expect(companyFromLink(link)).toMatchObject(company);
  });

  it("names the company from its slug until the board says otherwise", () => {
    expect(companyFromLink("jobs.lever.co/acme-corp")?.name).toBe("Acme Corp");
    expect(nameFromSlug("big_data.co")).toBe("Big Data Co");
  });

  it.each([
    "https://example.com/careers",
    "https://boards.greenhouse.io/",
    "https://boards.greenhouse.io/embed/job_board",
    "https://api.lever.co/v1/other/acme",
    "javascript:alert(1)",
    "https://jobs.lever.co/..%2F..",
    "not a link at all",
  ])("refuses %s", (link) => {
    expect(companyFromLink(link)).toBeNull();
  });
});

describe("boardLink and companyKey", () => {
  it("link to the board, and ignore case and name", () => {
    expect(boardLink({ platform: "lever", slug: "acme", name: "Acme", eu: true })).toBe("https://jobs.eu.lever.co/acme");
    expect(boardLink({ platform: "greenhouse", slug: "acme", name: "Acme" })).toBe("https://job-boards.greenhouse.io/acme");
    expect(companyKey({ platform: "ashby", slug: "Notion" })).toBe(companyKey({ platform: "ashby", slug: "notion" }));
  });
});
