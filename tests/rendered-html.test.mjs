import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Drive music player shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Drive Music Player/);
  assert.match(html, /Reproductor privado para carpetas de Drive/);
  assert.match(html, /Google OAuth Client ID/);
  assert.match(html, /URL de Google Drive/);
  assert.match(html, /Cargar canciones/);
  assert.match(html, /Modo oscuro/);
  assert.match(html, /Keep on device/);
  assert.match(html, /Clear saved tracks/);
  assert.match(html, /Cuotas del proyecto/);
  assert.match(html, /Panel general de cuotas/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("keeps repository instructions free of secrets", async () => {
  const [readme, envExample, packageJson] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /Do not commit `.env.local`/);
  assert.match(envExample, /^NEXT_PUBLIC_GOOGLE_CLIENT_ID=$/m);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
