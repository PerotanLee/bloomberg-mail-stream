
import './style.css';
import { gapiLoaded, gisLoaded, handleAuthClick, listBloombergEmails, getEmailDetails, markAsRead } from './gmail.js';
import { translateWithGemini } from './translate.js';

// Configuration State
const STATE = {
  clientId: localStorage.getItem('bloomberg_client_id') || '',
  geminiKey: localStorage.getItem('bloomberg_gemini_key') || '',
  nextPageToken: null,
  isLoading: false,
  emails: []
};

// DOM Elements
const app = document.getElementById('app');
const streamContainer = document.getElementById('stream-container');
const nextBtn = document.getElementById('next-btn');

// --- Settings UI ---
function showSettingsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.8); z-index: 200;
    display: flex; justify-content: center; align-items: center;
  `;

  overlay.innerHTML = `
    <div style="background: #161b22; padding: 24px; border-radius: 12px; max-width: 90%; width: 400px; border: 1px solid #30363d;">
      <h2 style="margin-top:0">Setup (Initial)</h2>
      <p style="color:#8b949e; font-size: 14px;">Enter your API credentials to start.</p>
      
      <label style="display:block; margin-bottom:8px; font-size:12px;">Google OAuth Client ID</label>
      <input type="text" id="inp-client-id" value="${STATE.clientId}" style="width:100%; padding:8px; background:#0d1117; border:1px solid #30363d; color:white; border-radius:6px; margin-bottom:16px;">
      
      <label style="display:block; margin-bottom:8px; font-size:12px;">Gemini API Key</label>
      <input type="password" id="inp-gemini-key" value="${STATE.geminiKey}" style="width:100%; padding:8px; background:#0d1117; border:1px solid #30363d; color:white; border-radius:6px; margin-bottom:24px;">
      
      <button id="save-settings" style="width:100%; padding:10px; background:#238636; border:none; color:white; border-radius:6px; cursor:pointer;">Start App</button>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('save-settings').onclick = () => {
    const cid = document.getElementById('inp-client-id').value.trim();
    const gkey = document.getElementById('inp-gemini-key').value.trim();

    if (cid && gkey) {
      localStorage.setItem('bloomberg_client_id', cid);
      localStorage.setItem('bloomberg_gemini_key', gkey);
      STATE.clientId = cid;
      STATE.geminiKey = gkey;
      overlay.remove();
      initApp();
    } else {
      alert("Both keys are required.");
    }
  };
}

// --- Debugging ---
function createDebugConsole() {
  if (document.getElementById('debug-console')) return;
  const con = document.createElement('div');
  con.id = 'debug-console';
  document.body.appendChild(con);
  logToScreen("Debug Console Initialized", "info");
}

