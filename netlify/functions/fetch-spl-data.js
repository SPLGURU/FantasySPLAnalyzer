// netlify/functions/fetch-spl-data.js

const fetch = require('node-fetch'); // Netlify Functions support node-fetch automatically

exports.handler = async function(event, context) {
  // Extract the manager ID and type (entry or history) from the path
  // The path will look like /.netlify/functions/fetch-spl-data?id=4&type=entry
  const managerId = event.queryStringParameters.id;
  const dataType = event.queryStringParameters.type; // 'entry' or 'history'

  if (!managerId || !dataType) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing manager ID or data type.' }),
    };
  }

  let apiUrl = '';
  if (dataType === 'entry') {
    apiUrl = `https://en.fantasy.spl.com.sa/entry/${managerId}`;
  } else if (dataType === 'history') {
    apiUrl = `https://en.fantasy.spl.com.sa/entry/${managerId}/history`;
  } else {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid data type specified.' }),
    };
  }

  try {
    const response = await fetch(apiUrl);

    if (!response.ok) {
      // If the external fetch failed, propagate the error status
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Failed to fetch from external SPL API: ${response.statusText}` }),
      };
    }

    const htmlContent = await response.text();

    return {
      statusCode: 200,
      body: htmlContent, // Return the raw HTML content
      headers: {
        'Content-Type': 'text/html', // Indicate that we're returning HTML
        'Access-Control-Allow-Origin': '*', // IMPORTANT: Allow your Netlify site to access this function
        'Access-Control-Allow-Methods': 'GET',
      },
    };
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error during fetch.', details: error.message }),
    };
  }
};