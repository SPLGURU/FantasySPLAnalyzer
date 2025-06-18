// This script runs during the Vercel build process (as specified in vercel.json's buildCommand).
// Its purpose is to inject the Firebase API key from a Vercel environment variable
// into the index.html file, replacing a placeholder string.

const fs = require('fs');
const path = require('path');

// Define the path to your index.html file.
// __dirname refers to the directory of the current script (scripts/).
// '..' moves up one level to the project root.
// 'index.html' points to the target file.
const filePath = path.join(__dirname, '..', 'index.html');

try {
    // Read the content of index.html
    let content = fs.readFileSync(filePath, 'utf8');

    // Define the placeholder string that needs to be replaced.
    const placeholder = '___FIREBASE_API_KEY_PLACEHOLDER___';

    // Define the name of the Vercel environment variable that holds the API key.
    // This is the variable name for your main, public-facing Firebase API Key.
    const apiKeyEnvVar = process.env.FIREBASE_API_KEY; // Using FIREBASE_API_KEY as the env var name

    // Check if the environment variable is set. If not, log a warning and exit.
    if (!apiKeyEnvVar) {
        console.warn('WARNING: FIREBASE_API_KEY environment variable is not set. The Firebase API key will not be injected.');
        process.exit(0); 
    }

    // Replace the placeholder with the actual API key value from the environment variable.
    content = content.replace(placeholder, apiKeyEnvVar);

    // Write the modified content back to index.html
    fs.writeFileSync(filePath, content, 'utf8');

    console.log('SUCCESS: Firebase API key injected into index.html using FIREBASE_API_KEY.');

} catch (error) {
    console.error('ERROR: Failed to inject Firebase API key into index.html:', error);
    process.exit(1); 
}
