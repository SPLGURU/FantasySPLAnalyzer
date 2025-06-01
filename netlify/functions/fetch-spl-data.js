// netlify/functions/fetch-spl-data.js
const fetch = require('node-fetch');

// --- GLOBAL VARIABLES ---
let captainCounts = {};
let captainedRoundsTracker = {};
// --- END GLOBAL VARIABLES ---

// Helper function to introduce a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to fetch data with retries and exponential backoff
async function fetchWithRetry(url, maxRetries = 5, baseDelayMs = 200) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const response = await fetch(url);

            if (response.ok) { // Status 200-299
                return response;
            } else if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
                const delay = baseDelayMs * Math.pow(2, retries) + Math.random() * 100;
                console.warn(`Attempt ${retries + 1}/${maxRetries} failed for ${url} with status ${response.status}. Retrying in ${delay.toFixed(0)}ms...`);
                await sleep(delay);
                retries++;
            } else {
                throw new Error(`Failed to fetch ${url}: HTTP status ${response.status}`);
            }
        } catch (error) {
            console.error(`Fetch error for ${url} (attempt ${retries + 1}/${maxRetries}):`, error.message);
            if (retries === maxRetries - 1) {
                throw error;
            }
            const delay = baseDelayMs * Math.pow(2, retries) + Math.random() * 100;
            console.warn(`Retrying in ${delay.toFixed(0)}ms...`);
            await sleep(delay);
            retries++;
        }
    }
    throw new Error(`Failed to fetch ${url} after ${maxRetries} retries.`);
}


// Helper function to fetch player names and create a map (from bootstrap-static API)
async function getPlayerNameMap() {
    const url = 'https://en.fantasy.spl.com.sa/api/bootstrap-static/';
    try {
        const response = await fetchWithRetry(url);
        const data = await response.json();
        const playerMap = {};
        data.elements.forEach(player => {
            playerMap[player.id] = player.web_name;
        });
        console.log("Player name map created successfully.");
        return playerMap;
    } catch (error) {
        console.error("Error in getPlayerNameMap:", error);
        return {};
    }
}

