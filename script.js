/**
 * Frontend Authentication Logic & UI Handlers
 * Wires the neumorphic UI to the secure Node.js + Express backend
 */

// State
let currentTempToken = null;
const API_BASE = (window.location.protocol === 'http:' || window.location.protocol === 'https:')
  ? '/api/auth'
  : 'https://localhost:3000/api/auth';

/**
 * 1. Flip Card Button (Flips between Login and Sign Up)
 *    Only resets 2FA state if 2FA panel is currently showing.
 *    Does NOT interfere with the normal login <-> signup CSS flip.
 */
function flipCard() {
  const card = document.getElementById("authCard");
  if (!card) return;

  const twofaPanel = document.getElementById("twofaPanel");

  // If 2FA panel is active, cancel it and return to login — do NOT flip
  if (twofaPanel && twofaPanel.classList.contains("active")) {
    cancel2FA();
    return;
  }

  // Normal behaviour: toggle the CSS 3D flip between Login and Sign Up
  card.classList.toggle("flipped");
}

/**
 * 2. Password Toggle Button (Toggles eye icon & input type between password and text)
 */
function togglePassword(id, button) {
  const input = document.getElementById(id);
  if (!input) return;

  const icon = (button && button.querySelector("i")) ||
               document.querySelector(`#${id} ~ .password-toggle i`) ||
               document.getElementById("faIcon");

  if (input.type === "password") {
    input.type = "text";
    if (icon) {
      icon.classList.remove("fa-eye");
      icon.classList.add("fa-eye-slash");
    }
  } else {
    input.type = "password";
    if (icon) {
      icon.classList.remove("fa-eye-slash");
      icon.classList.add("fa-eye");
    }
  }
}

// Fallback alias in case referenced anywhere
function loginPassword(id, button) {
  togglePassword(id, button);
}

/**
 * 3. Alert / Notification helpers
 */
function showAlert(elementId, message, type = 'error') {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.className = `auth-alert ${type}`;
  el.textContent = message;
  el.style.display = 'block';
}

function hideAlert(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.style.display = 'none';
}

function showTwoFactorStep(data, fallbackEmail = "") {
  currentTempToken = data.tempToken;
  // The 2FA panel overlays the login/signup card, so keep its parent upright.
  document.getElementById("authCard")?.classList.remove("flipped");
  const loginPanel = document.getElementById("loginPanel");
  const twofaPanel = document.getElementById("twofaPanel");
  const enrollmentSec = document.getElementById("enrollmentSection");
  const twofaTitle = document.getElementById("twofaTitle");
  const twofaSubtitle = document.getElementById("twofaSubtitle");
  const accountEmail = data.accountEmail || data.user?.email || fallbackEmail;

  if (!data.enrolled && data.qrCode) {
    twofaTitle.textContent = "2FA Enrollment";
    twofaSubtitle.textContent = accountEmail
      ? `Scan this QR code for ${accountEmail}`
      : "Scan this QR code with your authenticator app";
    enrollmentSec.style.display = "block";
    document.getElementById("qrCodeImg").src = data.qrCode;
    document.getElementById("manualSecretText").textContent = data.manualSecret;
    document.getElementById("recoveryCodesList").textContent = "";
    for (const code of data.recoveryCodes || []) {
      const item = document.createElement("div");
      item.className = "recovery-item";
      item.textContent = code;
      document.getElementById("recoveryCodesList").appendChild(item);
    }
  } else {
    twofaTitle.textContent = "Two-Factor Auth";
    twofaSubtitle.textContent = accountEmail
      ? `Enter a fresh code for ${accountEmail}`
      : "Enter your 6-digit TOTP or backup code";
    enrollmentSec.style.display = "none";
  }

  if (loginPanel) loginPanel.classList.add("hidden");
  twofaPanel.classList.add("active");
  hideAlert("twofaAlert");
  const totpInput = document.getElementById("totpInput");
  if (totpInput) { totpInput.value = ""; totpInput.focus(); }
}

/**
 * 4. Cancel 2FA Button (Returns back to Step 1 login form)
 */
function cancel2FA() {
  currentTempToken = null;
  const twofaPanel = document.getElementById("twofaPanel");
  const loginPanel = document.getElementById("loginPanel");
  if (twofaPanel) twofaPanel.classList.remove("active");
  if (loginPanel) {
    loginPanel.classList.remove("hidden");
    loginPanel.style.visibility = ""; // restore from visibility:hidden
  }
  document.getElementById("authCard")?.classList.remove("flipped");
  hideAlert("twofaAlert");
}

