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
    // You found your rank in the response for /api/entry/4/.
    // Now, you NEED TO ADJUST THESE SELECTORS based on the actual JSON response structure
    // that you'll see in the Netlify logs (from the console.log above).
    
    // Example: If the JSON looks like { "entry": { "overall_rank": 487 } }
    // const overallRank = data.entry.overall_rank;
    // Example: If the JSON looks like { "rank": { "overall": 487 } }
    // const overallRank = data.rank.overall;
    // For now, using a placeholder, but you MUST replace this.
    const overallRank = 'Adjust this based on actual JSON path'; 
    
    // For 'Most Captained Player', you'll need to inspect the full JSON response.
    // It's likely in an array of gameweeks/rounds or a 'history' section.
    // For now, using a placeholder, but you MUST replace this.
    const mostCaptainedPlayer = 'Adjust this based on actual JSON path for captained player';


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