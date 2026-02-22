import { Chart, registerables } from "chart.js";

Chart.register(...registerables);

const state = {
  range: "7d",
  dataSource: "live",
  persona: "new",
  liveSessions: [],
  analyticsCache: new Map(),
  searchQuery: "",
};

const chartRefs = {
  weeklyTime: null,
  weeklyScore: null,
  periodCompare: null,
  scoreDistribution: null,
};

function byId(id) {
  return document.getElementById(id);
}

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
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(ms / (1000 * 60))}m`;
}

function getDateKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getShortDayLabel(dateKey) {
  const d = new Date(`${dateKey}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function getLastNDaysKeys(days) {
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(getDateKey(d.getTime()));
  }
  return keys;
}

function countActiveDaysInWindow(sessions, days) {
  const allowedKeys = new Set(getLastNDaysKeys(days));
  const activeKeys = new Set();
  sessions.forEach((s) => {
    const key = getDateKey(s.startTime || s.endTime || Date.now());
    if (allowedKeys.has(key)) activeKeys.add(key);
  });
  return Math.min(activeKeys.size, days);
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDay(ts) {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function formatRangeLabel(startTs, endTs) {
  const start = new Date(startTs);
  const end = new Date(endTs);
  const startMonth = start.toLocaleDateString("en-US", { month: "short" });
  const endMonth = end.toLocaleDateString("en-US", { month: "short" });
  if (startMonth === endMonth) return `${startMonth} ${start.getDate()}-${end.getDate()}`;
  return `${startMonth} ${start.getDate()}-${endMonth} ${end.getDate()}`;
}

function buildTimelineSeries(sessions, range) {
  const now = Date.now();
  const getSessionTs = (s) => s.startTime || s.endTime || 0;

  if (range === "7d") {
    const dayKeys = getLastNDaysKeys(7);
    const byDate = {};
    sessions.forEach((s) => {
      const key = getDateKey(getSessionTs(s) || now);
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(s);
    });
    return {
      labels: dayKeys.map((k) => getShortDayLabel(k)),
      time: dayKeys.map((key) => sumDuration(byDate[key] || [])),
      score: dayKeys.map((key) => avgScore(byDate[key] || [])),
      timeSubtitle: "Hours per day, last 7 days",
      scoreSubtitle: "Average score per day, last 7 days",
    };
  }

  if (range === "30d") {
    const windowStart = startOfDay(now - 29 * 24 * 60 * 60 * 1000);
    const buckets = [];
    for (let i = 0; i < 5; i += 1) {
      const start = windowStart + i * 7 * 24 * 60 * 60 * 1000;
      const end = Math.min(start + 7 * 24 * 60 * 60 * 1000 - 1, endOfDay(now));
      buckets.push({ start, end });
    }

    const labels = [];
    const time = [];
    const score = [];
    buckets.forEach((bucket) => {
      const inBucket = sessions.filter((s) => {
        const ts = getSessionTs(s);
        return ts >= bucket.start && ts <= bucket.end;
      });
      labels.push(formatRangeLabel(bucket.start, bucket.end));
      time.push(sumDuration(inBucket));
      score.push(avgScore(inBucket));
    });

    return {
      labels,
      time,
      score,
      timeSubtitle: "Hours per week, last 30 days",
      scoreSubtitle: "Average score per week, last 30 days",
    };
  }

  const maxTs = sessions.length ? Math.max(...sessions.map((s) => getSessionTs(s))) : now;
  const minTs = sessions.length ? Math.min(...sessions.map((s) => getSessionTs(s))) : now;
  const startMonth = new Date(minTs);
  startMonth.setDate(1);
  startMonth.setHours(0, 0, 0, 0);
  const endMonth = new Date(maxTs);
  endMonth.setDate(1);
  endMonth.setHours(0, 0, 0, 0);

  const monthBuckets = [];
  const cursor = new Date(startMonth);
  while (cursor <= endMonth) {
    const start = cursor.getTime();
    const next = new Date(cursor);
    next.setMonth(next.getMonth() + 1);
    const end = next.getTime() - 1;
    monthBuckets.push({ start, end, label: cursor.toLocaleDateString("en-US", { month: "short", year: "numeric" }) });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const labels = [];
  const time = [];
  const score = [];
  monthBuckets.forEach((bucket) => {
    const inBucket = sessions.filter((s) => {
      const ts = getSessionTs(s);
      return ts >= bucket.start && ts <= bucket.end;
    });
    labels.push(bucket.label);
    time.push(sumDuration(inBucket));
    score.push(avgScore(inBucket));
  });

  return {
    labels,
    time,
    score,
    timeSubtitle: "Hours per month, full history",
    scoreSubtitle: "Average score per month",
  };
}

function rangeDays(range) {
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  return null;
}

function getRangeWindows(range) {
  const days = rangeDays(range);
  if (!days) return null;
  const now = Date.now();
  const currentStart = now - days * 24 * 60 * 60 * 1000;
  const previousStart = currentStart - days * 24 * 60 * 60 * 1000;
  return { currentStart, previousStart, now, currentEnd: now };
}

function sumDuration(sessions) {
  return sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
}

function avgScore(sessions) {
  if (!sessions.length) return null;
  return Math.round(sessions.reduce((sum, s) => sum + (s.focusScore || 0), 0) / sessions.length);
}

function sumDistractions(sessions) {
  return sessions.reduce((sum, s) => sum + (s.distractions || 0), 0);
}

function computeStreaks(sessions) {
  if (!sessions.length) return { currentStreak: 0, longestStreak: 0 };
  const dateSet = new Set(sessions.map((s) => getDateKey(s.startTime || s.endTime || Date.now())));
  const sortedDates = [...dateSet].sort();
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sortedDates.length; i += 1) {
    const prev = new Date(`${sortedDates[i - 1]}T12:00:00`);
    const curr = new Date(`${sortedDates[i]}T12:00:00`);
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (diff === 1) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }

  const today = new Date();
  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = getDateKey(d.getTime());
    if (dateSet.has(key)) {
      streak += 1;
    } else if (i === 0) {
      continue;
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
    confidence: { bestTime: 0, optimalLength: 0, bestDay: 0 },
    opportunity: "",
  };

  if (!sessions.length) {
    insights.opportunity = "Opportunity: Start 3 focused sessions to unlock personalized recommendations.";
    return insights;
  }

  const hourStats = {};
  sessions.forEach((s) => {
    if (!s.startTime) return;
    const hour = new Date(s.startTime).getHours();
    if (!hourStats[hour]) hourStats[hour] = { total: 0, count: 0 };
    hourStats[hour].total += s.focusScore || 0;
    hourStats[hour].count += 1;
  });

  let bestHour = null;
  let bestHourAvg = -1;
  Object.entries(hourStats).forEach(([hour, item]) => {
    if (item.count < 2) return;
    const avg = item.total / item.count;
    if (avg > bestHourAvg) {
      bestHourAvg = avg;
      bestHour = Number(hour);
    }
  });

  if (bestHour !== null) {
    const next = (bestHour + 2) % 24;
    const h12 = bestHour === 0 ? 12 : bestHour > 12 ? bestHour - 12 : bestHour;
    const n12 = next === 0 ? 12 : next > 12 ? next - 12 : next;
    insights.bestTime = {
      label: `${h12}${bestHour >= 12 ? "PM" : "AM"} - ${n12}${next >= 12 ? "PM" : "AM"}`,
      score: Math.round(bestHourAvg),
      recommendation: "Schedule your hardest task in this window.",
    };
    insights.confidence.bestTime = hourStats[bestHour].count;
  }

  const buckets = {
    "< 30m": [],
    "30-60m": [],
    "60-90m": [],
    "90m+": [],
  };
  sessions.forEach((s) => {
    const mins = (s.duration || 0) / 60000;
    if (mins < 30) buckets["< 30m"].push(s.focusScore || 0);
    else if (mins < 60) buckets["30-60m"].push(s.focusScore || 0);
    else if (mins < 90) buckets["60-90m"].push(s.focusScore || 0);
    else buckets["90m+"].push(s.focusScore || 0);
  });

  let bestBucket = null;
  let bestBucketAvg = -1;
  Object.entries(buckets).forEach(([label, scores]) => {
    if (scores.length < 2) return;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg > bestBucketAvg) {
      bestBucketAvg = avg;
      bestBucket = label;
    }
  });

  if (bestBucket) {
    insights.optimalLength = {
      label: bestBucket,
      score: Math.round(bestBucketAvg),
      recommendation: "Use this duration as your default deep-work block.",
    };
    insights.confidence.optimalLength = buckets[bestBucket].length;
  }

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayStats = {};
  sessions.forEach((s) => {
    if (!s.startTime) return;
    const day = new Date(s.startTime).getDay();
    if (!dayStats[day]) dayStats[day] = { total: 0, count: 0 };
    dayStats[day].total += s.focusScore || 0;
    dayStats[day].count += 1;
  });

  let bestDay = null;
  let bestDayAvg = -1;
  Object.entries(dayStats).forEach(([day, item]) => {
    if (item.count < 2) return;
    const avg = item.total / item.count;
    if (avg > bestDayAvg) {
      bestDayAvg = avg;
      bestDay = Number(day);
    }
  });

  if (bestDay !== null) {
    insights.bestDay = {
      label: dayNames[bestDay],
      score: Math.round(bestDayAvg),
      recommendation: "Plan revision-heavy sessions on this day.",
    };
    insights.confidence.bestDay = dayStats[bestDay].count;
  }

  const recent = sessions.filter((s) => (s.startTime || 0) >= Date.now() - 7 * 24 * 60 * 60 * 1000);
  const lateSessions = recent.filter((s) => {
    const h = new Date(s.startTime || 0).getHours();
    return h >= 21 || h < 6;
  });
  if (lateSessions.length >= 2) {
    const lateAvg = avgScore(lateSessions) || 0;
    const allAvg = avgScore(recent) || 0;
    if (lateAvg + 6 < allAvg) {
      insights.opportunity = "Opportunity: Late-night sessions are underperforming; shift deep work earlier.";
    }
  }
  if (!insights.opportunity) {
    insights.opportunity = "Opportunity: Keep session timing consistent to improve focus stability.";
  }

  return insights;
}

function computeAnalytics(allSessions, range) {
  const sortedAll = [...allSessions].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const windows = getRangeWindows(range);
  const inRange = windows
    ? sortedAll.filter((s) => (s.startTime || s.endTime || 0) >= windows.currentStart)
    : sortedAll;
  const previousRange = windows
    ? sortedAll.filter((s) => {
        const t = s.startTime || s.endTime || 0;
        return t >= windows.previousStart && t < windows.currentStart;
      })
    : [];

  const todayKey = getDateKey(Date.now());
  const todaySessions = inRange.filter((s) => getDateKey(s.startTime || s.endTime || Date.now()) === todayKey);

  const timeline = buildTimelineSeries(inRange, range);

  const scoreDistribution = {
    high: inRange.filter((s) => (s.focusScore || 0) >= 80).length,
    medium: inRange.filter((s) => (s.focusScore || 0) >= 50 && (s.focusScore || 0) < 80).length,
    low: inRange.filter((s) => (s.focusScore || 0) < 50).length,
  };

  const siteCounts = {};
  inRange.forEach((s) => {
    Object.entries(s.distractingSites || {}).forEach(([domain, count]) => {
      siteCounts[domain] = (siteCounts[domain] || 0) + count;
    });
  });
  const prevSiteCounts = {};
  previousRange.forEach((s) => {
    Object.entries(s.distractingSites || {}).forEach(([domain, count]) => {
      prevSiteCounts[domain] = (prevSiteCounts[domain] || 0) + count;
    });
  });
  const topSites = Object.entries(siteCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, count]) => ({ domain, count, delta: count - (prevSiteCounts[domain] || 0) }));

  let angel = 0;
  let devil = 0;
  inRange.forEach((s) => {
    angel += s.choices?.angel || 0;
    devil += s.choices?.devil || 0;
  });
  let prevAngel = 0;
  let prevDevil = 0;
  previousRange.forEach((s) => {
    prevAngel += s.choices?.angel || 0;
    prevDevil += s.choices?.devil || 0;
  });

  const activeDays14 = countActiveDaysInWindow(sortedAll, 14);

  const bestSession = inRange.length
    ? [...inRange].sort((a, b) => (b.focusScore || 0) - (a.focusScore || 0))[0]
    : null;
  const worstSession = inRange.length
    ? [...inRange].sort((a, b) => {
        const aPenalty = (a.focusScore || 0) - (a.distractions || 0) * 2;
        const bPenalty = (b.focusScore || 0) - (b.distractions || 0) * 2;
        return aPenalty - bPenalty;
      })[0]
    : null;

  const insights = computeInsights(inRange);
  const allStreaks = computeStreaks(sortedAll);

  return {
    sessionsFiltered: inRange,
    today: {
      focusTime: sumDuration(todaySessions),
      sessions: todaySessions.length,
      avgScore: avgScore(todaySessions),
      distractions: sumDistractions(todaySessions),
    },
    period: {
      focusTime: sumDuration(inRange),
      sessions: inRange.length,
      avgScore: avgScore(inRange),
      distractions: sumDistractions(inRange),
    },
    previous: {
      focusTime: sumDuration(previousRange),
      sessions: previousRange.length,
      avgScore: avgScore(previousRange),
      distractions: sumDistractions(previousRange),
    },
    allTime: {
      focusTime: sumDuration(sortedAll),
      sessions: sortedAll.length,
      avgScore: avgScore(sortedAll),
      longestStreak: allStreaks.longestStreak,
    },
    currentStreak: allStreaks.currentStreak,
    weekly: {
      labels: timeline.labels,
      time: timeline.time,
      score: timeline.score,
    },
    chartSubtitles: {
      time: timeline.timeSubtitle,
      score: timeline.scoreSubtitle,
    },
    periodCompare: {
      labels: ["Focus Hours", "Sessions", "Avg Score", "Distractions"],
      current: [
        Number((sumDuration(inRange) / (1000 * 60 * 60)).toFixed(1)),
        inRange.length,
        avgScore(inRange) || 0,
        sumDistractions(inRange),
      ],
      previous: [
        Number((sumDuration(previousRange) / (1000 * 60 * 60)).toFixed(1)),
        previousRange.length,
        avgScore(previousRange) || 0,
        sumDistractions(previousRange),
      ],
    },
    scoreDistribution,
    topSites,
    choices: {
      angel,
      devil,
      prevAngel,
      prevDevil,
    },
    insights,
    consistency14: activeDays14,
    bestSession,
    worstSession,
    range,
  };
}

