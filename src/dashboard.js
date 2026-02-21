// ===== Focus Flow - Dashboard =====
// Full-page analytics dashboard with Chart.js visualizations

import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

// ===== Utilities =====

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function formatHours(ms) {
  const hours = ms / (1000 * 60 * 60);
  if (hours >= 1) return hours.toFixed(1) + "h";
  const minutes = ms / (1000 * 60);
  return Math.round(minutes) + "m";
}

function getDateKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getDayLabel(dateKey) {
  const d = new Date(dateKey + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function getShortDayLabel(dateKey) {
  const d = new Date(dateKey + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function getTodayKey() {
  return getDateKey(Date.now());
}

function getLast7DaysKeys() {
  const keys = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(getDateKey(d.getTime()));
  }
  return keys;
}

// ===== Analytics Engine =====

function computeAnalytics(sessions) {
  const today = getTodayKey();
  const last7 = getLast7DaysKeys();

  // Group sessions by date
  const byDate = {};
  for (const s of sessions) {
    const key = getDateKey(s.startTime || s.endTime || Date.now());
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(s);
  }

  // Today's stats
  const todaySessions = byDate[today] || [];
  const todayFocusTime = todaySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  const todayCount = todaySessions.length;
  const todayAvgScore = todayCount > 0
    ? Math.round(todaySessions.reduce((sum, s) => sum + (s.focusScore || 0), 0) / todayCount)
    : null;
  const todayDistractions = todaySessions.reduce((sum, s) => sum + (s.distractions || 0), 0);

  // Weekly data
  const weeklyTime = last7.map((key) => {
    const daySessions = byDate[key] || [];
    return daySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  });
  const weeklyScore = last7.map((key) => {
    const daySessions = byDate[key] || [];
    if (daySessions.length === 0) return null;
    return Math.round(daySessions.reduce((sum, s) => sum + (s.focusScore || 0), 0) / daySessions.length);
  });
  const weeklyLabels = last7.map(getShortDayLabel);

  // All-time stats
  const totalFocusTime = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  const totalSessions = sessions.length;
  const avgScore = totalSessions > 0
    ? Math.round(sessions.reduce((sum, s) => sum + (s.focusScore || 0), 0) / totalSessions)
    : null;

  // Streak calculation
  const { currentStreak, longestStreak } = computeStreaks(sessions);

  // Top distracting sites (aggregate from all sessions)
  const siteCounts = {};
  for (const s of sessions) {
    const sites = s.distractingSites || {};
    for (const [domain, count] of Object.entries(sites)) {
      siteCounts[domain] = (siteCounts[domain] || 0) + count;
    }
  }
  const topSites = Object.entries(siteCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Angel vs Devil choices (aggregate)
  let totalAngel = 0;
  let totalDevil = 0;
  for (const s of sessions) {
    const c = s.choices || {};
    totalAngel += c.angel || 0;
    totalDevil += c.devil || 0;
  }

  // Study insights
  const insights = computeInsights(sessions);

  return {
    today: { focusTime: todayFocusTime, sessions: todayCount, avgScore: todayAvgScore, distractions: todayDistractions },
    weekly: { labels: weeklyLabels, time: weeklyTime, score: weeklyScore },
    allTime: { focusTime: totalFocusTime, sessions: totalSessions, avgScore, longestStreak },
    currentStreak,
    topSites,
    choices: { angel: totalAngel, devil: totalDevil },
    insights,
    byDate,
  };
}

function computeStreaks(sessions) {
  if (sessions.length === 0) return { currentStreak: 0, longestStreak: 0 };

  // Get unique date keys
  const dateSet = new Set();
  for (const s of sessions) {
    dateSet.add(getDateKey(s.startTime || s.endTime || Date.now()));
  }
  const sortedDates = [...dateSet].sort();

  // Compute longest streak
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1] + "T12:00:00");
    const curr = new Date(sortedDates[i] + "T12:00:00");
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (diff === 1) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }

  // Compute current streak (counting back from today)
  const todayKey = getTodayKey();
  let streak = 0;
  let checkDate = new Date();
  // If today has sessions, start from today; otherwise start from yesterday
  if (!dateSet.has(todayKey)) {
    checkDate.setDate(checkDate.getDate() - 1);
    const yesterdayKey = getDateKey(checkDate.getTime());
    if (!dateSet.has(yesterdayKey)) return { currentStreak: 0, longestStreak: longest };
  }
  while (true) {
    const key = getDateKey(checkDate.getTime());
    if (dateSet.has(key)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return { currentStreak: streak, longestStreak: Math.max(longest, streak) };
}

function computeInsights(sessions) {
  const insights = {
    bestTime: null,
    optimalLength: null,
    bestDay: null,
  };

  if (sessions.length < 3) return insights;

  // Best study time (hour of day)
  const hourScores = {};
  const hourCounts = {};
  for (const s of sessions) {
    if (!s.startTime) continue;
    const hour = new Date(s.startTime).getHours();
    hourScores[hour] = (hourScores[hour] || 0) + (s.focusScore || 0);
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
  }
  let bestHour = null;
  let bestHourAvg = 0;
  for (const [hour, total] of Object.entries(hourScores)) {
    const avg = total / hourCounts[hour];
    if (avg > bestHourAvg) {
      bestHourAvg = avg;
      bestHour = parseInt(hour);
    }
  }
  if (bestHour !== null) {
    const h = bestHour;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const nextH = (h + 2) % 24;
    const nextAmpm = nextH >= 12 ? "PM" : "AM";
    const nextH12 = nextH === 0 ? 12 : nextH > 12 ? nextH - 12 : nextH;
    insights.bestTime = {
      label: `${h12} ${ampm} - ${nextH12} ${nextAmpm}`,
      score: Math.round(bestHourAvg),
    };
  }

  // Optimal session length
  const buckets = { "< 30m": [], "30-60m": [], "60-90m": [], "90m+": [] };
  for (const s of sessions) {
    const mins = (s.duration || 0) / (1000 * 60);
    if (mins < 30) buckets["< 30m"].push(s.focusScore || 0);
    else if (mins < 60) buckets["30-60m"].push(s.focusScore || 0);
    else if (mins < 90) buckets["60-90m"].push(s.focusScore || 0);
    else buckets["90m+"].push(s.focusScore || 0);
  }
  let bestBucket = null;
  let bestBucketAvg = 0;
  for (const [label, scores] of Object.entries(buckets)) {
    if (scores.length < 1) continue;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg > bestBucketAvg) {
      bestBucketAvg = avg;
      bestBucket = label;
    }
  }
  if (bestBucket) {
    insights.optimalLength = { label: bestBucket, score: Math.round(bestBucketAvg) };
  }

  // Best day of week
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayScores = {};
  const dayCounts = {};
  for (const s of sessions) {
    if (!s.startTime) continue;
    const day = new Date(s.startTime).getDay();
    dayScores[day] = (dayScores[day] || 0) + (s.focusScore || 0);
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  }
  let bestDayIdx = null;
  let bestDayAvg = 0;
  for (const [day, total] of Object.entries(dayScores)) {
    const avg = total / dayCounts[day];
    if (avg > bestDayAvg) {
      bestDayAvg = avg;
      bestDayIdx = parseInt(day);
    }
  }
  if (bestDayIdx !== null) {
    insights.bestDay = { label: dayNames[bestDayIdx], score: Math.round(bestDayAvg) };
  }

  return insights;
}

// ===== Chart Rendering =====

function renderWeeklyTimeChart(labels, data) {
  const ctx = document.getElementById("chart-weekly-time");
  if (!ctx) return;

  // Convert ms to hours for display
  const hours = data.map((ms) => ms / (1000 * 60 * 60));

  new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Focus Time (hrs)",
          data: hours,
          borderColor: "#F47D5B",
          backgroundColor: "rgba(244, 125, 91, 0.08)",
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#F47D5B",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#2D2D2D",
          titleFont: { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto", size: 12 },
          bodyFont: { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto", size: 13 },
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (context) => {
              const ms = data[context.dataIndex];
              return `Focus: ${formatTime(ms)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 }, color: "#ABABAB" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(240, 237, 233, 0.5)" },
          ticks: {
            font: { size: 11 },
            color: "#ABABAB",
            callback: (value) => value.toFixed(1) + "h",
          },
        },
      },
    },
  });
}

function renderWeeklyScoreChart(labels, data) {
  const ctx = document.getElementById("chart-weekly-score");
  if (!ctx) return;

  const bgColors = data.map((score) => {
    if (score === null) return "rgba(240, 237, 233, 0.5)";
    if (score >= 80) return "rgba(107, 207, 127, 0.7)";
    if (score >= 50) return "rgba(255, 184, 128, 0.7)";
    return "rgba(255, 107, 107, 0.7)";
  });

  const borderColors = data.map((score) => {
    if (score === null) return "#F0EDE9";
    if (score >= 80) return "#6BCF7F";
    if (score >= 50) return "#FFB880";
    return "#FF6B6B";
  });

  new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Focus Score (%)",
          data: data.map((d) => d ?? 0),
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 2,
          borderRadius: 6,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#2D2D2D",
          titleFont: { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto", size: 12 },
          bodyFont: { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto", size: 13 },
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (context) => {
              const score = data[context.dataIndex];
              return score !== null ? `Score: ${score}%` : "No sessions";
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 }, color: "#ABABAB" },
        },
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: "rgba(240, 237, 233, 0.5)" },
          ticks: {
            font: { size: 11 },
            color: "#ABABAB",
            callback: (value) => value + "%",
            stepSize: 25,
          },
        },
      },
    },
  });
}

// ===== DOM Rendering =====

function renderNav(user, session) {
  const usernameEl = document.getElementById("nav-username");
  const avatarEl = document.getElementById("nav-avatar");
  const badgeEl = document.getElementById("nav-session-badge");

  if (user && user.name) {
    usernameEl.textContent = user.name;
    avatarEl.textContent = user.name.charAt(0).toUpperCase();
  }

  if (session && session.active) {
    badgeEl.style.display = "flex";
  }
}

function renderHero(user, analytics) {
  const dateEl = document.getElementById("hero-date");
  const titleEl = document.getElementById("hero-title");
  const subtitleEl = document.getElementById("hero-subtitle");
  const streakEl = document.getElementById("streak-number");

  const now = new Date();
  dateEl.textContent = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const name = user && user.name ? escapeHtml(user.name) : "there";
  const hour = now.getHours();
  let greeting;
  if (hour < 12) greeting = "Good morning";
  else if (hour < 17) greeting = "Good afternoon";
  else greeting = "Good evening";

  titleEl.innerHTML = `${greeting}, ${name}`;

  if (analytics.allTime.sessions === 0) {
    subtitleEl.textContent = "Start your first focus session to see your stats.";
  } else if (analytics.today.sessions > 0) {
    subtitleEl.textContent = `You've completed ${analytics.today.sessions} session${analytics.today.sessions !== 1 ? "s" : ""} today. Keep it up!`;
  } else {
    subtitleEl.textContent = "Let's see how your focus journey is going.";
  }

  streakEl.textContent = analytics.currentStreak;
}

function renderTodayStats(analytics) {
  document.getElementById("today-focus-time").textContent =
    analytics.today.focusTime > 0 ? formatTime(analytics.today.focusTime) : "0m";
  document.getElementById("today-sessions").textContent = analytics.today.sessions;
  document.getElementById("today-score").textContent =
    analytics.today.avgScore !== null ? analytics.today.avgScore + "%" : "--";
  document.getElementById("today-distractions").textContent = analytics.today.distractions;
}

function renderAllTimeStats(analytics) {
  document.getElementById("alltime-focus-time").textContent =
    analytics.allTime.focusTime > 0 ? formatHours(analytics.allTime.focusTime) : "0h";
  document.getElementById("alltime-sessions").textContent = analytics.allTime.sessions;
  document.getElementById("alltime-score").textContent =
    analytics.allTime.avgScore !== null ? analytics.allTime.avgScore + "%" : "--";
  document.getElementById("alltime-streak").textContent = analytics.allTime.longestStreak;
}

function renderTopSites(topSites) {
  const emptyEl = document.getElementById("distracting-sites-empty");
  const listEl = document.getElementById("distracting-sites-list");

  if (topSites.length === 0) {
    emptyEl.style.display = "block";
    listEl.style.display = "none";
    return;
  }

  emptyEl.style.display = "none";
  listEl.style.display = "block";

  const maxCount = topSites[0][1];

  listEl.innerHTML = topSites
    .map(
      ([domain, count], i) => `
    <div class="distraction-row">
      <div class="distraction-rank">${i + 1}</div>
      <div class="distraction-info">
        <div class="distraction-domain">${escapeHtml(domain)}</div>
        <div class="distraction-bar-bg">
          <div class="distraction-bar-fill" style="width: ${Math.round((count / maxCount) * 100)}%;"></div>
        </div>
      </div>
      <div class="distraction-count">${count}x</div>
    </div>
  `
    )
    .join("");
}

function renderChoices(choices) {
  const total = choices.angel + choices.devil;
  const angelPct = total > 0 ? (choices.angel / total) * 100 : 50;
  const devilPct = total > 0 ? (choices.devil / total) * 100 : 50;

  document.getElementById("choices-angel-count").textContent = choices.angel;
  document.getElementById("choices-devil-count").textContent = choices.devil;
  document.getElementById("choices-bar-angel").style.width = angelPct + "%";
  document.getElementById("choices-bar-devil").style.width = devilPct + "%";

  const summaryEl = document.getElementById("choices-summary");
  if (total === 0) {
    summaryEl.textContent = "Make your first choice during a distraction to see stats here.";
  } else if (angelPct >= 70) {
    summaryEl.textContent = `You chose the Angel ${choices.angel} times. You're staying strong!`;
  } else if (devilPct >= 70) {
    summaryEl.textContent = `The Devil won ${choices.devil} times. Try to resist next time!`;
  } else {
    summaryEl.textContent = `It's a close battle! Angel: ${choices.angel}, Devil: ${choices.devil}.`;
  }
}

function renderInsights(insights) {
  if (insights.bestTime) {
    document.getElementById("insight-best-time-title").textContent = "Best Study Time";
    document.getElementById("insight-best-time-desc").textContent =
      `You focus best around ${insights.bestTime.label} (avg score: ${insights.bestTime.score}%).`;
  }

  if (insights.optimalLength) {
    document.getElementById("insight-optimal-length-title").textContent = "Optimal Session Length";
    document.getElementById("insight-optimal-length-desc").textContent =
      `Your best sessions are ${insights.optimalLength.label} long (avg score: ${insights.optimalLength.score}%).`;
  }

  if (insights.bestDay) {
    document.getElementById("insight-best-day-title").textContent = "Most Productive Day";
    document.getElementById("insight-best-day-desc").textContent =
      `${insights.bestDay.label} is your strongest day (avg score: ${insights.bestDay.score}%).`;
  }
}

function renderSessionHistory(sessions) {
  const container = document.getElementById("history-table-container");
  const emptyEl = document.getElementById("history-empty");

  if (sessions.length === 0) {
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";

  const sorted = [...sessions].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

  const buildTable = (filtered) => {
    if (filtered.length === 0) {
      return `<div class="empty-state"><p>No sessions match your search.</p></div>`;
    }

    return `
      <table class="history-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Time</th>
            <th>Topic</th>
            <th>Duration</th>
            <th>Focus Score</th>
            <th>Distractions</th>
          </tr>
        </thead>
        <tbody>
          ${filtered
            .map((s) => {
              const d = new Date(s.startTime || s.endTime || Date.now());
              const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
              const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
              const scoreClass =
                s.focusScore >= 80 ? "high" : s.focusScore >= 50 ? "med" : "low";
              return `
              <tr>
                <td>${dateStr}</td>
                <td>${timeStr}</td>
                <td class="topic-cell" title="${escapeHtml(s.topic || "")}">${escapeHtml(s.topic || "Untitled")}</td>
                <td>${formatTime(s.duration || 0)}</td>
                <td><span class="score-badge ${scoreClass}">${s.focusScore != null ? s.focusScore + "%" : "--"}</span></td>
                <td>${s.distractions || 0}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    `;
  };

  container.innerHTML = buildTable(sorted);

  // Search functionality
  const searchInput = document.getElementById("history-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) {
        container.innerHTML = buildTable(sorted);
        return;
      }
      const filtered = sorted.filter(
        (s) => (s.topic || "").toLowerCase().includes(query)
      );
      container.innerHTML = buildTable(filtered);
    });
  }

  // CSV Export
  const exportBtn = document.getElementById("export-csv-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const headers = ["Date", "Time", "Topic", "Duration (min)", "Focus Score (%)", "Distractions", "Distraction Time (min)"];
      const rows = sorted.map((s) => {
        const d = new Date(s.startTime || s.endTime || Date.now());
        return [
          d.toLocaleDateString("en-US"),
          d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
          `"${(s.topic || "Untitled").replace(/"/g, '""')}"`,
          Math.round((s.duration || 0) / 60000),
          s.focusScore != null ? s.focusScore : "",
          s.distractions || 0,
          Math.round((s.distractionTime || 0) / 60000),
        ].join(",");
      });

      const csv = [headers.join(","), ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `focus-flow-sessions-${getTodayKey()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

// ===== Initialize Dashboard =====

async function init() {
  const { user, session, sessionHistory = [] } = await chrome.storage.local.get([
    "user",
    "session",
    "sessionHistory",
  ]);

  // Compute analytics
  const analytics = computeAnalytics(sessionHistory);

  // Render all sections
  renderNav(user, session);
  renderHero(user, analytics);
  renderTodayStats(analytics);
  renderAllTimeStats(analytics);
  renderTopSites(analytics.topSites);
  renderChoices(analytics.choices);
  renderInsights(analytics.insights);
  renderSessionHistory(sessionHistory);

  // Render charts
  renderWeeklyTimeChart(analytics.weekly.labels, analytics.weekly.time);
  renderWeeklyScoreChart(analytics.weekly.labels, analytics.weekly.score);
}

init();
