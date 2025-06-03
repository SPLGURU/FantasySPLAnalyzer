// netlify/functions/fetch-spl-data.js

// Import node-fetch for making HTTP requests in a Node.js environment
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
    // Extract the manager ID from the query parameters
    const managerId = event.queryStringParameters.id;

    // Basic validation: ensure managerId is provided
    if (!managerId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Manager ID is required.' }),
        };
    }

    try {
        // --- 1. Fetch Manager Details ---
        const managerResponse = await fetch(`https://en.fantasy.spl.com.sa/api/entry/${managerId}/`);
        if (!managerResponse.ok) {
            throw new Error(`Failed to fetch manager data: ${managerResponse.statusText}`);
        }
        const managerData = await managerResponse.json();

        // --- 2. Fetch Global Bootstrap Data ---
        const bootstrapResponse = await fetch('https://en.fantasy.spl.com.sa/api/bootstrap-static/');
        if (!bootstrapResponse.ok) {
            throw new Error(`Failed to fetch bootstrap data: ${bootstrapResponse.statusText}`);
        }
        const bootstrapData = await bootstrapResponse.json(); // Corrected this line in previous fix
        const elements = bootstrapData.elements;

        // Create a Map for efficient player ID to name lookup
        const playerMap = new Map();
        elements.forEach(player => {
            playerMap.set(player.id, player.web_name || `${player.first_name} ${player.second_name}`);
        });

        // --- 3. Fetch Transfers Data with MORE Comprehensive Headers ---
        const transfersResponse = await fetch(`https://en.fantasy.spl.com.sa/entry/${managerId}/transfers`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                'Accept': 'application/json, text/plain, */*', // More common Accept header
                'Accept-Language': 'en-US,en;q=0.9', // Common Accept-Language
                'Referer': `https://en.fantasy.spl.com.sa/entry/${managerId}/`, // Mimic referrer from the page
                'DNT': '1', // Do Not Track header
                'Connection': 'keep-alive', // Keep connection alive
            }
        });

        // Check if the response is OK (status 200-299)
        if (!transfersResponse.ok) {
            // If not OK, log the status and potentially the response text for debugging
            const errorText = await transfersResponse.text(); // Get response body as text
            console.error(`Transfers fetch failed with status ${transfersResponse.status}: ${errorText}`);
            throw new Error(`Failed to fetch transfers data: ${transfersResponse.statusText}. Response: ${errorText.substring(0, 200)}...`); // Log more of the response
        }

        // Attempt to parse JSON. If it fails, the 'invalid json' error will be caught.
        const transfersRawData = await transfersResponse.json();

        // --- 4. Calculate Total Transfers Count ---
        const totalTransfersCount = transfersRawData.length;

        // --- 5. Calculate Total Hits (Points Deducted) ---
        let totalHitsCount = 0;
        const transfersPerEvent = {};

        transfersRawData.forEach(transfer => {
            if (!transfersPerEvent[transfer.event]) {
                transfersPerEvent[transfer.event] = 0;
            }
            transfersPerEvent[transfer.event]++;
        });

        for (const eventId in transfersPerEvent) {
            const transfersInThisEvent = transfersPerEvent[eventId];
            if (transfersInThisEvent > 1) {
                totalHitsCount += (transfersInThisEvent - 1);
            }
        }
        const totalHitsPoints = totalHitsCount * -4;

        // --- 6. Process Existing Data Points for Frontend ---
        const overallRank = managerData.entry.overall_rank !== undefined ? managerData.entry.overall_rank.toLocaleString() : 'N/A';

        let bestOverallRank = 'N/A';
        let worstOverallRank = 'N/A';
        if (managerData.history && managerData.history.length > 0) {
            const ranks = managerData.history.map(h => h.overall_rank).filter(rank => typeof rank === 'number');
            if (ranks.length > 0) {
                bestOverallRank = Math.min(...ranks).toLocaleString();
                worstOverallRank = Math.max(...ranks).toLocaleString();
            }
        }

        const overallRankHistory = managerData.history.map(h => ({
            round: h.event,
            rank: h.overall_rank
        }));

        let averagePoints = 'N/A';
        if (managerData.history && managerData.history.length > 0) {
            const totalPoints = managerData.history.reduce((sum, h) => sum + (h.points || 0), 0);
            const totalRoundsWithPoints = managerData.history.filter(h => h.points !== undefined).length;
            if (totalRoundsWithPoints > 0) {
                averagePoints = (totalPoints / totalRoundsWithPoints).toFixed(2);
            }
        }
        
        const averagePointsFor1stPlace = 'N/A'; // Still needs a separate API if accurate data is desired

        const top3Captains = [];
        const bestPlayers = [];
        const worstPlayers = [];
        const top5MissedPoints = [];

        // --- 7. Return Combined Data as JSON ---
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({
                overallRankHistory: overallRankHistory,
                overallRank: overallRank,
                bestOverallRank: bestOverallRank,
                worstOverallRank: worstOverallRank,
                averagePoints: averagePoints,
                averagePointsFor1stPlace: averagePointsFor1stPlace,
                top3Captains: top3Captains,
                bestPlayers: bestPlayers,
                worstPlayers: worstPlayers,
                top5MissedPoints: top5MissedPoints,
                totalTransfersCount: totalTransfersCount,
                totalHitsPoints: totalHitsPoints
            })
        };

    } catch (error) {
        console.error('Error in Netlify function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error', details: error.message }),
        };
    }
};