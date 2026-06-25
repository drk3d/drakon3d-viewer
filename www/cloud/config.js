// cloud/config.js — credentials for cloud storage providers.
//
// All three values below are domain-scoped public identifiers. They are safe
// to ship in client code AS LONG AS the corresponding console has the
// allowed JavaScript origin restricted to your domain. Replace each empty
// string with the value from the provider's console.
//
// ──────────────────────────────────────────────────────────────────────────
// Google Drive
//   1. Create a project at https://console.cloud.google.com/
//   2. APIs & Services → Enable APIs → enable "Google Drive API" and
//      "Google Picker API".
//   3. APIs & Services → Credentials → "+ CREATE CREDENTIALS"
//        a. API Key — leave "Application restrictions" set to "None".
//           Do NOT use HTTP referrer restrictions: Google Picker loads
//           inside a docs.google.com iframe and does not reliably forward
//           the parent page's Referer header, so referrer-restricted keys
//           get rejected with "The API developer key is invalid."
//           Secure the key via "API restrictions" instead — limit it to
//           exactly: Google Drive API + Google Picker API. With those two
//           restrictions the key cannot be abused for anything else, and
//           Drive data access still requires an OAuth token per user.
//        b. OAuth client ID → Application type: Web application
//             Authorized JavaScript origins:
//               https://www.plusplastic.com
//               http://localhost:5173   (or whatever you use locally)
//             Authorized redirect URIs (only required if you ever leave the
//             implicit/token flow — GIS token client does not need one):
//               https://www.plusplastic.com/byRhinoView/
//   4. OAuth consent screen — add 'drive.file' scope; for production add
//      your logo and homepage URL. drive.file is non-sensitive so no
//      verification is required beyond brand info.
// ──────────────────────────────────────────────────────────────────────────
export const GOOGLE_CLIENT_ID = '795850727996-981q7t4r52qtd0pgibk593l15im8n3o2.apps.googleusercontent.com';   // e.g. '1234-abc.apps.googleusercontent.com'
export const GOOGLE_API_KEY   = 'AIzaSyBmVo4EBPnjfMYdr-dNnx8GlKb20HQWZuI';   // e.g. 'AIzaSy…'
export const GOOGLE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';

// ──────────────────────────────────────────────────────────────────────────
// OneDrive (Microsoft Identity Platform)
//   1. Register at https://entra.microsoft.com → App registrations → New
//      registration → Supported account types: "Personal Microsoft accounts
//      and work/school accounts" (multi-tenant + personal).
//   2. Authentication → Add a platform → Single-page application
//      Redirect URI:
//        https://www.plusplastic.com/byRhinoView/
//        http://localhost:5173/   (dev)
//   3. API permissions → Microsoft Graph → Delegated → Files.Read → Grant.
//   4. Copy the Application (client) ID below.
// ──────────────────────────────────────────────────────────────────────────
export const ONEDRIVE_CLIENT_ID = '9438b685-6087-4545-b2dd-3e1e3011bcd5';   // e.g. '12345678-1234-1234-1234-1234567890ab'

// ──────────────────────────────────────────────────────────────────────────
// Dropbox
//   1. https://www.dropbox.com/developers/apps → Create app
//        Choose: Scoped access · App folder OR Full Dropbox · name it.
//   2. Settings tab → "Chooser/Saver/Embedder domains" → add:
//        www.plusplastic.com
//        localhost   (dev)
//   3. Permissions tab → enable files.metadata.read + files.content.read
//      → Submit.
//   4. Copy the App key below.
// ──────────────────────────────────────────────────────────────────────────
export const DROPBOX_APP_KEY = 'asva3kpyp805xdc';   // e.g. 'abcd1234efgh5678'

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
