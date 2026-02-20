// ===== Focus Flow - Firebase Configuration =====

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBShjWSNLwVOiaGh34ei7NlVe2uXSC8g2E",
  authDomain: "focus-a5e5c.firebaseapp.com",
  projectId: "focus-a5e5c",
  storageBucket: "focus-a5e5c.firebasestorage.app",
  messagingSenderId: "245416282683",
  appId: "1:245416282683:web:54dfc1ac47dcd5406caa1e",
  measurementId: "G-8GJDKGNPD2",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
