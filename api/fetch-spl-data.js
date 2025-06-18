// Vercel Serverless Function: api/fetch-spl-data.js
// This function fetches SPL Fantasy League data based on a manager ID.
// It's designed to be deployed as a Vercel Serverless Function.

const fetch = require('node-fetch');

// --- GLOBAL VARIABLES (reset per invocation) ---
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
    const url = 'https://en.fantasy.spl.com.sa/api/bootstrap-static/'; // Corrected domain
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
async function getManagerBasicData(managerId) { 
    const managerEntryUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/`; // Corrected domain
    try {
        const entryRes = await fetchWithRetry(managerEntryUrl);
        const managerEntryData = await entryRes.json();
        
        console.log('--- Inside getManagerBasicData ---'); 
        console.log('Full managerEntryData object (for basic data):', JSON.stringify(managerEntryData, null, 2)); 

        const chips = managerEntryData.chips || []; 
        const currentEvent = managerEntryData.current_event || 34; 
        const lastDeadlineTotalTransfers = managerEntryData.last_deadline_total_transfers || 'N/A';
        const managerName = managerEntryData.name || `Manager ID: ${managerId}`; 

        console.log('Chips extracted by getManagerBasicData:', chips); 
        console.log('Current Event extracted by getManagerBasicData:', currentEvent); 
        console.log('last_deadline_total_transfers extracted by getManagerBasicData:', lastDeadlineTotalTransfers); 
        console.log('Manager Name extracted by getManagerBasicData:', managerName); 
        console.log('--- End getManagerBasicData ---'); 

        return { 
            chips, 
            currentEvent,
            lastDeadlineTotalTransfers,
            managerName 
        };
    } catch (error) {
        console.error(`ERROR: Failed to fetch manager basic data for ${managerId}:`, error.message);
        return { chips: [], currentEvent: 34, lastDeadlineTotalTransfers: 'N/A', managerName: `Manager ID: ${managerId}` }; 
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
    let totalTransfersCost = 0; 
    
    let greenArrowsCount = 0;
    let redArrowsCount = 0;

    const maxRounds = 34; // Total number of rounds in the season

    const overallRankHistory = [];

    const missedPointsInstances = []; 
    const playerSeasonStats = {}; 
    const uniquePlayerIdsInSquad = new Set(); 

    const managerChips = managerBasicData?.chips || []; 
    const currentEvent = managerBasicData?.currentEvent || maxRounds;

    const allTransfersAnalysis = [];

    // Fetch all transfers data once at the beginning of this function
    let transfersRawData = [];
    try {
        const transfersApiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/transfers/`; // Corrected domain
        const transfersResponse = await fetchWithRetry(transfersApiUrl);
        transfersRawData = await transfersResponse.json();
        console.log(`Fetched transfersRawData for manager ${managerId}. Total records: ${transfersRawData.length}`);
    } catch (error) {
        console.error(`Error fetching transfersRawData for manager ${managerId}:`, error.message);
    }


    // Fetch data for all rounds for the given manager concurrently with retries
    const managerPicksPromises = [];
    for (let round = 1; round <= maxRounds; round++) {
        const picksUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/event/${round}/picks`; // Corrected domain
        managerPicksPromises.push(
            (async () => {
                try {
                    const res = await fetchWithRetry(picksUrl);
                    return { round, data: await res.json() }; 
                } catch (error) {
                    console.warn(`Skipping round ${round} for manager ${managerId} due to persistent fetch error: ${error.message}`);
                    return { round, data: null };
                }
            })()
        );
    }
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
    let previousOverallRank = null; 
    for (const { round, data } of sortedManagerPicksData) {
        roundsProcessed++;

        // --- Update for Rank & Points Table ---
        const currentOverallRank = data.entry_history.overall_rank;
        const currentRoundPoints = data.entry_history.points;
        const currentRoundTransfersCost = data.entry_history.event_transfers_cost || 0; 
        const transfersMadeInRound = data.entry_history.event_transfers || 0; 

        totalTransfersCost += currentRoundTransfersCost;

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
            // Calculate Green/Red Arrows
            if (previousOverallRank !== null) { 
                if (currentOverallRank < previousOverallRank) {
                    greenArrowsCount++;
                } else if (currentOverallRank > previousOverallRank) {
                    redArrowsCount++;
                }
            }
            latestOverallRank = currentOverallRank;
            previousOverallRank = currentOverallRank; 

            if (currentOverallRank < minOverallRank) {
                minOverallRank = currentOverallRank;
                minOverallRankRound = round;
            }
            if (currentOverallRank > maxOverallRank) {
                maxOverallRank = currentOverallRank;
                maxOverallRankRound = round;
            }
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
            const actualTransfersToProcess = transfersForThisRound.slice(0, transfersMadeInRound);

            for (const transfer of actualTransfersToProcess) {
                const playerInId = transfer.element_in;
                const playerOutId = transfer.element_out;

                // Fetch player summary for IN and OUT players to get their points in this specific round
                const playerInSummaryPromise = fetchWithRetry(`https://en.fantasy.spl.com.sa/api/element-summary/${playerInId}/`); // Corrected domain
                const playerOutSummaryPromise = fetchWithRetry(`https://en.fantasy.spl.com.sa/api/element-summary/${playerOutId}/`); // Corrected domain

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

                const profitLoss = playerInPoints - playerOutPoints;

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
        .sort(([, countA], [, countB]) => countB - countA) 
        .slice(0, 3);

    for (const [captainIdStr, timesCaptained] of sortedCaptains) {
        const captainId = parseInt(captainIdStr);
        const playerSummaryUrl = `https://en.fantasy.spl.com.sa/api/element-summary/${captainId}/`; // Corrected domain
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
            totalCaptainedPoints: totalCaptainedPoints * 2, 
            captainedRounds: captainedRoundsTracker[captainId]
        });
    }

    const allPlayerSummaryPromises = Array.from(uniquePlayerIdsInSquad).map(async playerId => {
        try {
            const playerSummaryUrl = `https://en.fantasy.spl.com.sa/api/element-summary/${playerId}/`; // Corrected domain
            const response = await fetchWithRetry(playerSummaryUrl);
            return { playerId: parseInt(playerId), summary: await response.json() };
        } catch (error) {
            console.warn(`Could not fetch summary for player ${playerId} due to persistent error: ${error.message}`);
            return { playerId: parseInt(playerId), summary: null };
        }
    });
    const allPlayerSummariesResults = await Promise.all(allPlayerSummaryPromises);
    const allPlayerSummariesMap = new Map(allPlayerSummariesResults.filter(p => p.summary).map(p => [p.playerId, p.summary]));


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

            const allRoundStatsEntriesForCurrentRound = playerHistory.filter(h => h.round === roundNum);
            const playerPointsForRound = allRoundStatsEntriesForCurrentRound.reduce((sum, entry) => sum + entry.total_points, 0);

            if ((position >= 1 && position <= 11 && !isSubbedOut) || isSubbedIn) { 
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

    const top5MissedPoints = missedPointsInstances
        .sort((a, b) => b.points - a.points)
        .slice(0, 5)
        .map(item => ({
            playerName: playerNameMap[item.playerId] || `Unknown (ID:${item.playerId})`,
            points: item.points,
            round: item.round
        }));


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
        managerName: managerBasicData.managerName,
        bestRound: {
            points: bestRoundPoints !== -Infinity ? bestRoundPoints : 'N/A',
            deductions: bestRoundDeductions,
            round: bestRoundNumber
        },
        worstRound: {
            points: worstRoundPoints !== Infinity ? worstRoundPoints : 'N/A',
            deductions: worstRoundDeductions,
            round: worstRoundNumber
        },
        greenArrowsCount: greenArrowsCount,
        redArrowsCount: redArrowsCount
    };
}


