// netlify/functions/fetch-spl-data.js
const fetch = require('node-fetch');

// --- GLOBAL VARIABLES ---
let captainCounts = {};
let captainedRoundsTracker = {};
// --- END GLOBAL VARIABLES ---

// Helper function to introduce a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(ms, ms));
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

    // Array to store overall rank for each round
    const overallRankHistory = [];

    // Object to store stats for all players owned by the manager
    const playerSeasonStats = {}; // { playerId: { started: 0, autoSubbed: 0, pointsGained: 0, benchedPoints: 0, roundsInfo: {} } }
    const uniquePlayerIdsInSquad = new Set();

    // NEW: Array to store potential "missed points" instances
    const missedPointsInstances = [];

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
    // Use Promise.allSettled to ensure all promises are handled, even if some fail
    const allManagerPicksResults = await Promise.allSettled(managerPicksPromises);

    // Sort results by round number to ensure correct order for history
    const sortedManagerPicksData = allManagerPicksResults
        .filter(result => result.status === 'fulfilled' && result.value.data !== null)
        .map(result => result.value)
        .sort((a, b) => a.round - b.round);


    // Process collected manager picks data to populate overall stats and identify all unique players
    let latestOverallRank = 'N/A';
    for (const { round, data } of sortedManagerPicksData) {
        roundsProcessed++;

        // --- Update for Rank & Points Table ---
        const currentOverallRank = data.entry_history.overall_rank;
        const currentRoundPoints = data.entry_history.points;

        // Store overall rank for this round
        overallRankHistory.push({ round: round, rank: currentOverallRank });

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
        const captainPick = data.picks.find(p => p.multiplier === 2 || p.multiplier === 3); // Keep 3 for safety, though only 2 applies in SPL

        if (captainPick) {
            const captainId = captainPick.element;
            captainCounts[captainId] = (captainCounts[captainId] || 0) + 1;
            if (!captainedRoundsTracker[captainId]) {
                captainedRoundsTracker[captainId] = [];
            }
            captainedRoundsTracker[captainId].push(round);
        }

        // Process data for Best/Worst Players Table AND Missed Points Table
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

            // NEW LOGIC: Filter to get ALL history entries for this specific round number
            const allRoundStatsEntries = playerHistory.filter(h => h.round === roundNum);

            // Sum the total_points from all relevant entries for this round
            // This handles double gameweeks where a player might have multiple entries for the same round number
            const playerPointsForRound = allRoundStatsEntries.reduce((sum, entry) => sum + entry.total_points, 0);

            // Points Gained: Player was in starting XI (1-11) and not subbed out, OR was subbed in
            if ((position >= 1 && position <= 11 && !isSubbedOut) || isSubbedIn) {
                playerStats.pointsGained += (playerPointsForRound * multiplier);
            } else {
                // Benched Points: Player was on bench (12-15) OR was subbed out
                playerStats.benchedPoints += playerPointsForRound; // Raw points from bench

                // NEW LOGIC for Missed Points Table:
                // Check if the player was on the bench (position 12-15) AND NOT subbed in
                if (position >= 12 && position <= 15 && !isSubbedIn) {
                    missedPointsInstances.push({
                        playerId: playerId,
                        points: playerPointsForRound,
                        round: roundNum
                    });
                }
            }
        }
    }

    // Sort missed points instances by points in descending order and take top 5
    const top5MissedPoints = missedPointsInstances
        .sort((a, b) => b.points - a.points)
        .slice(0, 5)
        .map(item => ({
            playerName: playerNameMap[item.playerId] || `Unknown (ID:${item.playerId})`,
            points: item.points,
            round: item.round
        }));


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
                // NEW LOGIC for Captaincy Table: Sum points for captains in double gameweeks as well
                const captainRoundStatsEntries = playerHistory.filter(h => h.round === captainedRound);
                const captainPointsForRound = captainRoundStatsEntries.reduce((sum, entry) => sum + entry.total_points, 0);

                if (captainPointsForRound >= 5) {
                    successfulCaptaincies++;
                } else {
                    failedCaptaincies++;
                }
                totalCaptainedPoints += captainPointsForRound;
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
            pointsGained: stats.pointsGained, // This is now the season total points
            benchedPoints: stats.benchedPoints
        }));

    // Prepare Worst Players Table Data
    const worstPlayersList = Object.entries(playerSeasonStats)
        .filter(([, stats]) => stats.started > 0) // Only include players who started at least once
        .sort(([, statsA], [, statsB]) => statsA.pointsGained - statsB.pointsGained) // Sort by Points Gained ASC
        .slice(0, 5) // Take bottom 5 from the filtered list
        .map(([playerId, stats]) => ({
            name: playerNameMap[parseInt(playerId)] || `Unknown (ID:${playerId})`,
            started: stats.started,
            autoSubbed: stats.autoSubbed,
            pointsGained: stats.pointsGained,
            benchedPoints: stats.benchedPoints
        }));


    return {
        overallRank: latestOverallRank,
        bestOverallRank: minOverallRank !== Infinity ? `${minOverallRank} (R${minOverallRankRound})` : 'N/A',
        worstOverallRank: maxOverallRank !== -Infinity ? `${maxOverallRank} (R${maxOverallRankRound})` : 'N/A',
        averagePoints: averagePoints,
        top3Captains: top3CaptainsStats,
        bestPlayers: bestPlayersList,
        worstPlayers: worstPlayersList,
        overallRankHistory: overallRankHistory,
        top5MissedPoints: top5MissedPoints // NEW: Include in response
    };
}


