// ===== Focus Flow - Firestore Sync Module =====
// Syncs user profile, session history, and active sessions to Firestore

import { db } from "./firebase.js";
import { getCurrentUser } from "./auth.js";
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteField,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";

// ===== User Profile =====

/**
 * Save/update user profile to Firestore.
 */
export async function saveUserProfile(profile) {
  const user = getCurrentUser();
  if (!user) return;

  await setDoc(
    doc(db, "users", user.uid),
    {
      name: profile.name,
      college: profile.college || "",
      course: profile.course || "",
      year: profile.year || "",
      email: user.email,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Load user profile from Firestore.
 * Returns the profile object or null.
 */
export async function loadUserProfile() {
  const user = getCurrentUser();
  if (!user) return null;

  const snap = await getDoc(doc(db, "users", user.uid));
  return snap.exists() ? snap.data() : null;
}

// ===== Session History =====

/**
 * Save a completed session to Firestore.
 */
export async function saveSessionToCloud(sessionData) {
  const user = getCurrentUser();
  if (!user) return;

  await addDoc(collection(db, "users", user.uid, "sessions"), {
    topic: sessionData.topic,
    duration: sessionData.duration,
    startTime: sessionData.startTime,
    endTime: sessionData.endTime,
    focusScore: sessionData.focusScore,
    distractions: sessionData.distractions,
    distractionTime: sessionData.distractionTime,
    distractingSites: sessionData.distractingSites || {},
    choices: sessionData.choices || { angel: 0, devil: 0 },
    createdAt: serverTimestamp(),
  });
}

/**
 * Load recent sessions from Firestore.
 * Returns array of session objects (most recent first).
 */
export async function loadSessionHistory(count = 50) {
  const user = getCurrentUser();
  if (!user) return [];

  const q = query(
    collection(db, "users", user.uid, "sessions"),
    orderBy("createdAt", "desc"),
    limit(count)
  );

  const snap = await getDocs(q);
  return snap.docs.map((d) => normalizeSessionDoc(d));
}

/**
 * Load ALL session history from Firestore (no limit).
 * Used by dashboard and popup history for full cross-device data.
 * Returns array of session objects with normalized timestamps (most recent first).
 */
export async function loadAllSessionHistory() {
  const user = getCurrentUser();
  if (!user) return [];

  const q = query(
    collection(db, "users", user.uid, "sessions"),
    orderBy("createdAt", "desc")
  );

  const snap = await getDocs(q);
  return snap.docs.map((d) => normalizeSessionDoc(d));
}

/**
 * Normalize a Firestore session document snapshot.
 * Converts Firestore Timestamp objects to milliseconds and ensures consistent shape.
 */
function normalizeSessionDoc(docSnap) {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    topic: data.topic || "",
    duration: data.duration || 0,
    startTime: toMillis(data.startTime),
    endTime: toMillis(data.endTime),
    focusScore: data.focusScore != null ? data.focusScore : 100,
    distractions: data.distractions || 0,
    distractionTime: data.distractionTime || 0,
    distractingSites: data.distractingSites || {},
    choices: data.choices || { angel: 0, devil: 0 },
    allowedSites: data.allowedSites || [],
    createdAt: toMillis(data.createdAt),
  };
}

/**
 * Convert a value to milliseconds.
 * Handles Firestore Timestamp objects, plain numbers, and null/undefined.
 */
function toMillis(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value.seconds != null) return value.seconds * 1000 + (value.nanoseconds || 0) / 1e6;
  return null;
}

// ===== Active Session Sync =====

/**
 * STALE_SESSION_HOURS: Sessions older than this are auto-ended.
 */
const STALE_SESSION_HOURS = 24;

/**
 * Create a new active session in Firestore and set currentSessionId on user doc.
 * Returns the auto-generated session document ID.
 */
export async function createActiveSession(sessionData) {
  const user = getCurrentUser();
  if (!user) return null;

  // Create session document with auto-generated ID
  const sessionRef = await addDoc(
    collection(db, "users", user.uid, "sessions"),
    {
      topic: sessionData.topic || "",
      allowedSites: sessionData.allowedSites || [],
      startTime: sessionData.startTime,
      endTime: null,
      duration: 0,
      focusScore: 100,
      distractions: 0,
      distractionTime: 0,
      distractingSites: {},
      choices: { angel: 0, devil: 0 },
      createdAt: serverTimestamp(),
    }
  );

  // Set currentSessionId on user document
  await setDoc(
    doc(db, "users", user.uid),
    { currentSessionId: sessionRef.id },
    { merge: true }
  );

  return sessionRef.id;
}

/**
 * Update an active session's stats in Firestore.
 * Called periodically (every 2 minutes) during a session.
 */
export async function updateActiveSession(sessionId, updates) {
  const user = getCurrentUser();
  if (!user || !sessionId) return;

  await updateDoc(doc(db, "users", user.uid, "sessions", sessionId), {
    duration: updates.duration || 0,
    distractions: updates.distractions || 0,
    distractionTime: updates.distractionTime || 0,
    distractingSites: updates.distractingSites || {},
    choices: updates.choices || { angel: 0, devil: 0 },
    focusScore: updates.focusScore != null ? updates.focusScore : 100,
  });
}

/**
 * End an active session in Firestore: update final stats and clear currentSessionId.
 */
export async function endActiveSession(sessionId, finalData) {
  const user = getCurrentUser();
  if (!user || !sessionId) return;

  // Update session document with final stats
  await updateDoc(doc(db, "users", user.uid, "sessions", sessionId), {
    topic: finalData.topic || "",
    duration: finalData.duration || 0,
    startTime: finalData.startTime,
    endTime: finalData.endTime || Date.now(),
    focusScore: finalData.focusScore != null ? finalData.focusScore : 100,
    distractions: finalData.distractions || 0,
    distractionTime: finalData.distractionTime || 0,
    distractingSites: finalData.distractingSites || {},
    choices: finalData.choices || { angel: 0, devil: 0 },
  });

  // Clear currentSessionId on user document
  await updateDoc(doc(db, "users", user.uid), {
    currentSessionId: deleteField(),
  });
}

/**
 * Get the currentSessionId from the user document.
 * Returns the session ID string, or null if none.
 */
export async function getCurrentSessionId() {
  const user = getCurrentUser();
  if (!user) return null;

  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) return null;

  return snap.data().currentSessionId || null;
}

