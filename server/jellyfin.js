const axios = require('axios');
const config = require('./config');

const { SERVER_URL, API_KEY, USER_ID } = config;

let apiClient = null;

if (SERVER_URL && API_KEY && USER_ID) {
  apiClient = axios.create({
    baseURL: SERVER_URL,
    headers: {
      'X-Emby-Token': API_KEY,
      'Content-Type': 'application/json'
    }
  });
} else {
  console.warn('Jellyfin credentials missing. Media integration disabled.');
}

function isConfigured() {
  return !!apiClient;
}

async function getLibraries() {
  if (!apiClient) return [];
  try {
    const response = await apiClient.get(`/Users/${USER_ID}/Views`);
    return response.data.Items;
  } catch (error) {
    console.error('Error fetching Jellyfin libraries:', error.message);
    return [];
  }
}

async function getItems(libraryId) {
  if (!apiClient) return [];
  try {
    const response = await apiClient.get(`/Users/${USER_ID}/Items`, {
      params: {
        ParentId: libraryId,
        Recursive: true,
        IncludeItemTypes: 'Audio,Movie,Series',
        Fields: 'PrimaryImageAspectRatio,BasicSyncInfo'
      }
    });
    return response.data.Items;
  } catch (error) {
    console.error(`Error fetching items for library ${libraryId}:`, error.message);
    return [];
  }
}

function getImageUrl(itemId, type = 'Primary') {
  if (!SERVER_URL) return '';
  return `${SERVER_URL}/Items/${itemId}/Images/${type}`;
}

function getStreamUrl(itemId) {
  if (!SERVER_URL) return '';
  return `${SERVER_URL}/Audio/${itemId}/stream`;
}

module.exports = {
  isConfigured,
  getLibraries,
  getItems,
  getImageUrl,
  getStreamUrl
};
