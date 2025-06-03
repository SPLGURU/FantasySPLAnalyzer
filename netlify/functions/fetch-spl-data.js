// netlify/functions/fetch-spl-data.js

// Import node-fetch for making HTTP requests in a Node.js environment
// This is typically available in Netlify functions, but explicitly requiring it is good practice.
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
        // This API provides overall manager stats, history, and current team.
        const managerResponse = await fetch(`https://en.fantasy.spl.com.sa/api/entry/${managerId}/`);
        if (!managerResponse.ok) {
            // If manager data fetch fails, throw an error
            throw new Error(`Failed to fetch manager data: ${managerResponse.statusText}`);
        }
        const managerData = await managerResponse.json();

        // --- 2. Fetch Global Bootstrap Data ---
        // This API contains a list of all players (elements) and their details,
        // which is crucial for mapping player IDs from transfers to actual names.
        const bootstrapResponse = await fetch('https://en.fantasy.spl.com.sa/api/bootstrap-static/');
        if (!bootstrapResponse.ok) {
            // If bootstrap data fetch fails, throw an error
            throw new Error(`Failed to fetch bootstrap data: ${bootstrapResponse.statusText}`);
        }
        const bootstrapData = await bootstrapResponse.json();
        const elements = bootstrapData.elements; // Array of all players

        // Create a Map for efficient player ID to name lookup
        const playerMap = new Map();
        elements.forEach(player => {
            // Use web_name if available, otherwise combine first and second name
            playerMap.set(player.id, player.web_name || `${player.first_name} ${player.second_name}`);
        });

        // --- 3. Fetch Transfers Data ---
        // This API provides a list of all transfers made by the manager.
        const transfersResponse = await fetch(`https://en.fantasy.spl.com.sa/entry/${managerId}/transfers`);
        if (!transfersResponse.ok) {
            // If transfers data fetch fails, throw an error
            throw new Error(`Failed to fetch transfers data: ${transfersResponse.statusText}`);
        }
        const transfersRawData = await transfersResponse.json();

        // --- 4. Calculate Total Transfers Count ---
        // This is simply the number of transfer entries in the array.
        const totalTransfersCount = transfersRawData.length;

        // --- 5. Calculate Total Hits (Points Deducted) ---
        // A "hit" is typically a -4 point deduction for each transfer beyond the free transfer(s)
        // allowed in a given gameweek. Assuming 1 free transfer per gameweek.
        let totalHitsCount = 0;
        const transfersPerEvent = {}; // Object to store transfer counts per gameweek/event

        // Group transfers by their respective gameweek (event)
        transfersRawData.forEach(transfer => {
            if (!transfersPerEvent[transfer.event]) {
                transfersPerEvent[transfer.event] = 0;
            }
            transfersPerEvent[transfer.event]++;
        });

        // Iterate through each gameweek's transfer count to calculate hits
        for (const eventId in transfersPerEvent) {
            const transfersInThisEvent = transfersPerEvent[eventId];
            // If more than 1 transfer was made in a gameweek, calculate hits
            if (transfersInThisEvent > 1) {
                totalHitsCount += (transfersInThisEvent - 1); // Each transfer beyond the first costs a hit
            }
        }
        const totalHitsPoints = totalHitsCount * -4; // Each hit costs -4 points

        // --- 6. Process Existing Data Points for Frontend ---
        // These calculations are based on the structure of managerData
        const overallRank = managerData.entry.overall_rank !== undefined ? managerData.entry.overall_rank.toLocaleString() : 'N/A';

        // Best and Worst Overall Rank from history
        let bestOverallRank = 'N/A';
        let worstOverallRank = 'N/A';
        if (managerData.history && managerData.history.length > 0) {
            const ranks = managerData.history.map(h => h.overall_rank).filter(rank => typeof rank === 'number');
            if (ranks.length > 0) {
                bestOverallRank = Math.min(...ranks).toLocaleString();
                worstOverallRank = Math.max(...ranks).toLocaleString();
            }
        }

        // Overall Rank History for the chart
        const overallRankHistory = managerData.history.map(h => ({
            round: h.event,
            rank: h.overall_rank
        }));

        // Average Points (You'll need to calculate this based on your specific logic)
        // For example, if managerData.history has 'points' per round:
        let averagePoints = 'N/A';
        if (managerData.history && managerData.history.length > 0) {
            const totalPoints = managerData.history.reduce((sum, h) => sum + (h.points || 0), 0);
            const totalRoundsWithPoints = managerData.history.filter(h => h.points !== undefined).length;
            if (totalRoundsWithPoints > 0) {
                averagePoints = (totalPoints / totalRoundsWithPoints).toFixed(2);
            }
        }

        // Average Points for 1st Place (This data is NOT available from manager's own data.
        // You would need another API endpoint for league/global stats if this is required accurately.)
        // Placeholder for now:
        const averagePointsFor1stPlace = 'N/A';

        // Placeholders for other tables (Captaincy, Best/Worst Players, Missed Points)
        // You would integrate your existing logic to populate these from managerData.
        const top3Captains = []; // Example: managerData.picks or other sources
        const bestPlayers = []; // Example: managerData.picks or other sources
        const worstPlayers = []; // Example: managerData.picks or other sources
        const top5MissedPoints = []; // Example: managerData.automatic_subs or other sources

        // --- 7. Return Combined Data as JSON ---
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*', // Enable CORS for local development/testing
            },
            body: JSON.stringify({
                overallRankHistory: overallRankHistory,
                overallRank: overallRank,
                bestOverallRank: bestOverallRank,
                worstOverallRank: worstOverallRank,
                averagePoints: averagePoints,
                averagePointsFor1stPlace: averagePointsFor1stPlace,
                top3Captains: top3Captains, // Ensure these are populated by your existing logic
                bestPlayers: bestPlayers,   // Ensure these are populated by your existing logic
                worstPlayers: worstPlayers, // Ensure these are populated by your existing logic
                top5MissedPoints: top5MissedPoints, // Ensure these are populated by your existing logic
                totalTransfersCount: totalTransfersCount, // NEW: Total number of transfers
                totalHitsPoints: totalHitsPoints      // NEW: Total points deducted from hits
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