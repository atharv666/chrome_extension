// Firestore Security Rules for Focus Flow
// Deploy these in the Firebase Console → Firestore → Rules
//
// These rules ensure:
// 1. Users can only read/write their own data
// 2. User profiles and session history are scoped by UID
// 3. No unauthenticated access
// 4. currentSessionId field on user doc tracks active sessions across devices

/*
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // User profiles: only the owner can read/write
    // Includes currentSessionId field for cross-device session tracking
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      // Session history: nested under user document
      // Sessions are created, updated, and read by the extension and phone app
      match /sessions/{sessionId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }

    // Deny everything else
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
*/
