import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE_URL = "http://localhost:3000";

let pass = 0;
let fail = 0;
const failures = [];

async function settle(page, ms = 500) {
  // AnimatePresence keeps exiting cards in the DOM until their exit transition
  // finishes, so a count read immediately after a filter change can catch a
  // transient mid-animation state. Give it time to settle before asserting.
  await new Promise((r) => setTimeout(r, ms));
}

async function clearSearch(page) {
  // React tracks input values via a wrapped native setter, so a plain
  // `el.value = ""` doesn't trigger onChange. Use the native setter directly.
  await page.$eval('input[placeholder="search title or employer…"]', (el) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeSetter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButtonWithText(page, text) {
  const handle = await page.evaluateHandle(
    (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t),
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`No button found with text "${text}"`);
  await el.click();
}

function assert(condition, message) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${message}`);
  } else {
    fail++;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--window-size=1440,1200"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  console.log("\n=== 1. Initial load ===");
  await page.goto(BASE_URL, { waitUntil: "networkidle0" });
  await page.waitForSelector("article", { timeout: 5000 });

  const title = await page.title();
  assert(title.includes("Field Guide"), `page title is correct (got "${title}")`);

  const tallyAlt = await page.evaluate(() => document.querySelector("header span.text-brass-bright")?.textContent);
  assert(tallyAlt === "100", `header tally shows 100 (got "${tallyAlt}")`);

  const articleCount = await page.$$eval("article", (els) => els.length);
  assert(articleCount === 100, `renders 100 job cards (got ${articleCount})`);

  const sectionCount = await page.$$eval("section", (els) => els.length);
  assert(sectionCount === 20, `renders 20 keyword sections (got ${sectionCount})`);

  console.log("\n=== 2. Search filter ===");
  await page.type('input[placeholder="search title or employer…"]', "chef");
  await page.waitForFunction(() => document.querySelectorAll("article").length < 100, { timeout: 3000 });
  await settle(page);
  const chefArticles = await page.$$eval("article", (els) => els.length);
  const chefSections = await page.$$eval("section h2", (els) => els.map((e) => e.textContent));
  assert(chefArticles === 5, `search "chef" narrows to 5 cards (got ${chefArticles})`);
  assert(
    chefSections.length === 1 && chefSections[0] === "Chef",
    `search "chef" shows only the Chef section (got ${JSON.stringify(chefSections)})`,
  );

  await clearSearch(page);
  await page.waitForFunction(() => document.querySelectorAll("article").length === 100, { timeout: 3000 });
  await settle(page);

  console.log("\n=== 3. Search with no matches (empty state) ===");
  await page.type('input[placeholder="search title or employer…"]', "zzzznomatch");
  await page.waitForFunction(() => document.body.textContent.includes("No specimens match"), { timeout: 3000 });
  const emptyStateVisible = await page.evaluate(() =>
    document.body.textContent.includes("No specimens match this combination"),
  );
  assert(emptyStateVisible, "shows empty-state message when search matches nothing");
  await clearSearch(page);
  await page.waitForFunction(() => document.querySelectorAll("article").length === 100, { timeout: 3000 });
  await settle(page);

  console.log("\n=== 4. Type filter ===");
  await clickButtonWithText(page, "Casual");
  await page.waitForFunction(() => document.querySelectorAll("article").length < 100, { timeout: 3000 });
  await settle(page);
  const casualCount = await page.$$eval("article", (els) => els.length);
  const allCasual = await page.$$eval("article", (els) =>
    els.every((el) => [...el.querySelectorAll(".bg-moss")].some((tag) => tag.textContent.trim() === "Casual")),
  );
  assert(casualCount === 9, `"Casual" type filter narrows to exactly 9 cards (got ${casualCount})`);
  assert(allCasual, "every visible card after Casual filter actually has a Casual tag");

  await clickButtonWithText(page, "All");
  await page.waitForFunction(() => document.querySelectorAll("article").length === 100, { timeout: 3000 });
  await settle(page);

  console.log("\n=== 5. Salary filter ===");
  await clickButtonWithText(page, "$120k+");
  await page.waitForFunction(() => document.querySelectorAll("article").length < 100, { timeout: 3000 });
  await settle(page);
  const salaryCount = await page.$$eval("article", (els) => els.length);
  const jobsData = JSON.parse(readFileSync(new URL("../data/jobs.json", import.meta.url), "utf8"));
  const expectedSalaryCount = jobsData.filter((j) => (j.salary_min ?? 0) >= 120000).length;
  assert(
    salaryCount === expectedSalaryCount,
    `"$120k+" salary filter shows exactly ${expectedSalaryCount} cards matching data (got ${salaryCount})`,
  );

  await clickButtonWithText(page, "Any");
  await page.waitForFunction(() => document.querySelectorAll("article").length === 100, { timeout: 3000 });
  await settle(page);

  console.log("\n=== 6. Keyword rail filter ===");
  await clickButtonWithText(page, "Registered Nurse");
  await page.waitForFunction(() => document.querySelectorAll("section").length === 1, { timeout: 3000 });
  await settle(page);
  const nurseArticles = await page.$$eval("article", (els) => els.length);
  assert(nurseArticles === 5, `keyword filter "Registered Nurse" shows exactly 5 cards (got ${nurseArticles})`);

  await clickButtonWithText(page, "All occupations");
  await page.waitForFunction(() => document.querySelectorAll("section").length === 20, { timeout: 3000 });
  await settle(page);

  console.log("\n=== 7. Combined filters -> empty state ===");
  await clickButtonWithText(page, "Chef");
  await page.waitForFunction(() => document.querySelectorAll("section").length === 1, { timeout: 3000 });
  await settle(page);
  await clickButtonWithText(page, "$160k+");
  await page.waitForFunction(() => document.body.textContent.includes("No specimens match"), { timeout: 3000 });
  const noChefOver160 = await page.evaluate(() =>
    document.body.textContent.includes("No specimens match this combination"),
  );
  assert(noChefOver160, "Chef + $160k+ combo correctly yields empty state (no chef job pays that much)");

  await clickButtonWithText(page, "Any");
  await clickButtonWithText(page, "All occupations");
  await page.waitForFunction(() => document.querySelectorAll("article").length === 100, { timeout: 3000 });
  await settle(page);

  console.log("\n=== 8. Read full listing expand/collapse ===");
  const firstCard = await page.$("article");
  const readBtn = await firstCard.evaluateHandle((card) =>
    [...card.querySelectorAll("button")].find((b) => b.textContent.includes("Read full listing")),
  );
  await readBtn.asElement().click();
  await settle(page, 400);
  const descriptionVisible = await firstCard.evaluate((card) =>
    [...card.querySelectorAll("button")].some((b) => b.textContent.includes("Hide full listing")),
  );
  assert(descriptionVisible, "clicking 'Read full listing' toggles to 'Hide full listing'");

  const descLength = await firstCard.evaluate((card) => {
    const els = [...card.querySelectorAll("div")];
    const descDiv = els.find((d) => d.className.includes("max-h-64"));
    return descDiv ? descDiv.textContent.length : 0;
  });
  assert(descLength > 100, `full description content is actually rendered (${descLength} chars)`);

  console.log("\n=== 9. Interview questions button (live UI -> API -> DB) ===");
  const qBtn = await firstCard.evaluateHandle((card) =>
    [...card.querySelectorAll("button")].find((b) => b.textContent.includes("Interview questions")),
  );
  await qBtn.asElement().click();
  await page
    .waitForFunction((card) => [...card.querySelectorAll("li")].length > 0, { timeout: 15000 }, firstCard)
    .catch(() => null);
  const questionItems = await firstCard.evaluate((card) => [...card.querySelectorAll("li")].map((li) => li.textContent));
  assert(questionItems.length === 4, `interview questions button loads exactly 4 questions (got ${questionItems.length})`);
  assert(questionItems.every((q) => q.length > 20), "each question is a substantive, non-empty string");
  assert(
    questionItems.some((q) => /Ebix|WinBEAT|insurance|broking/i.test(q)),
    "questions are actually tailored to this specific job (mentions Ebix/insurance context), not generic",
  );

  console.log("\n=== 10. Console errors ===");
  assert(consoleErrors.length === 0, `no browser console errors during entire test run (found ${consoleErrors.length})`);
  if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5));

  await browser.close();

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log("Failures:", failures);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
