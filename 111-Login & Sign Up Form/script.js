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
  const loginPanel = document.getElementById("loginPanel");

  // If 2FA panel is active, cancel it and return to login — do NOT flip
  if (twofaPanel && twofaPanel.classList.contains("active")) {
    twofaPanel.classList.remove("active");
    if (loginPanel) {
      loginPanel.classList.remove("hidden");
      // Restore visibility (CSS uses visibility:hidden)
      loginPanel.style.visibility = "";
    }
    currentTempToken = null;
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
        currentTempToken = data.tempToken;

        const loginPanel = document.getElementById("loginPanel");
        const twofaPanel = document.getElementById("twofaPanel");
        const enrollmentSec = document.getElementById("enrollmentSection");
        const twofaTitle = document.getElementById("twofaTitle");
        const twofaSubtitle = document.getElementById("twofaSubtitle");

        if (data.enrolled === false) {
          // First time enrollment with QR Code & Recovery codes
          twofaTitle.textContent = "2FA Enrollment";
          twofaSubtitle.textContent = "Scan QR code with Google Authenticator";
          enrollmentSec.style.display = "block";

          const qrImg = document.getElementById("qrCodeImg");
          if (qrImg) qrImg.src = data.qrCode;

          const manualSecret = document.getElementById("manualSecretText");
          if (manualSecret) manualSecret.textContent = data.manualSecret;

          const recoveryList = document.getElementById("recoveryCodesList");
          if (recoveryList && data.recoveryCodes) {
            recoveryList.innerHTML = data.recoveryCodes
              .map(code => `<div class="recovery-item">${code}</div>`)
              .join("");
          }
        } else {
          // Already enrolled, prompt for 6-digit TOTP
          twofaTitle.textContent = "Two-Factor Auth";
          twofaSubtitle.textContent = "Enter your 6-digit TOTP or backup code";
          enrollmentSec.style.display = "none";
        }

        loginPanel.classList.add("hidden");
        twofaPanel.classList.add("active");
        hideAlert("twofaAlert");

        const totpInput = document.getElementById("totpInput");
        if (totpInput) {
          totpInput.value = "";
          totpInput.focus();
        }

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
          window.location.href = 'dashboard.html';
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
          showAlert("signupAlert", "Account request processed.", "success");
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
