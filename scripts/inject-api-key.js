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
    // This is the new variable name you created: FIREBASE_UNRESTRICTED_API_KEY.
    const newApiKeyEnvVar = process.env.FIREBASE_UNRESTRICTED_API_KEY;

    // Check if the environment variable is set. If not, log a warning and exit.
    if (!newApiKeyEnvVar) {
        console.warn('WARNING: FIREBASE_UNRESTRICTED_API_KEY environment variable is not set. The Firebase API key will not be injected.');
        process.exit(0); // Exit gracefully to allow the build to proceed, but warn.
    }

    // Replace the placeholder with the actual API key value from the environment variable.
    content = content.replace(placeholder, newApiKeyEnvVar);

    // Write the modified content back to index.html
    fs.writeFileSync(filePath, content, 'utf8');

    console.log('SUCCESS: Firebase API key injected into index.html using FIREBASE_UNRESTRICTED_API_KEY.');

} catch (error) {
    console.error('ERROR: Failed to inject Firebase API key into index.html:', error);
    process.exit(1); // Exit with an error code to indicate build failure.
}