function renderPeriodCompareChart(compare) {
  const ctx = document.getElementById("chart-period-compare");
  if (!ctx) return;
  if (chartRefs.periodCompare) chartRefs.periodCompare.destroy();

  chartRefs.periodCompare = new Chart(ctx, {
    type: "bar",
    data: {
      labels: compare.labels,
      datasets: [
        {
          label: "Current",
          data: compare.current,
          backgroundColor: "rgba(244, 125, 91, 0.75)",
          borderRadius: 6,
        },
        {
          label: "Previous",
          data: compare.previous,
          backgroundColor: "rgba(171, 171, 171, 0.55)",
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: { boxWidth: 10, color: "#7A7A7A", font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: "#2D2D2D",
          titleFont: { size: 11 },
          bodyFont: { size: 12 },
          padding: 10,
          cornerRadius: 8,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "#ABABAB", font: { size: 11 } },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(240, 237, 233, 0.35)" },
          ticks: { color: "#ABABAB", font: { size: 11 }, maxTicksLimit: 4 },
          border: { display: false },
        },
      },
    },
  });
}

function renderScoreDistributionChart(distribution) {
  const ctx = document.getElementById("chart-score-distribution");
  if (!ctx) return;
  if (chartRefs.scoreDistribution) chartRefs.scoreDistribution.destroy();

  chartRefs.scoreDistribution = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["High (80-100)", "Medium (50-79)", "Low (0-49)"],
      datasets: [
        {
          data: [distribution.high, distribution.medium, distribution.low],
          backgroundColor: ["#6BCF7F", "#FFB880", "#FF6B6B"],
          borderWidth: 0,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        legend: {
          position: "bottom",
          labels: { boxWidth: 10, color: "#7A7A7A", font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: "#2D2D2D",
          titleFont: { size: 11 },
          bodyFont: { size: 12 },
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (context) => {
              const total = context.dataset.data.reduce((sum, value) => sum + value, 0) || 1;
              const value = context.raw || 0;
              const pct = Math.round((value / total) * 100);
              return `${context.label}: ${value} sessions (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function formatDelta(value, suffix = "", invert = false) {
  if (value === null || Number.isNaN(value)) return { text: "--", cls: "delta-neutral" };
  if (value === 0) return { text: `0${suffix}`, cls: "delta-neutral" };
  const positive = value > 0;
  const cls = invert ? (positive ? "delta-neg" : "delta-pos") : positive ? "delta-pos" : "delta-neg";
  const sign = positive ? "+" : "";
  return { text: `${sign}${value}${suffix}`, cls };
}

function formatMinutesDelta(minutes) {
  if (minutes === null || Number.isNaN(minutes)) return { text: "--", cls: "delta-neutral" };
  if (minutes === 0) return { text: "0m", cls: "delta-neutral" };
  const positive = minutes > 0;
  const cls = positive ? "delta-pos" : "delta-neg";
  if (Math.abs(minutes) >= 180) {
    const sign = positive ? "+" : "-";
    return { text: `${sign}${(Math.abs(minutes) / 60).toFixed(1)}h`, cls };
  }
  return { text: `${positive ? "+" : ""}${minutes}m`, cls };
}

function renderWeeklyTimeChart(labels, data) {
  const ctx = document.getElementById("chart-weekly-time");
  if (!ctx) return;
  if (chartRefs.weeklyTime) chartRefs.weeklyTime.destroy();

  const hours = data.map((ms) => ms / (1000 * 60 * 60));
  const gradient = ctx.getContext("2d").createLinearGradient(0, 0, 0, 240);
  gradient.addColorStop(0, "rgba(244, 125, 91, 0.24)");
  gradient.addColorStop(1, "rgba(244, 125, 91, 0.02)");
  const xTickOptions = labels.length <= 8
    ? { color: "#ABABAB", autoSkip: false, font: { size: 11 } }
    : {
        color: "#ABABAB",
        font: { size: 11 },
        autoSkip: false,
        callback: (value, index) => {
          const isLast = index === labels.length - 1;
          return index % 2 === 0 || isLast ? labels[index] : "";
        },
      };

  chartRefs.weeklyTime = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Focus Time (hrs)",
          data: hours,
          borderColor: "#F47D5B",
          backgroundColor: gradient,
          fill: true,
          tension: 0.35,
          pointBackgroundColor: "#F47D5B",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
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
          titleFont: { size: 11 },
          bodyFont: { size: 12 },
          displayColors: false,
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (context) => `Focus: ${formatTime(data[context.dataIndex] || 0)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: xTickOptions,
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(240, 237, 233, 0.35)" },
          ticks: { color: "#ABABAB", callback: (v) => `${Number(v).toFixed(1)}h`, maxTicksLimit: 4, font: { size: 11 } },
          border: { display: false },
        },
      },
    },
  });
}

function renderWeeklyScoreChart(labels, data) {
  const ctx = document.getElementById("chart-weekly-score");
  if (!ctx) return;
  if (chartRefs.weeklyScore) chartRefs.weeklyScore.destroy();

  const xTickOptions = labels.length <= 8
    ? { color: "#ABABAB", autoSkip: false, font: { size: 11 } }
    : {
        color: "#ABABAB",
        font: { size: 11 },
        autoSkip: false,
        callback: (value, index) => {
          const isLast = index === labels.length - 1;
          return index % 2 === 0 || isLast ? labels[index] : "";
        },
      };

  chartRefs.weeklyScore = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: data.map((v) => v ?? 0),
          backgroundColor: data.map((v) => (v === null ? "rgba(240,237,233,0.6)" : v >= 80 ? "rgba(107,207,127,0.7)" : v >= 50 ? "rgba(255,184,128,0.7)" : "rgba(255,107,107,0.7)")),
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
          titleFont: { size: 11 },
          bodyFont: { size: 12 },
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (context) => {
              const score = data[context.dataIndex];
              return score === null ? "No sessions" : `Score: ${score}%`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: xTickOptions,
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: "rgba(240, 237, 233, 0.35)" },
          ticks: { color: "#ABABAB", callback: (v) => `${v}%`, maxTicksLimit: 4, font: { size: 11 } },
          border: { display: false },
        },
      },
    },
  });
}

