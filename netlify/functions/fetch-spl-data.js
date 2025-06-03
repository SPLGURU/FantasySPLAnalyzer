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

    let managerData = null;
    let bootstrapData = null;

    try {
        // --- 1. Fetch Manager Details ---
        const managerResponse = await fetch(`https://en.fantasy.spl.com.sa/api/entry/${managerId}/`);
        if (!managerResponse.ok) {
            throw new Error(`Failed to fetch manager data: ${managerResponse.statusText}. Status: ${managerResponse.status}`);
        }
        managerData = await managerResponse.json();

        // --- 2. Fetch Global Bootstrap Data ---
        const bootstrapResponse = await fetch('https://en.fantasy.spl.com.sa/api/bootstrap-static/');
        if (!bootstrapResponse.ok) {
            throw new Error(`Failed to fetch bootstrap data: ${bootstrapResponse.statusText}. Status: ${bootstrapResponse.status}`);
        }
        bootstrapData = await bootstrapResponse.json();
        
        const elements = bootstrapData && bootstrapData.elements ? bootstrapData.elements : [];

        // Create a Map for efficient player ID to name lookup (kept for other potential uses)
        const playerMap = new Map();
        elements.forEach(player => {
            playerMap.set(player.id, player.web_name || `${player.first_name} ${player.second_name}`);
        });

        // --- 3. Fetch Transfers Data and Calculate Total Transfers and Hits ---
        let transfersRawData = [];
        let totalTransfersCount = 'N/A';
        let totalHitsPoints = 'N/A';

        try {
            const transfersResponse = await fetch(`https://en.fantasy.spl.com.sa/entry/${managerId}/transfers`, {
                headers: {
                    // Mimic a browser request as closely as possible
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*', // Request JSON explicitly
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': `https://en.fantasy.spl.com.sa/entry/${managerId}/`, // Important for some APIs
                    'DNT': '1', // Do Not Track
                    'Connection': 'keep-alive',
                    'X-Requested-With': 'XMLHttpRequest', // Often sent by JS frameworks for AJAX requests
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Dest': 'empty', // Or 'document' if it's a page load
                    'Sec-Fetch-Site': 'same-origin', // Or 'cross-site' if fetching from different domain
                },
                // Removed `redirect: 'manual'` to allow following redirects, as the HTML response
                // could be a redirect to an error page. If it's HTML directly, this won't change.
            });

            if (transfersResponse.ok) {
                const responseText = await transfersResponse.text(); // Get as text first to inspect
                try {
                    transfersRawData = JSON.parse(responseText); // Try parsing as JSON
                    
                    // Calculate Total Transfers
                    totalTransfersCount = transfersRawData.length;

                    // Calculate Total Hits
                    let hitsCount = 0;
                    const transfersPerEvent = {};

                    transfersRawData.forEach(transfer => {
                        if (!transfersPerEvent[transfer.event]) {
                            transfersPerEvent[transfer.event] = 0;
                        }
                        transfersPerEvent[transfer.event]++;
                    });

                    for (const eventId in transfersPerEvent) {
                        const transfersInThisEvent = transfersPerEvent[eventId];
                        if (transfersInThisEvent > 1) { // First transfer is free
                            hitsCount += (transfersInThisEvent - 1);
                        }
                    }
                    totalHitsPoints = hitsCount * -4;

                } catch (jsonParseError) {
                    // If JSON parsing fails, it means we got HTML or malformed JSON
                    console.error('Transfers API returned non-JSON content:', responseText.substring(0, 500));
                    console.error('Error parsing transfers JSON:', jsonParseError);
                    // Keep totalTransfersCount and totalHitsPoints as 'N/A'
                }
            } else {
                const errorText = await transfersResponse.text();
                console.error(`Transfers fetch failed with status ${transfersResponse.status}: ${errorText.substring(0, 200)}...`);
                // If it's a redirect, status will be 302/301. Log the Location header if present.
                if (transfersResponse.headers.get('location')) {
                    console.error(`Redirect detected to: ${transfersResponse.headers.get('location')}`);
                }
                // Keep totalTransfersCount and totalHitsPoints as 'N/A'
            }
        } catch (transfersFetchError) {
            console.error('Error during transfers data fetch (network or unexpected issue):', transfersFetchError);
            // Keep totalTransfersCount and totalHitsPoints as 'N/A'
        }

        // --- 4. Process Existing Data Points for Frontend ---
        const overallRank = (managerData && managerData.entry && managerData.entry.overall_rank !== undefined) 
                            ? managerData.entry.overall_rank.toLocaleString() 
                            : 'N/A';

        let bestOverallRank = 'N/A';
        let worstOverallRank = 'N/A';
        if (managerData && managerData.history && managerData.history.length > 0) {
            const ranks = managerData.history.map(h => h.overall_rank).filter(rank => typeof rank === 'number');
            if (ranks.length > 0) {
                bestOverallRank = Math.min(...ranks).toLocaleString();
                worstOverallRank = Math.max(...ranks).toLocaleString();
            }
        }

        const overallRankHistory = (managerData && managerData.history) 
                                   ? managerData.history.map(h => ({
                                       round: h.event,
                                       rank: h.overall_rank
                                   })) 
                                   : [];

        let averagePoints = 'N/A';
        if (managerData && managerData.history && managerData.history.length > 0) {
            const totalPoints = managerData.history.reduce((sum, h) => sum + (h.points || 0), 0);
            const totalRoundsWithPoints = managerData.history.filter(h => h.points !== undefined).length;
            if (totalRoundsWithPoints > 0) {
                averagePoints = (totalPoints / totalRoundsWithPoints).toFixed(2);
            }
        }
        
        const averagePointsFor1stPlace = 'N/A'; // This still needs a separate API if accurate data is desired

        const top3Captains = [];
        const bestPlayers = [];
        const worstPlayers = [];
        const top5MissedPoints = [];

        // --- 5. Return Combined Data as JSON ---
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
        console.error('Error in Netlify function (main try-catch):', error);
        let errorMessage = 'An unexpected error occurred. Please try again later.';
        if (error.message.includes('Failed to fetch manager data')) {
            errorMessage = `Could not find manager data. Please check the Manager ID. (${error.message})`;
        } else if (error.message.includes('Failed to fetch bootstrap data')) {
            errorMessage = `Could not load global player data. (${error.message})`;
        } else if (error.message.includes('Unexpected token')) {
            errorMessage = `Data format error from SPL API. (${error.message})`;
        }
        
        return {
            statusCode: 500,
            body: JSON.stringify({ error: errorMessage, details: error.message }),
        };
    }
};