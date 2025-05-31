// netlify/functions/fetch-spl-data.js
const fetch = require('node-fetch'); // Import node-fetch

exports.handler = async function(event, context) {
  // Ensure the ID is correctly extracted from event.queryStringParameters.id
  const managerId = event.queryStringParameters.id;

  if (!managerId || typeof managerId !== 'string' || !/^\d+$/.test(managerId)) {
    console.error('Invalid managerId received:', managerId);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Manager ID is required and must be a valid number.' }),
      headers: { "Content-Type": "application/json" }
    };
  }

  // --- CORRECTED API URL ---
  const apiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/`;
  console.log(`Fetching data from CORRECTED API URL: ${apiUrl}`);

  try {
    const response = await fetch(apiUrl);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API response not OK: ${response.status} - ${errorText.substring(0, 500)}`);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Failed to fetch data from API. Status: ${response.status}. Message: ${errorText.substring(0, 200)}` }),
        headers: { "Content-Type": "application/json" }
      };
    }

    const data = await response.json();
    console.log('API data fetched successfully. Full JSON data:', JSON.stringify(data, null, 2));

    // --- Data Extraction from API Response (PLACEHOLDERS STILL) ---
    // YOU MUST ADJUST THESE SELECTORS based on the actual JSON response structure
    // that you will see in the Netlify logs (from the console.log above).
    // For now, using placeholders until you provide the full JSON.
    const overallRank = 'Adjust this based on actual JSON path'; 
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