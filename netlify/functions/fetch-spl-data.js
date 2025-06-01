// netlify/functions/fetch-spl-data.js
const fetch = require('node-fetch'); // Import node-fetch for Netlify Functions environment

// --- GLOBAL VARIABLES ---
let captainCounts = {};
let captainedRoundsTracker = {};
// --- END GLOBAL VARIABLES ---

// Helper function to introduce a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// NEW: Helper function to fetch data with retries and exponential backoff
async function fetchWithRetry(url, maxRetries = 5, baseDelayMs = 200) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const response = await fetch(url);

            if (response.ok) { // Status 200-299
                return response;
            } else if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
                // Retry for 429 (Too Many Requests) or server errors
                const delay = baseDelayMs * Math.pow(2, retries) + Math.random() * 100; // Exponential backoff + jitter
                console.warn(`Attempt ${retries + 1}/${maxRetries} failed for ${url} with status ${response.status}. Retrying in ${delay.toFixed(0)}ms...`);
                await sleep(delay);
                retries++;
            } else {
                // For other non-retryable errors (e.g., 400, 404), throw immediately
                throw new Error(`Failed to fetch ${url}: HTTP status ${response.status}`);
            }
        } catch (error) {
            console.error(`Fetch error for ${url} (attempt ${retries + 1}/${maxRetries}):`, error.message);
            if (retries === maxRetries - 1) {
                throw error; // Re-throw if it's the last retry
            }
            const delay = baseDelayMs * Math.pow(2, retries) + Math.random() * 100; // Exponential backoff + jitter
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
        const response = await fetchWithRetry(url); // Use fetchWithRetry
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

    // Fetch data for all rounds for the given manager concurrently with retries
    const managerPicksPromises = [];
    for (let round = 1; round <= maxRounds; round++) {
        const picksUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/event/${round}/picks`;
        managerPicksPromises.push(
            (async () => {
                try {
                    const res = await fetchWithRetry(picksUrl); // Use fetchWithRetry
                    return res.json();
                } catch (error) {
                    console.warn(`Skipping round ${round} for manager ${managerId} due to persistent fetch error: ${error.message}`);
                    return null; // Return null for failed fetches after retries
                }
            })()
        );
    }
    const allManagerPicksData = await Promise.all(managerPicksPromises);

    // Process collected manager picks data
    let latestOverallRank = 'N/A';
    for (let round = 1; round <= maxRounds; round++) {
        const data = allManagerPicksData[round - 1];

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
        }
    }

    const averagePoints = roundsProcessed > 0 ? Math.round(totalPointsSum / roundsProcessed) : 'N/A';

    // Fetch player summaries for all *unique* captains concurrently with retries
    const uniqueCaptains = Object.keys(captainCounts);
    const playerSummariesPromises = uniqueCaptains.map(async playerId => {
        try {
            const playerSummaryUrl = `https://en.fantasy.spl.com.sa/api/element-summary/${playerId}/`;
            const response = await fetchWithRetry(playerSummaryUrl); // Use fetchWithRetry
            return { playerId: parseInt(playerId), summary: await response.json() };
        } catch (error) {
            console.warn(`Could not fetch summary for player ${playerId} due to persistent error: ${error.message}`);
            return { playerId: parseInt(playerId), summary: null };
        }
    });
    const playerSummariesResults = await Promise.all(playerSummariesPromises);
    const playerSummariesMap = new Map(playerSummariesResults.filter(p => p.summary).map(p => [p.playerId, p.summary]));


    const top3CaptainsStats = [];
    const sortedCaptains = Object.entries(captainCounts)
        .sort(([, countA], [, countB]) => countB - countA)
        .slice(0, 3);

    for (const [captainIdStr, timesCaptained] of sortedCaptains) {
        const captainId = parseInt(captainIdStr);
        const playerSummary = playerSummariesMap.get(captainId);
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

    return {
        overallRank: latestOverallRank,
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
        const playerNameMap = await getPlayerNameMap();

        const managerStats = await getManagerHistoryAndCaptains(managerId, playerNameMap);

        const averagePointsFor1stPlace = 75; // This value was hardcoded in your original `index.html`

        return {
            statusCode: 200,
            body: JSON.stringify({
                overallRank: managerStats.overallRank,
                bestOverallRank: managerStats.bestOverallRank,
                worstOverallRank: managerStats.worstOverallRank,
                averagePoints: managerStats.averagePoints,
                averagePointsFor1stPlace: averagePointsFor1stPlace,
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