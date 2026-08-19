# Drive Music Player

Private web player for audio files stored in a Google Drive folder.

## What it does

- Connects to Google with Drive read-only permission.
- Accepts a Google Drive folder URL or folder ID.
- Lists audio files from that folder.
- Plays tracks in the browser with next, previous, shuffle, repeat, seek, volume, and search.
- Stores only local preferences in the browser. It does not store tokens, music files, or Google credentials in the repo.

## Google setup

Create one Google OAuth Client ID for the deployed app.

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable the Google Drive API.
4. Configure the OAuth consent screen.
5. Create an OAuth 2.0 Client ID with type `Web application`.
6. Add authorized JavaScript origins:
   - Local development: `http://localhost:5173`
   - Deployed app: your production URL
7. Copy the client ID.

The app requests this scope:

```text
https://www.googleapis.com/auth/drive.readonly
```

Your brother can use the same deployed app if the Drive folder is shared with his Google account and the OAuth app allows the deployed origin.

## Local development

Create `.env.local` from the example file:

```bash
cp .env.example .env.local
```

Set:

```text
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

Install and run:

```bash
npm install
npm run dev
```

Open the local URL shown in the terminal.

If no environment variable is configured, the app lets you paste the Client ID directly in the UI and saves it in your browser.

## Deployment notes

When deploying, set `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in the hosting environment and add that hosting origin to the OAuth Client ID in Google Cloud.

Do not commit `.env.local`.
