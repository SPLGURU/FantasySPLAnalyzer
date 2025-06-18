// Vercel Serverless Function: api/fetch-spl-data.js
// This function fetches SPL Fantasy League data based on a manager ID.
// It's designed to be deployed as a Vercel Serverless Function.

// Require node-fetch for making HTTP requests
const fetch = require('node-fetch');

module.exports = async (request, response) => {
    // Set CORS headers to allow requests from your frontend on any domain.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests (OPTIONS method)
    if (request.method === 'OPTIONS') {
        return response.status(200).send();
    }

    try {
        // Extract the manager ID from the query parameters
        const managerId = request.query.id;

        if (!managerId) {
            console.error("Vercel Function Error: Manager ID is missing from query parameters.");
            return response.status(400).json({ error: 'Manager ID is required.' });
        }

        console.log(`Vercel Function: Fetching SPL data for ID: ${managerId}`);

        // Construct the URL for the external SPL API directly.
        // As per your clarification, this public API does NOT require an API key or authorization header.
        const apiUrl = `https://www.fantasy-spl.com/api/rank/${managerId}`; 
        
        // Make the request to the external SPL API without any authorization headers
        const splResponse = await fetch(apiUrl); // Removed fetchOptions as no headers are needed

        if (!splResponse.ok) {
            const errorText = await splResponse.text();
            console.error(`Vercel Function Error: External SPL API responded with status ${splResponse.status}: ${errorText}`);
            return response.status(splResponse.status).json({
                error: `Failed to fetch SPL data from external API: ${splResponse.statusText}`,
                details: errorText
            });
        }

        const splData = await splResponse.json();

        // Extract the overall rank (adjust this based on actual SPL API response structure)
        const overallRank = splData.overallRank !== undefined ? splData.overallRank : 'N/A';

        console.log(`Vercel Function: Successfully fetched rank for ${managerId}: ${overallRank}`);

        // Send the rank back to the client
        response.status(200).json({ overallRank });

    } catch (error) {
        console.error('Vercel Function Error: Catch block caught an exception:', error);
        // Send a generic error response to the client
        response.status(500).json({ error: 'Internal Server Error processing request.', details: error.message });
    }
};