// --- Simplified getTransfersData function (no longer used for main calculations as data is in getManagerHistoryAndCaptains) ---
// This function name is misleading as it now just retrieves summary totals already calculated.
async function getTransfersData(managerId, managerBasicData, managerStats) { 
    const totalTransfersCount = managerBasicData.lastDeadlineTotalTransfers;
    const totalHitsPoints = managerStats.totalHitsPoints; 

    console.log(`Final Transfers Data: Total Transfers: ${totalTransfersCount}, Total Hits: ${totalHitsPoints}`);

    return {
        totalTransfersCount: totalTransfersCount,
        totalHitsPoints: totalHitsPoints
    };
}


// --- Vercel Function Handler (Main entry point) ---
module.exports = async (request, response) => { // Changed exports.handler to module.exports for Vercel Serverless
    // Set CORS headers to allow requests from your frontend on any domain.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests (OPTIONS method)
    if (request.method === 'OPTIONS') {
        return response.status(200).send();
    }

    const managerId = request.query.id;
    console.log(`Received request for managerId: ${managerId}`);

    if (!managerId || typeof managerId !== 'string' || !/^\d+$/.test(managerId)) {
        console.error('Invalid managerId received:', managerId);
        return response.status(400).json({ error: 'Manager ID is required and must be a valid number.' });
    }

    try {
        const playerMap = await getPlayerNameMap();

        let managerBasicData = {};
        try {
            managerBasicData = await getManagerBasicData(managerId);
            console.log('Manager Basic Data fetched successfully.');
            console.log('Basic Data (in handler):', managerBasicData);
        } catch (error) {
            console.error("getManagerBasicData failed in handler:", error);
            managerBasicData = { chips: [], currentEvent: 34, lastDeadlineTotalTransfers: 'N/A', managerName: `Manager ID: ${managerId}` };
        }

        let managerStats = {};
        try {
            managerStats = await getManagerHistoryAndCaptains(managerId, playerMap, managerBasicData);
            console.log('Manager History and Captains fetched successfully.');
            console.log('Manager Stats (in handler):', JSON.stringify(managerStats, null, 2));
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
                worstRound: { points: 'N/A', deductions: 'N/A', round: 'N/A' },
                greenArrowsCount: 0,
                redArrowsCount: 0
            };
        }

        let transfersData = {};
        try {
            // This function call is simplified as totalTransfersCount and totalHitsPoints are now derived from managerStats
            transfersData = await getTransfersData(managerId, managerBasicData, managerStats); 
            console.log('Transfers Data retrieved successfully.');
        } catch (error) {
            console.error("getTransfersData failed during retrieval in handler:", error);
            transfersData = {
                totalTransfersCount: 'N/A',
                totalHitsPoints: 'N/A'
            };
        }

        const averagePointsFor1stPlace = 75; // This seems like a static placeholder

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
            managerName: managerBasicData.managerName,
            bestRound: managerStats.bestRound,
            worstRound: managerStats.worstRound,
            greenArrowsCount: managerStats.greenArrowsCount,
            redArrowsCount: managerStats.redArrowsCount
        };
        console.log('Final JSON response body:', JSON.stringify(finalResponse, null, 2));

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
