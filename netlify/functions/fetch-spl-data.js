// netlify/functions/fetch-spl-data.js
const fetch = require('node-fetch'); // Import node-fetch for Netlify Functions environment

// Helper function to introduce a delay to mitigate rate-limiting
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to fetch player names and create a map (from bootstrap-static API)
async function getPlayerNameMap() {
    const url = 'https://en.fantasy.spl.com.sa/api/bootstrap-static/';
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch player name map: HTTP status ${response.status}`);
        }
        const data = await response.json();
        const playerMap = {};
        data.elements.forEach(player => {
            playerMap[player.id] = player.web_name;
        });
        console.log("Player name map created successfully.");
        return playerMap;
    } catch (error) {
        console.error("Error in getPlayerNameMap:", error);
        // Return empty map on error to allow the main handler to proceed with partial data or N/A
        return {};
    }
}

// Helper function to get manager's history details and captaincy stats
async function getManagerHistoryAndCaptains(managerId, playerNameMap) {
    let minOverallRank = Infinity;
    let minOverallRankRound = 'N/A';
    let maxOverallRank = -Infinity;
    let maxOverallRankRound = 'N/A';
    let totalPointsSum = 0;
    let roundsProcessed = 0;

    const captainCounts = {}; // Stores {playerId: count}
    // Stores {playerId: [round1, round2, ...]} - used to identify which rounds a player was captained
    const captaincyRoundsByPlayer = {};

    const maxRounds = 34; // Total number of rounds in the season

    // Fetch data for all rounds for the given manager concurrently with delays
    const managerPicksPromises = [];
    for (let round = 1; round <= maxRounds; round++) {
        const picksUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/event/${round}/picks`;
        managerPicksPromises.push(
            (async () => { // Use an async IIFE to await sleep inside the map
                await sleep(100); // Add a small delay before each fetch to mitigate rate limits
                try {
                    const res = await fetch(picksUrl);
                    if (!res.ok) {
                        console.warn(`Skipping round ${round} for manager ${managerId} due to fetch error: ${res.status}`);
                        return null; // Return null for failed fetches
                    }
                    return res.json();
                } catch (error) {
                    console.error(`Error fetching picks for manager ${managerId}, round ${round}:`, error);
                    return null; // Return null on network/parsing error
                }
            })()
        );
    }
    const allManagerPicksData = await Promise.all(managerPicksPromises);

    // Process collected manager picks data
    let latestOverallRank = 'N/A';
    for (let round = 1; round <= maxRounds; round++) {
        const data = allManagerPicksData[round - 1]; // Array is 0-indexed

        if (data) { // Check if data for this round was successfully fetched
            roundsProcessed++; // Count only successfully fetched rounds

            // --- Update for Rank & Points Table ---
            const currentOverallRank = data.entry_history.overall_rank;
            const currentRoundPoints = data.entry_history.points;

            if (currentOverallRank !== null && currentOverallRank !== undefined) {
                if (currentOverallRank < minOverallRank) {
                    minOverallRank = currentOverallRank;
                    minOverallRankRound = round;
                }
                if (currentOverallRank > maxOverallRank) {
                    maxOverallRank = currentOverallRank;
                    maxOverallRankRound = round;
                }
                latestOverallRank = currentOverallRank; // Update with the latest available rank
            }
            if (currentRoundPoints !== undefined) {
                totalPointsSum += currentRoundPoints;
            }

            // --- Update for Captaincy Table ---
            const captainPick = data.picks.find(p => p.is_captain);
            if (captainPick) {
                const captainId = captainPick.element;
                captainCounts[captainId] = (captainCounts[captainId] || 0) + 1;
                if (!captaincyRoundsByPlayer[captainId]) {
                    captaincyRoundsByPlayer[captainId] = [];
                }
                captaincyRoundsByPlayer[captainId].push(round); // Store round for later points lookup
            }
        }
    }

    const averagePoints = roundsProcessed > 0 ? Math.round(totalPointsSum / roundsProcessed) : 'N/A';

    // Fetch player summaries for all *unique* captains concurrently with delays
    const uniqueCaptains = Object.keys(captainCounts);
    const playerSummariesPromises = uniqueCaptains.map(async playerId => {
        await sleep(100); // Add a small delay before each fetch
        try {
            const playerSummaryUrl = `https://en.fantasy.spl.com.sa/api/element-summary/${playerId}/`;
            const response = await fetch(playerSummaryUrl);
            if (response.ok) {
                const data = await response.json();
                return { playerId: parseInt(playerId), summary: data };
            } else {
                console.warn(`Could not fetch summary for player ${playerId}: ${response.status}`);
                return { playerId: parseInt(playerId), summary: null };
            }
        } catch (error) {
            console.error(`Error fetching player summary for ${playerId}:`, error);
            return { playerId: parseInt(playerId), summary: null };
        }
    });
    const playerSummariesResults = await Promise.all(playerSummariesPromises);
    const playerSummariesMap = new Map(playerSummariesResults.filter(p => p.summary).map(p => [p.playerId, p.summary]));


    const top3CaptainsStats = [];
    const sortedCaptains = Object.entries(captainCounts)
        .sort(([, countA], [, countB]) => countB - countA)
        .slice(0, 3); // Get top 3 most captained players

    for (const [captainIdStr, timesCaptained] of sortedCaptains) {
        const captainId = parseInt(captainIdStr);
        const playerSummary = playerSummariesMap.get(captainId);
        const playerHistory = playerSummary ? playerSummary.history : [];

        let successfulCaptaincies = 0;
        let failedCaptaincies = 0;
        let totalCaptainedPoints = 0;

        if (playerHistory && captaincyRoundsByPlayer[captainId]) { // This line is where the error occurred
            captainedRoundsByPlayer[captainId].forEach(captainedRound => {
                const roundStats = playerHistory.find(h => h.round === captainedRound);
                if (roundStats) {
                    const points = roundStats.total_points;
                    if (points >= 5) { // Successful if 5 points or more
                        successfulCaptaincies++;
                    } else { // Failed if 4 points or less
                        failedCaptaincies++;
                    }
                    totalCaptainedPoints += points;
                }
            });
        }
        top3CaptainsStats.push({
            id: captainId,
            name: playerNameMap[captainId] || `Unknown (ID:${captainId})`,
            times: timesCaptained,
            successful: successfulCaptaincies,
            failed: failedCaptaincies,
            totalCaptainedPoints: totalCaptainedPoints,
            captainedRounds: captaincyRoundsByPlayer[captainId] // Add this for debugging
        });
    }

    return {
        overallRank: latestOverallRank, // The overall rank from the last processed round
        bestOverallRank: minOverallRank !== Infinity ? `${minOverallRank} (R${minOverallRankRound})` : 'N/A',
        worstOverallRank: maxOverallRank !== -Infinity ? `${maxOverallRank} (R${maxOverallRankRound})` : 'N/A',
        averagePoints: averagePoints,
        top3Captains: top3CaptainsStats
    };
}


