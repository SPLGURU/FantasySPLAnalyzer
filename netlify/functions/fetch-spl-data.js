// netlify/functions/fetch-spl-data.js
const fetch = require('node-fetch'); // Import node-fetch

exports.handler = async function(event, context) {
  const managerId = event.queryStringParameters.id;

  if (!managerId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Manager ID is required.' }),
      headers: { "Content-Type": "application/json" }
    };
  }

  const apiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/`;
  console.log(`Fetching data from API: ${apiUrl}`);

  try {
    const response = await fetch(apiUrl);

    if (!response.ok) {
      // If the response is not OK (e.g., 404, 500), throw an error
      const errorText = await response.text();
      console.error(`API response not OK: ${response.status} - ${errorText}`);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Failed to fetch data from API. Status: ${response.status}. Message: ${errorText.substring(0, 200)}` }),
        headers: { "Content-Type": "application/json" }
      };
    }

    const data = await response.json(); // Parse the JSON response
    console.log('API data fetched successfully. Full JSON data:', JSON.stringify(data, null, 2)); // Log the full JSON for inspection

    // --- Data Extraction from API Response ---
    // The overall rank is located at data.summary_overall_rank.
    const overallRank = data.summary_overall_rank;

    // 'mostCaptainedPlayer' is not present in the provided JSON data.
    const mostCaptainedPlayer = 'Most Captained Player data not available in this API response.';

    return {
      statusCode: 200,
      body: JSON.stringify({ overallRank, mostCaptainedPlayer }),
      headers: { "Content-Type": "application/json" }
    };

  } catch (error) {
    console.error(`Error fetching data from API:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to fetch data: ${error.message}. Please check the Manager ID or if the SPL API has changed.` }),
      headers: { "Content-Type": "application/json" }
    };
  }
};