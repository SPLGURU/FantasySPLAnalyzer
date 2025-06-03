// netlify/functions/fetch-spl-data.js

const fetch = require('node-fetch');

// Helper function to introduce a delay (from your original file)
function sleep(ms) {
    return new Promise(resolve => setTimeout(ms, ms));
}

// Helper function to fetch data with retries and exponential backoff (from your original file)
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

// Helper function to get manager's history details and captaincy stats (from your original file)
async function getManagerHistoryAndCaptains(managerId, playerNameMap) {
    let minOverallRank = Infinity;
    let minOverallRankRound = 'N/A';
    let maxOverallRank = -Infinity;
    let maxOverallRankRound = 'N/A';
    let totalPointsSum = 0;
    let roundsProcessed = 0;

    const maxRounds = 34; // Total number of rounds in the season

    const overallRankHistory = [];

    const captaincyStats = {}; // { playerId: { times: N, successful: N, failed: N, totalCaptainedPoints: N, captainedRounds: [] } }
    const playerSeasonStats = {}; // { playerId: { started: 0, autoSubbed: 0, pointsGained: 0, benchedPoints: 0, roundsInfo: {} } }
    const missedPointsInstances = []; // For top 5 missed points

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
    const allManagerPicksResults = await Promise.allSettled(managerPicksPromises);

    const sortedManagerPicksData = allManagerPicksResults
        .filter(result => result.status === 'fulfilled' && result.value.data !== null)
        .map(result => result.value)
        .sort((a, b) => a.round - b.round);

    let latestOverallRank = 'N/A';
    for (const { round, data } of sortedManagerPicksData) {
        roundsProcessed++;

        const currentOverallRank = data.entry_history.overall_rank;
        const currentRoundPoints = data.entry_history.points;

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

        // --- Captaincy Logic ---
        if (data.picks && Array.isArray(data.picks)) {
            const captainPick = data.picks.find(p => p.is_captain);

            if (captainPick) {
                const captainId = captainPick.element;
                const captainPoints = (captainPick.stats && captainPick.stats.total_points !== undefined) 
                                        ? captainPick.stats.total_points 
                                        : 0;
                const captainName = playerNameMap[captainId] || `Player ${captainId}`;

                if (!captaincyStats[captainId]) {
                    captaincyStats[captainId] = {
                        name: captainName,
                        times: 0,
                        successful: 0,
                        failed: 0,
                        totalCaptainedPoints: 0,
                        captainedRounds: []
                    };
                }
                captaincyStats[captainId].times++;
                captaincyStats[captainId].totalCaptainedPoints += captainPoints;
                captaincyStats[captainId].captainedRounds.push(round);

                if (captainPoints > 5) {
                    captaincyStats[captainId].successful++;
                } else {
                    captaincyStats[captainId].failed++;
                }
            }
        }

        // --- Player Stats for Best/Worst Players & Missed Points ---
        const automaticSubs = data.automatic_subs || [];
        const subbedOutPlayersThisRound = new Set(automaticSubs.map(sub => sub.element_out));
        const subbedInPlayersThisRound = new Set(automaticSubs.map(sub => sub.element_in));

        if (data.picks && Array.isArray(data.picks)) {
            data.picks.forEach(pick => {
                const playerId = pick.element;
                const playerName = playerNameMap[playerId] || `Player ${playerId}`;
                const playerType = (bootstrapData.elements.find(el => el.id === playerId))?.element_type; // Get type from bootstrap

                if (!playerSeasonStats[playerId]) {
                    playerSeasonStats[playerId] = {
                        name: playerName,
                        element_type: playerType,
                        started: 0,
                        autoSubbed: 0,
                        pointsGained: 0,
                        benchedPoints: 0,
                        roundsInfo: {}
                    };
                }

                const playerPointsInRound = (pick.stats && pick.stats.total_points !== undefined) ? pick.stats.total_points : 0;
                playerSeasonStats[playerId].totalPoints += playerPointsInRound; // Accumulate total points for the player

                const isSubbedOut = subbedOutPlayersThisRound.has(playerId);
                const isSubbedIn = subbedInPlayersThisRound.has(playerId);

                if (pick.position >= 1 && pick.position <= 11 && !isSubbedOut) {
                    playerSeasonStats[playerId].started++;
                } else if (isSubbedIn) {
                    playerSeasonStats[playerId].started++;
                    playerSeasonStats[playerId].autoSubbed++;
                }
                
                // Track benched points for this round
                if (pick.multiplier === 0) { // Player was on the bench
                    playerSeasonStats[playerId].benchedPoints += playerPointsInRound;
                }

                // Missed Points (from bench)
                if (pick.multiplier === 0 && playerPointsInRound > 0) {
                    missedPointsInstances.push({
                        playerName: playerName,
                        points: playerPointsInRound,
                        round: round
                    });
                }
            });
        }
    }

    const averagePoints = roundsProcessed > 0 ? (totalPointsSum / roundsProcessed).toFixed(2) : 'N/A';

    const top3CaptainsStats = Object.values(captaincyStats)
        .sort((a, b) => b.totalCaptainedPoints - a.totalCaptainedPoints)
        .slice(0, 3);

    const bestPlayersList = Object.values(playerSeasonStats)
        .filter(p => p.totalPoints > 0) // Only include players who actually scored points
        .sort((a, b) => b.totalPoints - a.totalPoints)
        .slice(0, 5)
        .map(player => ({
            name: player.name,
            started: player.started,
            autoSubbed: player.autoSubbed,
            pointsGained: player.totalPoints, // This is now the season total points
            benchedPoints: player.benchedPoints
        }));

    const worstPlayersList = Object.values(playerSeasonStats)
        .filter(p => p.started > 0 && p.element_type !== 1) // Must have started, not a GK
        .sort((a, b) => a.totalPoints - b.totalPoints)
        .slice(0, 5)
        .map(player => ({
            name: player.name,
            started: player.started,
            autoSubbed: player.autoSubbed,
            pointsGained: player.totalPoints,
            benchedPoints: player.benchedPoints
        }));

    const top5MissedPoints = missedPointsInstances
        .sort((a, b) => b.points - a.points)
        .slice(0, 5);

    return {
        overallRank: latestOverallRank,
        bestOverallRank: minOverallRank !== Infinity ? `${minOverallRank} (R${minOverallRankRound})` : 'N/A',
        worstOverallRank: maxOverallRank !== -Infinity ? `${maxOverallRank} (R${maxOverallRankRound})` : 'N/A',
        averagePoints: averagePoints,
        top3Captains: top3CaptainsStats,
        bestPlayers: bestPlayersList,
        worstPlayers: worstPlayersList,
        overallRankHistory: overallRankHistory,
        top5MissedPoints: top5MissedPoints
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

    let totalTransfersCount = 'N/A';
    let totalHitsPoints = 'N/A';

    try {
        // Fetch Transfers Data (Isolated and with robust error handling)
        const transfersApiUrl = `https://en.fantasy.spl.com.sa/entry/${managerId}/transfers`;
        console.log(`Attempting to fetch transfers data from: ${transfersApiUrl}`);
        try {
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
                    // console.log(JSON.stringify(transfersRawData, null, 2)); // Uncomment to dump transfers data

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
                }
            } else {
                const errorText = await transfersResponse.text();
                console.error(`Transfers fetch failed with status ${transfersResponse.status}: ${errorText.substring(0, 200)}...`);
                if (transfersResponse.headers.get('location')) {
                    console.error(`Redirect detected to: ${transfersResponse.headers.get('location')}`);
                }
            }
        } catch (transfersFetchError) {
            console.error('Error during transfers data fetch (network or unexpected issue):', transfersFetchError);
        }

        // Fetch other manager stats (this is the original getManagerHistoryAndCaptains logic)
        const playerNameMap = await getPlayerNameMap();
        const managerStats = await getManagerHistoryAndCaptains(managerId, playerNameMap);

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
                totalTransfersCount: totalTransfersCount, // Now includes transfers data
                totalHitsPoints: totalHitsPoints      // Now includes transfers data
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