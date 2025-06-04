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

// Dedicated function to fetch manager basic data: chips, current event, and last_deadline_total_transfers
async function getManagerBasicData(managerId) { // Renamed for clarity
    const managerEntryUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/`;
    try {
        const entryRes = await fetchWithRetry(managerEntryUrl);
        const managerEntryData = await entryRes.json();
        
        console.log('--- Inside getManagerBasicData ---'); // Debug Marker
        console.log('Full managerEntryData object (for basic data):', JSON.stringify(managerEntryData, null, 2)); // DEBUG LOG: Full object

        // Directly extract essential data
        const chips = managerEntryData.chips || []; // Chips might be missing sometimes
        const currentEvent = managerEntryData.current_event || 34; // Fallback to 34
        const lastDeadlineTotalTransfers = managerEntryData.last_deadline_total_transfers || 'N/A';
        const managerName = managerEntryData.name || `Manager ID: ${managerId}`; // Get manager's team name

        console.log('Chips extracted by getManagerBasicData:', chips); // DEBUG LOG
        console.log('Current Event extracted by getManagerBasicData:', currentEvent); // DEBUG LOG
        console.log('last_deadline_total_transfers extracted by getManagerBasicData:', lastDeadlineTotalTransfers); // DEBUG LOG
        console.log('Manager Name extracted by getManagerBasicData:', managerName); // DEBUG LOG
        console.log('--- End getManagerBasicData ---'); // Debug Marker

        return { 
            chips, 
            currentEvent,
            lastDeadlineTotalTransfers,
            managerName // Include managerName in the returned object
        };
    } catch (error) {
        console.error(`ERROR: Failed to fetch manager basic data for ${managerId}:`, error.message);
        return { chips: [], currentEvent: 34, lastDeadlineTotalTransfers: 'N/A', managerName: `Manager ID: ${managerId}` }; // Return defaults on failure
    }
}


// Helper function to get manager's history details, captaincy stats, and calculate total hits
async function getManagerHistoryAndCaptains(managerId, playerNameMap, managerBasicData) { 
    // Reset global counters for each invocation
    captainCounts = {};
    captainedRoundsTracker = {};

    let minOverallRank = Infinity;
    let minOverallRankRound = 'N/A';
    let maxOverallRank = -Infinity;
    let maxOverallRankRound = 'N/A';
    let totalPointsSum = 0;
    let roundsProcessed = 0;
    let totalTransfersCost = 0; // Initialize total transfers cost for hits calculation
    // Removed: isNonActiveManager and consecutiveZeroTC variables

    const maxRounds = 34; // Total number of rounds in the season

    // Array to store overall rank for each round, now including points and transfers cost
    const overallRankHistory = [];

    // Initialize these sets/objects
    const missedPointsInstances = []; 
    const playerSeasonStats = {}; 
    const uniquePlayerIdsInSquad = new Set(); 

    // Use chips and currentEvent from managerBasicData passed from handler
    const managerChips = managerBasicData?.chips || []; // Keep chips for other potential uses, not for hits calc
    const currentEvent = managerBasicData?.currentEvent || maxRounds;

    // Array to store all transfers with calculated profit/loss
    const allTransfersAnalysis = [];

    // Fetch all transfers data once at the beginning of this function
    let transfersRawData = [];
    try {
        const transfersApiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/transfers/`;
        const transfersResponse = await fetchWithRetry(transfersApiUrl);
        transfersRawData = await transfersResponse.json();
        console.log(`Fetched transfersRawData for manager ${managerId}. Total records: ${transfersRawData.length}`);
    } catch (error) {
        console.error(`Error fetching transfersRawData for manager ${managerId}:`, error.message);
    }


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
    console.log(`All Manager Picks Results (status of each round fetch):`, allManagerPicksResults.map(r => r.status));


    // Sort results by round number to ensure correct order for history
    const sortedManagerPicksData = allManagerPicksResults
        .filter(result => result.status === 'fulfilled' && result.value.data !== null)
        .map(result => result.value)
        .sort((a, b) => a.round - b.round);
    console.log(`Sorted Manager Picks Data (after filtering):`, sortedManagerPicksData.length > 0 ? `Contains data for ${sortedManagerPicksData.length} rounds.` : `Is EMPTY!`);

    let bestRoundPoints = -Infinity;
    let bestRoundDeductions = 0;
    let bestRoundNumber = 'N/A';

    let worstRoundPoints = Infinity;
    let worstRoundDeductions = 0;
    let worstRoundNumber = 'N/A';


    // Process collected manager picks data to populate overall stats and identify all unique players
    let latestOverallRank = 'N/A';
    for (const { round, data } of sortedManagerPicksData) {
        roundsProcessed++;

        // --- Update for Rank & Points Table ---
        const currentOverallRank = data.entry_history.overall_rank;
        const currentRoundPoints = data.entry_history.points;
        const currentRoundTransfersCost = data.entry_history.event_transfers_cost || 0; // Get TC for current round
        const transfersMadeInRound = data.entry_history.event_transfers || 0; // Get TM for current round

        // Calculate total hits by summing 'event_transfers_cost' from each round's entry_history
        totalTransfersCost += currentRoundTransfersCost;

        // Store overall rank, points, and transfers cost for this round
        overallRankHistory.push({ 
            round: round, 
            rank: currentOverallRank,
            points: currentRoundPoints,
            transfersCost: currentRoundTransfersCost
        });

        // Calculate Best/Worst Round
        if (currentRoundPoints !== undefined) {
            if (currentRoundPoints > bestRoundPoints) {
                bestRoundPoints = currentRoundPoints;
                bestRoundDeductions = currentRoundTransfersCost;
                bestRoundNumber = round;
            }
            if (currentRoundPoints < worstRoundPoints) {
                worstRoundPoints = currentRoundPoints;
                worstRoundDeductions = currentRoundTransfersCost;
                worstRoundNumber = round;
            }
            totalPointsSum += currentRoundPoints;
        }


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

        // Process data for Best/Worst Players Table AND Missed Points Table
        const automaticSubs = data.automatic_subs || [];
        const subbedOutPlayersThisRound = new Set(automaticSubs.map(sub => sub.element_out));
        const subbedInPlayersThisRound = new Set(automaticSubs.map(sub => sub.element_in));

        data.picks.forEach(pick => {
            const playerId = pick.element;
            uniquePlayerIdsInSquad.add(playerId); 

            if (!playerSeasonStats[playerId]) {
                playerSeasonStats[playerId] = {
                    started: 0,
                    autoSubbed: 0,
                    pointsGained: 0,
                    benchedPoints: 0,
                    roundsInfo: {} 
                };
            }

            // Track 'Started' and 'Auto subbed' counts
            const isSubbedOut = subbedOutPlayersThisRound.has(playerId);
            const isSubbedIn = subbedInPlayersThisRound.has(playerId);

            if (pick.position >= 1 && pick.position <= 11 && !isSubbedOut) {
                playerSeasonStats[playerId].started++;
            } else if (isSubbedIn) {
                playerSeasonStats[playerId].started++; 
                playerSeasonStats[playerId].autoSubbed++;
            }
            playerSeasonStats[playerId].roundsInfo[round] = {
                position: pick.position,
                multiplier: pick.multiplier,
                isSubbedOut: isSubbedOut,
                isSubbedIn: isSubbedIn
            };
        });

        // Collect and analyze transfers for "Most Profitable/Loss-making Transfers"
        if (transfersMadeInRound > 0) {
            const transfersForThisRound = transfersRawData.filter(t => t.event === round);
            // Take only the number of transfers that 'counted' for this round's TM
            const actualTransfersToProcess = transfersForThisRound.slice(0, transfersMadeInRound);

            for (const transfer of actualTransfersToProcess) {
                const playerInId = transfer.element_in;
                const playerOutId = transfer.element_out;

                // Fetch player summary for IN and OUT players to get their points in this specific round
                const playerInSummaryPromise = fetchWithRetry(`https://en.fantasy.spl.com.sa/api/element-summary/${playerInId}/`);
                const playerOutSummaryPromise = fetchWithRetry(`https://en.fantasy.spl.com.sa/api/element-summary/${playerOutId}/`);

                const [playerInRes, playerOutRes] = await Promise.allSettled([playerInSummaryPromise, playerOutSummaryPromise]);

                let playerInPoints = 0;
                if (playerInRes.status === 'fulfilled' && playerInRes.value.ok) {
                    const playerInSummary = await playerInRes.value.json();
                    const inHistory = playerInSummary.history.find(h => h.round === round);
                    playerInPoints = inHistory ? inHistory.total_points : 0;
                } else {
                    console.warn(`Could not get points for Player IN ID ${playerInId} in Round ${round}.`);
                }

                let playerOutPoints = 0;
                if (playerOutRes.status === 'fulfilled' && playerOutRes.value.ok) {
                    const playerOutSummary = await playerOutRes.value.json();
                    const outHistory = playerOutSummary.history.find(h => h.round === round);
                    playerOutPoints = outHistory ? outHistory.total_points : 0;
                } else {
                    console.warn(`Could not get points for Player OUT ID ${playerOutId} in Round ${round}.`);
                }

                // Calculate Profit/Loss using the user's formula
                const profitLoss = playerInPoints - playerOutPoints - currentRoundTransfersCost;

                allTransfersAnalysis.push({
                    playerInName: playerNameMap[playerInId] || `Unknown (ID:${playerInId})`,
                    playerOutName: playerNameMap[playerOutId] || `Unknown (ID:${playerOutId})`,
                    round: round,
                    tcValue: currentRoundTransfersCost,
                    profitLoss: profitLoss
                });
            }
        }
    }

    const averagePoints = roundsProcessed > 0 ? Math.round(totalPointsSum / roundsProcessed) : 'N/A';

    const top3CaptainsStats = [];
    const sortedCaptains = Object.entries(captainCounts)
        .sort(([, countA], [, countB]) => countB - countA) // Sort by times captained
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
        if (!playerSummary) continue; 

        const playerHistory = playerSummary.history || [];
        const playerStats = playerSeasonStats[playerId];

        playerStats.pointsGained = 0; 
        playerStats.benchedPoints = 0; 

        for (const round of Object.keys(playerStats.roundsInfo)) {
            const roundNum = parseInt(round);
            const { position, multiplier, isSubbedOut, isSubbedIn } = playerStats.roundsInfo[roundNum];

            // Corrected line: Missing parenthesis around 'entry' in the reduce callback
            const playerPointsForRound = allRoundStatsEntries.reduce((sum, entry) => sum + entry.total_points, 0);

            if ((position >= 1 && pick.position <= 11 && !isSubbedOut) || isSubbedIn) {
                playerStats.pointsGained += (playerPointsForRound * multiplier);
            } else {
                playerStats.benchedPoints += playerPointsForRound; 

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
        .filter(([, stats]) => stats.pointsGained > 0 || stats.benchedPoints > 0) 
        .sort(([, statsA], [, statsB]) => statsB.pointsGained - statsA.pointsGained) 
        .slice(0, 5) 
        .map(([playerId, stats]) => ({
            name: playerNameMap[parseInt(playerId)] || `Unknown (ID:${playerId})`,
            started: stats.started,
            autoSubbed: stats.autoSubbed,
            pointsGained: stats.pointsGained,
            benchedPoints: stats.benchedPoints
        }));

    // Prepare Worst Players Table Data
    const worstPlayersList = Object.entries(playerSeasonStats)
        .filter(([, stats]) => stats.started > 0) 
        .sort(([, statsA], [, statsB]) => statsA.pointsGained - statsB.pointsGained) 
        .slice(0, 5) 
        .map(([playerId, stats]) => ({
            name: playerNameMap[parseInt(playerId)] || `Unknown (ID:${playerId})`,
            started: stats.started,
            autoSubbed: stats.autoSubbed,
            pointsGained: stats.pointsGained,
            benchedPoints: stats.benchedPoints
        }));

    // Sort allTransfersAnalysis for top 5 profitable and loss-making
    const sortedByProfitLoss = [...allTransfersAnalysis].sort((a, b) => b.profitLoss - a.profitLoss);
    const top5ProfitableTransfers = sortedByProfitLoss.slice(0, 5);
    const top5LossMakingTransfers = sortedByProfitLoss.slice(-5).reverse(); 

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
        chips: managerBasicData.chips, 
        currentEvent: managerBasicData.currentEvent,
        totalHitsPoints: totalTransfersCost * -1, 
        top5ProfitableTransfers: top5ProfitableTransfers, 
        top5LossMakingTransfers: top5LossMakingTransfers,
        bestRound: {
            points: bestRoundPoints,
            deductions: bestRoundDeductions,
            round: bestRoundNumber
        },
        worstRound: {
            points: worstRoundPoints,
            deductions: worstRoundDeductions,
            round: worstRoundNumber
        }
    };
}


