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
                // For non-OK responses that are not 429/5xx, throw immediately
                throw new Error(`Failed to fetch ${url}: HTTP status ${response.status} - ${response.statusText}`);
            }
        } catch (error) {
            console.error(`Fetch error for ${url} (attempt ${retries + 1}/${maxRetries}):`, error.message);
            if (retries === maxRetries - 1) {
                throw error; // Re-throw if max retries reached
            }
            const delay = baseDelayMs * Math.pow(2, retries) + Math.random() * 100;
            console.warn(`Retrying in ${delay.toFixed(0)}ms...`);
            retries++;
        }
    }
    throw new Error(`Failed to fetch ${url} after ${maxRetries} retries.`);
}


// Helper function to fetch player names and create a map
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

// Dedicated function to fetch manager chips and current event
async function getManagerChipsAndCurrentEvent(managerId) {
    const managerEntryUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/`;
    try {
        const entryRes = await fetchWithRetry(managerEntryUrl);
        const managerEntryData = await entryRes.json();
        
        // Directly extract chips and current_event
        const chips = managerEntryData.chips || [];
        const currentEvent = managerEntryData.current_event || 34; // Fallback to 34 if not available

        console.log('Chips extracted by getManagerChipsAndCurrentEvent:', chips); // DEBUG LOG
        console.log('Current Event extracted by getManagerChipsAndCurrentEvent:', currentEvent); // DEBUG LOG
        console.log('last_deadline_total_transfers extracted:', managerEntryData.last_deadline_total_transfers); // DEBUG LOG

        return { 
            chips, 
            currentEvent,
            lastDeadlineTotalTransfers: managerEntryData.last_deadline_total_transfers // Also return this value
        };
    } catch (error) {
        console.error(`ERROR: Failed to fetch manager entry data (for chips/current event) for ${managerId}:`, error.message);
        return { chips: [], currentEvent: 34, lastDeadlineTotalTransfers: 'N/A' }; // Return defaults on failure
    }
}


// Helper function to get manager's history details and captaincy stats
async function getManagerHistoryAndCaptains(managerId, playerNameMap, managerChipsData) { // Now accepts managerChipsData
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

    // Use chips and currentEvent from managerChipsData passed from handler
    const managerChips = managerChipsData?.chips || [];
    const currentEvent = managerChipsData?.currentEvent || maxRounds;


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

    const top3CaptainsStats = [];
    const sortedCaptains = Object.entries(captainCounts)
        .sort(([, countA], [, countB]) => countB - countA)
        .slice(0, 3);

    for (const [captainIdStr, timesCaptained] of sortedCaptains) {
        const captainId = parseInt(captainIdStr);
        const playerSummaryUrl = `https://en.fantasy.spl.com.sa/api/element-summary/${captainId}/`;
        let playerSummary = null;
        try {
            const res = await fetchWithRetry(playerSummaryUrl);
            playerSummary = await res.json();
        } catch (error) {
            console.warn(`Could not fetch summary for captain ${captainId} due to persistent error: ${error.message}`);
        }

        const playerHistory = playerSummary ? playerSummary.history : [];

        let successfulCaptaincies = 0;
        let failedCaptaincies = 0;
        let totalCaptainedPoints = 0;

        if (playerHistory && captainedRoundsTracker[captainId]) {
            captainedRoundsTracker[captainId].forEach(captainedRound => {
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

    // Fetch Player Summaries for ALL unique players in the squad (needed for pointsGained/benchedPoints)
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

        playerStats.pointsGained = 0; // Reset for accurate calculation
        playerStats.benchedPoints = 0; // Reset for accurate calculation

        for (const round of Object.keys(playerStats.roundsInfo)) {
            const roundNum = parseInt(round);
            const { position, multiplier, isSubbedOut, isSubbedIn } = playerStats.roundsInfo[roundNum];

            // Filter to get ALL history entries for this specific round number
            const allRoundStatsEntries = playerHistory.filter(h => h.round === roundNum);
            const playerPointsForRound = allRoundStatsEntries.reduce((sum, entry) => sum + entry.total_points, 0);

            // Points Gained: Player was in initial starting XI (1-11) and not subbed out, OR was subbed in
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
        top5MissedPoints: top5MissedPoints,
        chips: managerChipsData.chips, // Return the chips array from the initial fetch
        currentEvent: managerChipsData.currentEvent // Return current event from the initial fetch
    };
}


// --- NEW: Function to fetch and process Transfers Data (Isolated) ---
async function getTransfersData(managerId, managerChipsData) { // Now accepts managerChipsData
    let totalTransfersCount = 'N/A';
    let totalHitsPoints = 'N/A';

    try {
        const transfersApiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/transfers/`;
        console.log(`Attempting to fetch transfers data from: ${transfersApiUrl}`);
        
        const transfersResponse = await fetch(transfersApiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': `https://en.fantasy.spl.com.sa/entry/${managerId}/`,
                'DNT': '1',
                'Connection': 'keep-alive',
                'X-Requested-With': 'XMLHttpRequest',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Site': 'same-origin',
                'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'priority': 'u=1, i',
            },
        });

        if (transfersResponse.ok) {
            const responseText = await transfersResponse.text();
            const transfersRawData = JSON.parse(responseText);
            console.log('Successfully fetched and parsed transfers data.');
            console.log('transfersRawData length:', transfersRawData.length); // DEBUG LOG

            // --- Retrieve Total Transfers directly from managerChipsData ---
            totalTransfersCount = managerChipsData.lastDeadlineTotalTransfers;
            console.log('Total Transfers (from last_deadline_total_transfers):', totalTransfersCount); // DEBUG LOG


            // --- Calculate Total Hits (Points Deducted) ---
            let totalHits = 0;
            let freeTransfersAvailable = 1; // Start with 1 free transfer for Round 1

            // Extract chip info and current event from managerChipsData
            const managerChips = managerChipsData?.chips || [];
            const currentEvent = managerChipsData?.currentEvent || 34; // Use currentEvent from managerStats, fallback to 34

            console.log('Manager Chips received for hits calculation:', managerChips); // DEBUG LOG

            const chipRounds = new Set();
            if (managerChips && Array.isArray(managerChips)) {
                managerChips.forEach(chip => {
                    // Exact check for chip names: 'wildcard' or 'loan_ranger'
                    if (chip.name === 'wildcard' || chip.name === 'loan_ranger') {
                        chipRounds.add(chip.event);
                    }
                });
            }
            console.log('Chip Rounds (where transfers are free):', Array.from(chipRounds)); // DEBUG LOG
            
            // Group transfers by event for easier processing
            const transfersInEachRound = {};
            transfersRawData.forEach(transfer => {
                transfersInEachRound[transfer.event] = (transfersInEachRound[transfer.event] || 0) + 1;
            });
            console.log('Transfers grouped by event:', transfersInEachRound); // DEBUG LOG

            // Iterate through rounds up to the current event
            for (let round = 1; round <= currentEvent; round++) {
                const transfersMadeInRound = transfersInEachRound[round] || 0;
                const chipPlayedInRound = chipRounds.has(round);

                console.log(`--- Round ${round} ---`); // DEBUG LOG
                console.log(`  Transfers made: ${transfersMadeInRound}`); // DEBUG LOG
                console.log(`  Chip played: ${chipPlayedInRound}`); // DEBUG LOG
                console.log(`  Free transfers available (start of round): ${freeTransfersAvailable}`); // DEBUG LOG

                if (chipPlayedInRound) {
                    // All transfers are free, free transfers reset to 1 for the *next* round
                    freeTransfersAvailable = 1;
                    console.log('  Chip played, free transfers reset to 1 for next round.'); // DEBUG LOG
                } else {
                    // Apply free transfer logic
                    const hitsForRound = Math.max(0, transfersMadeInRound - freeTransfersAvailable);
                    totalHits += hitsForRound;
                    console.log(`  Hits for round: ${hitsForRound}`); // DEBUG LOG

                    // Update free transfers for the next round
                    if (transfersMadeInRound > 0) { // If transfers were made, free transfers reset
                        freeTransfersAvailable = 1;
                        console.log('  Transfers made, free transfers reset to 1 for next round.'); // DEBUG LOG
                    } else { // No transfers made
                        // Special rule: "Round 1 & 34 not counted" for free transfer generation.
                        // This means rollover does NOT happen if no transfers were made in Round 1 or Round 34.
                        if (round === 1 || round === 34) {
                            // If no transfers were made in Round 1 or 34, free transfers remain 1 (no rollover)
                            freeTransfersAvailable = 1; 
                            console.log('  No transfers in Round 1 or 34, free transfers remain 1 (no rollover).'); // DEBUG LOG
                        } else {
                            // For other rounds, rollover normally
                            freeTransfersAvailable = Math.min(2, freeTransfersAvailable + 1);
                            console.log(`  No transfers, free transfers rolled over to: ${freeTransfersAvailable}`); // DEBUG LOG
                        }
                    }
                }
                console.log(`  Total hits so far: ${totalHits}`); // DEBUG LOG
            }
            totalHitsPoints = totalHits * -4;

            console.log(`Final calculated totalTransfersCount: ${totalTransfersCount}, totalHitsPoints: ${totalHitsPoints}`); // DEBUG LOG

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
        const playerMap = await getPlayerNameMap();

        // Step 1: Fetch manager chips, current event, and last_deadline_total_transfers independently
        let managerChipsAndCurrentEvent = {};
        try {
            managerChipsAndCurrentEvent = await getManagerChipsAndCurrentEvent(managerId);
            console.log('Manager Chips and Current Event fetched successfully.'); // DEBUG LOG
            console.log('Chips from dedicated function:', managerChipsAndCurrentEvent.chips); // DEBUG LOG
            console.log('Current Event from dedicated function:', managerChipsAndCurrentEvent.currentEvent); // DEBUG LOG
            console.log('lastDeadlineTotalTransfers from dedicated function:', managerChipsAndCurrentEvent.lastDeadlineTotalTransfers); // DEBUG LOG
        } catch (error) {
            console.error("getManagerChipsAndCurrentEvent failed:", error);
            managerChipsAndCurrentEvent = { chips: [], currentEvent: 34, lastDeadlineTotalTransfers: 'N/A' }; // Default on failure
        }

        // Step 2: Fetch manager stats (excluding chips and currentEvent, as they are already fetched)
        // Pass the chips and currentEvent to getManagerHistoryAndCaptains for its internal logic if needed
        let managerStats = {};
        try {
            managerStats = await getManagerHistoryAndCaptains(managerId, playerMap, managerChipsAndCurrentEvent);
            console.log('Manager History and Captains fetched successfully.'); // DEBUG LOG
        } catch (error) {
            console.error("getManagerHistoryAndCaptains failed:", error);
            managerStats = {
                overallRankHistory: [],
                overallRank: 'N/A',
                bestOverallRank: 'N/A',
                worstOverallRank: 'N/A',
                averagePoints: 'N/A',
                top3Captains: [],
                bestPlayers: [],
                worstPlayers: [],
                top5MissedPoints: [],
                chips: managerChipsAndCurrentEvent.chips, // Ensure chips are passed through
                currentEvent: managerChipsAndCurrentEvent.currentEvent // Ensure currentEvent is passed through
            };
        }

        // Step 3: Fetch transfers data using the obtained managerChipsAndCurrentEvent
        let transfersData = {};
        try {
            transfersData = await getTransfersData(managerId, managerChipsAndCurrentEvent); // Pass the correct chips and currentEvent
            console.log('Transfers Data calculated successfully.'); // DEBUG LOG
        } catch (error) {
            console.error("getTransfersData failed during calculation:", error);
            transfersData = {
                totalTransfersCount: 'N/A',
                totalHitsPoints: 'N/A'
            };
        }

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
                totalTransfersCount: transfersData.totalTransfersCount,
                totalHitsPoints: transfersData.totalHitsPoints
            }),
            headers: { "Content-Type": "application/json" }
        };

    } catch (error) {
        console.error(`Critical error in Netlify function handler for manager ${managerId}:`, error);
        let errorMessage = 'An unexpected error occurred. Please try again later.';
        
        return {
            statusCode: 500,
            body: JSON.stringify({ error: errorMessage, details: error.message }),
            headers: { "Content-Type": "application/json" }
        };
    }
};