const fs = require('fs');
const path = require('path');

const configPath = path.resolve(__dirname, '../../config.conf');
let config = {};

if (fs.existsSync(configPath)) {
  const fileContent = fs.readFileSync(configPath, 'utf8');
  fileContent.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.substring(0, idx).trim();
      const value = line.substring(idx + 1).trim();
      config[key] = value;
    }
  });
} else {
  console.warn(`WARN: config.conf not found at ${configPath}. Jellyfin integration disabled.`);
}

module.exports = config;