function renderNav(user, session) {
  const usernameEl = byId("nav-username");
  const avatarEl = byId("nav-avatar");
  const badgeEl = byId("nav-session-badge");
  if (user?.name) {
    if (usernameEl) usernameEl.textContent = user.name;
    if (avatarEl) avatarEl.textContent = user.name.charAt(0).toUpperCase();
  }
  if (badgeEl) badgeEl.style.display = session?.active ? "flex" : "none";
}

function renderHero(user, analytics) {
  const dateEl = byId("hero-date");
  const titleEl = byId("hero-title");
  const subtitleEl = byId("hero-subtitle");
  const streakEl = byId("streak-number");

  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  }
  if (titleEl) titleEl.textContent = `Welcome back, ${user?.name || "there"}`;

  if (subtitleEl) {
    if (!analytics.allTime.sessions) subtitleEl.textContent = "Start your first focus session to see your momentum.";
    else if (state.dataSource === "demo") subtitleEl.textContent = `Demo mode: ${state.persona} persona, ${analytics.range.toUpperCase()} range.`;
    else subtitleEl.textContent = `Tracking ${analytics.range.toUpperCase()} window. ${analytics.period.sessions} sessions in range.`;
  }

  if (streakEl) streakEl.textContent = analytics.currentStreak;
}

