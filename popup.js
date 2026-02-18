const app = document.getElementById("app");

function showOnboarding() {
  app.innerHTML = `
    <h3>Welcome 👋</h3>
    <input id="name" placeholder="Name">
    <input id="college" placeholder="College">
    <input id="course" placeholder="Course">
    <input id="year" placeholder="Year">
    <button id="save">Continue</button>
  `;

  document.getElementById("save").onclick = () => {
    const data = {
      name: document.getElementById("name").value,
      college: document.getElementById("college").value,
      course: document.getElementById("course").value,
      year: document.getElementById("year").value
    };

    chrome.storage.local.set({ user: data }, showMain);
  };
}

function showMain() {
  chrome.storage.local.get(["user"], (res) => {
    const user = res.user;

    app.innerHTML = `
      <h3>Hi ${user.name}</h3>
      <p>Study session?</p>
      <button id="yes">Start</button>
      <button id="no">Not now</button>
    `;

    document.getElementById("yes").onclick = showSessionSetup;
    document.getElementById("no").onclick = () => window.close();
  });
}

function showSessionSetup() {
  app.innerHTML = `
    <h3>Focus Mode</h3>
    <input id="topic" placeholder="What are you studying?">
    <input id="sites" placeholder="Allowed sites (comma separated)">
    <button id="start">Start Session</button>
  `;

  document.getElementById("start").onclick = () => {
    const topic = document.getElementById("topic").value;
    const sites = document.getElementById("sites").value;

    const allowed = sites.split(",").map(s => s.trim());

    chrome.storage.local.set({
      session: {
        active: true,
        topic,
        allowedSites: allowed
      }
    }, () => window.close());
  };
}

chrome.storage.local.get(["user"], (res) => {
  if (!res.user) showOnboarding();
  else showMain();
});
