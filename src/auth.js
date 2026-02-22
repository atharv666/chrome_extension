// ===== Focus Flow - Auth Module =====
// Email/password authentication with Firebase Auth
// JWT tokens managed by Firebase, session state stored in chrome.storage.local

import { auth } from "./firebase.js";
import "./webext-compat.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";

// ===== Auth State Management =====

// Promise that resolves once Firebase Auth has determined the initial auth state.
// auth.currentUser is null until onAuthStateChanged fires for the first time.
let _authReady;
const _authReadyPromise = new Promise((resolve) => {
  _authReady = resolve;
});

// Persist auth state to chrome.storage so background/content scripts can access it
async function persistAuthState(user) {
  if (user) {
    const token = await user.getIdToken();
    await chrome.storage.local.set({
      authUser: {
        uid: user.uid,
        email: user.email,
        token: token,
        lastRefresh: Date.now(),
      },
    });
  } else {
    await chrome.storage.local.remove(["authUser"]);
  }
}

// Listen for auth state changes and persist
onAuthStateChanged(auth, (user) => {
  persistAuthState(user);
  _authReady(); // resolve on first (and every subsequent) call
});

// ===== Public API =====

/**
 * Register a new user with email and password.
 * Returns { success, user?, error? }
 */
export async function register(email, password) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await persistAuthState(cred.user);
    return { success: true, user: cred.user };
  } catch (err) {
    return { success: false, error: friendlyError(err.code) };
  }
}

/**
 * Sign in with email and password.
 * Returns { success, user?, error? }
 */
export async function login(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await persistAuthState(cred.user);
    return { success: true, user: cred.user };
  } catch (err) {
    return { success: false, error: friendlyError(err.code) };
  }
}

/**
 * Sign out the current user.
 */
export async function logout() {
  await signOut(auth);
  await chrome.storage.local.remove(["authUser", "user", "session"]);
}

/**
 * Get current Firebase user (null if not signed in).
 */
export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Wait for Firebase Auth to finish initializing.
 * Resolves with the current user (or null if not signed in).
 * Must be awaited before calling getCurrentUser() or any sync.js function.
 */
export async function waitForAuth() {
  await _authReadyPromise;
  return auth.currentUser;
}

/**
 * Get a fresh ID token (auto-refreshes if expired).
 */
export async function getToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken(true);
}

/**
 * Check if user is authenticated (from chrome.storage — works without Firebase loaded).
 */
export async function isAuthenticated() {
  const { authUser } = await chrome.storage.local.get(["authUser"]);
  return !!authUser;
}

// ===== Error Messages =====

function friendlyError(code) {
  const map = {
    "auth/email-already-in-use": "An account with this email already exists.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect password. Please try again.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Network error. Check your connection.",
  };
  return map[code] || "Something went wrong. Please try again.";
}
