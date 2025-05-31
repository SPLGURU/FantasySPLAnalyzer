// netlify/functions/fetch-spl-data.js
const fetch = require('node-fetch'); // Import node-fetch

// Function to fetch player names and create a map (from bootstrap-static API)
async function getPlayerNameMap() {
    const url = 'https://en.fantasy.spl.com.sa/api/bootstrap-static/';
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        const playerMap = {};
        // The 'elements' array contains all player data
        data.elements.forEach(player => {
            playerMap[player.id] = player.web_name; // Map player ID to their web_name
        });
        console.log("Player name map created successfully.");
        return playerMap;
    } catch (error) {
        console.error("Error fetching player name map:", error);
        return {}; // Return empty map on error
    }
}

// Function to get the most captained player and their total points for a given manager
async function getMostCaptainedPlayerStats(managerId, playerNameMap) {
    const captainCounts = {}; // Stores {playerId: count}
    const captainedRoundsByPlayer = {}; // Stores {playerId: [round1, round2, ...]}

    // Assuming 34 rounds based on a typical fantasy league season.
    const maxRounds = 34;

    for (let round = 1; round <= maxRounds; round++) {
        try {
            const picksUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/event/${round}/picks`;
            // console.log(`Fetching picks for manager ${managerId}, round ${round} from: ${picksUrl}`); // Debugging line
            const response = await fetch(picksUrl);
            if (!response.ok) {
                // If a round's data isn't available (e.g., future rounds or invalid manager ID for that round), skip it
                console.warn(`Could not fetch picks for manager ${managerId}, round ${round}. Status: ${response.status}. Skipping round.`);
                continue;
            }
            const data = await response.json();

            // Find the captain in the picks array for this round
            const captainPick = data.picks.find(p => p.is_captain);
            if (captainPick) {
                const captainId = captainPick.element;
                captainCounts[captainId] = (captainCounts[captainId] || 0) + 1;
                if (!captainedRoundsByPlayer[captainId]) {
                    captainedRoundsByPlayer[captainId] = [];
                }
                captainedRoundsByPlayer[captainId].push(round);
            }
        } catch (error) {
            console.error(`Error fetching picks for manager ${managerId}, round ${round}:`, error);
            // Continue to the next round even if one fails
        }
    }

    let mostCaptainId = null;
    let maxCaptainCount = 0;
    let tiedCaptains = []; // To handle multiple players being most captained

    // Determine the player(s) with the highest captain count
    for (const id in captainCounts) {
        if (captainCounts[id] > maxCaptainCount) {
            maxCaptainCount = captainCounts[id];
            mostCaptainId = parseInt(id);
            tiedCaptains = [mostCaptainId]; // Start new list of tied captains
        } else if (captainCounts[id] === maxCaptainCount && maxCaptainCount > 0) {
            tiedCaptains.push(parseInt(id)); // Add to list if tied
        }
    }

    let result = {
        mostCaptainName: 'N/A',
        timesCaptained: 0,
        totalCaptainedPoints: 0
    };

    if (tiedCaptains.length > 0) {
        // If there's one clear most captained player
        if (tiedCaptains.length === 1) {
            mostCaptainId = tiedCaptains[0];
            result.mostCaptainName = playerNameMap[mostCaptainId] || `Unknown Player (ID: ${mostCaptainId})`;
            result.timesCaptained = maxCaptainCount;

            // Calculate total points for this single most captained player
            try {
                const playerSummaryUrl = `https://en.fantasy.spl.com.sa/api/element-summary/${mostCaptainId}/`;
                const response = await fetch(playerSummaryUrl);
                if (!response.ok) {
                    console.error(`Could not fetch summary for player ${mostCaptainId}. Status: ${response.status}`);
                    result.totalCaptainedPoints = 'Error fetching points';
                } else {
                    const data = await response.json();
                    const playerHistory = data.history;
                    let currentCaptainedPoints = 0;

                    if (playerHistory && captainedRoundsByPlayer[mostCaptainId]) {
                        captainedRoundsByPlayer[mostCaptainId].forEach(round => {
                            const roundStats = playerHistory.find(h => h.round === round);
                            if (roundStats) {
                                currentCaptainedPoints += roundStats.total_points;
                            }
                        });
                    }
                    result.totalCaptainedPoints = currentCaptainedPoints;
                }
            } catch (error) {
                console.error(`Error fetching player summary for ID ${mostCaptainId}:`, error);
                result.totalCaptainedPoints = 'Error fetching points';
            }
        } else {
            // If there are multiple players tied for most captained
            let tiedNames = [];
            let combinedPoints = 0;
            for (const id of tiedCaptains) {
                tiedNames.push(playerNameMap[id] || `Unknown Player (ID: ${id})`);
                // For tied players, we'll sum their individual captained points
                try {
                    const playerSummaryUrl = `https://en.fantasy.spl.com.sa/api/element-summary/${id}/`;
                    const response = await fetch(playerSummaryUrl);
                    if (response.ok) {
                        const data = await response.json();
                        const playerHistory = data.history;
                        if (playerHistory && captainedRoundsByPlayer[id]) {
                            captainedRoundsByPlayer[id].forEach(round => {
                                const roundStats = playerHistory.find(h => h.round === round);
                                if (roundStats) {
                                    combinedPoints += roundStats.total_points;
                                }
                            });
                        }
                    } else {
                         console.error(`Could not fetch summary for tied player ${id}. Status: ${response.status}`);
                    }
                } catch (error) {
                    console.error(`Error fetching player summary for tied ID ${id}:`, error);
                }
            }
            result.mostCaptainName = tiedNames.join(' & '); // Join names with '&'
            result.timesCaptained = maxCaptainCount;
            result.totalCaptainedPoints = combinedPoints; // Sum of points from all tied captains
        }
    }

    return result;
}


// --- Netlify Function Handler ---
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
        // Fetch Overall Rank (existing logic)
        const managerApiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/`;
        const managerResponse = await fetch(managerApiUrl);

        let overallRank = 'N/A';
        if (managerResponse.ok) {
            const managerData = await managerResponse.json();
            overallRank = managerData.summary_overall_rank || 'Not found';
        } else {
            console.error(`Failed to fetch manager summary for ID ${managerId}. Status: ${managerResponse.status}`);
            overallRank = 'Error';
        }

        // Fetch Most Captained Player stats
        const playerNameMap = await getPlayerNameMap();
        const captainStats = await getMostCaptainedPlayerStats(managerId, playerNameMap);

        return {
            statusCode: 200,
            body: JSON.stringify({
                overallRank: overallRank,
                mostCaptainName: captainStats.mostCaptainName,
                timesCaptained: captainStats.timesCaptained,
                totalCaptainedPoints: captainStats.totalCaptainedPoints
            }),
            headers: { "Content-Type": "application/json" }
        };

    } catch (error) {
        console.error(`Error in Netlify function for manager ${managerId}:`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Failed to fetch data: ${error.message}. Please check the Manager ID or if the SPL API has changed.` }),
            headers: { "Content-Type": "application/json" }
        };
    }
};