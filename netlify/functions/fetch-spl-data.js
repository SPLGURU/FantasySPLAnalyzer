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

    let managerData = null; // Initialize managerData to null
    let bootstrapData = null; // Initialize bootstrapData to null

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
        console.log('Successfully fetched manager data. Dumping content:');
        console.log(JSON.stringify(managerData, null, 2)); // DUMP MANAGER DATA

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
        console.log('Successfully fetched bootstrap data. Dumping content:');
        console.log(JSON.stringify(bootstrapData, null, 2)); // DUMP BOOTSTRAP DATA
        
        // Ensure elements exist before trying to map
        const elements = bootstrapData && bootstrapData.elements ? bootstrapData.elements : [];

        // Create a Map for efficient player ID to name lookup (kept for other potential uses)
        const playerMap = new Map();
        elements.forEach(player => {
            playerMap.set(player.id, player.web_name || `${player.first_name} ${player.second_name}`);
        });

        // --- REMOVED: Transfers Data Fetching and Calculation ---
        const totalTransfersCount = 'N/A';
        const totalHitsPoints = 'N/A';

        // --- 3. Process Existing Data Points for Frontend ---
        // Add robust checks for managerData and its nested properties
        const overallRank = (managerData && managerData.entry && managerData.entry.overall_rank !== undefined) 
                            ? managerData.entry.overall_rank.toLocaleString() 
                            : 'N/A';
        console.log(`Calculated overallRank: ${overallRank}`); // Log calculated value

        let bestOverallRank = 'N/A';
        let worstOverallRank = 'N/A';
        if (managerData && managerData.history && managerData.history.length > 0) {
            const ranks = managerData.history.map(h => h.overall_rank).filter(rank => typeof rank === 'number');
            if (ranks.length > 0) {
                bestOverallRank = Math.min(...ranks).toLocaleString();
                worstOverallRank = Math.max(...ranks).toLocaleString();
            }
        }
        console.log(`Calculated bestOverallRank: ${bestOverallRank}, worstOverallRank: ${worstOverallRank}`); // Log calculated values

        const overallRankHistory = (managerData && managerData.history) 
                                   ? managerData.history.map(h => ({
                                       round: h.event,
                                       rank: h.overall_rank
                                   })) 
                                   : [];
        console.log(`Overall Rank History length: ${overallRankHistory.length}`); // Log history length

        let averagePoints = 'N/A';
        if (managerData && managerData.history && managerData.history.length > 0) {
            const totalPoints = managerData.history.reduce((sum, h) => sum + (h.points || 0), 0);
            const totalRoundsWithPoints = managerData.history.filter(h => h.points !== undefined).length;
            if (totalRoundsWithPoints > 0) {
                averagePoints = (totalPoints / totalRoundsWithPoints).toFixed(2);
            }
        }
        console.log(`Calculated averagePoints: ${averagePoints}`); // Log calculated value
        
        const averagePointsFor1stPlace = 'N/A'; // This still needs a separate API if accurate data is desired

        // Placeholders for other tables (Captaincy, Best/Worst Players, Missed Points)
        // If these are expected to have data, their population logic needs to be added here.
        // For now, they remain empty arrays.
        const top3Captains = [];
        const bestPlayers = [];
        const worstPlayers = [];
        const top5MissedPoints = [];

        // --- 4. Return Combined Data as JSON ---
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