document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("loginForm");
  const signupForm = document.getElementById("signupForm");
  const twofaForm = document.getElementById("twofaForm");

  // Helmet CSP sets script-src-attr 'none', so inline onclick handlers are blocked.
  const flipToSignupBtn = document.getElementById("flipToSignupBtn");
  const flipToLoginBtn = document.getElementById("flipToLoginBtn");
  const cancel2faBtn = document.getElementById("cancel2faBtn");
  const forgotPasswordLink = document.getElementById("forgotPasswordLink");

  if (flipToSignupBtn) flipToSignupBtn.addEventListener("click", flipCard);
  if (flipToLoginBtn) flipToLoginBtn.addEventListener("click", flipCard);
  if (cancel2faBtn) cancel2faBtn.addEventListener("click", cancel2FA);
  if (forgotPasswordLink) {
    forgotPasswordLink.addEventListener("click", (e) => {
      e.preventDefault();
      alert("Please contact your system administrator to reset credentials.");
    });
  }

  document.querySelectorAll(".password-toggle[data-password-target]").forEach((button) => {
    button.addEventListener("click", () => {
      togglePassword(button.getAttribute("data-password-target"), button);
    });
  });

  // Detect file:// protocol warning
  if (window.location.protocol === 'file:') {
    showAlert(
      'loginAlert',
      '⚠️ You opened index.html via file://. Please open https://localhost:3000 in your browser to interact with the backend.',
      'info'
    );
  }

  // Check if session is already active
  if (window.location.protocol.startsWith('http')) {
    fetch(`${API_BASE}/me`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && data.user) {
          sessionStorage.setItem('authUser', JSON.stringify(data.user));
          sessionStorage.setItem('csrfToken', data.csrfToken);
          window.location.href = 'dashboard.html';
        }
      })
      .catch(() => {});
  }

  // --- 5. Login Submit Button ---
  if (loginForm) {
    loginForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      hideAlert("loginAlert");

      const email = document.getElementById("loginEmail").value.trim();
      const password = document.getElementById("loginPassword").value;
      const submitBtn = document.getElementById("loginSubmitBtn");
      const originalText = submitBtn.textContent;

      submitBtn.disabled = true;
      submitBtn.textContent = "Verifying...";

      try {
        const response = await fetch(`${API_BASE}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
          showAlert("loginAlert", data.error || "Invalid credentials", "error");
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
          return;
        }

        // Step 1 Success! Move to Step 2 (2FA)
        showTwoFactorStep(data, email);

      } catch (err) {
        showAlert("loginAlert", "Network error. Please make sure the server is running on https://localhost:3000.", "error");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
    });
  }

  // --- 6. 2FA Verification Submit Button ---
  if (twofaForm) {
    twofaForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      hideAlert("twofaAlert");

      if (!currentTempToken) {
        showAlert("twofaAlert", "Session expired. Please restart login.", "error");
        setTimeout(cancel2FA, 1500);
        return;
      }

      const inputVal = document.getElementById("totpInput").value.trim();
      const submitBtn = document.getElementById("twofaSubmitBtn");
      const originalText = submitBtn.textContent;

      submitBtn.disabled = true;
      submitBtn.textContent = "Authenticating...";

      // Check if user entered a 6-digit code or a recovery code
      const isSixDigit = /^\d{6}$/.test(inputVal);
      const payload = {
        tempToken: currentTempToken,
        totpCode: isSixDigit ? inputVal : null,
        recoveryCode: isSixDigit ? null : inputVal
      };

      try {
        const response = await fetch(`${API_BASE}/2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
          showAlert("twofaAlert", data.error || "Invalid credentials", "error");
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
          return;
        }

        // Successfully Authenticated!
        submitBtn.textContent = "✓ ACCESS GRANTED";
        showAlert("twofaAlert", "Authentication successful! Redirecting...", "success");

        if (data.csrfToken) {
          sessionStorage.setItem('csrfToken', data.csrfToken);
        }
        if (data.user) {
          sessionStorage.setItem('authUser', JSON.stringify(data.user));
        }

        setTimeout(() => {
          window.location.href = 'login-success.html';
        }, 800);

      } catch (err) {
        showAlert("twofaAlert", "Network error verifying code. Try again.", "error");
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
    });
  }

  // --- 7. Sign Up Submit Button (Public Registration Disabled) ---
  if (signupForm) {
    signupForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      hideAlert("signupAlert");

      const name = document.getElementById("signupName").value.trim();
      const email = document.getElementById("signupEmail").value.trim();
      const password = document.getElementById("signupPassword").value;
      const confirm = document.getElementById("confirmPassword").value;
      const submitBtn = document.getElementById("signupSubmitBtn");

      if (password !== confirm) {
        showAlert("signupAlert", "Passwords do not match.", "error");
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "SUBMITTING...";

      try {
        const response = await fetch(`${API_BASE}/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ signupName: name, signupEmail: email, signupPassword: password })
        });

        const data = await response.json();

        if (!response.ok) {
          showAlert("signupAlert", data.error || "Registration is restricted.", "info");
        } else {
          showTwoFactorStep(data);
        }
      } catch (err) {
        showAlert("signupAlert", "Registration request failed.", "error");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "CREATE ACCOUNT";
      }
    });
  }
});
