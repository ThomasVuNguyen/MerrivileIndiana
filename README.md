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
`Authorization: Bearer <email>:<password>` (Basic auth works too) or `X-API-Key: <email>:<password>`
(for claude.ai connectors: "No sign-in" plus that header), the same account as the web app.

- Projects: `list_projects`, `create_project`, `rename_project`, `delete_project` (needs the exact name).
- Parts: `list_parts`, `read_part` (any version), `write_part`, `edit_part`, `restore_part_version`,
  `delete_part`, `set_part_hardware`, `import_step` (URL, text or base64), `read_chats`.
- Components (account-wide): `import_component`, `start_upload`, `list_components`, `read_component`,
  `set_component_datums`. Assemblies (per project): `write_assembly`, `place`, `remove_instances`,
  `read_assembly`, `list_assemblies`, `check_assembly`, `render_assembly`, `export_assembly`,
  `duplicate_assembly`, `swap_component`, `delete_assembly`, `set_assembly_hardware`,
  `bill_of_materials`. Guides: `write_guide`, `edit_guide`, `read_guide`, `list_guides`,
  `render_guide`, `delete_guide`. See "Assemblies and components" and "Guides and BOM" below.
- Review: `inspect` runs build123d code where `part("id")` rebuilds a part from source (exact B-rep),
  prints measurements, returns `report` and full-precision metrics and renders of `result` from any
  view (`/inspect` in the geometry service). A list or `{name: shape}` result draws each part in its
  own colour with a legend (`geometry/scene.py`; part() labels its solid, and moved copies keep the
  label); `section` cuts the picture exactly and hatches the cut faces. `render_part` and
  `export_part` (signed `/api/dl/` links, valid 1 h, no login).
- Every render from `inspect` or `render_part` is saved under `projects/<id>/renders/`, shown in the
  "Outside agent (MCP)" chat with the agent's `caption`, and linked (signed, 1 h) in the tool result.
- Shop, memory and Library: the chat AI's tools (`worker/tools-shop.ts`), plus `list_memory`.

What an agent changes appears live in the viewer and in the project's "Outside agent (MCP)" chat,
whose history tells the in-app AI what changed. Each call is traced in Langfuse (tag `mcp`).

## Assemblies and components

No constraint solver: the AI places things by snapping named datums together, and every save
checks the result. The in-app AI and outside agents (MCP) have the same tools.

- **Datums.** A part script publishes them next to `result`: `datums = {"seat": Plane(...),
  "optical_axis": Axis(...), "m2_holes": [Vector(...), ...]}` (a list of points is a hole pattern;
  `Pattern(points, normal)` gives its normal). Kinds: plane (origin, normal out of the material, x
  direction: a full frame), axis, point, pattern. They're stored per part version (`PartDoc.datums`,
  `versions.datums`); a plane in no flat face or a pattern point on no hole axis is a warning.
