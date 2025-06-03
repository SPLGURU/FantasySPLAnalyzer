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
        console.log('Successfully fetched manager data. Dumping content:');
        console.log(JSON.stringify(managerData, null, 2)); // DUMP MANAGER DATA

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
        console.log('Successfully fetched bootstrap data. Dumping content:');
        console.log(JSON.stringify(bootstrapData, null, 2)); // DUMP BOOTSTRAP DATA
        
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
        console.log('Successfully fetched manager history data. Dumping content:');
        console.log(JSON.stringify(historyData, null, 2)); // DUMP HISTORY DATA

        // --- Transfers Data (Still N/A) ---
        // The transfers API is still consistently returning HTML, so these will remain 'N/A'
        // unless a reliable JSON source is found.
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

        const currentHistory = (historyData && historyData.current) ? historyData.current : [];

        if (currentHistory.length > 0) {
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
        const captaincyStats = {}; // { playerId: { name: '', times: N, successful: N, failed: N, totalCaptainedPoints: N, captainedRounds: [] } }
        if (currentHistory.length > 0) {
            currentHistory.forEach(round => {
                if (round.picks && Array.isArray(round.picks)) {
                    const captainPick = round.picks.find(p => p.is_captain);

                    if (captainPick) {
                        const captainId = captainPick.element;
                        const captainPoints = (captainPick.stats && captainPick.stats.total_points !== undefined) 
                                                ? captainPick.stats.total_points 
                                                : 0; // Default to 0 if stats or total_points missing
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
                        captaincyStats[captainId].captainedRounds.push(round.event);

                        if (captainPoints > 5) { // Threshold can be adjusted
                            captaincyStats[captainId].successful++;
                        } else {
                            captaincyStats[captainId].failed++;
                        }
                    }
                }
            });
        }

        const top3Captains = Object.values(captaincyStats)
            .sort((a, b) => b.totalCaptainedPoints - a.totalCaptainedPoints)
            .slice(0, 3);
        console.log('Top 3 Captains:', top3Captains);

        // --- Calculate Best Players and Worst Players ---
        const playerSeasonStats = {}; // { playerId: { name: '', totalPoints: N, started: N, autoSubbed: N, benchedPoints: N, element_type: N } }

        if (currentHistory.length > 0) {
            currentHistory.forEach(round => {
                if (round.picks && Array.isArray(round.picks)) {
                    round.picks.forEach(pick => {
                        const playerId = pick.element;
                        const playerName = playerMap.get(playerId)?.name || `Player ${playerId}`;
                        const playerType = playerMap.get(playerId)?.element_type;

                        if (!playerSeasonStats[playerId]) {
                            playerSeasonStats[playerId] = {
                                name: playerName,
                                element_type: playerType,
                                totalPoints: 0,
                                started: 0,
                                autoSubbed: 0,
                                benchedPoints: 0
                            };
                        }

                        const playerPointsInRound = (pick.stats && pick.stats.total_points !== undefined) ? pick.stats.total_points : 0;
                        playerSeasonStats[playerId].totalPoints += playerPointsInRound;

                        if (pick.multiplier > 0) {
                            playerSeasonStats[playerId].started++;
                        } else if (pick.multiplier === 0) {
                            playerSeasonStats[playerId].benchedPoints += playerPointsInRound;
                        }

                        if (pick.multiplier === 0 && playerPointsInRound > 0) {
                            playerSeasonStats[playerId].autoSubbed++;
                        }
                    });
                }
            });
        }

        const currentSquadPlayerIds = new Set((managerData && managerData.picks) ? managerData.picks.map(p => p.element) : []);
        // Filter players to only include those currently in the squad AND have stats
        const relevantPlayers = Object.values(playerSeasonStats).filter(player => 
            currentSquadPlayerIds.has(Object.keys(playerMap).find(key => playerMap.get(key).name === player.name)) && player.totalPoints > 0
        );

        const bestPlayers = [...relevantPlayers]
            .sort((a, b) => b.totalPoints - a.totalPoints)
            .slice(0, 5)
            .map(player => ({
                name: player.name,
                started: player.started,
                autoSubbed: player.autoSubbed,
                pointsGained: player.totalPoints,
                benchedPoints: player.benchedPoints
            }));
        console.log('Best Players:', bestPlayers);

        const worstPlayers = [...relevantPlayers]
            .filter(player => player.started > 0 && player.element_type !== 1) // Must have started, not a GK
            .sort((a, b) => a.totalPoints - b.totalPoints)
            .slice(0, 5)
            .map(player => ({
                name: player.name,
                started: player.started,
                autoSubbed: player.autoSubbed,
                pointsGained: player.totalPoints,
                benchedPoints: player.benchedPoints
            }));
        console.log('Worst Players:', worstPlayers);

        // --- Calculate Missed Points (Benched Players Points) ---
        const missedPoints = [];
        if (currentHistory.length > 0) {
            currentHistory.forEach(round => {
                if (round.picks && Array.isArray(round.picks)) {
                    round.picks.forEach(pick => {
                        const playerPointsInRound = (pick.stats && pick.stats.total_points !== undefined) ? pick.stats.total_points : 0;
                        if (pick.multiplier === 0 && playerPointsInRound > 0) {
                            missedPoints.push({
                                playerName: playerMap.get(pick.element)?.name || `Player ${pick.element}`,
                                points: playerPointsInRound,
                                round: round.event
                            });
                        }
                    });
                }
            });
        }
        const top5MissedPoints = missedPoints.sort((a, b) => b.points - a.points).slice(0, 5);
        console.log('Top 5 Missed Points:', top5MissedPoints);


        // --- 5. Return Combined Data as JSON ---
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
                top3Captains: top3Captains,
                bestPlayers: bestPlayers,
                worstPlayers: worstPlayers,
                top5MissedPoints: top5MissedPoints,
                totalTransfersCount: totalTransfersCount,
                totalHitsPoints: totalHitsPoints
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