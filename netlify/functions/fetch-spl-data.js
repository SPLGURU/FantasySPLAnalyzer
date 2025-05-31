// netlify/functions/fetch-spl-data.js

exports.handler = async function(event, context) {
  // Dynamically import node-fetch (required for Netlify functions to use ES Modules)
  const { default: fetch } = await import('node-fetch');

  const managerId = event.queryStringParameters.id;
  const dataType = event.queryStringParameters.type; // Get the 'type' parameter (e.g., 'entry', 'history')

  // Basic validation for managerId
  if (!managerId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Manager ID is required.' }),
      headers: { "Content-Type": "application/json" }
    };
  }

  let targetUrl;
  // Determine the target URL based on the 'type' parameter from the frontend
  if (dataType === 'entry') {
    // This URL is likely for the main manager entry page where overall rank is found
    targetUrl = `https://en.fantasy.spl.com.sa/entry/${managerId}`;
  } else if (dataType === 'history') {
    // This URL is for the manager's history page where captain data is found
    targetUrl = `https://en.fantasy.spl.com.sa/entry/${managerId}/history`;
  } else {
    // Return an error if an unknown type is requested
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid data type requested. Must be "entry" or "history".' }),
      headers: { "Content-Type": "application/json" }
    };
  }

  try {
    // Make the fetch request to the determined target URL
    const response = await fetch(targetUrl);

    // If the HTTP response was not OK (e.g., 404, 500 from SPL site)
    if (!response.ok) {
      const errorText = await response.text(); // Get potential error message from SPL site
      console.error(`HTTP error fetching ${dataType} data from SPL: status: ${response.status}, response: ${errorText}`);
      return {
        statusCode: response.status, // Pass through the SPL site's status code
        body: JSON.stringify({
          error: `Failed to fetch ${dataType} data from SPL. HTTP status: ${response.status}. Details: ${errorText.substring(0, Math.min(errorText.length, 200))}...` // Return partial error text
        }),
        headers: { "Content-Type": "application/json" }
      };
    }

    // Get the HTML content as text from the successful response
    const data = await response.text();

    // Return the HTML content to the frontend
    return {
      statusCode: 200,
      body: data, // Sending back the raw HTML
      headers: { "Content-Type": "text/html" } // Important: Tell the browser it's HTML
    };
  } catch (error) {
    // Catch any network errors or other unexpected issues during execution
    console.error(`Error during function execution for ${dataType} data:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `An unexpected server error occurred while fetching ${dataType} data: ${error.message}` }),
      headers: { "Content-Type": "application/json" }
    };
  }
};