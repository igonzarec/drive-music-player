"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
};

type CachedTrack = {
  objectUrl: string;
  blob: Blob;
  size: number;
  lastUsed: number;
};

type PersistedTrackRecord = {
  id: string;
  folderId: string;
  name: string;
  mimeType?: string;
  size?: string;
  sizeBytes: number;
  modifiedTime?: string;
  blob: Blob;
  savedAt: number;
};

type PersistedFolderRecord = {
  folderId: string;
  tracks: DriveFile[];
  savedAt: number;
};

type PersistentCacheSummary = {
  ids: string[];
  totalBytes: number;
};

function CacheCheckIcon({ className = "", label = "En cache" }: { className?: string; label?: string }) {
  return (
    <span className={`cache-check ${className}`} aria-label={label} title={label}>
      <span aria-hidden="true">✓</span>
    </span>
  );
}

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
const THEME_STORAGE_KEY = "drive-player-theme";
const PERSISTENT_CACHE_STORAGE_KEY = "drive-player-persistent-cache-enabled";
const AUDIO_CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;
const PERSISTENT_CACHE_DB_NAME = "drive-music-player-cache";
const PERSISTENT_CACHE_DB_VERSION = 1;
const PERSISTENT_TRACK_STORE = "tracks";
const PERSISTENT_FOLDER_STORE = "folders";
const PROJECT_QUOTAS_URL =
  "https://console.cloud.google.com/iam-admin/quotas?project=drive-music-player-506007&orgonly=true&supportedpurview=organizationId,folder,project";
const GENERAL_QUOTAS_URL = "https://console.cloud.google.com/quotas?project=_";

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

  return formatBytes(bytes);
}

