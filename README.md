# Drive Music Player

Private web player for audio files stored in a Google Drive folder.

## What it does

- Connects to Google with Drive read-only permission.
- Accepts a Google Drive folder URL or folder ID.
- Lists audio files from that folder.
- Plays tracks in the browser with next, previous, shuffle, repeat, seek, volume, and search.
- Stores only local preferences in the browser. It does not store tokens, music files, or Google credentials in the repo.

## Google setup

The project owner has already configured a Google Cloud project and OAuth Client ID. New users do not need to create a Google Cloud project if the owner gives them the Client ID and the Drive folder is shared with their Google account.

The owner setup is:

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable the Google Drive API.
4. Configure the OAuth consent screen.
5. Create an OAuth 2.0 Client ID with type `Web application`.
6. Add authorized JavaScript origins:
   - Local development: `http://localhost:3000`
   - Deployed app: your production URL
7. Copy the client ID.

The app requests this scope:

```text
https://www.googleapis.com/auth/drive.readonly
```

Your brother can use the same deployed app if the Drive folder is shared with his Google account and the OAuth app allows the deployed origin.

## New user setup

Use these steps if someone else wants to run the player locally.

1. Make sure the Google Drive music folder is shared with their Google account.
2. Send them the OAuth Client ID from the configured Google Cloud project. It looks like `1234567890-abc.apps.googleusercontent.com`.
3. Have them clone the repo:

```bash
git clone https://github.com/igonzarec/drive-music-player.git
cd drive-music-player
```

4. Install and run:

```bash
npm install
npm run dev
```

5. Open `http://localhost:3000`.
6. Paste the OAuth Client ID into `Google OAuth Client ID`.
7. Click `Conectar Google` and accept the Drive read-only permission.
8. Paste the shared Google Drive folder URL.
9. Click `Cargar canciones`.

If the user is outside the owner's Google organization, the owner may need to add that email as a test user or switch the OAuth audience to external.

## Local cache

The player has two cache layers:

1. Temporary cache: every played song stays in memory for the current browser tab, up to 1 GB.
2. Computer cache: if `Keep on device` is enabled, played songs are stored in the browser's IndexedDB.

The computer cache does not store Google tokens or the OAuth Client ID. It only stores the audio blobs and basic track metadata on that browser profile. Use `Borrar guardadas` to remove the saved songs from the computer.

Saved songs can play again after refreshing the page or losing the Google session. To load them without reconnecting Google, keep the same Drive folder URL, keep `Keep on device` enabled, and click `Cargar canciones`.

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
