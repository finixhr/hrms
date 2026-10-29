// Finix HR Desktop Shell
(function () {
  const STORAGE_KEY = "finix_desktop_server_url";
  const DEFAULT_LOCAL = "http://localhost:4055";

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

  // Test server connectivity
  async function checkServerHealth(url, timeoutMs = 3500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Test the server with a light fetch (mode: no-cors permits basic reachability test)
      await fetch(url, {
        method: "HEAD",
        mode: "no-cors",
        signal: controller.signal,
        cache: "no-cache",
      });
      clearTimeout(timer);
      return { ok: true };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, error: err.name === "AbortError" ? "Connection timed out" : (err.message || "Host unreachable") };
    }
  }

  // Connect and load workspace
  async function connectWorkspace(forceUrl) {
    const url = forceUrl || getServerUrl();
    diagUrl.textContent = url;
    inputServerUrl.value = url;

    setStatus("checking", "Connecting...");
    hubSubtitle.textContent = "Connecting to Finix HR server at " + url + "...";
    diagStatus.className = "diag-value";
    diagStatus.textContent = "Testing network reachability...";

    btnRetry.style.display = "inline-flex";
    btnLaunch.style.display = "none";

    const health = await checkServerHealth(url);

    if (health.ok) {
      setStatus("online", "Connected: " + new URL(url).host);
      diagStatus.className = "diag-value diag-success";
      diagStatus.textContent = "Connected (Online). Launching workspace...";
      hubSubtitle.textContent = "Server is online. Opening Finix HR...";

      btnLaunch.style.display = "inline-flex";
      btnLaunch.onclick = () => {
        window.location.replace(url);
      };

      // Top-level navigation directly replaces the window location
      // This completely eliminates iframe X-Frame-Options blocking & camera permission issues
      setTimeout(() => {
        window.location.replace(url);
      }, 350);
    } else {
      setStatus("offline", "Server Unreachable");
      diagStatus.className = "diag-value diag-error";
      diagStatus.textContent = health.error || "Cannot establish connection (Server offline or DNS unconfigured)";
      hubSubtitle.textContent = "Unable to reach Finix HR server. Make sure your server is running.";
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

  // Test button inside modal
  btnTestUrl.addEventListener("click", async () => {
    const testTarget = inputServerUrl.value.trim();
    if (!testTarget) return;

    testResult.className = "test-result";
    testResult.textContent = "Testing " + testTarget + "...";

    try {
      new URL(testTarget);
    } catch (_) {
      testResult.className = "test-result error";
      testResult.textContent = "Invalid URL format. Please include http:// or https://";
      return;
    }

    const res = await checkServerHealth(testTarget, 4000);
    if (res.ok) {
      testResult.className = "test-result success";
      testResult.textContent = "✓ Success! Server is online and responding.";
    } else {
      testResult.className = "test-result error";
      testResult.textContent = "✗ Failed: " + (res.error || "Cannot connect to server");
    }
  });

  // Save button inside modal
  btnSaveUrl.addEventListener("click", () => {
    const newUrl = inputServerUrl.value.trim();
    if (!newUrl) return;

    try {
      new URL(newUrl);
    } catch (_) {
      alert("Please enter a valid URL (e.g. http://localhost:4055 or https://finixhrm.com)");
      return;
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