function setDelta(elId, value, suffix = "", invert = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  const out = formatDelta(value, suffix, invert);
  el.textContent = out.text;
  el.classList.remove("delta-pos", "delta-neg", "delta-neutral");
  el.classList.add(out.cls);
}

function renderTodayStats(analytics) {
  const focusEl = byId("today-focus-time");
  const sessionsEl = byId("today-sessions");
  const scoreEl = byId("today-score");
  const distractEl = byId("today-distractions");
  if (focusEl) focusEl.textContent = analytics.today.focusTime ? formatTime(analytics.today.focusTime) : "0m";
  if (sessionsEl) sessionsEl.textContent = analytics.today.sessions;
  if (scoreEl) scoreEl.textContent = analytics.today.avgScore !== null ? `${analytics.today.avgScore}%` : "--";
  if (distractEl) distractEl.textContent = analytics.today.distractions;

  const focusDeltaEl = byId("delta-focus");
  if (focusDeltaEl) {
    const focusDelta = Math.round((analytics.period.focusTime - analytics.previous.focusTime) / 60000);
    const out = formatMinutesDelta(focusDelta);
    focusDeltaEl.textContent = out.text;
    focusDeltaEl.classList.remove("delta-pos", "delta-neg", "delta-neutral");
    focusDeltaEl.classList.add(out.cls);
  }
  setDelta("delta-sessions", analytics.period.sessions - analytics.previous.sessions);
  const scoreDelta = analytics.period.avgScore !== null && analytics.previous.avgScore !== null
    ? analytics.period.avgScore - analytics.previous.avgScore
    : null;
  setDelta("delta-score", scoreDelta, "%");
  setDelta("delta-distractions", analytics.period.distractions - analytics.previous.distractions, "", true);
  const consistencyEl = byId("consistency-value");
  if (consistencyEl) consistencyEl.textContent = `${analytics.consistency14}/14 days`;
}

