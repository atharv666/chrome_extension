// ===== Focus Flow - Firestore Sync Module =====
// Syncs user profile and session history to Firestore

import { db } from "./firebase.js";
import { getCurrentUser } from "./auth.js";
import {
  doc,
  setDoc,
  getDoc,
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
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
