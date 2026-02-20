// ===== Focus Flow - Auth Module =====
// Email/password authentication with Firebase Auth
// JWT tokens managed by Firebase, session state stored in chrome.storage.local

import { auth } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";

// ===== Auth State Management =====

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
