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
  let page = null;

  try {
    // Launch the headless browser
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    page = await browser.newPage();
    const url = `https://en.fantasy.spl.com.sa/entry/${managerId}/history`;

    console.log(`Navigating to ${url}`);
    // --- CHANGE HERE: Changed waitUntil to 'domcontentloaded' ---
    await page.goto(url, {
      waitUntil: 'domcontentloaded', // Wait until the initial HTML and DOM are loaded
      timeout: 60000 // 60 seconds timeout for page load (still generous)
    });
    console.log('Page loaded.');

    // Wait for the specific element containing the rank to ensure dynamic content is rendered
    await page.waitForSelector('span.Entry__BoldText-sc-3fiqhf-9', { timeout: 10000 }); // Still wait for the content itself
    console.log('Required selector found.');

    // Use page.evaluate to run JavaScript directly in the browser context
    const outcomes = await page.evaluate(() => {
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