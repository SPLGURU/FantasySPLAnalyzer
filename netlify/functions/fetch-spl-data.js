// netlify/functions/fetch-spl-data.js

exports.handler = async function(event, context) {
  // Use dynamic import for node-fetch (ESM)
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
    // --- THIS IS THE MODIFIED URL LINE ---
    // Using the URL you provided, with managerId inserted into the path
    const response = await fetch(`https://en.fantasy.spl.com.sa/entry/${managerId}/history`);

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

    // Assuming the SPL website returns HTML, you'll read it as text
    const data = await response.text();

    // In a real application, you would now parse this 'data' (HTML)
    // using a library like Cheerio to extract the performance metrics.
    // For now, we're returning the raw HTML content.

    return {
      statusCode: 200,
      body: data, // Sending back the raw HTML received from the SPL site
      headers: {
        "Content-Type": "text/html" // Changed to text/html as we are returning HTML
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