- **Components** are vendor STEP models in the account's library (`Account` object, files in R2
  under `users/<uid>/components/<id>/`: the original STEP, a BREP, a viewer mesh in the parts'
  format, renders). Import from a URL, STEP text, base64, a Library item, a chat attachment, or a
  one-time signed upload link (`start_upload`, then `curl -T file.step <link>`; up to 95 MB). The
  geometry service (`POST /component`) suggests datums: the largest flat face (`base`), hole
  patterns in its plane grouped by diameter (`holes_d2.7`) and bores; they start as the component's
  datums, and `set_component_datums` edits them, the keep-outs (box, cylinder, cone in the
  component's frame) and the outline. `component("id")` works in part scripts and inspect.
  The geometry service caches BREPs by hash (`geometry/cache.py`); a call naming one it lacks
  answers `{need: [hash]}` and the Worker uploads it from R2 (`POST /cache/<hash>`).
- **Assemblies** (`worker/assemblies.ts`, `geometry/assembly.py`) are instances of parts (latest
  good version unless pinned), components and other assemblies, each placed by `pos`/`rot`
  (build123d `Pos * Rot`) or by one or two snaps `{own, to: "<instance>.<datum>", offset?, flip?,
  spin?}`: plane to plane (face to face), axis to axis (coaxial), point to point, pattern to pattern
  (Kabsch, residual per point). Inside a sub-assembly: `"<sub>/<child>.<datum>"`. Instances are
  placed in dependency order on every save; a cycle is an error; a snap that can't be met keeps the
  instance's last placement and is reported. Matrices are 4x4 row-major (`p = M · [x, y, z, 1]`).
- **Checks** (`geometry/check.py`) run on every save and with `check_assembly`: per-solid box
  prefilter, then exact OpenCASCADE distance and common volume. Clashes (volume, centroid, box and a
  red mesh), tight gaps under the clearance (0.2 mm default), contacts, floating instances (not
  connected to the ground), keep-out intrusions, pattern fits over 0.05 mm, unresolved snaps and
  declared requirements (`coaxial`, `parallel`, `distance`; default 0.02 mm and 0.05°). Warnings
  only. A time limit (30 s default) returns partial results.
- **Viewer data** (`shared/protocol.ts`): `AssemblyDoc.leaves` lists every part and component
  instance to draw (sub-assemblies flattened) with its mesh URL, matrix and colour; the project
  snapshot has `assemblies`, and `{type: 'assembly'}` / `{type: 'assembly_removed'}` follow changes.
  HTTP: `GET/POST /api/components`, `GET/PATCH/DELETE /api/components/:id`; component files are
  served to their owner under `/api/files/users/<uid>/components/`.
- Changing a part marks the assemblies that use it out of date; `place` with `instances: []`
  re-places and re-checks one. `export_assembly` gives a STEP with named, nested instances.

## Guides and BOM

Animated assembly guides the AI writes and the person plays in the viewer, like a Lego booklet
that moves. The in-app AI and outside agents have the same tools (`worker/tools-guide.ts`,
`worker/guides.ts`, `geometry/guide.py`).

- **Kinds.** `build` starts empty and each step adds instances (upcoming ones show as ghosts unless
  `upcoming: "hidden"`); `exploded` and `explain` start assembled. A step has a title and text,
  `add` / `remove`, `motions`, `camera` (view, frame, zoom, orbit), `focus`, `labels`, `hardware`
  (shop item ids filled in with name and picture), `tools` and a `warning`. `explode: {axis?,
  distance?, stagger?, back?}` is shorthand for motions out from the assembly's centre (with `axis`, all one way along it).
- **Poses** are relative to where an instance sits assembled, in the assembly's frame
  (`GuidePose` in `shared/protocol.ts`). The tools also take `{offset?, along: "<inst>.<datum>",
  distance?, turn?: {about: "<inst>.<datum>" | axis + pivot, deg}}`; every save resolves them
  from the datums of the placed part versions and components. A motion's `from` defaults to where
  earlier steps left the instance, `to` to assembled; `via` poses get equal time per leg.
- **Playback maths** is `shared/guide.ts` (`guideState`, `motionPose`, `stepFrame`, `VIEWS`, …): the
  viewer plays guides with it, and the Worker samples with the same functions for checks and sheets.
- **Every save** (`write_guide`, `edit_guide`) refuses unknown instances and datums, warns about
  instances added twice, moved or labelled while not shown, never added or left apart at the end of
  a build, and steps' hardware that doesn't match the assembly's joining hardware. Then the
  geometry service (`POST /guide`) path-checks every motion: the Worker samples it at most 2 mm apart
  (per corner of each moving box; ≤ 400 samples a step, 2400 a guide) and sends matrices; per solid,
  boxes first, then the exact common volume (> 0.01 mm³). Pairs that overlap when assembled, pairs
  still in their assembled relation (a sub-assembly moving as one) and a motion's arrival when it
  ends assembled are left out. One `path_clash` per step and pair: first time, worst volume, where.
  It also draws a sheet with each step's end from its camera (faded out-of-focus instances, faint
  ghosts, labels, dark arrows for motion) and a thumbnail, and saves a version (`guides` and
  `guide_versions` tables; the written form is kept for `edit_guide`).
- **Viewer data**: the project snapshot has `guides`; `{type: 'guide'}` / `{type: 'guide_removed'}`
  follow changes. A guide follows its assembly's live leaves; `assemblyVersion` older than the
  assembly's only means its check is out of date (`edit_guide` with `ops: []` re-checks).
- **Hardware and BOM.** `set_assembly_hardware` stores the joining hardware on `AssemblyDoc.hardware`
  (kept through saves). `bill_of_materials` and `GET /api/projects/:id/assemblies/:aid/bom` (a
  `Bom`) count parts per placement with sub-assemblies flattened (material, mass each),
  components (vendor, part number, link) and hardware (each part's × how many are placed, plus
  joining hardware, merged by shop item, else by name), with the shop's tier, picture, price, on
  hand and short. Shop stock is never taken off: projects are plans. One assembly per variant.
- `delete_assembly` removes an assembly and its guides, unless another assembly uses it.

## Concept demo

`#/p/actuator` is the static concept assembly from `tools/gen_models.py`
(`.venv/bin/python tools/gen_models.py` regenerates it). Its chat is mocked, and it keeps the
A/B/C layout switcher (`?v=a|b|c`, `&clean` hides it).
