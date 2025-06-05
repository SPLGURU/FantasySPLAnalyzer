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
            if (retries === maxRetries - 1) {
                console.error(`Max retries reached for ${url}. Error:`, error);
                throw error; // Re-throw if max retries reached
            }
            const delay = baseDelayMs * Math.pow(2, retries) + Math.random() * 100;
            console.warn(`Attempt ${retries + 1}/${maxRetries} failed for ${url}. Retrying in ${delay.toFixed(0)}ms...`);
            await sleep(delay);
            retries++;
        }
    }
    throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts.`);
}

// Helper function to fetch manager's basic data
async function fetchManagerBasicData(managerId) {
    const response = await fetchWithRetry(`https://fantasy.premierleague.com/api/entry/${managerId}/`);
    const data = await response.json();
    return {
        managerName: data.name,
        overallRank: data.summary_overall_rank,
        entryData: data
    };
}

// Helper function to fetch manager's history including overall rank
async function fetchManagerHistory(managerId) {
    const response = await fetchWithRetry(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`);
    const data = await response.json();
    return data;
}

// Helper function to fetch event status to get current gameweek
async function fetchEventStatus() {
    const response = await fetchWithRetry(`https://fantasy.premierleague.com/api/event-status/`);
    const data = await response.json();
    // Find the latest completed gameweek
    const latestCompletedGameweek = data.status.find(event => event.event_past === true && event.points_calculated === true);
    return latestCompletedGameweek ? latestCompletedGameweek.event : 0; // Return event number, or 0 if none completed
}

// Helper function to fetch gameweek data to get average points and rank
async function fetchGameweekData(gameweekId) {
    const response = await fetchWithRetry(`https://fantasy.premierleague.com/api/event/${gameweekId}/live/`);
    const data = await response.json();
    return data;
}

// Helper function to get manager's picks for a specific gameweek
async function fetchManagerPicks(managerId, gameweekId) {
    const response = await fetchWithRetry(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${gameweekId}/picks/`);
    const data = await response.json();
    return data;
}

// Helper function to get player details (used for mapping element IDs to player names)
async function fetchAllPlayers() {
    const response = await fetchWithRetry(`https://fantasy.premierleague.com/api/bootstrap-static/`);
    const data = await response.json();
    const playersMap = {};
    data.elements.forEach(player => {
        playersMap[player.id] = {
            name: player.web_name,
            points: player.total_points,
            element_type: player.element_type, // For position mapping later if needed
            team: player.team // For team name mapping later if needed
        };
    });
    return playersMap;
}

// Helper function to get team details (used for mapping team IDs to team names)
async function fetchAllTeams() {
    const response = await fetchWithRetry(`https://fantasy.premierleague.com/api/bootstrap-static/`);
    const data = await response.json();
    const teamsMap = {};
    data.teams.forEach(team => {
        teamsMap[team.id] = team.name;
    });
    return teamsMap;
}


// --- Main handler for Netlify Function ---
exports.handler = async function(event, context) {
    const managerId = event.queryStringParameters.id;

    if (!managerId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Manager ID is required.' }),
            headers: { "Content-Type": "application/json" }
        };
    }

    try {
        const managerBasicData = await fetchManagerBasicData(managerId);
        const managerHistory = await fetchManagerHistory(managerId);
        const latestGameweek = await fetchEventStatus(); // Get the latest completed gameweek ID

        // Early exit if manager not found or history is empty
        if (!managerBasicData || !managerHistory || !managerHistory.past || managerHistory.past.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: `Manager with ID ${managerId} not found or no historical data available.` }),
                headers: { "Content-Type": "application/json" }
            };
        }

        const overallRankHistory = managerHistory.past.map(gw => ({
            round: gw.event,
            points: gw.points,
            totalPoints: gw.total_points,
            rank: gw.overall_rank,
            eventTransfers: gw.event_transfers,
            transfersCost: gw.event_transfers_cost
        }));

        // Calculate Best and Worst Overall Rank with Round number
        let bestOverallRank = 'N/A';
        let worstOverallRank = 'N/A';
        let minRank = Infinity;
        let maxRank = 0;
        
        // Find best and worst round points/deductions
        let bestRound = { points: 'N/A', round: 'N/A', deductions: 0 };
        let worstRound = { points: 'N/A', round: 'N/A', deductions: 0 };
        let maxPoints = -Infinity;
        let minPoints = Infinity;

        overallRankHistory.forEach(gw => {
            if (gw.rank < minRank) {
                minRank = gw.rank;
                bestOverallRank = `${gw.rank} (R${gw.round})`;
            }
            if (gw.rank > maxRank) {
                maxRank = gw.rank;
                worstOverallRank = `${gw.rank} (R${gw.round})`;
            }

            if (gw.points > maxPoints) {
                maxPoints = gw.points;
                bestRound = { points: gw.points, round: gw.round, deductions: gw.transfersCost };
            }
            if (gw.points < minPoints) {
                minPoints = gw.points;
                worstRound = { points: gw.points, round: gw.round, deductions: gw.transfersCost };
            }
        });

        // Calculate Green and Red Arrows
        let greenArrowsCount = 0;
        let redArrowsCount = 0;
        for (let i = 1; i < overallRankHistory.length; i++) {
            const currentRoundData = overallRankHistory[i];
            const previousRoundData = overallRankHistory[i - 1];

            if (currentRoundData.rank < previousRoundData.rank) {
                greenArrowsCount++;
            } else if (currentRoundData.rank > previousRoundData.rank) {
                redArrowsCount++;
            }
        }


        // Calculate Average Points per Round
        const totalPoints = overallRankHistory.reduce((sum, gw) => sum + gw.points, 0);
        const averagePoints = overallRankHistory.length > 0 ? (totalPoints / overallRankHistory.length).toFixed(2) : 'N/A';

        // Fetch overall league data for average points of 1st place (if available)
        let averagePointsFor1stPlace = 'N/A';
        if (latestGameweek) {
            try {
                const gameweekData = await fetchGameweekData(latestGameweek);
                if (gameweekData.top_element_info) {
                    // This typically returns the top individual score for the week, not average 1st place.
                    // For true 1st place average, we would need to query the league data for top overall ranks across rounds.
                    // For now, let's use the average score of all players for the latest gameweek as a proxy for "league average".
                    // Or if a specific "average_entry_score" is available in the event status.
                     if (gameweekData.elements && gameweekData.elements.length > 0) {
                        const allScores = Object.values(gameweekData.elements).map(e => e.stats.total_points);
                        const totalAllScores = allScores.reduce((sum, score) => sum + score, 0);
                        averagePointsFor1stPlace = (totalAllScores / allScores.length).toFixed(2);
                    }
                }
            } catch (error) {
                console.warn("Could not fetch gameweek data for 1st place average:", error);
            }
        }

        // --- Captains Analysis ---
        const allPlayers = await fetchAllPlayers();
        captainCounts = {}; // Reset for each manager
        captainedRoundsTracker = {}; // Reset for each manager

        for (let gw = 1; gw <= latestGameweek; gw++) {
            try {
                const picks = await fetchManagerPicks(managerId, gw);
                const captainPick = picks.picks.find(p => p.is_captain || p.is_vice_captain); // Consider vice too? FPL only counts captain
                
                if (captainPick) {
                    const captainId = captainPick.element;
                    const captainName = allPlayers[captainId] ? allPlayers[captainId].name : `Player ${captainId}`;
                    const gameweekLive = await fetchGameweekData(gw);
                    const captainPoints = gameweekLive.elements[captainId]?.stats.total_points || 0;
                    const multiplier = captainPick.multiplier;

                    if (!captainCounts[captainName]) {
                        captainCounts[captainName] = {
                            times: 0,
                            successful: 0, // Captained and got points > 0
                            failed: 0,     // Captained and got points <= 0
                            totalCaptainedPoints: 0,
                            captainedRounds: []
                        };
                    }
                    captainCounts[captainName].times++;
                    captainCounts[captainName].totalCaptainedPoints += (captainPoints * multiplier);
                    captainCounts[captainName].captainedRounds.push(gw);

                    if (captainPoints > 0) {
                        captainCounts[captainName].successful++;
                    } else {
                        captainCounts[captainName].failed++;
                    }
                }
            } catch (error) {
                console.warn(`Could not fetch picks for GW ${gw} for manager ${managerId}:`, error.message);
            }
        }

        // Sort top 3 captains by totalCaptainedPoints
        const top3Captains = Object.entries(captainCounts)
            .sort(([, a], [, b]) => b.totalCaptainedPoints - a.totalCaptainedPoints)
            .slice(0, 3)
            .map(([name, data]) => ({ name, ...data }));


        // --- Player Performance Analysis (Best/Worst Players) ---
        let playerPerformance = {}; // { playerId: { name, started, autoSubbed, pointsGained, benchedPoints } }

        for (let gw = 1; gw <= latestGameweek; gw++) {
            try {
                const picks = await fetchManagerPicks(managerId, gw);
                const teamData = picks.picks;
                const benchData = picks.automatic_subs; // Auto subs

                const gameweekLive = await fetchGameweekData(gw);

                teamData.forEach(pick => {
                    const playerId = pick.element;
                    const playerName = allPlayers[playerId] ? allPlayers[playerId].name : `Player ${playerId}`;
                    const playerPoints = gameweekLive.elements[playerId]?.stats.total_points || 0;

                    if (!playerPerformance[playerId]) {
                        playerPerformance[playerId] = {
                            name: playerName,
                            started: 0,
                            autoSubbed: 0,
                            pointsGained: 0,
                            benchedPoints: 0
                        };
                    }

                    const isStarted = pick.position <= 11;
                    const wasAutoSub = benchData.some(sub => sub.element_in === playerId);

                    if (isStarted && !wasAutoSub) {
                        playerPerformance[playerId].started++;
                        playerPerformance[playerId].pointsGained += playerPoints;
                    } else if (wasAutoSub) {
                        playerPerformance[playerId].autoSubbed++;
                        playerPerformance[playerId].pointsGained += playerPoints;
                    } else { // Must be on bench and not auto-subbed
                        // Find this player if they were on the bench (position > 11)
                        if (pick.position > 11) {
                            const benchedPoints = gameweekLive.elements[playerId]?.stats.total_points || 0;
                            playerPerformance[playerId].benchedPoints += benchedPoints;
                        }
                    }
                });
            } catch (error) {
                console.warn(`Could not process player performance for GW ${gw} for manager ${managerId}:`, error.message);
            }
        }

        // Convert to array and filter out players with no activity
        const activePlayers = Object.values(playerPerformance).filter(p => p.started > 0 || p.autoSubbed > 0 || p.benchedPoints > 0);

        // Sort and get top 5 best players (most points gained from starting/subbing in)
        const bestPlayers = [...activePlayers].sort((a, b) => b.pointsGained - a.pointsGained).slice(0, 5);

        // Sort and get top 5 worst players (most points wasted on bench or low contribution)
        // This definition of "worst" is a bit subjective; here it's defined as least points gained from starting/subbing in.
        const worstPlayers = [...activePlayers].sort((a, b) => a.pointsGained - b.pointsGained).slice(0, 5);


        // --- Top 5 Missed Points (Benched Players) ---
        let missedPointsMap = {}; // { playerId: { playerName, totalMissedPoints, rounds: [] } }

        for (let gw = 1; gw <= latestGameweek; gw++) {
            try {
                const picks = await fetchManagerPicks(managerId, gw);
                const gameweekLive = await fetchGameweekData(gw);

                picks.picks.forEach(pick => {
                    // Check if player was on the bench (position > 11) and was NOT auto-subbed in
                    const wasOnBench = pick.position > 11;
                    const wasNotAutoSubbed = !picks.automatic_subs.some(sub => sub.element_in === pick.element);

                    if (wasOnBench && wasNotAutoSubbed) {
                        const playerId = pick.element;
                        const playerName = allPlayers[playerId] ? allPlayers[playerId].name : `Player ${playerId}`;
                        const benchedPoints = gameweekLive.elements[playerId]?.stats.total_points || 0;

                        if (benchedPoints > 0) { // Only count if points were actually missed
                            if (!missedPointsMap[playerId]) {
                                missedPointsMap[playerId] = { playerName: playerName, points: 0, round: [] };
                            }
                            missedPointsMap[playerId].points += benchedPoints;
                            missedPointsMap[playerId].round.push(gw);
                        }
                    }
                });
            } catch (error) {
                console.warn(`Could not process missed points for GW ${gw} for manager ${managerId}:`, error.message);
            }
        }

        // Convert to array and sort by total missed points
        const top5MissedPoints = Object.values(missedPointsMap)
            .sort((a, b) => b.points - a.points)
            .slice(0, 5);

        // --- Transfers Analysis ---
        let totalTransfersCount = 0;
        let totalHitsPoints = 0;
        let profitableTransfers = []; // Stores { playerInName, playerOutName, round, profitLoss }
        let lossMakingTransfers = []; // Stores { playerInName, playerOutName, round, profitLoss }

        for (let i = 0; i < overallRankHistory.length; i++) {
            const gwHistory = overallRankHistory[i];
            totalTransfersCount += gwHistory.eventTransfers;
            totalHitsPoints += gwHistory.transfersCost;

            if (gwHistory.eventTransfers > 0) {
                try {
                    const transfersResponse = await fetchWithRetry(`https://fantasy.premierleague.com/api/entry/${managerId}/transfers/`);
                    const transfersData = await transfersResponse.json();

                    // Filter transfers for the current gameweek and process them
                    const transfersForGw = transfersData.history.filter(t => t.event === gwHistory.round);
                    
                    for (const transfer of transfersForGw) {
                        const playerInId = transfer.element_in;
                        const playerOutId = transfer.element_out;

                        const playerInName = allPlayers[playerInId] ? allPlayers[playerInId].name : `Player ${playerInId}`;
                        const playerOutName = allPlayers[playerOutId] ? allPlayers[playerOutId].name : `Player ${playerOutId}`;

                        // Calculate profit/loss: points gained by IN - points gained by OUT (if they had played)
                        // This is a simplified calculation. A more robust one would involve tracking actual points for each player per round.
                        // For demonstration, we'll use total points from bootstrap-static as a proxy for "value"
                        const playerInTotalPoints = allPlayers[playerInId]?.points || 0;
                        const playerOutTotalPoints = allPlayers[playerOutId]?.points || 0;

                        const profitLoss = playerInTotalPoints - playerOutTotalPoints; // Simple approximation

                        if (profitLoss > 0) {
                            profitableTransfers.push({
                                playerInName: playerInName,
                                playerOutName: playerOutName,
                                round: gwHistory.round,
                                profitLoss: profitLoss
                            });
                        } else if (profitLoss < 0) {
                            lossMakingTransfers.push({
                                playerInName: playerInName,
                                playerOutName: playerOutName,
                                round: gwHistory.round,
                                profitLoss: profitLoss
                            });
                        }
                    }
                } catch (error) {
                    console.warn(`Could not fetch transfers for GW ${gwHistory.round} for manager ${managerId}:`, error.message);
                }
            }
        }
        
        // Sort and slice top 5 profitable/loss-making transfers
        const top5ProfitableTransfers = profitableTransfers.sort((a, b) => b.profitLoss - a.profitLoss).slice(0, 5);
        const top5LossMakingTransfers = lossMakingTransfers.sort((a, b) => a.profitLoss - b.profitLoss).slice(0, 5);

        // Final response
        return {
            statusCode: 200,
            body: JSON.stringify({
                overallRankHistory: overallRankHistory,
                overallRank: managerBasicData.overallRank,
                bestOverallRank: bestOverallRank,
                worstOverallRank: worstOverallRank,
                averagePoints: averagePoints,
                averagePointsFor1stPlace: averagePointsFor1stPlace,
                top3Captains: top3Captains,
                bestPlayers: bestPlayers,
                worstPlayers: worstPlayers,
                top5MissedPoints: top5MissedPoints,
                totalTransfersCount: totalTransfersCount,
                totalHitsPoints: totalHitsPoints,
                top5ProfitableTransfers: top5ProfitableTransfers, 
                top5LossMakingTransfers: top5LossMakingTransfers,
                managerName: managerBasicData.managerName,
                greenArrowsCount: greenArrowsCount, // NEW
                redArrowsCount: redArrowsCount // NEW
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