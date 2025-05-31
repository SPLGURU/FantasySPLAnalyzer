// netlify/functions/fetch-spl-data.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

exports.handler = async function(event, context) {
  const managerId = event.queryStringParameters.id;

  if (!managerId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Manager ID is required.' }),
      headers: { "Content-Type": "application/json" }
    };
  }

  let browser = null;
  let page = null;
  const startTime = Date.now(); // Start timing for the entire function

  try {
    console.log(`Function started for ID: ${managerId}`);

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    console.log(`Browser launched in ${Date.now() - startTime} ms.`);

    page = await browser.newPage();
    const url = `https://en.fantasy.spl.com.sa/entry/${managerId}/history`;

    console.log(`Navigating to ${url}`);
    await page.goto(url, {
      waitUntil: 'domcontentloaded', // Keep 'domcontentloaded'
      timeout: 20000 // Give page.goto up to 20 seconds, though function still times out at 10s
    });
    console.log(`Page loaded (domcontentloaded) in ${Date.now() - startTime} ms.`);

    // Wait for the specific element containing the rank to ensure dynamic content is rendered
    // Reduced this timeout to be aggressive and ensure it finishes within the 10s window.
    await page.waitForSelector('span.Entry__BoldText-sc-3fiqhf-9', { timeout: 5000 }); // Try a 5-second timeout
    console.log(`Required selector found in ${Date.now() - startTime} ms (total).`);

    const outcomes = await page.evaluate(() => {
        const overallRankElement = document.querySelector('span.Entry__BoldText-sc-3fiqhf-9');
        const overallRank = overallRankElement ? overallRankElement.textContent.trim() : 'Not found';

        // Placeholder for Most Captained Player - this logic will be more complex later
        const mostCaptainedPlayer = 'Logic for Most Captained Player not yet implemented';

        return { overallRank, mostCaptainedPlayer };
    });

    console.log(`Data extracted in ${Date.now() - startTime} ms (total).`);

    return {
      statusCode: 200,
      body: JSON.stringify(outcomes),
      headers: { "Content-Type": "application/json" }
    };

  } catch (error) {
    console.error(`Puppeteer function error (total time: ${Date.now() - startTime} ms):`, error);
    // Be more specific with error message if timeout occurs
    if (error.name === 'TimeoutError') {
         return {
            statusCode: 504, // Gateway Timeout
            body: JSON.stringify({ error: `Function timed out before data could be extracted. The SPL website may be slow or the request limit for the free tier is exceeded. (Total time: ${Date.now() - startTime} ms)` }),
            headers: { "Content-Type": "application/json" }
         };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to fetch data: ${error.message}. This might be due to an invalid Manager ID, or changes on the SPL website. (Total time: ${Date.now() - startTime} ms)` }),
      headers: { "Content-Type": "application/json" }
    };
  } finally {
    if (browser !== null) {
      await browser.close();
      console.log(`Browser closed after ${Date.now() - startTime} ms (total).`);
    }
  }
};