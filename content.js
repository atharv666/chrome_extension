// chrome.runtime.onMessage.addListener((msg) => {
//   if (msg.action === "block") {
//     const result = confirm(
//       `Distraction detected!\n${msg.site}\n\nOK = Allow\nCancel = Close tab`
//     );

//     if (result) {
//       chrome.runtime.sendMessage({ action: "addAllowed", site: msg.site });
//     } else {
//       chrome.runtime.sendMessage({ action: "closeTab" });
//     }
//   }
// });

let inactivityTimer;
const INACTIVITY_LIMIT = 6000; // 6 seconds test

let lastActivity = Date.now();

function resetTimer() {
  const now = Date.now();

  // ignore rapid duplicate events
  if (now - lastActivity < 500) return;

  lastActivity = now;

  console.log("Activity detected → reset timer");

  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(showInactivityPopup, INACTIVITY_LIMIT);
}

function showInactivityPopup() {
  console.log("INACTIVITY TRIGGERED");

  if (document.getElementById("focus-popup")) return;

  const overlay = document.createElement("div");
  overlay.id = "focus-popup";

  overlay.style.position = "fixed";
  overlay.style.top = "0";
  overlay.style.left = "0";
  overlay.style.width = "100vw";
  overlay.style.height = "100vh";
  overlay.style.background = "rgba(0,0,0,0.7)";
  overlay.style.display = "flex";
  overlay.style.justifyContent = "center";
  overlay.style.alignItems = "center";
  overlay.style.zIndex = "2147483647"; // MAX Z-INDEX
  overlay.style.fontFamily = "sans-serif";

  overlay.innerHTML = `
    <div style="
      background:white;
      padding:30px;
      border-radius:12px;
      text-align:center;
      box-shadow:0 10px 40px rgba(0,0,0,0.3);
    ">
      <h2>⏰ Are you still there?</h2>
      <button id="focus-yes" style="
        padding:12px 18px;
        border:none;
        border-radius:8px;
        background:#2575fc;
        color:white;
        font-weight:bold;
        cursor:pointer;
      ">
        Yes, continue
      </button>
    </div>
  `;

  document.documentElement.appendChild(overlay);

  document.getElementById("focus-yes").onclick = () => {
    overlay.remove();
    resetTimer();
  };
}

// real user activity only
["click", "keydown", "scroll", "touchstart"].forEach(event => {
  document.addEventListener(event, resetTimer, true);
});

resetTimer();

// distraction logic
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "block") {
    const result = confirm(
      `Distraction detected!\n${msg.site}\n\nOK = Allow\nCancel = Close tab`
    );

    if (result) {
      chrome.runtime.sendMessage({ action: "addAllowed", site: msg.site });
    } else {
      chrome.runtime.sendMessage({ action: "closeTab" });
    }
  }
});
