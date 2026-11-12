// Finix HR Desktop Shell
// FIN-032/033/034 (Phase 2) — hardened server connection:
//   · VERIFICATION BEFORE NAVIGATION: the shell is a native window branded
//     "Finix HR" with no address bar, so navigating it to an arbitrary URL
//     renders a perfect phishing clone inside the trusted app. Before any
//     navigation the shell now fetches GET /api/health on the target and
//     requires ok:true AND product:"finix-hr" (a marker only a real Finix HR
//     server emits). The old "health check" was a no-cors HEAD that passed
//     on ANY reachable host — including captive portals.
//   · ALLOW-LIST: loopback self-hosting (localhost / 127.0.0.1 / [::1], any
//     port) and the official cloud hosts navigate once verified. Anything
//     else is "custom (advanced)": the operator must type the exact
//     confirmation phrase, and the host is then remembered explicitly.
//     file:// and non-http(s) schemes are refused outright.
//   · NO AUTO-NAVIGATE TO UNVERIFIED HOSTS: the automatic redirect after
//     connection only fires for VERIFIED servers; everything else waits for
//     an explicit human click on "Open Workspace Now".
//   · CLEAR SESSION DATA: webview cookies persisted across restarts with no
//     clearing affordance — the settings modal and the menu (Rust side) now
//     offer "Clear session data", which wipes the webview's cookies/storage
//     and returns to this launcher.
(function () {
  const STORAGE_KEY = "finix_desktop_server_url";
  const TRUSTED_KEY = "finix_desktop_trusted_hosts";
  const DEFAULT_LOCAL = "http://localhost:4055";

  // FIN-032 — hosts the shell navigates to without an explicit trust gesture.
  // Loopback (any port) covers self-hosting; the two cloud entries cover the
  // official SaaS. Office-LAN IP deployments use the custom (advanced) path.
  const CLOUD_ALLOWLIST = ["finixhrm.com", "oms.finixhr.com"];
  const CONFIRM_PHRASE = "I trust this server";

  function isLoopbackHost(host) {
    const h = host.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  }

  function hostCategory(url) {
    let u;
    try { u = new URL(url); } catch (_) { return { kind: "invalid" }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { kind: "refused", reason: "Only http:// and https:// servers are supported (file:// and other schemes are refused)." };
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isLoopbackHost(host)) return { kind: "loopback", host, url: u };
    if (CLOUD_ALLOWLIST.includes(host)) return { kind: "cloud", host, url: u };
    return { kind: "custom", host, url: u };
  }

  function trustedHosts() {
    try { return JSON.parse(localStorage.getItem(TRUSTED_KEY) || "[]"); } catch (_) { return []; }
  }

  function isTrustedCustom(host) {
    return trustedHosts().some((h) => String(h).toLowerCase() === String(host).toLowerCase());
  }

  function rememberTrustedCustom(host) {
    const list = trustedHosts().filter((h) => String(h).toLowerCase() !== String(host).toLowerCase());
    list.push(host);
    localStorage.setItem(TRUSTED_KEY, JSON.stringify(list.slice(-10)));
  }

  // Elements
  const statusPill = document.getElementById("statusPill");
  const statusText = document.getElementById("statusText");
  const hubSubtitle = document.getElementById("hubSubtitle");
  const diagUrl = document.getElementById("diagUrl");
  const diagStatus = document.getElementById("diagStatus");
  const btnLaunch = document.getElementById("btnLaunch");
  const btnRetry = document.getElementById("btnRetry");
  const btnSwitchLocal = document.getElementById("btnSwitchLocal");
  const btnRefresh = document.getElementById("btnRefresh");
  const btnSettings = document.getElementById("btnSettings");
  const linkOpenSettings = document.getElementById("linkOpenSettings");
  const linkClearSession = document.getElementById("linkClearSession");
  const settingsModal = document.getElementById("settingsModal");
  const btnCloseSettings = document.getElementById("btnCloseSettings");
  const inputServerUrl = document.getElementById("inputServerUrl");
  const btnTestUrl = document.getElementById("btnTestUrl");
  const btnSaveUrl = document.getElementById("btnSaveUrl");
  const testResult = document.getElementById("testResult");
  const appVersion = document.getElementById("appVersion");

  // Prevent right-click context menu (eliminate browser feel)
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  // Fetch Tauri app version if available
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke("app_version").then((v) => {
      if (v) appVersion.textContent = "v" + v;
    }).catch(() => {});
  }

  // Get configured URL or default
  function getServerUrl() {
    let url = localStorage.getItem(STORAGE_KEY);
    if (!url) {
      url = DEFAULT_LOCAL;
      localStorage.setItem(STORAGE_KEY, url);
    }
    return url.replace(/\/+$/, "");
  }

  function setServerUrl(url) {
    const cleaned = url.trim().replace(/\/+$/, "");
    localStorage.setItem(STORAGE_KEY, cleaned);
    return cleaned;
  }

  // Set UI state
  function setStatus(state, message) {
    statusPill.className = "status-pill status-" + state;
    statusText.textContent = message;
  }

  // FIN-032 — REAL server verification: fetch the Finix health marker and
  // require ok:true + product:"finix-hr". mode:"cors" (the route sends
  // Access-Control-Allow-Origin: *), so the JSON body is readable and the
  // check actually FAILS for non-Finix hosts and captive portals.
  async function verifyFinixServer(url, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.replace(/\/+$/, "") + "/api/health", {
        method: "GET",
        mode: "cors",
        cache: "no-cache",
        signal: controller.signal,
      });
      clearTimeout(timer);
      let body = null;
      try { body = await res.json(); } catch (_) { /* non-JSON → not a Finix server */ }
      if (body && body.ok === true && body.product === "finix-hr") {
        return { ok: true, db: body.db };
      }
      return {
        ok: false,
        error: "The host answered but is not a Finix HR server" +
          (body && body.product ? " (product marker: " + body.product + ")" : "") +
          ". Refusing to open it inside the trusted app window.",
      };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, error: err.name === "AbortError" ? "Verification timed out" : (err.message || "Host unreachable") };
    }
  }

  // FIN-032 — legacy reachability-only probe, kept ONLY for the modal's
  // "Test Connection" hint line; navigation decisions never use it.
  async function checkServerHealth(url, timeoutMs = 3500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(url, { method: "HEAD", mode: "no-cors", signal: controller.signal, cache: "no-cache" });
      clearTimeout(timer);
      return { ok: true };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, error: err.name === "AbortError" ? "Connection timed out" : (err.message || "Host unreachable") };
    }
  }

  // Connect and load workspace — verification-gated
  async function connectWorkspace(forceUrl) {
    const url = (forceUrl || getServerUrl()).trim();
    diagUrl.textContent = url;
    inputServerUrl.value = url;

    const cat = hostCategory(url);
    if (cat.kind === "invalid") {
      setStatus("offline", "Invalid server URL");
      diagStatus.className = "diag-value diag-error";
      diagStatus.textContent = "The saved server URL is not valid — open Server Settings and re-enter it.";
      return;
    }
    if (cat.kind === "refused") {
      setStatus("offline", "Unsupported URL scheme");
      diagStatus.className = "diag-value diag-error";
      diagStatus.textContent = cat.reason;
      return;
    }

    setStatus("checking", "Verifying server...");
    hubSubtitle.textContent = "Verifying " + url + " is a genuine Finix HR server...";
    diagStatus.className = "diag-value";
    diagStatus.textContent = "Checking the Finix HR health marker (/api/health)...";

    btnRetry.style.display = "inline-flex";
    btnLaunch.style.display = "none";

    const verified = await verifyFinixServer(url);

    if (verified.ok) {
      setStatus("online", "Verified: " + new URL(url).host);
      diagStatus.className = "diag-value diag-success";
      diagStatus.textContent = "Verified Finix HR server (database " + (verified.db || "?") + ").";
      hubSubtitle.textContent = "Connected to a verified Finix HR server. Opening workspace...";

      btnLaunch.style.display = "inline-flex";
      btnLaunch.onclick = () => {
        window.location.replace(url);
      };

      // Auto-navigate ONLY verified servers (FIN-032): an unverified host
      // requires the explicit human click above.
      const isTrusted = cat.kind === "loopback" || cat.kind === "cloud" || isTrustedCustom(cat.host);
      if (isTrusted) {
        setTimeout(() => {
          window.location.replace(url);
        }, 350);
      } else {
        hubSubtitle.textContent = "This custom server is not in your trusted list yet — review it in Server Settings before opening.";
      }
    } else {
      setStatus("offline", "Not verified");
      diagStatus.className = "diag-value diag-error";
      diagStatus.textContent = verified.error || "Could not verify this host as a Finix HR server.";
      hubSubtitle.textContent = "Refusing to open an unverified host inside the trusted app window. Retry, switch to your local server, or review Server Settings.";
    }
  }

  // Event Listeners
  btnRetry.addEventListener("click", () => {
    connectWorkspace();
  });

  btnSwitchLocal.addEventListener("click", () => {
    setServerUrl(DEFAULT_LOCAL);
    connectWorkspace(DEFAULT_LOCAL);
  });

  btnRefresh.addEventListener("click", () => {
    connectWorkspace();
  });

  // FIN-032/DSK-2 — clear the webview's persisted session data (cookies,
  // local/session storage of previously connected servers) via the Rust
  // `clear_session` command. app.withGlobalTauri is now enabled and the
  // main-window capability (src-tauri/capabilities/default.json) grants
  // core:default, so this plain script actually receives the
  // window.__TAURI__ bridge and the invoke is no longer a silent no-op.
  // If the bridge is ever missing or the command fails, we fall back to
  // wiping this origin's storage AND tell the user what was NOT wiped,
  // so the advertised wipe never fails silently again.
  async function clearSessionData() {
    let wiped = false;
    let bridgeMissing = false;
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
      try {
        await window.__TAURI__.core.invoke("clear_session");
        wiped = true;
      } catch (_) {
        /* command failed in this build — fall through to the local wipe */
      }
    } else {
      bridgeMissing = true;
    }
    try { localStorage.clear(); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
    let message;
    if (wiped) {
      message = "Session data cleared — webview cookies and storage of previously connected servers were wiped. You will need to sign in again on the next connect.";
    } else {
      message = "Cleared this launcher's stored settings only" +
        (bridgeMissing ? " (the app bridge is unavailable in this build)" : " (the session-clear command failed)") +
        ". Webview cookies of connected servers were NOT wiped — use Workspace \u2192 'Clear Session Data && Sign Out' in the app menu, then reconnect and sign out from the web app.";
    }
    alert(message);
    connectWorkspace();
  }
  if (linkClearSession) {
    linkClearSession.addEventListener("click", (e) => {
      e.preventDefault();
      clearSessionData();
    });
  }

  // Settings Modal handlers
  function openSettings() {
    inputServerUrl.value = getServerUrl();
    testResult.className = "test-result hidden";
    settingsModal.classList.remove("hidden");
  }

  function closeSettings() {
    settingsModal.classList.add("hidden");
  }

  btnSettings.addEventListener("click", openSettings);
  linkOpenSettings.addEventListener("click", (e) => {
    e.preventDefault();
    openSettings();
  });
  btnCloseSettings.addEventListener("click", closeSettings);

  // Preset buttons
  document.querySelectorAll(".preset-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      inputServerUrl.value = btn.getAttribute("data-url");
    });
  });

  // Test button inside modal — the REAL verification, not bare reachability
  btnTestUrl.addEventListener("click", async () => {
    const testTarget = inputServerUrl.value.trim();
    if (!testTarget) return;

    testResult.className = "test-result";
    testResult.textContent = "Verifying " + testTarget + "...";

    const cat = hostCategory(testTarget);
    if (cat.kind === "invalid") {
      testResult.className = "test-result error";
      testResult.textContent = "Invalid URL format. Please include http:// or https://";
      return;
    }
    if (cat.kind === "refused") {
      testResult.className = "test-result error";
      testResult.textContent = cat.reason;
      return;
    }

    const res = await verifyFinixServer(testTarget, 6000);
    if (res.ok) {
      testResult.className = "test-result success";
      testResult.textContent = "✓ Verified Finix HR server (database " + (res.db || "?") + ")." +
        (cat.kind === "custom" && !isTrustedCustom(cat.host)
          ? " Saving a custom host requires the confirmation step below."
          : "");
    } else {
      const reach = await checkServerHealth(testTarget, 4000);
      testResult.className = "test-result error";
      testResult.textContent = reach.ok
        ? "✗ " + res.error
        : "✗ " + (res.error || "Cannot connect to server");
    }
  });

  // Save button inside modal — custom hosts need the typed trust phrase
  btnSaveUrl.addEventListener("click", () => {
    const newUrl = inputServerUrl.value.trim();
    if (!newUrl) return;

    const cat = hostCategory(newUrl);
    if (cat.kind === "invalid") {
      alert("Please enter a valid URL (e.g. http://localhost:4055 or https://finixhrm.com)");
      return;
    }
    if (cat.kind === "refused") {
      alert(cat.reason);
      return;
    }
    if (cat.kind === "custom" && !isTrustedCustom(cat.host)) {
      // FIN-032 — the explicit trust gesture for non-allow-listed hosts
      const phrase = prompt(
        "You are connecting the Finix HR desktop app to a server outside the official allow-list:\n\n" +
        "  " + cat.host + "\n\n" +
        "The app window has no address bar — make sure you trust this host (it will receive your sign-in credentials).\n" +
        'Type "' + CONFIRM_PHRASE + '" to continue:'
      );
      if (phrase === null) return;
      if (phrase.trim().toLowerCase() !== CONFIRM_PHRASE.toLowerCase()) {
        alert("Confirmation phrase did not match — the server was NOT saved.");
        return;
      }
      rememberTrustedCustom(cat.host);
    }

    setServerUrl(newUrl);
    closeSettings();
    connectWorkspace(newUrl);
  });

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if (e.key === "F5" || (e.ctrlKey && e.key === "r")) {
      e.preventDefault();
      connectWorkspace();
    }
    if (e.key === "Escape" && !settingsModal.classList.contains("hidden")) {
      closeSettings();
    }
  });

  // Initial connect
  connectWorkspace();
})();
