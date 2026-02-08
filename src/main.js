
import './style.css';
import { gapiLoaded, gisLoaded, handleAuthClick, listBloombergEmails, getEmailDetails, markAsRead, batchMarkAsRead, GmailApiError, clearStoredToken } from './gmail.js';

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

async function renderEmail(msgDetails, index, total) {
  try {
    const subject = getHeader(msgDetails.payload.headers, 'Subject');
    const from = getHeader(msgDetails.payload.headers, 'From');
    const dateStr = getHeader(msgDetails.payload.headers, 'Date') || msgDetails.internalDate;
    const date = new Date(parseInt(msgDetails.internalDate) || dateStr);
    // Double check unread status just in case
    const isUnread = msgDetails.labelIds.includes('UNREAD');

    const { html: bodyHtml } = extractBodyData(msgDetails.payload);

    const card = document.createElement('div');
    card.className = `email-card ${isUnread ? 'unread' : ''}`;
    card.id = `card-${msgDetails.id}`;

    // Add to navigation dropdown
    const nav = document.getElementById('email-nav');
    if (nav) {
      const option = document.createElement('option');
      option.value = card.id;
      // Clean up subject for short display
      const shortSubject = subject.replace(/Australia Briefing:|Briefing:|Bloomberg|Japan/gi, '').trim();
      const shortFrom = from.split('<')[0].replace(/"/g, '').trim();
      option.textContent = `${shortFrom}: ${shortSubject}`;
      nav.appendChild(option);
    }

    // Index display: "1/20"
    const counterStr = (index !== undefined && total !== undefined) ? `${index + 1}/${total}` : '';

    card.innerHTML = `
        <div class="card-meta">
          <span>${date.toLocaleDateString()} ${date.toLocaleTimeString()}</span>
          <span>${counterStr}</span>
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

  // Clear navigation dropdown except for first item
  const nav = document.getElementById('email-nav');
  if (nav) nav.innerHTML = '<option value="">Jump to email...</option>';

  try {
    // 1. Fetch List (Query: from:bloomberg.com is:unread newer_than:2d)
    const listResp = await listBloombergEmails(STATE.nextPageToken);

    if (listResp && listResp.messages) {
      const messages = listResp.messages;
      const detailsPromises = messages.map(msg => getEmailDetails(msg.id));
      const details = await Promise.all(detailsPromises);

      // Strict filtering: Ensure msg is not null AND actually has UNREAD label
      const validDetails = details.filter(d => d && d.labelIds && d.labelIds.includes('UNREAD'));

      // Sort Oldest -> Newest (Ascending internalDate)
      validDetails.sort((a, b) => parseInt(a.internalDate) - parseInt(b.internalDate));

      // Limit to 40 items for performance (Phase 6 requirement)
      const displayEmails = validDetails.slice(0, 40);
      const total = displayEmails.length;

      for (let i = 0; i < total; i++) {
        await renderEmail(displayEmails[i], i, total);
      }

      // Add Batch Mark as Read button at the bottom if there are emails
      if (total > 0) {
        addBatchReadButton(displayEmails.map(e => e.id));
      }

      if (total === 0) {
        if (loadingEl) loadingEl.textContent = "No unread Bloomberg emails found in the last 48h.";
      }

    } else {
      if (document.querySelectorAll('.email-card').length === 0) {
        if (loadingEl) loadingEl.textContent = "No Bloomberg emails found.";
      }
    }
  } catch (e) {
    console.error(e);
    showLoadError(loadingEl, e);
  } finally {
    STATE.isLoading = false;
    if (loadingEl && document.querySelectorAll('.email-card').length > 0) loadingEl.remove();
  }
}

/** メール取得エラー時のメッセージと再試行・再ログイン用 UI を表示 */
function showLoadError(container, error) {
  if (!container) return;
  const isAuthError = error instanceof GmailApiError && error.code === 'auth';
  const message = error instanceof GmailApiError ? error.message : (error?.message || 'メールの取得に失敗しました。');
  if (isAuthError) clearStoredToken();

  container.innerHTML = `
    <div class="error-state">
      <p class="error-message">${escapeHtml(message)}</p>
      <div class="error-actions">
        ${isAuthError
    ? '<button type="button" class="btn-primary" id="error-reauth-btn">再度サインイン</button>'
    : '<button type="button" class="btn-primary" id="error-retry-btn">再試行</button>'
}
      </div>
    </div>
  `;

  const btn = container.querySelector(isAuthError ? '#error-reauth-btn' : '#error-retry-btn');
  if (btn) {
    btn.onclick = () => {
      if (isAuthError) {
        container.innerHTML = '<p>Connecting to Gmail...</p>';
        window.handleGoogleAuth?.();
      } else {
        container.innerHTML = '<p>Loading emails...</p>';
        loadEmails();
      }
    };
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Batch Actions ---
function addBatchReadButton(messageIds) {
  const container = document.getElementById('stream-container');
  const wrapper = document.createElement('div');
  wrapper.className = 'batch-actions-wrapper';
  wrapper.style.cssText = 'padding: 40px 20px; text-align: center;';

  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.textContent = `Mark all ${messageIds.length} emails as read`;
  btn.onclick = async () => {
    if (confirm(`Mark all ${messageIds.length} visible emails as read?`)) {
      btn.disabled = true;
      btn.textContent = 'Processing...';
      const success = await batchMarkAsRead(messageIds);
      if (success) {
        // Refresh the list to show remaining unread if any
        location.reload();
      } else {
        alert('Batch update failed.');
        btn.disabled = false;
        btn.textContent = `Mark all ${messageIds.length} emails as read`;
      }
    }
  };

  wrapper.appendChild(btn);
  container.appendChild(wrapper);
}

// --- Navigation & Zoom Controls ---
function setupNavigation() {
  const nav = document.getElementById('email-nav');
  if (!nav) return;
  nav.addEventListener('change', (e) => {
    const cardId = e.target.value;
    if (cardId) {
      const target = document.getElementById(cardId);
      if (target) {
        // Immediate jump often more reliable on mobile components
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
        console.log(`Jumped to: ${cardId}`);
      }
      // Reset select so we can jump back to the same email if needed
      setTimeout(() => { nav.value = ""; }, 100);
    }
  });
}

function setupZoom() {
  const zoomCtrl = document.getElementById('zoom-ctrl');
  if (!zoomCtrl) return;

  // Initialize zoom value from current CSS state
  const currentZoom = getComputedStyle(document.body).getPropertyValue('--current-zoom').trim();
  if (currentZoom) {
    zoomCtrl.value = parseFloat(currentZoom).toFixed(1);
  }

  zoomCtrl.addEventListener('change', (e) => {
    const val = e.target.value;
    document.body.style.setProperty('--current-zoom', val);
    console.log(`Manual zoom set to: ${val}`);
  });
}

// --- Initialization ---
function loadScript(src) {
  return new Promise((resolve, reject) => {
    console.log(`Loading script: ${src}`);
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      console.log(`Script loaded: ${src}`);
      resolve();
    };
    script.onerror = () => {
      console.error(`Script load error: ${src}`);
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(script);
  });
}

// --- Device Detection ---
function checkDeviceType() {
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  // Simple check for mobile/tablet via user agent as fallback/complement
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  if (isTouchDevice || isMobileUA) {
    document.body.classList.add('is-mobile-view');
    console.log("Mobile/Tablet device detected. Applying adaptive zoom styles.");
  }
}

async function initApp() {
  checkDeviceType(); // Detect device on init
  setupNavigation();
  setupZoom();

  window.handleGoogleAuth = () => {
    handleAuthClick(async () => {
      document.getElementById('auth-status').textContent = 'Connected';
      await loadEmails();
    });
  };

  try {
    const authStatus = document.getElementById('auth-status');
    authStatus.textContent = "Initializing Google Services...";

    // 1. Load Scripts sequentially
    await loadScript('https://apis.google.com/js/api.js');
    await loadScript('https://accounts.google.com/gsi/client');

    // 2. Initialize GAPI
    await new Promise((resolve) => gapi.load('client', resolve));
    await gapiLoaded();

    // 3. Initialize GIS
    gisLoaded(STATE.clientId);

    authStatus.textContent = "";

    // Auto-login if token exists
    const savedToken = localStorage.getItem('gmail_access_token');
    if (savedToken) {
      handleGoogleAuth();
    } else {
      const btn = document.createElement('button');
      btn.textContent = 'Sign In / Connect';
      btn.className = 'btn-text';
      btn.onclick = window.handleGoogleAuth;
      authStatus.appendChild(btn);
    }

  } catch (e) {
    console.error("Initialization Error:", e);
    const authStatus = document.getElementById('auth-status');
    authStatus.innerHTML = `
      <div style="color: #ff7b72; font-size: 12px; text-align: right;">
        Loading Error. <button onclick="location.reload()" style="background:none; border:1px solid #ff7b72; color:#ff7b72; border-radius:4px; cursor:pointer;">Retry</button>
      </div>
    `;
  }
}

// Main logic
if (!STATE.clientId) {
  showSettingsModal();
} else {
  initApp();
}

// Page Down Logic (Instant Scroll)
// Page Down Logic (Instant Scroll) with Dragging support
let isDragging = false;
let startY = 0;
let initialTop = 0;
const fabContainer = document.querySelector('.fab-container');

nextBtn.oncontextmenu = (e) => {
  e.preventDefault();
  e.stopPropagation();
  return false;
};

nextBtn.onpointerdown = (e) => {
  // Only drag on mobile
  if (!document.body.classList.contains('is-mobile-view')) {
    isDragging = false;
    return;
  }
  isDragging = false;
  startY = e.clientY;
  const rect = fabContainer.getBoundingClientRect();
  initialTop = rect.top;
  nextBtn.setPointerCapture(e.pointerId);
};

nextBtn.onpointermove = (e) => {
  const deltaY = Math.abs(e.clientY - startY);
  if (deltaY > 5) {
    isDragging = true;
    const newTop = initialTop + (e.clientY - startY);
    // Keep within viewport
    const boundedTop = Math.max(60, Math.min(window.innerHeight - 60, newTop));
    fabContainer.style.top = `${boundedTop}px`;
    fabContainer.style.bottom = 'auto'; // Break the default bottom if any
    fabContainer.style.transform = 'none'; // Clear the centering transform during manual movement
  }
};

nextBtn.onpointerup = (e) => {
  nextBtn.releasePointerCapture(e.pointerId);
  if (!isDragging) {
    // It's a click
    window.scrollBy({
      top: window.innerHeight * 0.9,
      behavior: 'auto'
    });
  }
};

window.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault();
    // Simulate click scroll
    window.scrollBy({
      top: window.innerHeight * 0.9,
      behavior: 'auto'
    });
  }
});