// --- NEW: Function to fetch and process Transfers Data ---
async function getTransfersData(managerId) {
    let totalTransfersCount = 'N/A';
    let totalHitsPoints = 'N/A';

    try {
        const transfersApiUrl = `https://en.fantasy.spl.com.sa/entry/${managerId}/transfers`;
        console.log(`Attempting to fetch transfers data from: ${transfersApiUrl}`);
        
        const transfersResponse = await fetch(transfersApiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': `https://en.fantasy.spl.com.sa/entry/${managerId}/`,
                'DNT': '1',
                'Connection': 'keep-alive',
                'X-Requested-With': 'XMLHttpRequest',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Site': 'same-origin',
            },
        });

        if (transfersResponse.ok) {
            const responseText = await transfersResponse.text();
            try {
                const transfersRawData = JSON.parse(responseText);
                console.log('Successfully fetched and parsed transfers data.');
                // console.log(JSON.stringify(transfersRawData, null, 2)); // Uncomment to dump transfers data if needed

                totalTransfersCount = transfersRawData.length;

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
                console.log(`Calculated totalTransfersCount: ${totalTransfersCount}, totalHitsPoints: ${totalHitsPoints}`);

            } catch (jsonParseError) {
                console.error('Transfers API returned non-JSON content or malformed JSON. Response snippet:', responseText.substring(0, 500));
                console.error('Error parsing transfers JSON:', jsonParseError);
                // Values remain 'N/A' as initialized
            }
        } else {
            const errorText = await transfersResponse.text();
            console.error(`Transfers fetch failed with status ${transfersResponse.status}: ${errorText.substring(0, 200)}...`);
            if (transfersResponse.headers.get('location')) {
                console.error(`Redirect detected to: ${transfersResponse.headers.get('location')}`);
            }
            // Values remain 'N/A' as initialized
        }
    } catch (transfersFetchError) {
        console.error('Error during transfers data fetch (network or unexpected issue):', transfersFetchError);
        // Values remain 'N/A' as initialized
    }

    return {
        totalTransfersCount: totalTransfersCount,
        totalHitsPoints: totalHitsPoints
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
        // Run main stats and transfers data fetches in parallel
        const [managerStats, transfersData] = await Promise.all([
            getManagerHistoryAndCaptains(managerId, await getPlayerNameMap()), // Pass playerMap here
            getTransfersData(managerId)
        ]);

        const averagePointsFor1stPlace = 75; // Hardcoded as requested

        return {
            statusCode: 200,
            body: JSON.stringify({
                overallRankHistory: managerStats.overallRankHistory,
                overallRank: managerStats.overallRank,
                bestOverallRank: managerStats.bestOverallRank,
                worstOverallRank: managerStats.worstOverallRank,
                averagePoints: managerStats.averagePoints,
                averagePointsFor1stPlace: averagePointsFor1stPlace,
                top3Captains: managerStats.top3Captains,
                bestPlayers: managerStats.bestPlayers,
                worstPlayers: managerStats.worstPlayers,
                top5MissedPoints: managerStats.top5MissedPoints,
                totalTransfersCount: transfersData.totalTransfersCount, // Get from transfersData
                totalHitsPoints: transfersData.totalHitsPoints      // Get from transfersData
            }),
            headers: { "Content-Type": "application/json" }
        };

    } catch (error) {
        console.error(`Error in Netlify function handler for manager ${managerId}:`, error);
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
            headers: { "Content-Type": "application/json" }
        };
    }
};