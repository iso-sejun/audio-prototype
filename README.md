# Audio Triggers

Upload an audio file, drop named "triggers" at points in it, and play from any trigger.
Everything is stored on the device (IndexedDB); there is no backend. Installable as a PWA.

```bash
npm install
npm run dev      # http://localhost:5173 (also on your LAN, for testing on a phone)
npm run build    # production build in dist/, with service worker
```

- `src/db.ts`: Dexie schema (clips, audio blobs, triggers) and data helpers
- `src/Library.tsx`: clip list and upload
- `src/ClipView.tsx`: player, trigger list, "stop at next trigger"

On iOS, add the app to the Home Screen so Safari doesn't clear its storage after 7 days without use.
