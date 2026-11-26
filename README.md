# MerrivileIndiana
A cad experience Thomas dreams about in Merrivile Indiana

## Run it locally

```bash
uv venv .venv -p 3.12 && uv pip install -p .venv -r geometry/requirements.txt
cd web && npm install
npm run geometry        # build123d service on :8790 (keep it running)
npm run dev             # app + Worker + Durable Objects + R2 on http://localhost:5180
```

Open http://localhost:5180/#/settings, add a model (Anthropic, Cloudflare Workers AI or any
OpenAI-compatible endpoint), then describe a part on the projects page.

- `geometry/` runs AI-written build123d scripts in forked, time-limited processes and returns
  metrics, a face-indexed mesh, STEP/STL and a 4-view render the model looks at.
- `web/worker/` is the Cloudflare Worker: an `Account` Durable Object (model keys, project list),
  a `Project` Durable Object per project (agent loop, chat, part versions) and R2 for files.
- Local state lives in `web/.wrangler/state`; delete it to start over.

## Deploy (Cloudflare)

```bash
cd web
./deploy.sh   # build, deploy (container rollout: immediate), wait until /api/health shows the new geometry version
```

When `geometry/` changes, bump `VERSION` in `geometry/server.py` and `GEOMETRY_VERSION` in
`web/worker/geometry.ts` together: the container instance name includes it, so the deploy starts
fresh containers instead of reusing warm ones on the old image.

Live at https://merry.beenex.company (also merrivile.thomas-aed.workers.dev).
after that sign-ups are closed unless the `OPEN_SIGNUP` var is `"true"`.
`GET /api/health` wakes the geometry container, runs a test build and reports its version.

## Shop and memory

- **Shop** (`#/shop`): hardware (on hand / Prime / order) and tools, per account, in the `Account`
  Durable Object. The shop chat takes photos, screenshots (attach or Ctrl+V) and product links; the
  AI adds items, crops their pictures (`/image/crop` in the geometry service) and reads Amazon pages.
- **Memory** (Settings → Memory): lasting preferences the AI saves with `remember`.
- **Library** (`#/library`): a free-form grid of reference files (photos of the office and lab,
  experiments, data) with optional notes. Each file gets a one-line AI description in the
  background so `search_library` can find it; `open_library_item` shows it to the model.
- **Attachments and uploads** (paperclip, paste or drop; chats and Library): any file up to 5 GB.
  Up to 95 MB goes in one streamed request; bigger files go straight to R2 in 50 MB multipart chunks.
  Photos keep the original (HEIC included) plus a 1568 px JPEG preview, made in the browser or, for
  HEIC in Chrome, by the geometry container (`/image/preview`, pillow-heif). The AI reads previews,
  PDFs up to 25 MB, the first 200 KB of text files, and imports STEP files up to 45 MB.
  Uploads run 4 files at a time, and 3 parts at a time within a big file.
- **Spreadsheets and documents** (Excel, Numbers, ODS, Word, PowerPoint, ODT): the geometry
  container (`/convert`) turns them into text, with every sheet as CSV. The text is kept in R2
  next to the original, and the AI reads it like a text file.
- **`run_python`**: AI-written Python (pandas, matplotlib, openpyxl, …) runs in the geometry
  container (`/python`) over the chat's last 20 files and any Library files it names, with no
  internet, a 120 s limit and 3 GB of memory. Charts and files saved to `out/` come back as
  downloads, and the AI sees the charts.
- **Shop tools work in batches** (`add_shop_items`, `update_shop_items`, `remove_shop_items`,
  `upsert_tools`). Each batch gets one note whose undo covers all of it: the note's changeId holds
  the batch's change ids joined by commas.
- **Multiple chats** in the Shop and in every project (`worker/threads.ts`). Each chat keeps
  its own messages, model history, latest attachments, and a record of which shop and memory it
  has been shown. They all share the shop, memory, Library and parts. A project runs one AI turn
  at a time, and the other chats show where it's working. The single chat from before moved
  into the first thread.
- **Chat UI**: the AI's work shows as one line ("Worked for 12 s · Read motor-plate ▾") that
  opens into readable steps (`src/steps.ts`). Answers come with Copy and Retry, and source chips
  (`library:` / `shop:` / `part:` links in the reply) open what the AI cited. The empty message box
  offers suggestions. On screens 1000 px and wider the chat is a full-height column on the right
  and the page makes room for it; it can be floated instead (remembered per browser).
- **Project layout**: parts and the open part's sheet on the left, the model in the middle, the chat
  on the right. The sheet shows material, mass and size on one line; Hardware, Made with, Versions,
  Properties and the build123d source fold, stay open across parts, and open by themselves when
  the AI changes what they list.
- **Videos** (MP4, MOV, WebM, MKV, AVI, WMV, MPG, …): a poster and a 3×2 sheet of timed frames,
  which is what the AI sees. The browser makes them when it can play the file; otherwise the
  `Video` container (same image, standard-3, ffmpeg: `/video/frames`) does. Formats browsers
  can't play get an H.264 MP4 copy (`/video/copy`), made by the Account's alarm. So does any
  video a viewer's browser fails to play, such as HEVC in Firefox or Chrome on Linux.
  History keeps attachments by R2 key; they're loaded just before each model call.
- Every AI change to the shop or memory is logged with an undo shown in the chat.
- The design AI gets memory, stock and tools with each message (when they change), sizes holes to
  stocked hardware, and lists the hardware on each part. Parts keep versions with Restore.

Langfuse tracing (https://fuse.beenex.cloud, project Merrivile-CAD) is on when both keys are set as
Worker secrets (`npx wrangler secret put LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`). Each chat
message is a trace (user = email, session = project id) with one generation per model API call,
including retries, failures and stopped calls, and a span per tool call. Token usage comes from the
API; a call cut off by Stop logs an estimate flagged `outputTokensEstimated`. API keys, cookies and
render images are never sent.

## MCP server (outside agents)

`POST /api/mcp` is an MCP server (Streamable HTTP, JSON responses; `worker/mcp.ts`) so agents
such as Claude Code can do what the in-app AI does. They sign in on every request with
`Authorization: Bearer <email>:<password>` (Basic auth works too), the same account as the web app.

- Projects: `list_projects`, `create_project`, `rename_project`, `delete_project` (needs the exact name).
- Parts: `list_parts`, `read_part` (any version), `write_part`, `edit_part`, `restore_part_version`,
  `delete_part`, `set_part_hardware`, `import_step` (URL, text or base64), `read_chats`.
- Review: `inspect` runs build123d code where `part("id")` rebuilds a part from source (exact B-rep),
  prints measurements, returns `report` and full-precision metrics and renders of `result` from any
  view (`/inspect` in the geometry service). `render_part` and `export_part` (signed `/api/dl/`
  links, valid 1 h, no login).
- Shop, memory and Library: the chat AI's tools (`worker/tools-shop.ts`), plus `list_memory`.

What an agent changes appears live in the viewer and in the project's "Outside agent (MCP)" chat,
whose history tells the in-app AI what changed. Each call is traced in Langfuse (tag `mcp`).

## Concept demo

`#/p/actuator` is the static concept assembly from `tools/gen_models.py`
(`.venv/bin/python tools/gen_models.py` regenerates it). Its chat is mocked, and it keeps the
A/B/C layout switcher (`?v=a|b|c`, `&clean` hides it).
