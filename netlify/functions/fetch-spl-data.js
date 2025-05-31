// netlify/functions/fetch-spl-data.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

exports.handler = async function(event, context) {
  const managerId = event.queryStringParameters.id;
  const dataType = event.queryStringParameters.type; // We'll mainly focus on 'history' as it's the only working URL

  if (!managerId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Manager ID is required.' }),
      headers: { "Content-Type": "application/json" }
    };
  }

  let browser = null;
  let page = null; // Initialize page outside try block

  try {
    // Launch the headless browser
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true, // Be cautious with this in production, but often needed for scraping
    });

    page = await browser.newPage();
    const url = `https://en.fantasy.spl.com.sa/entry/${managerId}/history`;

    console.log(`Navigating to ${url}`);
    await page.goto(url, {
      waitUntil: 'networkidle0', // Wait until no more than 0 network connections for at least 500ms
      timeout: 60000 // 60 seconds timeout for page load
    });
    console.log('Page loaded.');

    // Wait for a specific selector to ensure content is rendered
    // Adjust this selector if the main content area changes, but 'root' is usually safe.
    // We'll wait for the span containing the rank, as it's a specific element we need.
    await page.waitForSelector('span.Entry__BoldText-sc-3fiqhf-9', { timeout: 10000 });
    console.log('Required selector found.');

    // Get the full HTML content of the page after JavaScript has rendered it
    const renderedHtml = await page.content();
    // console.log('Rendered HTML snippet:', renderedHtml.substring(0, 500)); // Log a snippet for debugging

    // Use DOMParser on the rendered HTML to extract data
    const parser = new DOMParser(); // DOMParser is available in Node.js via 'jsdom' if you were not running in a browser context.
                                   // However, in this serverless function context, we need to correctly import it or use Puppeteer's page.evaluate.
                                   // Let's use page.evaluate for robustness as it runs in the browser context.

    const outcomes = await page.evaluate(() => {
        // This code runs in the context of the browser page (Puppeteer)
        const overallRankElement = document.querySelector('span.Entry__BoldText-sc-3fiqhf-9');
        const overallRank = overallRankElement ? overallRankElement.textContent.trim() : 'Not found';

        // Placeholder for Most Captained Player - this logic will be more complex later
        const mostCaptainedPlayer = 'Logic for Most Captained Player not yet implemented';

        return { overallRank, mostCaptainedPlayer };
    });

    return {
      statusCode: 200,
      body: JSON.stringify(outcomes),
      headers: { "Content-Type": "application/json" }
    };

  } catch (error) {
    console.error(`Puppeteer function error:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to fetch data: ${error.message}. This might be due to a timeout, an invalid Manager ID, or changes on the SPL website.` }),
      headers: { "Content-Type": "application/json" }
    };
  } finally {
    if (browser !== null) {
      await browser.close();
      console.log('Browser closed.');
    }
  }
};