// --- Netlify Function Handler (Main entry point) ---
exports.handler = async function(event, context) {
    const managerId = event.queryStringParameters.id;

    if (!managerId || typeof managerId !== 'string' || !/^\d+$/.test(managerId)) {
        console.error('Invalid managerId received:', managerId);
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Manager ID is required and must be a valid number.' }),
            headers: { "Content-Type": "application/json" }
        };
    }

    try {
        const playerNameMap = await getPlayerNameMap(); // Fetch player names once

        // Get manager's overall history and captaincy stats
        const managerStats = await getManagerHistoryAndCaptains(managerId, playerNameMap);

        // --- Fixed Average Points for 1st Place ---
        const averagePointsFor1stPlace = 75; // Using the fixed value as specified

        // Return all collected data
        return {
            statusCode: 200,
            body: JSON.stringify({
                overallRank: managerStats.overallRank,
                bestOverallRank: managerStats.bestOverallRank,
                worstOverallRank: managerStats.worstOverallRank,
                averagePoints: managerStats.averagePoints,
                averagePointsFor1stPlace: averagePointsFor1stPlace, // Fixed value
                top3Captains: managerStats.top3Captains
            }),
            headers: { "Content-Type": "application/json" }
        };

    } catch (error) {
        console.error(`Error in Netlify function handler for manager ${managerId}:`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Failed to fetch data: ${error.message}. This might be due to a network issue, an invalid Manager ID, or a temporary API problem. Please try again.` }),
            headers: { "Content-Type": "application/json" }
        };
    }
};
