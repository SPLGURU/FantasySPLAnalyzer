// netlify/functions/fetch-spl-data.js

exports.handler = async function(event, context) {
  // Use dynamic import for node-fetch (ESM)
  // This line replaces: const fetch = require('node-fetch');
  const { default: fetch } = await import('node-fetch');

  // Assuming the manager ID is passed as a query string parameter, e.g., /.netlify/functions/fetch-spl-data?id=4
  const managerId = event.queryStringParameters.id;

  // Basic validation for the manager ID
  if (!managerId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Manager ID is required.' }),
      headers: {
        "Content-Type": "application/json"
      }
    };
  }

  try {
    // IMPORTANT: Replace 'YOUR_SPL_DATA_API_URL_HERE' with the actual URL
    // of the SPL website or API endpoint you are trying to fetch data from.
    // Make sure to correctly append the managerId to the URL if needed.
    const response = await fetch(`YOUR_SPL_DATA_API_URL_HERE?id=${managerId}`);

    // Check if the HTTP request itself was successful
    if (!response.ok) {
      const errorText = await response.text(); // Get raw text for better error debugging
      console.error(`HTTP error! status: ${response.status}, response: ${errorText}`);
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: `Failed to fetch data from SPL. HTTP status: ${response.status}. Details: ${errorText.substring(0, 200)}...`
        }),
        headers: {
          "Content-Type": "application/json"
        }
      };
    }

    // Assuming the SPL website returns HTML, you'll likely process it as text
    const data = await response.text();

    // In a real scenario, you would parse the 'data' (e.g., using Cheerio for HTML, or JSON.parse if it's JSON)
    // and extract the relevant information before sending it back to your frontend.
    // For now, we're sending the raw fetched content back as a placeholder.
    // You might also want to set Content-Type header to 'text/html' if you're returning HTML.

    return {
      statusCode: 200,
      body: data, // Sending back the raw text/HTML received from the SPL site
      headers: {
        "Content-Type": "text/plain" // Or "text/html" if you expect HTML, or "application/json" if you parse to JSON
      }
    };
  } catch (error) {
    // Catch any network errors or errors during data processing
    console.error("Error during function execution:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An unexpected server error occurred: " + error.message }),
      headers: {
        "Content-Type": "application/json"
      }
    };
  }
};