/**
 * Load an active session's data from Firestore by session ID.
 * Returns session data object or null.
 */
export async function loadActiveSession(sessionId) {
  const user = getCurrentUser();
  if (!user || !sessionId) return null;

  const snap = await getDoc(
    doc(db, "users", user.uid, "sessions", sessionId)
  );
  if (!snap.exists()) return null;

  return { id: snap.id, ...snap.data() };
}

/**
 * Clear a stale currentSessionId from the user document.
 * Optionally marks the session as ended with current timestamp.
 */
export async function clearStaleSession(sessionId) {
  const user = getCurrentUser();
  if (!user) return;

  // Try to end the stale session document
  if (sessionId) {
    try {
      const sessionSnap = await getDoc(
        doc(db, "users", user.uid, "sessions", sessionId)
      );
      if (sessionSnap.exists()) {
        const data = sessionSnap.data();
        await updateDoc(
          doc(db, "users", user.uid, "sessions", sessionId),
          {
            endTime: data.startTime ? data.startTime + (data.duration || 0) : Date.now(),
            duration: data.duration || 0,
          }
        );
      }
    } catch (e) {
      console.warn("Focus Flow: failed to end stale session document", e);
    }
  }

  // Clear currentSessionId
  await updateDoc(doc(db, "users", user.uid), {
    currentSessionId: deleteField(),
  });
}

/**
 * Check if a session is stale (older than STALE_SESSION_HOURS).
 */
export function isSessionStale(startTime) {
  if (!startTime) return true;
  const ageMs = Date.now() - startTime;
  return ageMs > STALE_SESSION_HOURS * 60 * 60 * 1000;
}
