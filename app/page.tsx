"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
};

type TokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

type GoogleIdentity = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: { access_token?: string; error?: string }) => void;
      }) => TokenClient;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const CLIENT_ID_STORAGE_KEY = "drive-player-client-id";
const FOLDER_STORAGE_KEY = "drive-player-folder-url";
const VOLUME_STORAGE_KEY = "drive-player-volume";

function extractFolderId(input: string) {
  const trimmed = input.trim();

  if (!trimmed) {
    return "";
  }

  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch?.[1]) {
    return folderMatch[1];
  }

  try {
    const url = new URL(trimmed);
    const id = url.searchParams.get("id");
    if (id) {
      return id;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

function formatSize(size?: string) {
  if (!size) {
    return "";
  }

  const bytes = Number(size);
  if (!Number.isFinite(bytes)) {
    return "";
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number) {
  if (!Number.isFinite(value)) {
    return "0:00";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function getTrackTitle(name: string) {
  return name.replace(/\.[^/.]+$/, "");
}

function buildDriveQuery(folderId: string) {
  const escapedFolderId = folderId.replace(/'/g, "\\'");
  return [
    `'${escapedFolderId}' in parents`,
    "trashed = false",
    "(mimeType contains 'audio/' or name contains '.mp3' or name contains '.wav' or name contains '.m4a' or name contains '.ogg')",
  ].join(" and ");
}

export default function Home() {
  const configuredClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tokenClientRef = useRef<TokenClient | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const [clientId, setClientId] = useState(configuredClientId);
  const [folderUrl, setFolderUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [tracks, setTracks] = useState<DriveFile[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isGoogleReady, setIsGoogleReady] = useState(false);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("all");
  const [query, setQuery] = useState("");
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [status, setStatus] = useState("Pega una URL de carpeta de Drive para empezar.");
  const [error, setError] = useState("");

  const currentTrack = tracks[currentIndex];

  const filteredTracks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return tracks;
    }

    return tracks.filter((track) => track.name.toLowerCase().includes(needle));
  }, [query, tracks]);

  useEffect(() => {
    setClientId(configuredClientId || localStorage.getItem(CLIENT_ID_STORAGE_KEY) || "");
    setFolderUrl(localStorage.getItem(FOLDER_STORAGE_KEY) || "");

    const savedVolume = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
    if (audioRef.current && Number.isFinite(savedVolume)) {
      audioRef.current.volume = savedVolume;
    }
  }, [configuredClientId]);

  useEffect(() => {
    const scriptId = "google-identity-services";
    const existingScript = document.getElementById(scriptId);

    if (window.google?.accounts?.oauth2) {
      setIsGoogleReady(true);
      return;
    }

    const script = existingScript ?? document.createElement("script");
    script.id = scriptId;
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => setIsGoogleReady(true);
    script.onerror = () => setError("No se pudo cargar Google Identity Services.");

    if (!existingScript) {
      document.body.appendChild(script);
    }
  }, []);

  useEffect(() => {
    if (!isGoogleReady || !clientId || !window.google?.accounts?.oauth2) {
      tokenClientRef.current = null;
      return;
    }

    tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          setError("Google no devolvio un token de acceso.");
          return;
        }

        setAccessToken(response.access_token);
        setStatus("Conectado a Google Drive.");
        setError("");
      },
    });
  }, [clientId, isGoogleReady]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  async function connectGoogle() {
    setError("");

    if (!clientId.trim()) {
      setError("Configura un Google OAuth Client ID antes de conectar.");
      return;
    }

    localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId.trim());

    if (!tokenClientRef.current) {
      setError("Google todavia no esta listo. Espera unos segundos e intenta otra vez.");
      return;
    }

    tokenClientRef.current.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  }

  async function loadFolder(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setError("");

    const folderId = extractFolderId(folderUrl);
    if (!folderId) {
      setError("Pega la URL de una carpeta de Google Drive.");
      return;
    }

    if (!accessToken) {
      setError("Primero conecta tu cuenta de Google.");
      return;
    }

    localStorage.setItem(FOLDER_STORAGE_KEY, folderUrl.trim());
    setIsLoadingTracks(true);
    setStatus("Leyendo canciones de Drive...");

    try {
      const params = new URLSearchParams({
        q: buildDriveQuery(folderId),
        fields: "files(id,name,mimeType,size,modifiedTime)",
        orderBy: "name",
        pageSize: "1000",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
      });

      const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Drive respondio con ${response.status}`);
      }

      const data = (await response.json()) as { files?: DriveFile[] };
      const files = data.files ?? [];
      setTracks(files);
      setCurrentIndex(0);
      setPosition(0);
      setDuration(0);
      setStatus(files.length ? `${files.length} canciones listas.` : "No encontre archivos de audio en esa carpeta.");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo leer la carpeta.");
      setStatus("No se pudo cargar la carpeta.");
    } finally {
      setIsLoadingTracks(false);
    }
  }

  async function prepareTrack(track: DriveFile) {
    if (!accessToken) {
      throw new Error("Falta conectar Google.");
    }

    setIsLoadingAudio(true);
    setStatus(`Cargando ${track.name}...`);

    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${track.id}?alt=media`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`No se pudo cargar el audio (${response.status}).`);
    }

    const blob = await response.blob();
    const nextUrl = URL.createObjectURL(blob);

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }

    objectUrlRef.current = nextUrl;

    if (audioRef.current) {
      audioRef.current.src = nextUrl;
      audioRef.current.load();
    }

    setIsLoadingAudio(false);
    setStatus(`Listo: ${track.name}`);
  }

  async function playTrack(index: number) {
    const track = tracks[index];
    if (!track || !audioRef.current) {
      return;
    }

    setError("");
    setCurrentIndex(index);

    try {
      await prepareTrack(track);
      await audioRef.current.play();
      setIsPlaying(true);
    } catch (playError) {
      setIsLoadingAudio(false);
      setIsPlaying(false);
      setError(playError instanceof Error ? playError.message : "No se pudo reproducir la cancion.");
    }
  }

  async function togglePlayback() {
    if (!audioRef.current) {
      return;
    }

    if (!currentTrack) {
      if (tracks[0]) {
        await playTrack(0);
      }
      return;
    }

    if (!audioRef.current.src) {
      await playTrack(currentIndex);
      return;
    }

    if (audioRef.current.paused) {
      await audioRef.current.play();
      setIsPlaying(true);
    } else {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }

  function getNextIndex() {
    if (!tracks.length) {
      return -1;
    }

    if (repeat === "one") {
      return currentIndex;
    }

    if (shuffle && tracks.length > 1) {
      let next = currentIndex;
      while (next === currentIndex) {
        next = Math.floor(Math.random() * tracks.length);
      }
      return next;
    }

    const next = currentIndex + 1;
    if (next < tracks.length) {
      return next;
    }

    return repeat === "all" ? 0 : -1;
  }

  function getPreviousIndex() {
    if (!tracks.length) {
      return -1;
    }

    if (position > 5 && audioRef.current) {
      audioRef.current.currentTime = 0;
      return currentIndex;
    }

    const previous = currentIndex - 1;
    return previous >= 0 ? previous : tracks.length - 1;
  }

  async function playNext() {
    const next = getNextIndex();
    if (next >= 0) {
      await playTrack(next);
    } else {
      setIsPlaying(false);
    }
  }

  async function playPrevious() {
    const previous = getPreviousIndex();
    if (previous >= 0 && previous !== currentIndex) {
      await playTrack(previous);
    }
  }

  function handleVolumeChange(value: string) {
    const volume = Number(value);
    if (!audioRef.current || !Number.isFinite(volume)) {
      return;
    }

    audioRef.current.volume = volume;
    localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
  }

  function seek(value: string) {
    const nextPosition = Number(value);
    if (!audioRef.current || !Number.isFinite(nextPosition)) {
      return;
    }

    audioRef.current.currentTime = nextPosition;
    setPosition(nextPosition);
  }

  function cycleRepeat() {
    setRepeat((value) => {
      if (value === "off") {
        return "all";
      }

      if (value === "all") {
        return "one";
      }

      return "off";
    });
  }

  return (
    <main className="min-h-screen bg-[var(--page-bg)] text-[var(--ink)]">
      <section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <header className="grid gap-4 border-b border-[var(--line)] pb-5 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
              Google Drive Music Player
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-balance sm:text-5xl">
              Reproductor privado para carpetas de Drive.
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
            <span className="rounded-full border border-[var(--line)] px-3 py-1">
              {isGoogleReady ? "Google listo" : "Cargando Google"}
            </span>
            <span className="rounded-full border border-[var(--line)] px-3 py-1">
              {accessToken ? "Conectado" : "Sin conectar"}
            </span>
          </div>
        </header>

        <div className="grid flex-1 gap-5 py-5 lg:grid-cols-[390px_1fr]">
          <aside className="flex flex-col gap-4">
            <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4 shadow-sm">
              <h2 className="text-base font-semibold">Conexion</h2>
              <label className="mt-4 block text-sm font-medium text-[var(--muted)]" htmlFor="client-id">
                Google OAuth Client ID
              </label>
              <input
                id="client-id"
                className="mt-2 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                placeholder="123.apps.googleusercontent.com"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
              <button
                className="mt-3 w-full rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onClick={connectGoogle}
                disabled={!isGoogleReady}
              >
                {accessToken ? "Reconectar Google" : "Conectar Google"}
              </button>
            </section>

            <form className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4 shadow-sm" onSubmit={loadFolder}>
              <h2 className="text-base font-semibold">Carpeta</h2>
              <label className="mt-4 block text-sm font-medium text-[var(--muted)]" htmlFor="folder-url">
                URL de Google Drive
              </label>
              <textarea
                id="folder-url"
                className="mt-2 min-h-24 w-full resize-none rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                placeholder="https://drive.google.com/drive/folders/..."
                value={folderUrl}
                onChange={(event) => setFolderUrl(event.target.value)}
              />
              <button
                className="mt-3 w-full rounded-md border border-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent)] transition hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                type="submit"
                disabled={isLoadingTracks || !accessToken}
              >
                {isLoadingTracks ? "Leyendo..." : "Cargar canciones"}
              </button>
            </form>

            <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4 text-sm text-[var(--muted)] shadow-sm">
              <h2 className="text-base font-semibold text-[var(--ink)]">Para compartirlo</h2>
              <p className="mt-3 leading-6">
                El repo no guarda tokens ni musica. Tu hermano solo necesita acceso a la carpeta en Drive
                y un OAuth Client ID autorizado para la URL donde publiquen la app.
              </p>
            </section>
          </aside>

          <section className="flex min-h-[620px] flex-col rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-sm">
            <div className="border-b border-[var(--line)] p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">Biblioteca</h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">{status}</p>
                </div>
                <input
                  className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] md:w-72"
                  placeholder="Buscar cancion"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {error ? (
                <p className="mt-3 rounded-md border border-[var(--danger-line)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger)]">
                  {error}
                </p>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {filteredTracks.length ? (
                <ol className="divide-y divide-[var(--line)]">
                  {filteredTracks.map((track) => {
                    const realIndex = tracks.findIndex((candidate) => candidate.id === track.id);
                    const active = realIndex === currentIndex;

                    return (
                      <li key={track.id}>
                        <button
                          className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--row-hover)] ${
                            active ? "bg-[var(--accent-soft)]" : ""
                          }`}
                          type="button"
                          onClick={() => playTrack(realIndex)}
                        >
                          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--line)] text-sm font-semibold">
                            {active && isPlaying ? "||" : ">"}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{getTrackTitle(track.name)}</span>
                            <span className="mt-1 block truncate text-xs text-[var(--muted)]">{track.name}</span>
                          </span>
                          <span className="text-xs text-[var(--muted)]">{formatSize(track.size)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="flex h-full min-h-[360px] items-center justify-center px-6 text-center text-sm text-[var(--muted)]">
                  {tracks.length ? "No hay resultados para esa busqueda." : "Conecta Google y carga una carpeta para ver tus canciones aqui."}
                </div>
              )}
            </div>

            <footer className="border-t border-[var(--line)] bg-[var(--player)] p-4">
              <audio
                ref={audioRef}
                onEnded={playNext}
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
              <div className="flex flex-col gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {currentTrack ? getTrackTitle(currentTrack.name) : "Sin cancion seleccionada"}
                  </p>
                  <p className="mt-1 truncate text-xs text-[var(--muted)]">
                    {isLoadingAudio ? "Cargando audio..." : currentTrack?.name ?? "Carga una carpeta para empezar"}
                  </p>
                </div>

                <div className="grid gap-3 lg:grid-cols-[1fr_auto_180px] lg:items-center">
                  <div className="grid grid-cols-[44px_1fr_44px] items-center gap-2 text-xs text-[var(--muted)]">
                    <span>{formatTime(position)}</span>
                    <input
                      aria-label="Progreso"
                      type="range"
                      min="0"
                      max={duration || 0}
                      value={Math.min(position, duration || 0)}
                      onChange={(event) => seek(event.target.value)}
                    />
                    <span className="text-right">{formatTime(duration)}</span>
                  </div>

                  <div className="flex items-center justify-center gap-2">
                    <button
                      aria-label="Anterior"
                      className="control-button"
                      type="button"
                      onClick={playPrevious}
                      disabled={!tracks.length}
                    >
                      {"<<"}
                    </button>
                    <button
                      aria-label={isPlaying ? "Pausar" : "Reproducir"}
                      className="control-button primary"
                      type="button"
                      onClick={togglePlayback}
                      disabled={!tracks.length || isLoadingAudio}
                    >
                      {isPlaying ? "||" : ">"}
                    </button>
                    <button
                      aria-label="Siguiente"
                      className="control-button"
                      type="button"
                      onClick={playNext}
                      disabled={!tracks.length}
                    >
                      {">>"}
                    </button>
                    <button
                      aria-label="Aleatorio"
                      className={`control-button text-button ${shuffle ? "selected" : ""}`}
                      type="button"
                      onClick={() => setShuffle((value) => !value)}
                    >
                      Mix
                    </button>
                    <button
                      aria-label="Repetir"
                      className={`control-button text-button ${repeat !== "off" ? "selected" : ""}`}
                      type="button"
                      onClick={cycleRepeat}
                    >
                      {repeat === "one" ? "Rep 1" : repeat === "all" ? "Rep" : "Off"}
                    </button>
                  </div>

                  <label className="grid grid-cols-[auto_1fr] items-center gap-2 text-xs text-[var(--muted)]">
                    Vol
                    <input
                      aria-label="Volumen"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      defaultValue="1"
                      onChange={(event) => handleVolumeChange(event.target.value)}
                    />
                  </label>
                </div>
              </div>
            </footer>
          </section>
        </div>
      </section>
    </main>
  );
}
