
const GMAIL_API_DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest';
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let userCallback = null;

// Initialize gapi
export async function gapiLoaded() {
    await gapi.client.init({
        discoveryDocs: [GMAIL_API_DISCOVERY_DOC],
    });
    gapiInited = true;

    // Restore token if exists
    const savedToken = localStorage.getItem('gmail_access_token');
    if (savedToken) {
        gapi.client.setToken(JSON.parse(savedToken));
    }

    checkAuth();
}

// Initialize GIS
export function gisLoaded(clientId, scope = SCOPES) {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: scope,
        callback: async (resp) => {
            if (resp.error !== undefined) {
                throw (resp);
            }
            // Save token to localStorage
            localStorage.setItem('gmail_access_token', JSON.stringify(resp));
            if (userCallback) userCallback();
        },
    });
    gisInited = true;
    checkAuth();
}

function checkAuth() {
    // Can trigger initial UI update here
}

export function handleAuthClick(callback) {
    userCallback = callback;
    const token = gapi.client.getToken();
    if (token === null) {
        // Try to see if we have a persisted session but no gapi token set
        tokenClient.requestAccessToken({ prompt: '' });
    } else {
        // Skip display of account chooser and consent dialog for an existing session.
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

export async function listBloombergEmails(pageToken = null) {
    try {
        const response = await gapi.client.gmail.users.messages.list({
            'userId': 'me',
            'q': 'from:bloomberg.com',
            'maxResults': 10,
            'pageToken': pageToken
        });
        return response.result;
    } catch (err) {
        console.error('Execute error', err);
        return null;
    }
}

export async function getEmailDetails(messageId) {
    try {
        const response = await gapi.client.gmail.users.messages.get({
            'userId': 'me',
            'id': messageId,
            'format': 'full'
        });
        return response.result;
    } catch (err) {
        console.error('Get details error', err);
        return null;
    }
}

export async function markAsRead(messageId) {
    try {
        await gapi.client.gmail.users.messages.modify({
            'userId': 'me',
            'id': messageId,
            'resource': {
                'removeLabelIds': ['UNREAD']
            }
        });
        return true;
    } catch (err) {
        console.error('Mark read error', err);
        return false;
    }
}
