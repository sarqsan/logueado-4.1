import { initializeApp } from "firebase/app";
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  getDocs, 
  deleteDoc
} from "firebase/firestore";
import { AppState, Property, PropertyDocument } from "../types";

// Firebase Client Configuration
const firebaseConfig = {
  projectId: "startup-sanctuary-sln7n",
  appId: "1:590446652750:web:cfe218b502b4fe8846421f",
  apiKey: "AIzaSyBxspQVfcvexPuyioGwNLiWxxLYnDuY58M",
  authDomain: "startup-sanctuary-sln7n.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-remixlogeado41-69a7dc5e-eeca-458d-b8f9-6c6b275abc58",
  storageBucket: "startup-sanctuary-sln7n.firebasestorage.app",
  messagingSenderId: "590446652750"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

/**
 * Gets a unique device ID to sync anonymous/local sessions
 */
export function getOrCreateDeviceId(): string {
  let devId = localStorage.getItem("rentasync_device_id");
  if (!devId) {
    devId = `device_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`;
    localStorage.setItem("rentasync_device_id", devId);
  }
  return devId;
}

/**
 * Syncs the AppState and heavy documents to Firebase Firestore.
 * To optimize Firestore document size (< 1MB), we strip the heavy `fileData` (Base64)
 * from the properties/documents array, store them in a subcollection, and store
 * the rest of the metadata in a single clean document.
 */
export async function syncStateToFirebase(state: AppState): Promise<void> {
  try {
    const isAuth = !!state.isAuthenticated && !!state.currentUser;
    const userId = isAuth ? state.currentUser! : getOrCreateDeviceId();
    const parentPath = isAuth ? "users" : "anonymous";

    // 1. Extract documents with fileData to save them separately
    const documentsToSync: { propId: string; doc: PropertyDocument }[] = [];
    const sanitizedProperties: Property[] = (state.properties || []).map((prop) => {
      const sanitizedDocs = (prop.documents || []).map((d) => {
        if (d.fileData) {
          documentsToSync.push({ propId: prop.id, doc: d });
        }
        // Save the metadata without the heavy base64 fileData in the main state
        const { fileData, ...metadata } = d;
        return metadata as PropertyDocument;
      });

      return {
        ...prop,
        documents: sanitizedDocs
      };
    });

    // 2. Prepare the clean state for upload
    const cleanState: Partial<AppState> = {
      user1: state.user1,
      user2: state.user2,
      properties: sanitizedProperties,
      payments: state.payments || [],
      expenses: state.expenses || [],
      syncEvents: state.syncEvents || [],
      syncEnabled: state.syncEnabled,
      isOnboarded: state.isOnboarded,
      currentUser: state.currentUser || "",
      theme: state.theme || "slate-indigo",
      currentYear: state.currentYear || 2026,
      yearlyProfiles: state.yearlyProfiles || {}
    };

    // 3. Save clean state metadata
    const stateDocRef = doc(db, parentPath, userId, "data", "state");
    await setDoc(stateDocRef, {
      ...cleanState,
      lastSyncedAt: new Date().toISOString()
    }, { merge: true });

    // 4. Save heavy documents in parallel in the subcollection
    for (const item of documentsToSync) {
      const docRef = doc(db, parentPath, userId, "uploaded_documents", `${item.propId}_${item.doc.id}`);
      await setDoc(docRef, {
        id: item.doc.id,
        propertyId: item.propId,
        name: item.doc.name,
        size: item.doc.size,
        type: item.doc.type,
        category: item.doc.category,
        year: item.doc.year,
        uploadDate: item.doc.uploadDate,
        fileData: item.doc.fileData // full Base64
      });
    }

    console.log(`Cloud sync successful for ${parentPath}/${userId}`);
  } catch (error) {
    console.error("Error syncing state to Firebase:", error);
  }
}

/**
 * Loads the saved state and merges it with any saved heavy files from Firebase Firestore.
 */
export async function loadStateFromFirebase(state: AppState): Promise<AppState | null> {
  try {
    const isAuth = !!state.isAuthenticated && !!state.currentUser;
    const userId = isAuth ? state.currentUser! : getOrCreateDeviceId();
    const parentPath = isAuth ? "users" : "anonymous";

    // 1. Fetch main state metadata
    const stateDocRef = doc(db, parentPath, userId, "data", "state");
    const stateSnap = await getDoc(stateDocRef);

    if (!stateSnap.exists()) {
      return null;
    }

    const cloudData = stateSnap.data() as AppState;

    // 2. Fetch all uploaded documents from the subcollection to restore fileData Base64
    const docsCollRef = collection(db, parentPath, userId, "uploaded_documents");
    const docsSnap = await getDocs(docsCollRef);
    
    const docsMap: Record<string, PropertyDocument> = {};
    docsSnap.forEach((dDoc) => {
      const dData = dDoc.data();
      docsMap[`${dData.propertyId}_${dData.id}`] = {
        id: dData.id,
        name: dData.name,
        size: dData.size,
        type: dData.type,
        category: dData.category,
        year: dData.year,
        uploadDate: dData.uploadDate,
        fileData: dData.fileData
      };
    });

    // 3. Restore the full documents array with base64 fileData
    if (cloudData.properties) {
      cloudData.properties = cloudData.properties.map((prop) => {
        const restoredDocs = (prop.documents || []).map((d) => {
          const restored = docsMap[`${prop.id}_${d.id}`];
          return restored ? restored : d;
        });

        return {
          ...prop,
          documents: restoredDocs
        };
      });
    }

    return {
      ...state,
      ...cloudData,
      isAuthenticated: isAuth,
      currentUser: state.currentUser
    };
  } catch (error) {
    console.error("Error loading state from Firebase:", error);
    return null;
  }
}

/**
 * Utility to get the correct API endpoint, routing to Cloud Run backend
 * when the app is running on GitHub Pages or other external static hosting.
 */
export function getApiUrl(path: string): string {
  const hostname = window.location.hostname;
  if (
    hostname.includes("github.io") || 
    hostname.includes("vercel.app") || 
    hostname.includes("pages.dev") || 
    hostname.includes("netlify.app")
  ) {
    const backendBase = "https://ais-pre-cou4hef2wa6lyapbvmyaqy-188021975467.europe-west1.run.app";
    // Strip leading slash if any
    const cleanPath = path.startsWith("/") ? path.substring(1) : path;
    return `${backendBase}/${cleanPath}`;
  }
  return path;
}
