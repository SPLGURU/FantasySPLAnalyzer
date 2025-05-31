// TEMPORARY LINE FOR GIT DEBUG - PLEASE DELETE AFTER COMMIT
exports.handler = async function(event, context) {
  console.log('Function started.');
  // ... rest of your function code ...
};

// netlify/functions/fetch-spl-data.js

exports.handler = async function(event, context) {
  console.log('Function started.'); // Log 1

  // Try a different way to import node-fetch, just in case
  let fetch;
  try {
    fetch = (await import('node-fetch')).default;
    console.log('node-fetch imported successfully.'); // Log 2
  } catch (importError) {
    console.error('Error importing node-fetch:', importError.message); // Log for import failure
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to import node-fetch: ${importError.message}` }),
      headers: { "Content-Type": "application/json" }
    };
  }

  const managerId = event.queryStringParameters.id;
  const dataType = event.queryStringParameters.type;

  console.log(`Received request: managerId=<span class="math-inline">\{managerId\}, dataType\=</span>{dataType}`); // Log 3

  if (!managerId) {
    console.warn('Manager ID is missing.'); // Log 4
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Manager ID is required.' }),
      headers: { "Content-Type": "application/json" }
    };
  }

  let targetUrl;
  if (dataType === 'entry') {
    targetUrl = `https://en.fantasy.spl.com.sa/entry/${managerId}`;
  } else if (dataType === 'history') {
    targetUrl = `https://en.fantasy.spl.com.sa/entry/${managerId}/history`;
  } else {
    console.warn('Invalid data type requested.'); // Log 5
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid data type requested. Must be "entry" or "history".' }),
      headers: { "Content-Type": "application/json" }
    };
  }

  console.log(`Fetching from targetUrl: ${targetUrl}`); // Log 6

  try {
    const response = await fetch(targetUrl);
    console.log(`Fetch response status: ${response.status}`); // Log 7

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`HTTP error from SPL site: status: ${response.status}, response: ${errorText}`); // Log 8
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: `Failed to fetch ${dataType} data from SPL. HTTP status: ${response.status}. Details: ${errorText.substring(0, Math.min(errorText.length, 200))}...`
        }),
        headers: { "Content-Type": "application/json" }
      };
    }

    const data = await response.text();
    console.log('Data fetched successfully, returning HTML.'); // Log 9
    return {
      statusCode: 200,
      body: data,
      headers: { "Content-Type": "text/html" }
    };
  } catch (error) {
    console.error(`Error during function execution:`, error); // Log 10
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `An unexpected server error occurred: ${error.message}` }),
      headers: { "Content-Type": "application/json" }
    };
  }
};