function renderAllTimeStats(analytics) {
  const focusEl = byId("alltime-focus-time");
  const sessionsEl = byId("alltime-sessions");
  const scoreEl = byId("alltime-score");
  const streakEl = byId("alltime-streak");
  if (focusEl) focusEl.textContent = analytics.allTime.focusTime ? formatHours(analytics.allTime.focusTime) : "0h";
  if (sessionsEl) sessionsEl.textContent = analytics.allTime.sessions;
  if (scoreEl) scoreEl.textContent = analytics.allTime.avgScore !== null ? `${analytics.allTime.avgScore}%` : "--";
  if (streakEl) streakEl.textContent = analytics.allTime.longestStreak;
}

function renderTopSites(topSites) {
  const emptyEl = byId("distracting-sites-empty");
  const listEl = byId("distracting-sites-list");
  if (!emptyEl || !listEl) return;
  if (!topSites.length) {
    emptyEl.style.display = "block";
    listEl.style.display = "none";
    return;
  }
  emptyEl.style.display = "none";
  listEl.style.display = "block";

  const maxCount = topSites[0].count;
  listEl.innerHTML = topSites
    .map((row, i) => {
      const trendClass = row.delta > 0 ? "trend-up" : row.delta < 0 ? "trend-down" : "trend-flat";
      const trendText = row.delta > 0 ? `+${row.delta}` : row.delta < 0 ? `${row.delta}` : "0";
      return `
        <div class="distraction-row">
          <div class="distraction-rank">${i + 1}</div>
          <div class="distraction-info">
            <div class="distraction-domain">${escapeHtml(row.domain)}</div>
            <div class="distraction-bar-bg">
              <div class="distraction-bar-fill" style="width:${Math.round((row.count / maxCount) * 100)}%;"></div>
            </div>
          </div>
          <div class="distraction-count">${row.count}x</div>
          <div class="trend-chip ${trendClass}">${trendText}</div>
        </div>
      `;
    })
    .join("");
}

