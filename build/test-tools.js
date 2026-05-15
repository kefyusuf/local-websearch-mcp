import { chromium } from "playwright";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
async function test() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const turndown = new TurndownService();
    console.log("--- Testing Web Search (Brave Search) ---");
    const query = "Model Context Protocol";
    const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    try {
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForSelector("div.snippet", { timeout: 10000 });
    }
    catch (e) {
        console.log("Results not found, taking screenshot...");
        await page.screenshot({ path: "brave-fail.png" });
        throw e;
    }
    const results = await page.$$eval("div.snippet", (elements) => {
        return elements.slice(0, 3).map((el) => {
            const titleEl = el.querySelector(".title");
            const linkEl = el.querySelector("a");
            return {
                title: titleEl?.textContent?.trim() || "",
                url: linkEl?.href || "",
            };
        }).filter(r => r.title && r.url);
    });
    console.log("Search Results:", JSON.stringify(results, null, 2));
    if (results.length > 0) {
        console.log("\n--- Testing Fetch Content ---");
        const testUrl = results[0].url;
        console.log(`Fetching: ${testUrl}`);
        const response = await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        const buffer = await response?.body();
        const html = buffer?.toString('utf-8') || "";
        const dom = new JSDOM(html, { url: testUrl });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        if (article && article.content) {
            const markdown = turndown.turndown(article.content);
            console.log("Title:", article.title);
            console.log("Markdown Preview (first 500 chars):", markdown.substring(0, 500));
        }
        else {
            console.log("Failed to parse article.");
        }
    }
    await browser.close();
}
test().catch(console.error);
