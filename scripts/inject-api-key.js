    const fs = require('fs');
    const path = require('path');

    // This script should be located in 'scripts/inject-api-key.js'
    // It modifies 'index.html' which is in the parent directory of 'scripts'
    const filePath = path.join(__dirname, '..', 'index.html');
    let content = fs.readFileSync(filePath, 'utf8');

    // Get the API key from Netlify's environment variable
    const apiKey = process.env.REACT_APP_FIREBASE_API_KEY;

    if (!apiKey) {
        console.error('ERROR: REACT_APP_FIREBASE_API_KEY environment variable is not set!');
        // Exit with an error code to fail the Netlify build if the key is missing
        process.exit(1); 
    }

    // This placeholder must exactly match the one in index.html
    const placeholder = '___FIREBASE_API_KEY_PLACEHOLDER___';

    if (content.includes(placeholder)) {
        // Perform the replacement
        content = content.replace(placeholder, apiKey);
        // Write the modified content back to index.html
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('SUCCESS: Firebase API Key injected into index.html');
    } else {
        console.warn('WARNING: Firebase API Key placeholder not found in index.html. API Key might not be injected.');
        // Optionally, you might want to exit with an error here too if the placeholder is critical
        // process.exit(1); 
    }
    