function formatBytes(bytes: number, fractionDigits = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 MB";
  }

  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(fractionDigits)} GB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(fractionDigits)} MB`;
}

function formatCacheLimit(bytes: number) {
  return formatBytes(bytes, 0);
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

function escapeDriveQueryValue(value: string) {
  return value.replace(/'/g, "\\'");
}

function buildDriveQuery(folderId: string) {
  const escapedFolderId = escapeDriveQueryValue(folderId);
  return [
    `'${escapedFolderId}' in parents`,
    "trashed = false",
    "(mimeType contains 'audio/' or name contains '.mp3' or name contains '.wav' or name contains '.m4a' or name contains '.ogg')",
  ].join(" and ");
}

function openPersistentCacheDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("IndexedDB no esta disponible en este navegador."));
      return;
    }

    const request = window.indexedDB.open(PERSISTENT_CACHE_DB_NAME, PERSISTENT_CACHE_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(PERSISTENT_TRACK_STORE)) {
        database.createObjectStore(PERSISTENT_TRACK_STORE, { keyPath: "id" });
      }

      if (!database.objectStoreNames.contains(PERSISTENT_FOLDER_STORE)) {
        database.createObjectStore(PERSISTENT_FOLDER_STORE, { keyPath: "folderId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir el cache local."));
  });
}

async function putPersistentRecord(storeName: string, record: unknown) {
  const database = await openPersistentCacheDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(record);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("No se pudo guardar en el cache local."));
    };
  });
}

async function getPersistentRecord<T>(storeName: string, key: string) {
  const database = await openPersistentCacheDatabase();

  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error("No se pudo leer el cache local."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("No se pudo leer el cache local."));
    };
  });
}

async function getAllPersistentRecords<T>(storeName: string) {
  const database = await openPersistentCacheDatabase();

  return new Promise<T[]>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error("No se pudo leer el cache local."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("No se pudo leer el cache local."));
    };
  });
}

async function clearPersistentStore(storeName: string) {
  const database = await openPersistentCacheDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).clear();
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("No se pudo borrar el cache local."));
    };
  });
}

function buildPersistedTrackRecord(track: DriveFile, folderId: string, blob: Blob): PersistedTrackRecord {
  return {
    id: track.id,
    folderId,
    name: track.name,
    mimeType: track.mimeType,
    size: track.size,
    sizeBytes: blob.size,
    modifiedTime: track.modifiedTime,
    blob,
    savedAt: Date.now(),
  };
}

async function savePersistedTrack(track: DriveFile, folderId: string, blob: Blob) {
  await putPersistentRecord(PERSISTENT_TRACK_STORE, buildPersistedTrackRecord(track, folderId, blob));
}

async function getPersistedTrack(trackId: string) {
  return getPersistentRecord<PersistedTrackRecord>(PERSISTENT_TRACK_STORE, trackId);
}

async function savePersistedFolderTracks(folderId: string, tracks: DriveFile[]) {
  const record: PersistedFolderRecord = {
    folderId,
    tracks,
    savedAt: Date.now(),
  };

  await putPersistentRecord(PERSISTENT_FOLDER_STORE, record);
}

async function getPersistedFolderTracks(folderId: string) {
  return getPersistentRecord<PersistedFolderRecord>(PERSISTENT_FOLDER_STORE, folderId);
}

async function getPersistentCacheSummary(): Promise<PersistentCacheSummary> {
  const records = await getAllPersistentRecords<PersistedTrackRecord>(PERSISTENT_TRACK_STORE);

  return {
    ids: records.map((record) => record.id),
    totalBytes: records.reduce((total, record) => total + (record.sizeBytes || record.blob.size || 0), 0),
  };
}

async function clearPersistentCache() {
  await clearPersistentStore(PERSISTENT_TRACK_STORE);
  await clearPersistentStore(PERSISTENT_FOLDER_STORE);
}

export default function Home() {
  const configuredClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tokenClientRef = useRef<TokenClient | null>(null);
  const audioCacheRef = useRef<Map<string, CachedTrack>>(new Map());
  const cacheTickRef = useRef(0);

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
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [cachedTrackIds, setCachedTrackIds] = useState<string[]>([]);
  const [persistedTrackIds, setPersistedTrackIds] = useState<string[]>([]);
  const [persistentCacheBytes, setPersistentCacheBytes] = useState(0);
  const [persistentCacheEnabled, setPersistentCacheEnabled] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [status, setStatus] = useState("Pega una URL de carpeta de Drive para empezar.");
  const [error, setError] = useState("");

  const currentTrack = tracks[currentIndex];
  const cachedTrackIdSet = useMemo(() => new Set(cachedTrackIds), [cachedTrackIds]);
  const persistedTrackIdSet = useMemo(() => new Set(persistedTrackIds), [persistedTrackIds]);
  const currentTrackIsCached = currentTrack ? cachedTrackIdSet.has(currentTrack.id) : false;
  const currentTrackIsPersisted = currentTrack ? persistedTrackIdSet.has(currentTrack.id) : false;
  const currentTrackCacheLabel = currentTrackIsPersisted ? "Guardada en computadora" : "En cache temporal";

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
    const nextVolume = Number.isFinite(savedVolume) ? Math.min(Math.max(savedVolume, 0), 1) : 1;
    setVolume(nextVolume);

    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "dark" || savedTheme === "light") {
      setTheme(savedTheme);
    }

    setPersistentCacheEnabled(localStorage.getItem(PERSISTENT_CACHE_STORAGE_KEY) === "true");
    refreshPersistentCacheSummary().catch(() => {
      setPersistedTrackIds([]);
      setPersistentCacheBytes(0);
    });
  }, [configuredClientId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.volume = volume;
    audioRef.current.muted = isMuted || volume === 0;
  }, [isMuted, volume]);

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
      audioCacheRef.current.forEach((cachedTrack) => URL.revokeObjectURL(cachedTrack.objectUrl));
      audioCacheRef.current.clear();
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

  async function parseDriveError(response: Response) {
    try {
      const data = (await response.json()) as { error?: { message?: string } };
      return data.error?.message ?? `Drive respondio con ${response.status}`;
    } catch {
      return `Drive respondio con ${response.status}`;
    }
  }

  async function fetchDriveFiles(params: URLSearchParams) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(await parseDriveError(response));
    }

    return (await response.json()) as { files?: DriveFile[] };
  }

  function resetPlayerForFolderChange() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    setIsPlaying(false);
    setTracks([]);
    setCurrentIndex(0);
    setPosition(0);
    setDuration(0);
  }

  async function refreshPersistentCacheSummary() {
    try {
      const summary = await getPersistentCacheSummary();
      setPersistedTrackIds(summary.ids);
      setPersistentCacheBytes(summary.totalBytes);
    } catch {
      setPersistedTrackIds([]);
      setPersistentCacheBytes(0);
    }
  }

  function getAudioCacheSize() {
    let size = 0;
    audioCacheRef.current.forEach((cachedTrack) => {
      size += cachedTrack.size;
    });
    return size;
  }

  function pruneAudioCache(protectedTrackId?: string) {
    let cacheSize = getAudioCacheSize();

    if (cacheSize <= AUDIO_CACHE_LIMIT_BYTES) {
      return;
    }

    const cachedTracks = [...audioCacheRef.current.entries()].sort(
      (first, second) => first[1].lastUsed - second[1].lastUsed,
    );

    for (const [trackId, cachedTrack] of cachedTracks) {
      if (trackId === protectedTrackId) {
        continue;
      }

      URL.revokeObjectURL(cachedTrack.objectUrl);
      audioCacheRef.current.delete(trackId);
      cacheSize -= cachedTrack.size;

      if (cacheSize <= AUDIO_CACHE_LIMIT_BYTES) {
        break;
      }
    }

    setCachedTrackIds([...audioCacheRef.current.keys()]);
  }

  function cacheBlobInMemory(trackId: string, blob: Blob) {
    const objectUrl = URL.createObjectURL(blob);

    audioCacheRef.current.set(trackId, {
      objectUrl,
      blob,
      size: blob.size,
      lastUsed: ++cacheTickRef.current,
    });
    pruneAudioCache(trackId);
    setCachedTrackIds([...audioCacheRef.current.keys()]);

    return objectUrl;
  }

  async function loadSavedFolderFromComputer(folderId: string) {
    const savedFolder = await getPersistedFolderTracks(folderId);
    const summary = await getPersistentCacheSummary();
    const savedTrackIds = new Set(summary.ids);
    const savedTracks = (savedFolder?.tracks ?? []).filter((track) => savedTrackIds.has(track.id));

    setPersistedTrackIds(summary.ids);
    setPersistentCacheBytes(summary.totalBytes);

    if (!savedTracks.length) {
      return false;
    }

    resetPlayerForFolderChange();
    setActiveFolderId(folderId);
    setTracks(savedTracks);
    setStatus(`${savedTracks.length} canciones guardadas listas desde esta computadora.`);
    return true;
  }

  async function handlePersistentCacheToggle(enabled: boolean) {
    setPersistentCacheEnabled(enabled);
    localStorage.setItem(PERSISTENT_CACHE_STORAGE_KEY, String(enabled));
    setError("");
    await refreshPersistentCacheSummary();

    const folderId = activeFolderId || extractFolderId(folderUrl);
    if (enabled && folderId && tracks.length) {
      try {
        await savePersistedFolderTracks(folderId, tracks);
        for (const track of tracks) {
          const cachedTrack = audioCacheRef.current.get(track.id);
          if (cachedTrack) {
            await savePersistedTrack(track, folderId, cachedTrack.blob);
          }
        }
        await refreshPersistentCacheSummary();
      } catch {
        setError("No se pudo preparar la lista para uso local.");
      }
    }
  }

  async function clearSavedTracks() {
    setError("");
    try {
      await clearPersistentCache();
      setPersistedTrackIds([]);
      setPersistentCacheBytes(0);
      setStatus("Canciones guardadas borradas de esta computadora.");
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "No se pudo borrar el cache local.");
    }
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
      if (persistentCacheEnabled) {
        setIsLoadingTracks(true);
        setStatus("Buscando canciones guardadas en esta computadora...");
        try {
          const loadedFromComputer = await loadSavedFolderFromComputer(folderId);
          if (!loadedFromComputer) {
            setError("No hay canciones guardadas para esa carpeta. Conecta Google para cargarla desde Drive.");
            setStatus("No encontre canciones guardadas para esa carpeta.");
          }
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "No se pudo leer el cache local.");
          setStatus("No se pudo cargar desde esta computadora.");
        } finally {
          setIsLoadingTracks(false);
        }
        return;
      }

      setError("Primero conecta tu cuenta de Google.");
      return;
    }

    localStorage.setItem(FOLDER_STORAGE_KEY, folderUrl.trim());
    resetPlayerForFolderChange();
    setActiveFolderId(folderId);
    setIsLoadingTracks(true);
    setStatus("Buscando canciones en la carpeta...");

    try {
      const params = new URLSearchParams({
        q: buildDriveQuery(folderId),
        fields: "files(id,name,mimeType,size,modifiedTime)",
        orderBy: "name",
        pageSize: "1000",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
      });

      const data = await fetchDriveFiles(params);
      const files = data.files ?? [];
      setTracks(files);
      if (persistentCacheEnabled) {
        await savePersistedFolderTracks(folderId, files);
      }
      await refreshPersistentCacheSummary();
      setStatus(files.length ? `${files.length} canciones listas.` : "No encontre archivos de audio en esa carpeta.");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo leer la carpeta.");
      setStatus("No se pudo cargar la carpeta.");
    } finally {
      setIsLoadingTracks(false);
    }
  }

  async function prepareTrack(track: DriveFile) {
    setIsLoadingAudio(true);
    const cachedTrack = audioCacheRef.current.get(track.id);

    if (cachedTrack) {
      cachedTrack.lastUsed = ++cacheTickRef.current;

      if (audioRef.current) {
        audioRef.current.src = cachedTrack.objectUrl;
        audioRef.current.load();
      }

      if (persistentCacheEnabled && !persistedTrackIdSet.has(track.id)) {
        try {
          await savePersistedTrack(track, activeFolderId || extractFolderId(folderUrl), cachedTrack.blob);
          await refreshPersistentCacheSummary();
        } catch {
          setError("La cancion se puede reproducir, pero no se pudo guardar en esta computadora.");
        }
      }

      setIsLoadingAudio(false);
      setStatus(`Listo desde cache: ${track.name}`);
      return;
    }

    if (persistentCacheEnabled) {
      const persistedTrack = await getPersistedTrack(track.id);

      if (persistedTrack?.blob) {
        const persistedUrl = cacheBlobInMemory(track.id, persistedTrack.blob);

        if (audioRef.current) {
          audioRef.current.src = persistedUrl;
          audioRef.current.load();
        }

        setIsLoadingAudio(false);
        setStatus(`Listo desde esta computadora: ${track.name}`);
        await refreshPersistentCacheSummary();
        return;
      }
    }

    if (!accessToken) {
      throw new Error("Esta cancion no esta guardada. Conecta Google para descargarla desde Drive.");
    }

    setStatus(`Descargando ${track.name} de Drive...`);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${track.id}?alt=media`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`No se pudo cargar el audio (${response.status}).`);
    }

    const blob = await response.blob();
    const nextUrl = cacheBlobInMemory(track.id, blob);

    if (persistentCacheEnabled) {
      try {
        await savePersistedTrack(track, activeFolderId || extractFolderId(folderUrl), blob);
        await refreshPersistentCacheSummary();
      } catch {
        setError("La cancion se puede reproducir, pero no se pudo guardar en esta computadora.");
      }
    }

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
    const nextVolume = Number(value);
    if (!Number.isFinite(nextVolume)) {
      return;
    }

    const clampedVolume = Math.min(Math.max(nextVolume, 0), 1);
    setVolume(clampedVolume);
    setIsMuted(clampedVolume === 0);
    localStorage.setItem(VOLUME_STORAGE_KEY, String(clampedVolume));
  }

  function toggleMute() {
    if (volume === 0) {
      setVolume(1);
      setIsMuted(false);
      localStorage.setItem(VOLUME_STORAGE_KEY, "1");
      return;
    }

    setIsMuted((muted) => !muted);
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

  function toggleTheme() {
    setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"));
  }

  return (
    <main className="min-h-screen bg-[var(--page-bg)] pb-56 text-[var(--ink)] sm:pb-44 lg:pb-32">
      <section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-3 py-4 sm:px-5 lg:px-10">
        <header className="grid gap-3 border-b border-[var(--line)] pb-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
              Google Drive Music Player
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-balance sm:text-4xl lg:text-5xl">
              Reproductor privado para carpetas de Drive.
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
            <button
              className="rounded-full border border-[var(--line)] px-3 py-1 transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
              type="button"
              onClick={toggleTheme}
            >
              {theme === "dark" ? "Modo claro" : "Modo oscuro"}
            </button>
            <span className="rounded-full border border-[var(--line)] px-3 py-1">
              {isGoogleReady ? "Google listo" : "Cargando Google"}
            </span>
            <span className="rounded-full border border-[var(--line)] px-3 py-1">
              {accessToken ? "Conectado" : "Sin conectar"}
            </span>
          </div>
        </header>

        <div className="grid flex-1 gap-5 py-4 lg:grid-cols-[390px_1fr] lg:py-5">
          <aside className="hidden flex-col gap-4 lg:flex">
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
                disabled={isLoadingTracks || (!accessToken && !persistentCacheEnabled)}
              >
                {isLoadingTracks ? "Cargando..." : tracks.length ? "Refresh canciones" : "Cargar canciones"}
              </button>
            </form>

            <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4 text-sm text-[var(--muted)] shadow-sm">
              <h2 className="text-base font-semibold text-[var(--ink)]">Para compartirlo</h2>
              <p className="mt-3 leading-6">
                El repo no guarda tokens ni musica. Tu hermano solo necesita acceso a la carpeta en Drive
                y un OAuth Client ID autorizado para la URL donde publiquen la app.
              </p>
            </section>

            <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4 text-sm text-[var(--muted)] shadow-sm">
              <h2 className="text-base font-semibold text-[var(--ink)]">Limites y cache</h2>
              <p className="mt-3 leading-6">
                Consulta los paneles de Google Cloud para revisar cuotas del proyecto y uso general.
              </p>
              <div className="mt-4 grid gap-2">
                <a
                  className="rounded-md border border-[var(--line)] px-3 py-2 font-semibold text-[var(--accent)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  href={PROJECT_QUOTAS_URL}
                  rel="noreferrer"
                  target="_blank"
                >
                  Cuotas del proyecto
                </a>
                <a
                  className="rounded-md border border-[var(--line)] px-3 py-2 font-semibold text-[var(--accent)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  href={GENERAL_QUOTAS_URL}
                  rel="noreferrer"
                  target="_blank"
                >
                  Panel general de cuotas
                </a>
              </div>
            </section>
          </aside>

          <section className="flex min-h-[calc(100vh-310px)] flex-col rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-sm lg:min-h-[620px]">
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
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)]">
                <label className="flex cursor-pointer items-center gap-2 text-[var(--ink)]">
                  <input
                    className="switch-input"
                    type="checkbox"
                    checked={persistentCacheEnabled}
                    onChange={(event) => {
                      void handlePersistentCacheToggle(event.target.checked);
                    }}
                  />
                  <span className="font-semibold">Guardar canciones en la computadora</span>
                </label>
                <div className="leading-4">
                  <p>Local: {persistedTrackIds.length} guardadas</p>
                  <p>Local size: {formatBytes(persistentCacheBytes)}</p>
                </div>
                <p className="min-w-0 flex-1">Tab cache: {formatCacheLimit(AUDIO_CACHE_LIMIT_BYTES)}</p>
                <button
                  aria-label="Borrar guardadas"
                  className="rounded-md border border-[var(--line)] px-2 py-1 font-semibold text-[var(--accent)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  onClick={() => {
                    void clearSavedTracks();
                  }}
                  disabled={!persistedTrackIds.length}
                >
                  Borrar
                </button>
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
                    const trackIsPersisted = persistedTrackIdSet.has(track.id);
                    const trackIsCached = cachedTrackIdSet.has(track.id);

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
                          <span className="flex items-center justify-end gap-2 text-xs text-[var(--muted)]">
                            {trackIsPersisted || trackIsCached ? (
                              <CacheCheckIcon label={trackIsPersisted ? "Guardada en computadora" : "En cache temporal"} />
                            ) : null}
                            <span>{formatSize(track.size)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="flex h-full min-h-[360px] items-center justify-center px-6 text-center text-sm text-[var(--muted)]">
                  {isLoadingTracks
                    ? "Buscando canciones..."
                    : tracks.length
                      ? "No hay resultados para esa busqueda."
                      : "Pega una URL de carpeta y carga canciones para verlas aqui."}
                </div>
              )}
            </div>

            <footer className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--line)] bg-[var(--player)] px-4 py-3 shadow-[0_-12px_36px_rgba(24,33,31,0.12)]">
              <audio
                ref={audioRef}
                onEnded={playNext}
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onVolumeChange={(event) => {
                  setVolume(event.currentTarget.volume);
                  setIsMuted(event.currentTarget.muted || event.currentTarget.volume === 0);
                }}
              />
              <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 sm:px-4 lg:px-6">
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    {currentTrackIsPersisted || currentTrackIsCached ? (
                      <CacheCheckIcon label={currentTrackCacheLabel} />
                    ) : null}
                    <span className="truncate">
                      {currentTrack ? getTrackTitle(currentTrack.name) : "Sin cancion seleccionada"}
                    </span>
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

                  <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-xs text-[var(--muted)]">
                    <button
                      aria-label={isMuted || volume === 0 ? "Activar sonido" : "Silenciar"}
                      className={`control-button text-button ${isMuted || volume === 0 ? "selected" : ""}`}
                      type="button"
                      onClick={toggleMute}
                    >
                      {isMuted || volume === 0 ? "Mute" : "Vol"}
                    </button>
                    <input
                      aria-label="Volumen"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={volume}
                      onChange={(event) => handleVolumeChange(event.target.value)}
                    />
                  </div>
                </div>
              </div>
            </footer>
          </section>
        </div>
      </section>
    </main>
  );
}
