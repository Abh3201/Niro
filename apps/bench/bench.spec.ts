import { appendFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { ScenarioResult } from "./src/main";

/**
 * Times the engine on the seeded board and writes the numbers to
 * `bench-results.json`, plus a table to the GitHub job summary in CI. No
 * thresholds: timings on shared CI machines are too noisy to fail a build
 * on, so this records a trend to compare between runs.
 */
test("frame times on a 10,000-shape board", async ({ page }) => {
  await page.goto("/?shapes=10000&seed=1");
  await page.waitForFunction(() => window.niroBench?.ready);
  expect(await page.evaluate(() => window.niroBench.shapes)).toBe(10_000);
  const results: ScenarioResult[] = await page.evaluate(() => window.niroBench.run());

  const rows = results.map(
    (r) => `| ${r.name} | ${r.p50} | ${r.p95} | ${r.max} | ${r.scriptP50} | ${r.drawn} |`,
  );
  const table = [
    "| Scenario | p50 ms | p95 ms | max ms | script p50 ms | shapes drawn |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  console.log(`\n${table}\n`);
  writeFileSync(
    "bench-results.json",
    `${JSON.stringify({ date: new Date().toISOString(), results }, null, 2)}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Frame times, 10,000 shapes\n\n${table}\n`);
});
