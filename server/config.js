const fs = require('fs');
const path = require('path');

const configPath = path.resolve(__dirname, '../../config.conf');
let config = {};

if (fs.existsSync(configPath)) {
    const fileContent = fs.readFileSync(configPath, 'utf8');
    fileContent.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
            config[key.trim()] = value.trim();
        }
    });
} else {
    console.warn(`WARN: Jellyfin config file not found at ${configPath}. Jellyfin integration will be disabled.`);
}

module.exports = config;