// --- Simplified getTransfersData function (no longer used for main calculations) ---
async function getTransfersData(managerId, managerBasicData, managerStats) { 
    const totalTransfersCount = managerBasicData.lastDeadlineTotalTransfers;
    const totalHitsPoints = managerStats.totalHitsPoints; 

    console.log(`Final Transfers Data: Total Transfers: ${totalTransfersCount}, Total Hits: ${totalHitsPoints}`); // DEBUG LOG

    return {
        totalTransfersCount: totalTransfersCount,
        totalHitsPoints: totalHitsPoints
    };
}


// --- Netlify Function Handler (Main entry point) ---
exports.handler = async function(event, context) {
    const managerId = event.queryStringParameters.id;
    console.log(`Received request for managerId: ${managerId}`); // Added logging

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

        // Step 1: Fetch manager basic data (current event, total transfers, and chips)
        let managerBasicData = {};
        try {
            managerBasicData = await getManagerBasicData(managerId);
            console.log('Manager Basic Data fetched successfully.'); // DEBUG LOG
            console.log('Basic Data (in handler):', managerBasicData); // DEBUG LOG
        } catch (error) {
            console.error("getManagerBasicData failed in handler:", error);
            managerBasicData = { chips: [], currentEvent: 34, lastDeadlineTotalTransfers: 'N/A', managerName: `Manager ID: ${managerId}` }; // Default on failure
        }

        // Step 2: Fetch manager history and captaincy stats, and calculate total hits AND transfer analysis
        let managerStats = {};
        try {
            managerStats = await getManagerHistoryAndCaptains(managerId, playerMap, managerBasicData);
            console.log('Manager History and Captains fetched successfully.'); // DEBUG LOG
            console.log('Manager Stats (in handler):', JSON.stringify(managerStats, null, 2)); // Added detailed logging
        } catch (error) {
            console.error("getManagerHistoryAndCaptains failed in handler:", error);
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
                chips: managerBasicData.chips, 
                currentEvent: managerBasicData.currentEvent,
                totalHitsPoints: 'N/A', 
                top5ProfitableTransfers: [], 
                top5LossMakingTransfers: [],
                bestRound: { points: 'N/A', deductions: 'N/A', round: 'N/A' },
                worstRound: { points: 'N/A', deductions: 'N/A', round: 'N/A' }
            };
        }

        // Step 3: Get transfers data (now just passing through pre-calculated values)
        let transfersData = {};
        try {
            transfersData = await getTransfersData(managerId, managerBasicData, managerStats); 
            console.log('Transfers Data retrieved successfully.'); // DEBUG LOG
        } catch (error) {
            console.error("getTransfersData failed during retrieval in handler:", error);
            transfersData = {
                totalTransfersCount: 'N/A',
                totalHitsPoints: 'N/A'
            };
        }

        const averagePointsFor1stPlace = 75; // Hardcoded as requested

        const finalResponse = {
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
            totalHitsPoints: transfersData.totalHitsPoints,
            top5ProfitableTransfers: managerStats.top5ProfitableTransfers, 
            top5LossMakingTransfers: managerStats.top5LossMakingTransfers,
            managerName: managerBasicData.managerName, // Pass managerName from basic data
            bestRound: managerStats.bestRound,
            worstRound: managerStats.worstRound
        };
        console.log('Final JSON response body:', JSON.stringify(finalResponse, null, 2)); // Added final response logging

        return {
            statusCode: 200,
            body: JSON.stringify(finalResponse),
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