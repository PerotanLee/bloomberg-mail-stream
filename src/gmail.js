
const GMAIL_API_DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest';
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify';

/**
 * Gmail API エラー（認証・ネットワーク・API 等を区別するため）
 */
export class GmailApiError extends Error {
    constructor(code, message, original = null) {
        super(message);
        this.name = 'GmailApiError';
        this.code = code; // 'auth' | 'network' | 'rate_limit' | 'server' | 'unknown'
        this.original = original;
    }
}

function normalizeApiError(err) {
    const httpCode = err.result?.error?.code;
    const apiMessage = err.result?.error?.message || err.message || '';
    const isNetwork = !err.result && (err.message === 'Failed to fetch' || err.message?.includes('NetworkError'));
    if (httpCode === 401) {
        return new GmailApiError('auth', 'ログインの有効期限が切れています。再度サインインしてください。', err);
    }
    if (httpCode === 403) {
        return new GmailApiError('rate_limit', apiMessage || 'アクセスが制限されています。しばらくしてからお試しください。', err);
    }
    if (httpCode >= 500) {
        return new GmailApiError('server', 'Gmail のサーバーで問題が発生しています。しばらくしてからお試しください。', err);
    }
    if (isNetwork) {
        return new GmailApiError('network', 'ネットワークに接続できません。接続を確認して再試行してください。', err);
    }
    return new GmailApiError('unknown', apiMessage || 'メールの取得に失敗しました。', err);
}

/** 保存済みトークンを削除（再サインインを促す場合に使用） */
export function clearStoredToken() {
    localStorage.removeItem('gmail_access_token');
}

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
            'q': 'from:bloomberg.com is:unread newer_than:2d',
            'maxResults': 100,
            'pageToken': pageToken
        });
        return response.result;
    } catch (err) {
        console.error('Execute error', err);
        throw normalizeApiError(err);
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
        throw normalizeApiError(err);
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

export async function batchMarkAsRead(messageIds) {
    try {
        await gapi.client.gmail.users.messages.batchModify({
            'userId': 'me',
            'resource': {
                'ids': messageIds,
                'removeLabelIds': ['UNREAD']
            }
        });
        return true;
    } catch (err) {
        console.error('Batch mark read error', err);
        return false;
    }
}