function renderChoices(choices) {
  const total = choices.angel + choices.devil;
  const angelPct = total ? (choices.angel / total) * 100 : 50;
  const devilPct = total ? (choices.devil / total) * 100 : 50;

  const angelCountEl = byId("choices-angel-count");
  const devilCountEl = byId("choices-devil-count");
  const angelBarEl = byId("choices-bar-angel");
  const devilBarEl = byId("choices-bar-devil");
  if (angelCountEl) angelCountEl.textContent = choices.angel;
  if (devilCountEl) devilCountEl.textContent = choices.devil;
  if (angelBarEl) angelBarEl.style.width = `${angelPct}%`;
  if (devilBarEl) devilBarEl.style.width = `${devilPct}%`;

  const summaryEl = byId("choices-summary");
  if (summaryEl) {
    if (!total) summaryEl.textContent = "No intervention choices yet in this range.";
    else summaryEl.textContent = `Angel ${Math.round(angelPct)}% vs Devil ${Math.round(devilPct)}% in selected range.`;
  }

  const prevTotal = choices.prevAngel + choices.prevDevil;
  const prevAngelPct = prevTotal ? (choices.prevAngel / prevTotal) * 100 : null;
  const trendEl = byId("choices-trend-summary");
  if (!trendEl) return;
  if (prevAngelPct === null || !total) {
    trendEl.textContent = "Trend appears once previous period has enough choices.";
  } else {
    const delta = Math.round(angelPct - prevAngelPct);
    trendEl.textContent =
      delta === 0
        ? "Choice trend is stable vs previous period."
        : delta > 0
          ? `Angel choices improved by ${delta} points vs previous period.`
          : `Devil choices increased by ${Math.abs(delta)} points vs previous period.`;
  }
}

function renderSessionHighlights(bestSession, worstSession) {
  const bestEl = byId("best-session-summary");
  const worstEl = byId("improve-session-summary");
  if (!bestEl || !worstEl) return;

  if (!bestSession) {
    bestEl.textContent = "Best session highlight will appear here.";
  } else {
    bestEl.textContent = `Best session: ${bestSession.topic || "Untitled"} (${formatTime(bestSession.duration || 0)}, ${bestSession.focusScore || 0}% focus).`;
  }

  if (!worstSession) {
    worstEl.textContent = "Improvement opportunity will appear here.";
  } else {
    worstEl.textContent = `Improve this pattern: ${worstSession.topic || "Untitled"} had ${worstSession.distractions || 0} distractions with ${worstSession.focusScore || 0}% focus.`;
  }
}

function renderInsights(insights) {
  const setInsight = (idPrefix, value, fallback) => {
    const titleEl = document.getElementById(`insight-${idPrefix}-title`);
    const descEl = document.getElementById(`insight-${idPrefix}-desc`);
    const confEl = document.getElementById(`insight-${idPrefix}-confidence`);
    if (!titleEl || !descEl || !confEl) return;

    if (!value) {
      descEl.textContent = fallback;
      confEl.textContent = "Need at least 2 sessions in this pattern.";
      return;
    }

    if (idPrefix === "best-time") {
      descEl.textContent = `You focus best around ${value.label} (avg ${value.score}%). ${value.recommendation}`;
      confEl.textContent = `Based on ${insights.confidence.bestTime} sessions.`;
    }
    if (idPrefix === "optimal-length") {
      descEl.textContent = `Your strongest block is ${value.label} (avg ${value.score}%). ${value.recommendation}`;
      confEl.textContent = `Based on ${insights.confidence.optimalLength} sessions.`;
    }
    if (idPrefix === "best-day") {
      descEl.textContent = `${value.label} performs best (avg ${value.score}%). ${value.recommendation}`;
      confEl.textContent = `Based on ${insights.confidence.bestDay} sessions.`;
    }
  };

  setInsight("best-time", insights.bestTime, "Complete a few sessions to see your patterns.");
  setInsight("optimal-length", insights.optimalLength, "We'll analyze your data once you have more sessions.");
  setInsight("best-day", insights.bestDay, "Keep studying to unlock day-of-week patterns.");

  const alertEl = document.getElementById("insight-opportunity");
  if (alertEl) alertEl.textContent = insights.opportunity;
}

