// netlify/functions/fetch-spl-data.js

// Import node-fetch for making HTTP requests in a Node.js environment
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
    const managerId = event.queryStringParameters.id;

    if (!managerId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Manager ID is required.' }),
        };
    }

    let managerData = null;
    let bootstrapData = null;
    let historyData = null;

    try {
        // --- 1. Fetch Manager Details ---
        const managerApiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/`;
        console.log(`Fetching manager data from: ${managerApiUrl}`);
        const managerResponse = await fetch(managerApiUrl);
        
        if (!managerResponse.ok) {
            const errorText = await managerResponse.text();
            console.error(`Manager data fetch failed with status ${managerResponse.status}: ${errorText.substring(0, 200)}...`);
            throw new Error(`Failed to fetch manager data: ${managerResponse.statusText}. Status: ${managerResponse.status}. Response: ${errorText.substring(0, 100)}...`);
        }
        managerData = await managerResponse.json();
        console.log('Successfully fetched manager data.');

        // --- 2. Fetch Global Bootstrap Data ---
        const bootstrapApiUrl = 'https://en.fantasy.spl.com.sa/api/bootstrap-static/';
        console.log(`Fetching bootstrap data from: ${bootstrapApiUrl}`);
        const bootstrapResponse = await fetch(bootstrapApiUrl);
        
        if (!bootstrapResponse.ok) {
            const errorText = await bootstrapResponse.text();
            console.error(`Bootstrap data fetch failed with status ${bootstrapResponse.status}: ${errorText.substring(0, 200)}...`);
            throw new Error(`Failed to fetch bootstrap data: ${bootstrapResponse.statusText}. Status: ${bootstrapResponse.status}. Response: ${errorText.substring(0, 100)}...`);
        }
        bootstrapData = await bootstrapResponse.json();
        console.log('Successfully fetched bootstrap data.');
        
        const elements = bootstrapData && bootstrapData.elements ? bootstrapData.elements : [];

        const playerMap = new Map();
        elements.forEach(player => {
            playerMap.set(player.id, {
                name: player.web_name || `${player.first_name} ${player.second_name}`,
                element_type: player.element_type // Position type (1=GK, 2=DEF, 3=MID, 4=FWD)
            });
        });

        // --- 3. Fetch Manager History Data ---
        const historyApiUrl = `https://en.fantasy.spl.com.sa/api/entry/${managerId}/history/`;
        console.log(`Fetching manager history data from: ${historyApiUrl}`);
        const historyResponse = await fetch(historyApiUrl);

        if (!historyResponse.ok) {
            const errorText = await historyResponse.text();
            console.error(`Manager history data fetch failed with status ${historyResponse.status}: ${errorText.substring(0, 200)}...`);
            throw new Error(`Failed to fetch manager history data: ${historyResponse.statusText}. Status: ${historyResponse.status}. Response: ${errorText.substring(0, 100)}...`);
        }
        historyData = await historyResponse.json();
        console.log('Successfully fetched manager history data.');

        // --- Transfers Data (Still N/A) ---
        const totalTransfersCount = 'N/A';
        const totalHitsPoints = 'N/A';

        // --- 4. Process Data Points for Frontend ---
        const overallRank = (managerData && managerData.summary_overall_rank !== undefined) 
                            ? managerData.summary_overall_rank.toLocaleString() 
                            : 'N/A';
        console.log(`Calculated overallRank: ${overallRank}`);

        let bestOverallRank = 'N/A';
        let worstOverallRank = 'N/A';
        let overallRankHistory = [];
        let averagePoints = 'N/A';

        if (historyData && historyData.current && historyData.current.length > 0) {
            const currentHistory = historyData.current; 

            overallRankHistory = currentHistory.map(h => ({
                round: h.event,
                rank: h.overall_rank
            }));

            const ranks = currentHistory.map(h => h.overall_rank).filter(rank => typeof rank === 'number');
            if (ranks.length > 0) {
                bestOverallRank = Math.min(...ranks).toLocaleString();
                worstOverallRank = Math.max(...ranks).toLocaleString();
            }

            const totalPoints = currentHistory.reduce((sum, h) => sum + (h.points || 0), 0);
            const totalRoundsWithPoints = currentHistory.filter(h => h.points !== undefined).length;
            if (totalRoundsWithPoints > 0) {
                averagePoints = (totalPoints / totalRoundsWithPoints).toFixed(2);
            }
        }
        console.log(`Calculated bestOverallRank: ${bestOverallRank}, worstOverallRank: ${worstOverallRank}`);
        console.log(`Overall Rank History length: ${overallRankHistory.length}`);
        console.log(`Calculated averagePoints: ${averagePoints}`);
        
        // --- Calculate Top 3 Captains ---
        const captaincyStats = {}; // { playerId: { times: N, successful: N, failed: N, totalCaptainedPoints: N, captainedRounds: [] } }
        if (historyData && historyData.current) {
            historyData.current.forEach(round => {
                const captainPick = round.picks.find(p => p.is_captain);
                const viceCaptainPick = round.picks.find(p => p.is_vice_captain);

                if (captainPick) {
                    const captainId = captainPick.element;
                    const captainPoints = round.entry_history.points; // Points for the captain in this round
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
                    captaincyStats[captainId].captainedRounds.push(round.event); // Add round number

                    // Simple success/failure: if captain scored well (e.g., > 5 points), consider successful
                    if (captainPoints > 5) { // Threshold can be adjusted
                        captaincyStats[captainId].successful++;
                    } else {
                        captaincyStats[captainId].failed++;
                    }
                }
                // Note: Vice-captain logic can be added here if needed, but often only captain points are tracked.
            });
        }

        const top3Captains = Object.values(captaincyStats)
            .sort((a, b) => b.totalCaptainedPoints - a.totalCaptainedPoints) // Sort by total points captained
            .slice(0, 3); // Get top 3
        console.log('Top 3 Captains:', top3Captains);

        // --- Calculate Best Players and Worst Players ---
        const playerSeasonStats = {}; // { playerId: { name: '', totalPoints: N, started: N, autoSubbed: N, benchedPoints: N } }

        // Iterate through each round's picks to aggregate player stats
        if (historyData && historyData.current) {
            historyData.current.forEach(round => {
                round.picks.forEach(pick => {
                    const playerId = pick.element;
                    const playerName = playerMap.get(playerId)?.name || `Player ${playerId}`;
                    const playerType = playerMap.get(playerId)?.element_type; // Get player type/position

                    if (!playerSeasonStats[playerId]) {
                        playerSeasonStats[playerId] = {
                            name: playerName,
                            element_type: playerType, // Store player type
                            totalPoints: 0,
                            started: 0,
                            autoSubbed: 0,
                            benchedPoints: 0
                        };
                    }

                    // Total points for the player across all rounds they were in the squad
                    // Note: round.entry_history.points is total team points. We need player-specific points.
                    // The 'stats' array within each pick in history.current.picks contains points for that player in that round.
                    const playerPointsInRound = pick.stats.total_points || 0;
                    playerSeasonStats[playerId].totalPoints += playerPointsInRound;

                    // Check if player started (multiplier > 0)
                    if (pick.multiplier > 0) {
                        playerSeasonStats[playerId].started++;
                    } else if (pick.multiplier === 0) { // Player was benched
                        playerSeasonStats[playerId].benchedPoints += playerPointsInRound;
                    }

                    // Auto-subbed logic is complex and usually requires checking managerData.automatic_subs
                    // For simplicity, we'll mark autoSubbed if they were on bench (multiplier 0) but still played (points > 0)
                    // This is a simplification; true auto-sub logic is more involved.
                    // A more accurate way would be to parse managerData.automatic_subs for each round.
                    // For now, we'll use a simplified check:
                    if (pick.multiplier === 0 && playerPointsInRound > 0) {
                        playerSeasonStats[playerId].autoSubbed++;
                    }
                });
            });
        }

        // Convert to array and filter for players currently in the squad (if managerData.picks is reliable)
        const currentSquadPlayerIds = new Set(managerData.picks.map(p => p.element));
        const relevantPlayers = Object.values(playerSeasonStats).filter(player => currentSquadPlayerIds.has(Object.keys(playerMap).find(key => playerMap.get(key).name === player.name))); // Filter by current squad

        // Sort for Best Players (highest total points)
        const bestPlayers = [...relevantPlayers]
            .sort((a, b) => b.totalPoints - a.totalPoints)
            .slice(0, 5) // Top 5
            .map(player => ({
                name: player.name,
                started: player.started,
                autoSubbed: player.autoSubbed,
                pointsGained: player.totalPoints, // Renamed for clarity
                benchedPoints: player.benchedPoints
            }));
        console.log('Best Players:', bestPlayers);

        // Sort for Worst Players (lowest total points, excluding GKs and DEF if not relevant)
        // This definition of "worst" can be subjective. Let's pick players with lowest points
        // who have started at least once and are not GKs (as GKs often have lower points).
        const worstPlayers = [...relevantPlayers]
            .filter(player => player.started > 0 && player.element_type !== 1) // Must have started, not a GK
            .sort((a, b) => a.totalPoints - b.totalPoints)
            .slice(0, 5) // Bottom 5
            .map(player => ({
                name: player.name,
                started: player.started,
                autoSubbed: player.autoSubbed,
                pointsGained: player.totalPoints,
                benchedPoints: player.benchedPoints
            }));
        console.log('Worst Players:', worstPlayers);

        // --- Calculate Missed Points (Benched Players Points) ---
        const missedPoints = []; // { playerName: '', points: N, round: N }
        if (historyData && historyData.current) {
            historyData.current.forEach(round => {
                round.picks.forEach(pick => {
                    // If multiplier is 0, the player was on the bench
                    // and if they scored points, those were "missed"
                    const playerPointsInRound = pick.stats.total_points || 0;
                    if (pick.multiplier === 0 && playerPointsInRound > 0) {
                        missedPoints.push({
                            playerName: playerMap.get(pick.element)?.name || `Player ${pick.element}`,
                            points: playerPointsInRound,
                            round: round.event
                        });
                    }
                });
            });
        }
        // Sort by points (descending) and get top 5
        const top5MissedPoints = missedPoints.sort((a, b) => b.points - a.points).slice(0, 5);
        console.log('Top 5 Missed Points:', top5MissedPoints);


        // --- 6. Return Combined Data as JSON ---
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({
                overallRankHistory: overallRankHistory,
                overallRank: overallRank,
                bestOverallRank: bestOverallRank,
                worstOverallRank: worstOverallRank,
                averagePoints: averagePoints,
                // averagePointsFor1stPlace is hardcoded in frontend
                top3Captains: top3Captains,
                bestPlayers: bestPlayers,
                worstPlayers: worstPlayers,
                top5MissedPoints: top5MissedPoints,
                totalTransfersCount: totalTransfersCount, // Still N/A
                totalHitsPoints: totalHitsPoints      // Still N/A
            })
        };

    } catch (error) {
        console.error('Error in Netlify function (main try-catch):', error);
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
        };
    }
};