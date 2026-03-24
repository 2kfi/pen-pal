const axios = require('axios');
const config = require('./config');

const { SERVER_URL, API_KEY, USER_ID } = config;

if (!SERVER_URL || !API_KEY || !USER_ID) {
    console.warn("Jellyfin credentials missing. Integration will not work.");
    module.exports = { getLibraries: () => [], getItems: () => [] };
    return;
}

const apiClient = axios.create({
    baseURL: SERVER_URL,
    headers: {
        'X-Emby-Token': API_KEY,
        'Content-Type': 'application/json'
    }
});

async function getLibraries() {
    try {
        const response = await apiClient.get(`/Users/${USER_ID}/Views`);
        return response.data.Items;
    } catch (error) {
        console.error('Error fetching Jellyfin libraries:', error.message);
        return [];
    }
}

async function getItems(libraryId) {
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
    return `${SERVER_URL}/Items/${itemId}/Images/${type}`;
}

function getStreamUrl(itemId) {
    return `${SERVER_URL}/Audio/${itemId}/stream`;
}


module.exports = {
    getLibraries,
    getItems,
    getImageUrl,
    getStreamUrl
};
