// netlify/functions/fetch-spl-data.js

// Import node-fetch for making HTTP requests in a Node.js environment
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
    // Extract the manager ID from the query parameters
    const managerId = event.queryStringParameters.id;

    // Basic validation: ensure managerId is provided
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
            playerMap.set(player.id, player.web_name || `${player.first_name} ${player.second_name}`);
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

        // --- 4. Fetch Transfers Data and Calculate Total Transfers and Hits (Re-enabled) ---
        let transfersRawData = [];
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
                    transfersRawData = JSON.parse(responseText);
                    console.log('Successfully fetched and parsed transfers data.');

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
                        if (transfersInThisEvent > 1) {
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

        // --- 5. Process Other Data Points for Frontend ---
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
        
        // Removed averagePointsFor1stPlace from backend response as it's hardcoded in frontend
        // const averagePointsFor1stPlace = 'N/A'; 

        const top3Captains = [];
        const bestPlayers = [];
        const worstPlayers = [];
        const top5MissedPoints = [];

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
                // averagePointsFor1stPlace: averagePointsFor1stPlace, // Removed from here
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