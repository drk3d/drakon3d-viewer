// cloud/config.js — credentials for cloud storage providers.
//
// All three values below are domain-scoped public identifiers. They are safe
// to ship in client code only when the corresponding console restricts the
// allowed JavaScript origin to viewer.drakon3d.com. Replace each empty string
// with a Drakon-owned value from the provider's console.
//
// ──────────────────────────────────────────────────────────────────────────
// Google Drive
//   1. Create a project at https://console.cloud.google.com/
//   2. APIs & Services → Enable APIs → enable "Google Drive API" and
//      "Google Picker API".
//   3. APIs & Services → Credentials → "+ CREATE CREDENTIALS"
//        a. API Key — restrict it to Websites:
//             https://viewer.drakon3d.com/*
//             https://docs.google.com/*
//           Google Picker runs within a docs.google.com iframe, so it must
//           be included alongside the viewer origin. Also apply API
//           restrictions to exactly Google Drive API + Google Picker API.
//           Drive data access still requires a per-user OAuth token.
//        b. OAuth client ID → Application type: Web application
//             Authorized JavaScript origins:
//               https://viewer.drakon3d.com
//               http://localhost:5173   (or whatever you use locally)
//             Authorized redirect URIs (only required if you ever leave the
//             implicit/token flow — GIS token client does not need one):
//               https://viewer.drakon3d.com/
//   4. OAuth consent screen — add 'drive.file' scope; for production add
//      your logo and homepage URL. drive.file is non-sensitive so no
//      verification is required beyond brand info.
// ──────────────────────────────────────────────────────────────────────────
export const GOOGLE_CLIENT_ID = '';   // e.g. '1234-abc.apps.googleusercontent.com'
export const GOOGLE_API_KEY   = '';   // e.g. 'AIzaSy…'
export const GOOGLE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';

// ──────────────────────────────────────────────────────────────────────────
// OneDrive (Microsoft Identity Platform)
//   1. Register at https://entra.microsoft.com → App registrations → New
//      registration → Supported account types: "Personal Microsoft accounts
//      and work/school accounts" (multi-tenant + personal).
//   2. Authentication → Add a platform → Single-page application
//      Redirect URI:
//        https://viewer.drakon3d.com/
//        http://localhost:5173/   (dev)
//   3. API permissions → Microsoft Graph → Delegated → Files.Read → Grant.
//   4. Copy the Application (client) ID below.
// ──────────────────────────────────────────────────────────────────────────
export const ONEDRIVE_CLIENT_ID = '';   // e.g. '12345678-1234-1234-1234-1234567890ab'

// ──────────────────────────────────────────────────────────────────────────
// Dropbox
//   1. https://www.dropbox.com/developers/apps → Create app
//        Choose: Scoped access · App folder OR Full Dropbox · name it.
//   2. Settings tab → "Chooser/Saver/Embedder domains" → add:
//        viewer.drakon3d.com
//        localhost   (dev)
//   3. Permissions tab → enable files.metadata.read + files.content.read
//      → Submit.
//   4. Copy the App key below.
// ──────────────────────────────────────────────────────────────────────────
export const DROPBOX_APP_KEY = '';   // e.g. 'abcd1234efgh5678'

// Extensions exposed in the cloud pickers. Keep in sync with
// loaders.js → handleFile() supportedExtensions.
export const SUPPORTED_EXTENSIONS = [
  '.3dm', '.glb', '.gltf', '.stl', '.3mf',
  '.stp', '.step', '.iges', '.igs', '.rhv',
];

export function isConfigured(provider) {
  switch (provider) {
    case 'google':   return !!(GOOGLE_CLIENT_ID && GOOGLE_API_KEY);
    case 'onedrive': return !!ONEDRIVE_CLIENT_ID;
    case 'dropbox':  return !!DROPBOX_APP_KEY;
    default: return false;
  }
}
