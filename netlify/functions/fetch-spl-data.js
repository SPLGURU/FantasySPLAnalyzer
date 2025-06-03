// netlify/functions/fetch-spl-data.js
const fetch = require('node-fetch');

// --- GLOBAL VARIABLES ---
// These are reset per invocation of getManagerHistoryAndCaptains
let captainCounts = {};
let captainedRoundsTracker = {};
// --- END GLOBAL VARIABLES ---

// Helper function to introduce a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms)); // FIX: Corrected setTimeout usage
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
        const playerMap = new Map(); // Use Map for better performance and type safety
        data.elements.forEach(player => {
            playerMap.set(player.id, {
                name: player.web_name || `${player.first_name} ${player.second_name}`,
                element_type: player.element_type,
                total_points: player.total_points || 0
            });
        });
        console.log("Player name map created successfully.");
        return playerMap;
    } catch (error) {
        console.error("Error in getPlayerNameMap:", error);
        return new Map(); // Return empty map on error
    }
}

// Helper function to get manager's history details and captaincy stats
async function getManagerHistoryAndCaptains(managerId, playerMap) {
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

    // Object to store stats for all players ever in the manager's squad
    const playerSeasonStats = {}; // { playerId: { started: 0, autoSubbed: 0, pointsGained: 0, benchedPoints: 0 } }
    const uniquePlayerIdsInSquad = new Set(); // To track all unique players the manager has owned

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

        // --- Update for Rank & Points Table ---
        const currentOverallRank = data.entry_history?.overall_rank; // Use optional chaining
        const currentRoundPoints = data.entry_history?.points; // Use optional chaining

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
            const captainPick = data.picks.find(p => p.is_captain); // is_captain is boolean

            if (captainPick) {
                const captainId = captainPick.element;
                const captainPoints = (captainPick.stats && captainPick.stats.total_points !== undefined) 
                                        ? captainPick.stats.total_points 
                                        : 0;
                const captainName = playerMap.get(captainId)?.name || `Player ${captainId}`;

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
                captainedRoundsTracker[captainId].push(round); // Store round for captaincy
                captaincyStats[captainId].captainedRounds.push(round);

                if (captainPoints > 5) { // Arbitrary threshold for 'successful' captaincy
                    captaincyStats[captainId].successful++;
                } else {
                    captaincyStats[captainId].failed++;
                }
            }
        }

        // --- Player Stats for Best/Worst Players & Missed Points ---
        if (data.picks && Array.isArray(data.picks)) {
            data.picks.forEach(pick => {
                const playerId = pick.element;
                uniquePlayerIdsInSquad.add(playerId); // Add all players ever in squad

                const playerInfo = playerMap.get(playerId);
                const playerName = playerInfo?.name || `Player ${playerId}`;
                const playerType = playerInfo?.element_type;

                if (!playerSeasonStats[playerId]) {
                    playerSeasonStats[playerId] = {
                        name: playerName,
                        element_type: playerType,
                        started: 0,
                        autoSubbed: 0,
                        pointsGained: 0, // This will be total points scored while playing
                        benchedPoints: 0 // This will be total points scored while on bench
                    };
                }

                const playerPointsInRound = (pick.stats && pick.stats.total_points !== undefined) ? pick.stats.total_points : 0;
                
                // If player was in starting XI (position 1-11) and multiplier > 0 (actually played)
                if (pick.position >= 1 && pick.position <= 11 && pick.multiplier > 0) {
                    playerSeasonStats[playerId].started++;
                    playerSeasonStats[playerId].pointsGained += playerPointsInRound;
                } else if (pick.position >= 12 && pick.position <= 15) { // Player was on the bench
                    playerSeasonStats[playerId].benchedPoints += playerPointsInRound;

                    // Check for auto-subbed (was on bench but came on and scored points)
                    if (playerPointsInRound > 0 && data.automatic_subs && Array.isArray(data.automatic_subs)) {
                        const wasAutoSubbedIn = data.automatic_subs.some(sub => sub.element_in === playerId);
                        if (wasAutoSubbedIn) {
                            playerSeasonStats[playerId].autoSubbed++;
                            // If auto-subbed in, their points count as "pointsGained" not "benchedPoints"
                            playerSeasonStats[playerId].pointsGained += playerPointsInRound;
                            playerSeasonStats[playerId].benchedPoints -= playerPointsInRound; // Remove from benched
                        }
                    }
                }

                // Missed Points (from bench) - if player was on bench and scored points, and wasn't auto-subbed in
                if (pick.position >= 12 && pick.position <= 15 && playerPointsInRound > 0) {
                    const wasAutoSubbedIn = data.automatic_subs && Array.isArray(data.automatic_subs) && data.automatic_subs.some(sub => sub.element_in === playerId);
                    if (!wasAutoSubbedIn) {
                        missedPointsInstances.push({
                            playerName: playerName,
                            points: playerPointsInRound,
                            round: round
                        });
                    }
                }
            });
        }
    }

    const averagePoints = roundsProcessed > 0 ? (totalPointsSum / roundsProcessed).toFixed(2) : 'N/A';

    const top3CaptainsStats = Object.values(captaincyStats)
        .sort((a, b) => b.totalCaptainedPoints - a.totalCaptainedPoints)
        .slice(0, 3);

    // Filter playerSeasonStats to only include players that were actually in the manager's squad at some point
    const allPlayersWithStats = Object.values(playerSeasonStats);

    const bestPlayersList = [...allPlayersWithStats]
        .filter(p => p.pointsGained > 0) // Only include players who actually scored points while playing
        .sort((a, b) => b.pointsGained - a.pointsGained) // Sort by Points Gained DESC
        .slice(0, 5) // Take top 5
        .map(player => ({
            name: player.name,
            started: player.started,
            autoSubbed: player.autoSubbed,
            pointsGained: player.pointsGained,
            benchedPoints: player.benchedPoints
        }));

    const worstPlayersList = [...allPlayersWithStats]
        .filter(p => p.started > 0 && p.element_type !== 1) // Must have started, not a GK
        .sort((a, b) => a.pointsGained - b.pointsGained) // Sort by Points Gained ASC
        .slice(0, 5)
        .map(player => ({
            name: player.name,
            started: player.started,
            autoSubbed: player.autoSubbed,
            pointsGained: player.pointsGained,
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
        // Fetch player map first as it's needed by getManagerHistoryAndCaptains
        const playerMap = await getPlayerNameMap();

        // Run main stats and transfers data fetches in parallel
        const [managerStats, transfersData] = await Promise.all([
            getManagerHistoryAndCaptains(managerId, playerMap), // Pass playerMap here
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
        } else if (error.message.includes('Failed to fetch') && error.message.includes('element-summary')) {
            errorMessage = `Could not load player summary data. This might affect player statistics. (${error.message})`;
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