function logToScreen(msg, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${msg}`); // Keep browser console
  const con = document.getElementById('debug-console');
  if (!con) return;

  // Auto-scroll
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  con.appendChild(entry);
  con.scrollTop = con.scrollHeight;
}

// Override global console for convenience (optional, but let's stick to explicit caching)
window.onerror = function (msg, url, line) {
  logToScreen(`Global Error: ${msg} @ ${line}`, 'error');
};

// --- Email Processing ---
function decodeUrlSafeBase64(data) {
  if (!data) return '';
  const customAtob = (str) => {
    try {
      return decodeURIComponent(escape(window.atob(str)));
    } catch (e) {
      console.warn("Base64 Decode Error", e);
      return window.atob(str); // best effort
    }
  };
  return customAtob(data.replace(/-/g, '+').replace(/_/g, '/'));
}

function extractBody(payload) {
  let textBody = '';
  let htmlBody = '';

  logToScreen(`Extracting body for msg... Parts: ${payload.parts ? payload.parts.length : '0'}`, 'info');

  const traverse = (nodes) => {
    for (const node of nodes) {
      if (node.mimeType === 'text/plain' && node.body && node.body.data) {
        textBody += decodeUrlSafeBase64(node.body.data);
      } else if (node.mimeType === 'text/html' && node.body && node.body.data) {
        htmlBody += decodeUrlSafeBase64(node.body.data);
      } else if (node.parts) {
        traverse(node.parts);
      }
    }
  };

  if (payload.parts) {
    traverse(payload.parts);
  } else {
    // Single part message
    if (payload.body && payload.body.data) {
      if (payload.mimeType === 'text/html') htmlBody = decodeUrlSafeBase64(payload.body.data);
      else textBody = decodeUrlSafeBase64(payload.body.data);
    }
  }

  // Prefer text, fallback to stripped HTML
  let finalBody = textBody;
  if (!finalBody && htmlBody) {
    // Strip tags
    const tmp = document.createElement('div');
    tmp.innerHTML = htmlBody;
    finalBody = tmp.textContent || tmp.innerText || "";
  }

  // Last resort: Snippet
  if (!finalBody.trim()) {
    logToScreen("Body empty, using snippet", 'warn');
    return payload.snippet || "(No content)";
  }

  return finalBody.trim();
}

function getHeader(headers, name) {
  if (!headers) return '';
  const h = headers.find(x => x.name === name);
  return h ? h.value : '';
}

async function renderEmail(msgDetails) {
  try {
    const subject = getHeader(msgDetails.payload.headers, 'Subject');
    const from = getHeader(msgDetails.payload.headers, 'From');
    const dateStr = getHeader(msgDetails.payload.headers, 'Date') || msgDetails.internalDate;
    const date = new Date(parseInt(msgDetails.internalDate) || dateStr);
    const isUnread = msgDetails.labelIds.includes('UNREAD');

    logToScreen(`Rendering: ${subject}`, 'info');

    const bodyText = extractBody(msgDetails.payload);

    // Card Container
    const card = document.createElement('div');
    card.className = `email-card ${isUnread ? 'unread' : ''}`;
    card.id = `card-${msgDetails.id}`;

    // Initial Loading UI
    card.innerHTML = `
        <div class="card-meta">
          <span>${date.toLocaleDateString()} ${date.toLocaleTimeString()}</span>
          <span>${from.split('<')[0]}</span>
        </div>
        <div class="card-title">${subject}</div>
        <div class="card-body translating-state" style="color:#8b949e; font-style:italic;">
          Running Gemini Translation...
        </div>
        <div class="original-text">${bodyText.substring(0, 1000)}...</div>
        <div class="card-actions">
           <button class="btn-text toggle-original">Show Original</button>
           ${isUnread ? `<button class="btn-text mark-read" data-id="${msgDetails.id}">Mark as Read</button>` : ''}
        </div>
      `;

    streamContainer.appendChild(card);

    // Trigger Translation
    // Limit text length more aggressively if needed, but 2000 is usually fine.
    const textToTranslate = bodyText.substring(0, 3000);
    const translation = await translateWithGemini(textToTranslate, STATE.geminiKey);

    // Update UI with translation
    const bodyEl = card.querySelector('.card-body');
    const toggleBtn = card.querySelector('.toggle-original');
    const origEl = card.querySelector('.original-text');

    bodyEl.classList.remove('translating-state');

    if (translation.includes("Error")) {
      bodyEl.style.color = '#ff7b72'; // Reddish for error
      bodyEl.textContent = translation;
      // Auto-show original on error
      origEl.classList.add('visible');
      toggleBtn.textContent = 'Hide Original';
      logToScreen(`Translation error for ${msgDetails.id}: ${translation}`, 'error');
    } else {
      bodyEl.style.color = 'var(--text-primary)';
      bodyEl.style.fontStyle = 'normal';
      bodyEl.textContent = translation;
    }

    // Event Listeners
    toggleBtn.onclick = () => {
      origEl.classList.toggle('visible');
      toggleBtn.textContent = origEl.classList.contains('visible') ? 'Hide Original' : 'Show Original';
    };

    const readBtn = card.querySelector('.mark-read');
    if (readBtn) {
      readBtn.onclick = async (e) => {
        e.stopPropagation();
        const success = await markAsRead(msgDetails.id);
        if (success) {
          card.classList.remove('unread');
          readBtn.remove();
        }
      };
    }
  } catch (e) {
    logToScreen(`Error rendering email ${msgDetails.id}: ${e.message}`, 'error');
    console.error(e);
  }
}

async function loadEmails() {
  if (STATE.isLoading) return;
  STATE.isLoading = true;

  const loadingEl = document.querySelector('.loading-state');
  if (loadingEl) loadingEl.textContent = 'Loading emails...';

  logToScreen("Fetching emails list...", 'info');

  try {
    const listResp = await listBloombergEmails(STATE.nextPageToken);

    if (listResp && listResp.messages) {
      logToScreen(`Found ${listResp.messages.length} emails. Fetching details...`, 'info');
      STATE.nextPageToken = listResp.nextPageToken;

      // Fetch details
      for (const msg of listResp.messages) {
        logToScreen(`Fetching detail for ${msg.id}`, 'info');
        const details = await getEmailDetails(msg.id);
        if (details) await renderEmail(details);
        else logToScreen(`Failed to get details for ${msg.id}`, 'error');
      }
    } else {
      logToScreen("No messages found in list response.", 'warn');
      if (document.querySelectorAll('.email-card').length === 0) {
        if (loadingEl) loadingEl.textContent = "No Bloomberg emails found.";
      }
    }
  } catch (e) {
    logToScreen(`Critical Error loading emails: ${e.message}`, 'error');
    console.error(e);
    if (loadingEl) loadingEl.textContent = "Error loading emails.";
  } finally {
    STATE.isLoading = false;
    if (loadingEl && document.querySelectorAll('.email-card').length > 0) loadingEl.remove();
  }
}

// --- Initialization ---
function waitForGlobal(name, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (window[name]) return resolve();
    const interval = setInterval(() => {
      if (window[name]) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(interval);
      reject(`Timeout waiting for ${name}`);
    }, timeout);
  });
}

async function initApp() {
  createDebugConsole();
  logToScreen("App Initializing...", 'info');

  // Inject Scripts logic
  window.handleGoogleAuth = () => {
    logToScreen("Auth button clicked", 'info');
    handleAuthClick(async () => {
      document.getElementById('auth-status').textContent = 'Connected';
      logToScreen("Auth successful, starting load...", 'info');
      await loadEmails();
    });
  };

  try {
    const authStatus = document.getElementById('auth-status');
    authStatus.textContent = "Loading scripts...";

    await waitForGlobal('gapi');
    await waitForGlobal('google');

    gapiLoaded();
    gisLoaded(STATE.clientId);

    authStatus.textContent = "";
    // Connect Google button
    const btn = document.createElement('button');
    btn.textContent = 'Sign In / Connect';
    btn.className = 'btn-text';
    btn.onclick = window.handleGoogleAuth;
    authStatus.appendChild(btn);
    logToScreen("Scripts loaded. Ready for Sign In.", 'info');

  } catch (e) {
    logToScreen(`Init Error: ${e}`, 'error');
    console.error(e);
    alert("Error loading Google Scripts. Check connection.");
  }
}

// Main logic
if (!STATE.clientId || !STATE.geminiKey) {
  showSettingsModal();
} else {
  initApp();
}

// Page Down Logic
nextBtn.onclick = () => {
  window.scrollBy({
    top: window.innerHeight * 0.8,
    behavior: 'smooth'
  });

  // Check if near bottom to load more
  if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) {
    loadEmails();
  }
};

window.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault();
    nextBtn.click();
  }
});
