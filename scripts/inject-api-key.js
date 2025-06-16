const fs = require('fs');
const path = require('path');

// This script should be located in 'scripts/inject-api-key.js'
// It modifies 'index.html' which is in the parent directory of 'scripts'
const filePath = path.join(__dirname, '..', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// Get the API key from Vercel's environment variable.
// Using a plain name (FIREBASE_API_KEY) for better compatibility with generic Node.js builds.
const apiKey = process.env.FIREBASE_API_KEY; 

if (!apiKey) {
    console.error('ERROR: FIREBASE_API_KEY environment variable is not set! Build will fail.');
    process.exit(1); // Exit with an error if key is missing, to ensure build fails clearly
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
    // This warning suggests a mismatch if the placeholder is expected but not found
    console.warn('WARNING: Firebase API Key placeholder not found in index.html. API Key might not be injected.');
    // Consider exiting with error here if finding placeholder is critical: process.exit(1);
}
