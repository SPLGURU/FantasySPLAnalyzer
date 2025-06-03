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
    let historyData = null; // New variable for historical data

    try {
        // --- 1. Fetch Manager Details ---
        const managerApiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/`;
        console.log(`Fetching manager data from: ${managerApiUrl}`);
        const managerResponse = await fetch(managerApiUrl);
        
        if (!managerResponse.ok) {
            const errorText = await managerResponse.text();
            console.error(`Manager data fetch failed with status ${managerResponse.status}: ${errorText.substring(0, 200)}...`);
            throw new Error(`Failed to fetch manager data: ${managerResponse.statusText}. Status: ${managerResponse.status}. Response: ${errorText.substring(0, 100)}...`);
        }
        managerData = await managerResponse.json();
        console.log('Successfully fetched manager data.');
        // console.log(JSON.stringify(managerData, null, 2)); // Keep for debugging if needed, but usually not necessary in production

        // --- 2. Fetch Global Bootstrap Data ---
        const bootstrapApiUrl = 'https://en.fantasy.spl.com.sa/api/bootstrap-static/';
        console.log(`Fetching bootstrap data from: ${bootstrapApiUrl}`);
        const bootstrapResponse = await fetch(bootstrapApiUrl);
        
        if (!bootstrapResponse.ok) {
            const errorText = await bootstrapResponse.text();
            console.error(`Bootstrap data fetch failed with status ${bootstrapResponse.status}: ${errorText.substring(0, 200)}...`);
            throw new Error(`Failed to fetch bootstrap data: ${bootstrapResponse.statusText}. Status: ${bootstrapResponse.status}. Response: ${errorText.substring(0, 100)}...`);
        }
        bootstrapData = await bootstrapResponse.json();
        console.log('Successfully fetched bootstrap data.');
        // console.log(JSON.stringify(bootstrapData, null, 2)); // Keep for debugging if needed

        // Ensure elements exist before trying to map (from bootstrapData)
        const elements = bootstrapData && bootstrapData.elements ? bootstrapData.elements : [];

        // Create a Map for efficient player ID to name lookup (kept for other potential uses)
        const playerMap = new Map();
        elements.forEach(player => {
            playerMap.set(player.id, player.web_name || `${player.first_name} ${player.second_name}`);
        });

        // --- 3. Fetch Manager History Data (NEW API CALL) ---
        const historyApiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/history/`;
        console.log(`Fetching manager history data from: ${historyApiUrl}`);
        const historyResponse = await fetch(historyApiUrl);

        if (!historyResponse.ok) {
            const errorText = await historyResponse.text();
            console.error(`Manager history data fetch failed with status ${historyResponse.status}: ${errorText.substring(0, 200)}...`);
            throw new Error(`Failed to fetch manager history data: ${historyResponse.statusText}. Status: ${historyResponse.status}. Response: ${errorText.substring(0, 100)}...`);
        }
        historyData = await historyResponse.json();
        console.log('Successfully fetched manager history data.');
        // console.log(JSON.stringify(historyData, null, 2)); // Keep for debugging if needed

        // --- Transfers Data (Still N/A as per previous conclusion) ---
        const totalTransfersCount = 'N/A';
        const totalHitsPoints = 'N/A';

        // --- 4. Process Data Points for Frontend ---
        // Corrected access for overallRank (directly from managerData)
        const overallRank = (managerData && managerData.summary_overall_rank !== undefined) 
                            ? managerData.summary_overall_rank.toLocaleString() 
                            : 'N/A';
        console.log(`Calculated overallRank: ${overallRank}`);

        let bestOverallRank = 'N/A';
        let worstOverallRank = 'N/A';
        let overallRankHistory = [];
        let averagePoints = 'N/A';

        // Use historyData for rank history and average points
        if (historyData && historyData.past && historyData.past.length > 0) {
            // The 'past' array in history data contains overall_rank for each season
            // However, for round-by-round history, we need the 'current' array
            // Let's assume 'current' contains round-by-round history as per typical FPL APIs
            const currentHistory = historyData.current || []; 

            if (currentHistory.length > 0) {
                overallRankHistory = currentHistory.map(h => ({
                    round: h.event,
                    rank: h.overall_rank
                }));

                const ranks = currentHistory.map(h => h.overall_rank).filter(rank => typeof rank === 'number');
                if (ranks.length > 0) {
                    bestOverallRank = Math.min(...ranks).toLocaleString();
                    worstOverallRank = Math.max(...ranks).toLocaleString();
                }

                const totalPoints = currentHistory.reduce((sum, h) => sum + (h.points || 0), 0);
                const totalRoundsWithPoints = currentHistory.filter(h => h.points !== undefined).length;
                if (totalRoundsWithPoints > 0) {
                    averagePoints = (totalPoints / totalRoundsWithPoints).toFixed(2);
                }
            }
        }
        console.log(`Calculated bestOverallRank: ${bestOverallRank}, worstOverallRank: ${worstOverallRank}`);
        console.log(`Overall Rank History length: ${overallRankHistory.length}`);
        console.log(`Calculated averagePoints: ${averagePoints}`);
        
        const averagePointsFor1stPlace = 'N/A'; // Still needs a specific API if accurate data is desired

        // Placeholders for other tables (Captaincy, Best/Worst Players, Missed Points)
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
        } else if (error.message.includes('Failed to fetch manager history data')) {
            errorMessage = `Could not load manager history data. (${error.message})`;
        } else if (error.message.includes('Unexpected token')) {
            errorMessage = `Data format error from SPL API. (${error.message})`;
        }
        
        return {
            statusCode: 500,
            body: JSON.stringify({ error: errorMessage, details: error.message }),
        };
    }
};