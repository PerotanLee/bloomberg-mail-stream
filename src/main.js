
import './style.css';
import { gapiLoaded, gisLoaded, handleAuthClick, listBloombergEmails, getEmailDetails, markAsRead } from './gmail.js';

// Configuration State
const STATE = {
  clientId: localStorage.getItem('bloomberg_client_id') || '',
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
      <h2 style="margin-top:0">Setup</h2>
      <p style="color:#8b949e; font-size: 14px;">Enter your OAuth Client ID.</p>
      
      <label style="display:block; margin-bottom:8px; font-size:12px;">Google OAuth Client ID</label>
      <input type="text" id="inp-client-id" value="${STATE.clientId}" style="width:100%; padding:8px; background:#0d1117; border:1px solid #30363d; color:white; border-radius:6px; margin-bottom:24px;">
      
      <button id="save-settings" style="width:100%; padding:10px; background:#238636; border:none; color:white; border-radius:6px; cursor:pointer;">Save & Start</button>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('save-settings').onclick = () => {
    const cid = document.getElementById('inp-client-id').value.trim();
    if (cid) {
      localStorage.setItem('bloomberg_client_id', cid);
      STATE.clientId = cid;
      overlay.remove();
      initApp();
    } else {
      alert("Client ID is required.");
    }
  };
}

// --- Email Processing ---
function decodeUrlSafeBase64(data) {
  if (!data) return '';
  const customAtob = (str) => {
    try {
      return decodeURIComponent(escape(window.atob(str)));
    } catch (e) {
      console.warn("Base64 Decode Error", e);
      return window.atob(str);
    }
  };
  return customAtob(data.replace(/-/g, '+').replace(/_/g, '/'));
}

function extractBodyData(payload) {
  let textBody = '';
  let htmlBody = '';

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
    // Single part
    if (payload.body && payload.body.data) {
      if (payload.mimeType === 'text/html') htmlBody = decodeUrlSafeBase64(payload.body.data);
      else textBody = decodeUrlSafeBase64(payload.body.data);
    }
  }

  // Fallback html
  if (!htmlBody && textBody) {
    htmlBody = `<pre>${textBody}</pre>`;
  }

  return { html: htmlBody || payload.snippet || "" };
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

    const { html: bodyHtml } = extractBodyData(msgDetails.payload);

    const card = document.createElement('div');
    card.className = `email-card ${isUnread ? 'unread' : ''}`;
    card.id = `card-${msgDetails.id}`;

    card.innerHTML = `
        <div class="card-meta">
          <span>${date.toLocaleDateString()} ${date.toLocaleTimeString()}</span>
          <span>${from.split('<')[0]}</span>
        </div>
        <div class="card-title">${subject}</div>
        <div class="email-content-view"></div>
        <div class="card-actions">
           ${isUnread ? `<button class="btn-text mark-read" data-id="${msgDetails.id}">Mark as Read</button>` : ''}
        </div>
      `;

    const contentDiv = card.querySelector('.email-content-view');
    contentDiv.innerHTML = bodyHtml;

    // Basic styling for content safety
    contentDiv.style.backgroundColor = '#ffffff';
    contentDiv.style.color = '#000000';
    contentDiv.style.padding = '8px';
    contentDiv.style.borderRadius = '4px';
    contentDiv.style.overflowX = 'auto'; // ensure tables scroll

    streamContainer.appendChild(card);

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
    console.error(e);
  }
}

async function loadEmails() {
  if (STATE.isLoading) return;
  STATE.isLoading = true;

  const loadingEl = document.querySelector('.loading-state');
  if (loadingEl) loadingEl.textContent = 'Loading emails...';

  try {
    // 1. Fetch List (Query: from:bloomberg.com is:unread newer_than:2d)
    const listResp = await listBloombergEmails(STATE.nextPageToken);

    if (listResp && listResp.messages) {
      // Pagination logic roughly ignored for sorting requirement within batch.
      // STATE.nextPageToken = listResp.nextPageToken; 

      const messages = listResp.messages;
      const detailsPromises = messages.map(msg => getEmailDetails(msg.id));
      const details = await Promise.all(detailsPromises);

      const validDetails = details.filter(d => d);

      // Sort Oldest -> Newest (Ascending internalDate)
      validDetails.sort((a, b) => {
        return parseInt(a.internalDate) - parseInt(b.internalDate);
      });

      for (const d of validDetails) {
        await renderEmail(d);
      }

    } else {
      if (document.querySelectorAll('.email-card').length === 0) {
        if (loadingEl) loadingEl.textContent = "No Bloomberg emails found.";
      }
    }
  } catch (e) {
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
  window.handleGoogleAuth = () => {
    handleAuthClick(async () => {
      document.getElementById('auth-status').textContent = 'Connected';
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
    const btn = document.createElement('button');
    btn.textContent = 'Sign In / Connect';
    btn.className = 'btn-text';
    btn.onclick = window.handleGoogleAuth;
    authStatus.appendChild(btn);

  } catch (e) {
    console.error(e);
    alert("Error loading Google Scripts. Check connection.");
  }
}

// Main logic
if (!STATE.clientId) {
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

  // Logic for load more is removed/complicated by sorting requirement (scrolling down to load *newer* emails vs infinite scroll usually loads *older*).
  // With "Oldest First", the bottom of the list is the "Newest".
  // So typically we load everything involved in the sort range at once.
};

window.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault();
    nextBtn.click();
  }
});