// Helper function to get manager's history details and captaincy stats
async function getManagerHistoryAndCaptains(managerId, playerNameMap) {
    // Reset global counters for each invocation
    captainCounts = {};
    captainedRoundsTracker = {};

    let minOverallRank = Infinity;
    let minOverallRankRound = 'N/A';
    let maxOverallRank = -Infinity;
    let maxOverallRankRound = 'N/A';
    let totalPointsSum = 0;
    let roundsProcessed = 0;

    const maxRounds = 34; // Total number of rounds in the season

    // Object to store stats for all players owned by the manager
    const playerSeasonStats = {}; // { playerId: { started: 0, autoSubbed: 0, pointsGained: 0, benchedPoints: 0, roundsInfo: {} } }
    const uniquePlayerIdsInSquad = new Set();

    // Fetch data for all rounds for the given manager concurrently with retries
    const managerPicksPromises = [];
    for (let round = 1; round <= maxRounds; round++) {
        const picksUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/event/${round}/picks`;
        managerPicksPromises.push(
            (async () => {
                try {
                    const res = await fetchWithRetry(picksUrl);
                    return { round, data: await res.json() }; // Return round number with data
                } catch (error) {
                    console.warn(`Skipping round ${round} for manager ${managerId} due to persistent fetch error: ${error.message}`);
                    return { round, data: null };
                }
            })()
        );
    }
    const allManagerPicksData = await Promise.all(managerPicksPromises);

    // Process collected manager picks data to populate overall stats and identify all unique players
    let latestOverallRank = 'N/A';
    for (const { round, data } of allManagerPicksData) {
        if (data) {
            roundsProcessed++;

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
                latestOverallRank = currentOverallRank;
            }
            if (currentRoundPoints !== undefined) {
                totalPointsSum += currentRoundPoints;
            }

            // --- Update for Captaincy Table ---
            const captainPick = data.picks.find(p => p.multiplier === 2 || p.multiplier === 3);

            if (captainPick) {
                const captainId = captainPick.element;
                captainCounts[captainId] = (captainCounts[captainId] || 0) + 1;
                if (!captainedRoundsTracker[captainId]) {
                    captainedRoundsTracker[captainId] = [];
                }
                captainedRoundsTracker[captainId].push(round);
            }

            // Process data for Best/Worst Players Table
            const automaticSubs = data.automatic_subs || [];
            const subbedOutPlayersThisRound = new Set(automaticSubs.map(sub => sub.element_out));
            const subbedInPlayersThisRound = new Set(automaticSubs.map(sub => sub.element_in));

            data.picks.forEach(pick => {
                const playerId = pick.element;
                uniquePlayerIdsInSquad.add(playerId); // Add all players ever in squad

                if (!playerSeasonStats[playerId]) {
                    playerSeasonStats[playerId] = {
                        started: 0,
                        autoSubbed: 0,
                        pointsGained: 0,
                        benchedPoints: 0,
                        roundsInfo: {} // To store position and multiplier for each round
                    };
                }

                // Track 'Started' and 'Auto subbed' counts
                const isSubbedOut = subbedOutPlayersThisRound.has(playerId);
                const isSubbedIn = subbedInPlayersThisRound.has(playerId);

                if (pick.position >= 1 && pick.position <= 11 && !isSubbedOut) {
                    // Player was in initial starting XI and not subbed out
                    playerSeasonStats[playerId].started++;
                } else if (isSubbedIn) {
                    // Player was auto-subbed in (counts as starting for points purposes)
                    playerSeasonStats[playerId].started++; // Counts as started for this specific round's context
                    playerSeasonStats[playerId].autoSubbed++;
                }
                // Store pick details for later point calculation
                playerSeasonStats[playerId].roundsInfo[round] = {
                    position: pick.position,
                    multiplier: pick.multiplier,
                    isSubbedOut: isSubbedOut,
                    isSubbedIn: isSubbedIn
                };
            });
        }
    }

    const averagePoints = roundsProcessed > 0 ? Math.round(totalPointsSum / roundsProcessed) : 'N/A';

    // Fetch Player Summaries for ALL unique players in the squad
    const allPlayerSummaryPromises = Array.from(uniquePlayerIdsInSquad).map(async playerId => {
        try {
            const playerSummaryUrl = `https://en.fantasy.spl.com.sa/api/element-summary/${playerId}/`;
            const response = await fetchWithRetry(playerSummaryUrl);
            return { playerId: parseInt(playerId), summary: await response.json() };
        } catch (error) {
            console.warn(`Could not fetch summary for player ${playerId} due to persistent error: ${error.message}`);
            return { playerId: parseInt(playerId), summary: null };
        }
    });
    const allPlayerSummariesResults = await Promise.all(allPlayerSummaryPromises);
    const allPlayerSummariesMap = new Map(allPlayerSummariesResults.filter(p => p.summary).map(p => [p.playerId, p.summary]));


    // Calculate "Points Gained" and "Benched Points" for all players
    for (const playerId of uniquePlayerIdsInSquad) {
        const playerSummary = allPlayerSummariesMap.get(playerId);
        if (!playerSummary) continue; // Skip if player summary could not be fetched

        const playerHistory = playerSummary.history || [];
        const playerStats = playerSeasonStats[playerId];

        for (const round of Object.keys(playerStats.roundsInfo)) {
            const roundNum = parseInt(round);
            const { position, multiplier, isSubbedOut, isSubbedIn } = playerStats.roundsInfo[roundNum];
            const roundStats = playerHistory.find(h => h.round === roundNum);
            const playerPointsForRound = roundStats ? roundStats.total_points : 0;

            if (roundStats) { // Only count points if the player actually had stats for that round
                // Points Gained: Player was in starting XI (1-11) and not subbed out, OR was subbed in
                if ((position >= 1 && position <= 11 && !isSubbedOut) || isSubbedIn) {
                    playerStats.pointsGained += (playerPointsForRound * multiplier);
                } else {
                    // Benched Points: Player was on bench (12-15) OR was subbed out
                    playerStats.benchedPoints += playerPointsForRound; // Raw points from bench
                }
            }
        }
    }


    const top3CaptainsStats = [];
    const sortedCaptains = Object.entries(captainCounts)
        .sort(([, countA], [, countB]) => countB - countA)
        .slice(0, 3);

    for (const [captainIdStr, timesCaptained] of sortedCaptains) {
        const captainId = parseInt(captainIdStr);
        const playerSummary = allPlayerSummariesMap.get(captainId); // Use the comprehensive map
        const playerHistory = playerSummary ? playerSummary.history : [];

        let successfulCaptaincies = 0;
        let failedCaptaincies = 0;
        let totalCaptainedPoints = 0;

        if (playerHistory && captainedRoundsTracker[captainId]) {
            captainedRoundsTracker[captainId].forEach(captainedRound => {
                const roundStats = playerHistory.find(h => h.round === captainedRound);
                if (roundStats) {
                    const points = roundStats.total_points;
                    if (points >= 5) {
                        successfulCaptaincies++;
                    } else {
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
            captainedRounds: captainedRoundsTracker[captainId]
        });
    }

    // Prepare Best Players Table Data
    const bestPlayersList = Object.entries(playerSeasonStats)
        .filter(([, stats]) => stats.pointsGained > 0 || stats.benchedPoints > 0) // Only include players who gained points
        .sort(([, statsA], [, statsB]) => statsB.pointsGained - statsA.pointsGained) // Sort by Points Gained DESC
        .slice(0, 5) // Take top 5
        .map(([playerId, stats]) => ({
            name: playerNameMap[parseInt(playerId)] || `Unknown (ID:${playerId})`,
            started: stats.started,
            autoSubbed: stats.autoSubbed,
            pointsGained: stats.pointsGained,
            benchedPoints: stats.benchedPoints
        }));

    // NEW: Prepare Worst Players Table Data (opposite of Best Players)
    const worstPlayersList = Object.entries(playerSeasonStats)
        .filter(([, stats]) => stats.pointsGained >= 0 || stats.benchedPoints >= 0) // Include all players with recorded points (even 0 or negative if that's possible)
        .sort(([, statsA], [, statsB]) => statsA.pointsGained - statsB.pointsGained) // Sort by Points Gained ASC
        .slice(0, 5) // Take bottom 5
        .map(([playerId, stats]) => ({
            name: playerNameMap[parseInt(playerId)] || `Unknown (ID:${playerId})`,
            started: stats.started,
            autoSubbed: stats.autoSubbed,
            pointsGained: stats.pointsGained,
            benchedPoints: stats.benchedPoints
        }));
    // END NEW


    return {
        overallRank: latestOverallRank,
        bestOverallRank: minOverallRank !== Infinity ? `${minOverallRank} (R${minOverallRankRound})` : 'N/A',
        worstOverallRank: maxOverallRank !== -Infinity ? `${maxOverallRank} (R${maxOverallRankRound})` : 'N/A',
        averagePoints: averagePoints,
        top3Captains: top3CaptainsStats,
        bestPlayers: bestPlayersList,
        worstPlayers: worstPlayersList // NEW: Add worstPlayers to the returned object
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
        const playerNameMap = await getPlayerNameMap();
        const managerStats = await getManagerHistoryAndCaptains(managerId, playerNameMap);

        const averagePointsFor1stPlace = 75;

        return {
            statusCode: 200,
            body: JSON.stringify({
                overallRank: managerStats.overallRank,
                bestOverallRank: managerStats.bestOverallRank,
                worstOverallRank: managerStats.worstOverallRank,
                averagePoints: managerStats.averagePoints,
                averagePointsFor1stPlace: averagePointsFor1stPlace,
                top3Captains: managerStats.top3Captains,
                bestPlayers: managerStats.bestPlayers,
                worstPlayers: managerStats.worstPlayers // NEW: Include worstPlayers in the response
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