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

        console.log(`Vercel Function: Attempting to fetch SPL data for ID: ${managerId}`);

        // CONTAINS THE CRITICAL FIX: Corrected the external SPL API domain.
        // Assuming the path remains /api/rank/ for manager ID. If this path changes for the new domain,
        // please provide a full example URL from the new domain.
        const apiUrl = `https://en.fantasy.spl.com.sa/api/rank/${managerId}`; 
        console.log(`Vercel Function: Calling external SPL API URL: ${apiUrl}`);

        const splResponse = await fetch(apiUrl);
        console.log(`Vercel Function: External SPL API Response Status: ${splResponse.status}`);
        console.log(`Vercel Function: External SPL API Response StatusText: ${splResponse.statusText}`);
        
        const responseHeaders = {};
        splResponse.headers.forEach((value, name) => {
            responseHeaders[name] = value;
        });
        console.log("Vercel Function: External SPL API Response Headers:", responseHeaders);

        if (!splResponse.ok) {
            const errorText = await splResponse.text();
            console.error(`Vercel Function Error: External SPL API responded with non-OK status ${splResponse.status}: ${errorText}`);
            return response.status(splResponse.status).json({
                error: `Failed to fetch SPL data from external API: ${splResponse.statusText || 'Unknown Status'}`,
                details: errorText 
            });
        }

        const splData = await splResponse.json();
        console.log("Vercel Function: Raw SPL Data received:", splData); 

        // Extract the overall rank (adjust this based on actual SPL API response structure)
        const overallRank = splData.overallRank !== undefined ? splData.overallRank : 'N/A';

        console.log(`Vercel Function: Successfully extracted rank for ${managerId}: ${overallRank}`);

        // Send the rank back to the client
        response.status(200).json({ overallRank });

    } catch (error) {
        console.error('Vercel Function Error: Catch block caught an exception:', error);
        response.status(500).json({ error: 'Internal Server Error processing request.', details: error.message });
    }
};