function buildHistoryTable(sessions) {
  if (!sessions.length) {
    return `<div class="empty-state"><p>No sessions match your current filters.</p></div>`;
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
        ${sessions
          .map((s) => {
            const d = new Date(s.startTime || s.endTime || Date.now());
            const scoreClass = s.focusScore >= 80 ? "high" : s.focusScore >= 50 ? "med" : "low";
            return `
            <tr>
              <td>${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
              <td>${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</td>
              <td class="topic-cell" title="${escapeHtml(s.topic || "")}">${escapeHtml(s.topic || "Untitled")}</td>
              <td>${formatTime(s.duration || 0)}</td>
              <td><span class="score-badge ${scoreClass}">${s.focusScore != null ? `${s.focusScore}%` : "--"}</span></td>
              <td>${s.distractions || 0}</td>
            </tr>
          `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function debounce(fn, delay = 200) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function renderSessionHistory(sessions) {
  const container = byId("history-table-container");
  if (!container) return;
  const emptyEl = byId("history-empty");
  let contentEl = byId("history-table-content");
  if (!contentEl) {
    contentEl = document.createElement("div");
    contentEl.id = "history-table-content";
    container.appendChild(contentEl);
  }
  const sorted = [...sessions].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

  const filtered = state.searchQuery
    ? sorted.filter((s) => (s.topic || "").toLowerCase().includes(state.searchQuery.toLowerCase()))
    : sorted;

  if (!sorted.length) {
    if (emptyEl) emptyEl.style.display = "block";
    contentEl.innerHTML = "";
  } else {
    if (emptyEl) emptyEl.style.display = "none";
    contentEl.innerHTML = buildHistoryTable(filtered);
  }

  const exportBtn = document.getElementById("export-csv-btn");
  if (exportBtn) {
    exportBtn.onclick = () => {
      const headers = ["Date", "Time", "Topic", "Duration (min)", "Focus Score (%)", "Distractions", "Distraction Time (min)"];
      const rows = filtered.map((s) => {
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

      const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `focus-flow-${state.range}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    };
  }
}

function seededRandom(seed) {
  let t = seed + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateDemoSessions(persona) {
  const seed = persona === "new" ? 17 : persona === "active" ? 29 : 53;
  const rand = seededRandom(seed);
  const topics = ["DSA", "DBMS", "OS", "React", "System Design", "Python", "ML"];
  const distractors = ["youtube.com", "instagram.com", "reddit.com", "x.com", "facebook.com"];
  const days = persona === "new" ? 8 : persona === "active" ? 28 : 90;
  const sessionsPerDay = persona === "new" ? [0, 1] : persona === "active" ? [0, 2] : [1, 3];
  const sessions = [];

  for (let d = days - 1; d >= 0; d -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const restProbability = persona === "new" ? 0.5 : persona === "active" ? 0.25 : 0.12;
    const isRestDay = rand() < restProbability;
    const count = isRestDay
      ? 0
      : sessionsPerDay[0] + Math.floor(rand() * (sessionsPerDay[1] - sessionsPerDay[0] + 1));

    for (let i = 0; i < count; i += 1) {
      const start = new Date(date);
      const hourBase = persona === "power" ? 8 : 10;
      start.setHours(hourBase + Math.floor(rand() * 11), Math.floor(rand() * 60), 0, 0);

      const durationMin = persona === "new"
        ? 18 + Math.floor(rand() * 42)
        : persona === "active"
          ? 28 + Math.floor(rand() * 58)
          : 35 + Math.floor(rand() * 80);
      const duration = durationMin * 60000;

      const distractionBase = persona === "new" ? 3 : persona === "active" ? 2 : 1;
      const distractions = Math.max(0, distractionBase + Math.floor(rand() * 5) - 2);
      const weeklyDip = (date.getDay() === 0 || date.getDay() === 6) ? -6 : 0;
      const scoreBase = persona === "new" ? 56 : persona === "active" ? 72 : 84;
      const focusScore = Math.max(32, Math.min(98, scoreBase + weeklyDip + Math.floor(rand() * 18) - distractions * 3));

      const distractingSites = {};
      for (let j = 0; j < distractions; j += 1) {
        const site = distractors[Math.floor(rand() * distractors.length)];
        distractingSites[site] = (distractingSites[site] || 0) + 1;
      }

      const angel = Math.floor(rand() * 3);
      const devil = Math.floor(rand() * 2);

      sessions.push({
        topic: topics[Math.floor(rand() * topics.length)],
        startTime: start.getTime(),
        endTime: start.getTime() + duration,
        duration,
        focusScore,
        distractions,
        distractionTime: distractions * (2 + Math.floor(rand() * 5)) * 60000,
        distractingSites,
        choices: { angel, devil },
      });
    }
  }

  return sessions;
}

const demoSessionsByPersona = {
  new: generateDemoSessions("new"),
  active: generateDemoSessions("active"),
  power: generateDemoSessions("power"),
};

function currentSessions() {
  return state.dataSource === "demo"
    ? demoSessionsByPersona[state.persona] || []
    : state.liveSessions;
}

function getAnalyticsCached() {
  const cacheKey = `${state.dataSource}:${state.persona}:${state.range}`;
  if (!state.analyticsCache.has(cacheKey)) {
    state.analyticsCache.set(cacheKey, computeAnalytics(currentSessions(), state.range));
  }
  return state.analyticsCache.get(cacheKey);
}

function syncControlActiveStyles() {
  document.querySelectorAll("#range-group .control-chip").forEach((el) => {
    el.classList.toggle("active", el.dataset.range === state.range);
  });
  document.querySelectorAll("#data-source-group .control-chip").forEach((el) => {
    el.classList.toggle("active", el.dataset.source === state.dataSource);
  });
  document.querySelectorAll("#persona-group .control-chip").forEach((el) => {
    el.classList.toggle("active", el.dataset.persona === state.persona);
  });

  const personaGroup = document.getElementById("persona-group");
  const demoBadge = document.getElementById("demo-badge");
  if (personaGroup) {
    personaGroup.style.display = state.dataSource === "demo" ? "flex" : "none";
  }
  if (demoBadge) {
    demoBadge.style.display = state.dataSource === "demo" ? "inline-flex" : "none";
  }
}

function getTrendHeading(range) {
  if (range === "30d") return "Monthly Trends";
  if (range === "all") return "Long-Term Trends";
  return "Weekly Trends";
}

function getCompareSubtitle(range) {
  if (range === "30d") return "Current month vs previous month movement";
  if (range === "all") return "Current long-term window vs previous window";
  return "Current week vs previous week movement";
}

function renderAll(user, session) {
  syncControlActiveStyles();
  const analytics = getAnalyticsCached();

  renderNav(user, session);
  renderHero(user, analytics);
  renderTodayStats(analytics);
  renderAllTimeStats(analytics);
  renderTopSites(analytics.topSites);
  renderChoices(analytics.choices);
  renderSessionHighlights(analytics.bestSession, analytics.worstSession);
  renderInsights(analytics.insights);
  renderSessionHistory(analytics.sessionsFiltered);

  const trendsTitle = document.getElementById("trends-section-title");
  if (trendsTitle) {
    trendsTitle.textContent = getTrendHeading(state.range);
  }
  const timeSubtitle = document.getElementById("chart-time-subtitle");
  const scoreSubtitle = document.getElementById("chart-score-subtitle");
  const compareSubtitle = document.getElementById("chart-compare-subtitle");
  if (timeSubtitle) timeSubtitle.textContent = analytics.chartSubtitles.time;
  if (scoreSubtitle) scoreSubtitle.textContent = analytics.chartSubtitles.score;
  if (compareSubtitle) compareSubtitle.textContent = getCompareSubtitle(state.range);

  renderWeeklyTimeChart(analytics.weekly.labels, analytics.weekly.time);
  renderWeeklyScoreChart(analytics.weekly.labels, analytics.weekly.score);
  renderPeriodCompareChart(analytics.periodCompare);
  renderScoreDistributionChart(analytics.scoreDistribution);
}

function setupControls(user, session) {
  document.querySelectorAll("#range-group .control-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.range = btn.dataset.range;
      renderAll(user, session);
    });
  });

  document.querySelectorAll("#data-source-group .control-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.dataSource = btn.dataset.source;
      renderAll(user, session);
    });
  });

  document.querySelectorAll("#persona-group .control-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.persona = btn.dataset.persona;
      renderAll(user, session);
    });
  });

  const searchInput = document.getElementById("history-search");
  if (searchInput) {
    const onInput = debounce((value) => {
      state.searchQuery = value;
      renderSessionHistory(getAnalyticsCached().sessionsFiltered);
    }, 200);
    searchInput.addEventListener("input", () => onInput(searchInput.value.trim()));
  }
}

async function init() {
  const { user, session, sessionHistory = [] } = await chrome.storage.local.get([
    "user",
    "session",
    "sessionHistory",
  ]);

  state.liveSessions = sessionHistory;
  if (sessionHistory.length < 5) {
    state.dataSource = "demo";
    state.persona = "power";
    state.range = "30d";
  }
  setupControls(user, session);
  renderAll(user, session);
}

init();
