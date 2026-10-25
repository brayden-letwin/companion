# Companion

An on-screen math assistant: talk through a paper, follow connected ideas, and turn a request into a plot or a saved note.

## Start here

1. **Double-click `Start Companion.cmd`** in the Companion folder. It opens the math assistant in your browser and starts the installed local AI services.
2. **Choose a source** in the reading map, or open a PDF.
3. **Click the microphone or type a request.** Try “Explain this,” “Plot x^2,” or “Save note: completeness keeps the limit inside the space.” Use Stop to end the current request.

The personal assistant opens without a group account. Your notes and familiarity preferences stay in this browser. The separate **Shared room** keeps its existing accounts and saved group discussions.

**This development PC is already configured.** No terminal commands or new installation are needed. A fresh checkout needs **Node.js 24.15 or newer**; live questions and voice also need the local model and speech setup below. The assistant uses the installed Qwen math model and Whisper speech recognizer on this PC, with no cloud fallback or API key.

**Version 0.5** adds a dark, voice-centered workspace inspired by the [Jarvis demonstration](https://www.youtube.com/watch?v=Acw0NtkyNtM&t=17s). Its reading map uses prepared mathematical connections tied to the original sample passages. Imported PDF text stays local until you ask about a selected passage. Actions operate inside Companion: source navigation, explanations, plots, and notes.

The assistant runs at **http://127.0.0.1:4174/assistant.html**. The shared reading room remains at **http://127.0.0.1:4174/room.html** with one sample paper. Colleagues on other computers will need a hosted version.

<details>
<summary>Advanced: shared-room launch options, storage, and limits</summary>

Use **Node.js 24.15 or newer**; Node 24 LTS is the tested runtime. The shared server uses Node's built-in SQLite and crypto modules, with no extra server packages or AI key required. From the repository directory on Windows:

```powershell
.\scripts\start-shared.ps1
```

The launcher finds Node on PATH or in the configured Codex runtime, starts the server in the background, and opens **http://127.0.0.1:4174/room.html**. It reuses an already running Companion room on that port. Closing the browser leaves the server running. Pass `-NodePath '<path-to-node.exe>'` for a specific runtime, `-DataDirectory '<absolute-folder>'` for another data location, or `-NoOpen` to start without opening a browser.

For a foreground development server, use this alternative and press **Ctrl+C** in its terminal to stop it:

```powershell
npm run shared
```

Both launch methods default to the configured workspace's `work/companion-shared` data directory. The server reads `COMPANION_SHARED_DATA_DIR` and optional `COMPANION_SHARED_PORT` for a custom location or port. Choose a data folder outside the source checkout. Use a different port **and** data directory for a separate QA room so test accounts and discussions stay separate.

On first opening, create a reading-group name and your administrator account. Choose your own member name and a password of 12–128 characters. No human account or default password is supplied. The administrator can create a one-use invite link that expires after 24 hours; the invited person uses it to create their own member account. Copy and share links yourself; the app sends no email.

**This server listens only on this PC. Invite links work in another browser on this computer; they cannot reach a colleague's computer until a hosted service is configured.** It currently supports one group, up to 50 members, and one original fixed-point sample paper. It has no university sign-in, account recovery, paper uploads, or AI answers in the shared room. The intended audience is the University of Washington theory group; no institutional service or endorsement is implied.

The server derives authorship from the signed-in session. If another session changes the discussion before you submit, the latest room is loaded and your draft stays available for an explicit retry. An uncertain send offers **Retry sending**, which prevents a duplicate contribution. [DISCUSSION_FLOW.md](DISCUSSION_FLOW.md) explains contributions, review, and resolution history.

Accounts, invitations, sessions, and discussion history are stored in `room.sqlite` in the data directory. Passwords are salted and hashed; sessions use HttpOnly cookies and expire after eight hours. Keep this directory private and out of Git. For a file-copy backup, stop the server before copying its data folder; copying only the database while SQLite is writing can miss recent changes. Automated backups and recovery are not implemented.

</details>

## Original desktop reader (optional)

<details>
<summary>Open, configure, or rebuild the personal reader and local AI</summary>

### Open the configured local app

If the portable runtime, model, speech environment, and packaged app have already been installed, run this from the repository:

```powershell
.\scripts\start-local.ps1 -RuntimeRoot '<portable-runtime-root>'
```

Replace the placeholder with the folder containing `runtime/ollama.exe` and `models/`. The launcher starts the local services and opens `release/Companion-0.5.0/Companion.exe`. The configured development installation also provides **Start Companion.cmd** in its adjacent `companion-local` folder for this original desktop reader. Close any existing desktop instance first: focus the corner and press **Alt+F4**. An already running instance keeps its previous configuration. The new browser assistant uses the main repository's launcher instead.

The launcher selects `companion-math` at `127.0.0.1:11434`, sets `OLLAMA_NO_CLOUD=1`, and uses the speech helper at `127.0.0.1:8178`. No API key is needed. **Preferences → Refresh connection** checks model and microphone transcription availability separately. If voice is unavailable, typed questions still work. A model's first question can take longer while weights load.

The speech environment defaults to the workspace `work` folder, three levels above the launcher directory. Use `-SpeechRuntimeRoot '<speech-work-folder>'` for another location, or `-SkipSpeech` for typed questions only. `-AppPath '<path-to-Companion.exe>'` selects another packaged build. Services remain running after the app closes.

### Reading and asking

The reader and corner open together. Use **Open a PDF** for a paper, then hover over or select its text and ask a question. Starting a question pins its passage; moving to the microphone does not change the target. The × on the context chip releases the pin. The pointer supplies context only inside Companion's reader.

Try `plot x^2`, `define completeness`, `show this larger`, or `save note: My observation`. **Save** keeps an answer or selected passage with its source. **Preferences** sets concept familiarity and optional read-aloud. Familiarity is explicit; the app does not infer intelligence or knowledge from hesitation or mouse movement.

| Control | Behavior |
| --- | --- |
| `Ctrl+Alt+Space` | Start recording; press again to submit. Requires a ready transcription service. |
| `Ctrl+Alt+Escape` | Stop recording, requests, and read-aloud immediately. |
| Corner header / collapse button | Expand or collapse: 360 × 82 collapsed, 360 × 520 expanded. |
| Close reader | Hide it; reopen using the corner's book button. |
| `Alt+F4` with the corner focused | Quit Companion. |

Recording automatically submits at 60 seconds. Spoken “stop” is processed after submission; use the visible **Stop** control or shortcut for immediate cancellation. Global shortcuts depend on system availability. Cancelling discards late results; an already running CPU operation may finish before the speech helper notices the disconnected request.

### First setup: app and local math model

Use Windows, Node.js **24.15 or newer**, pnpm, and several GB of free space for the portable runtime and model. The steps below use a new runtime directory outside the repository. Downloads require internet access; local questions do not after setup. The tested machine has an RTX 4070 with 12 GB VRAM and 32 GB system RAM. Performance on other hardware has not been measured.

Build the app from the repository directory:

```powershell
pnpm install
node node_modules/electron/install.js
node scripts/package.mjs Companion-0.5.0
```

The explicit Electron command installs its runtime. Packaging creates an unsigned development build, not an installer. Keep the whole output folder together. The packager excludes private `.env` files and refuses to replace an existing output directory; choose a new package name if needed, then pass its executable through `-AppPath`.

Download the tested [Ollama v0.40.11 Windows ZIP](https://github.com/ollama/ollama/releases/tag/v0.40.11), verify it, and extract it into a fresh portable runtime folder:

```powershell
$runtimeRoot = [IO.Path]::GetFullPath('..\companion-local')
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$archive = Join-Path $runtimeRoot 'ollama-windows-amd64.zip'
Invoke-WebRequest 'https://github.com/ollama/ollama/releases/download/v0.40.11/ollama-windows-amd64.zip' -OutFile $archive
$expectedHash = 'bda4a493ba8a7c24d57263cd843cd68cee84f44aed4299eeed532acad7eda12a'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Ollama archive checksum mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $runtimeRoot 'runtime')
```

Quit any other Ollama server before starting this one so the model folder and local-only settings take effect. In the same PowerShell session, set process-scoped variables, start the server, and install [Qwen3.5:4b](https://ollama.com/library/qwen3.5:4b):

```powershell
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_MODELS = Join-Path $runtimeRoot 'models'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_CONTEXT_LENGTH = '4096'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$ollama = Join-Path $runtimeRoot 'runtime\ollama.exe'
Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        $ready = [bool](Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 1).version
        if ($ready) { break }
    } catch { }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw 'The local model server did not start.' }
& $ollama pull qwen3.5:4b
if ($LASTEXITCODE -ne 0) { throw 'Model download failed.' }
& $ollama create companion-math -f .\local\Modelfile
if ($LASTEXITCODE -ne 0) { throw 'Companion model creation failed.' }
```

[`local/Modelfile`](local/Modelfile) configures the math teaching instructions and generation limits. `companion-math` uses the downloaded Qwen weights with those instructions; creating the alias does not train new weights. Model tags can change upstream, so retain the installed model files and record `ollama list`/`ollama show companion-math` when comparing runs. Ollama documents [local-only mode and server settings](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features).

### First setup: local English voice

Voice input uses [faster-whisper](https://github.com/SYSTRAN/faster-whisper) with the official [Systran base.en model](https://huggingface.co/Systran/faster-whisper-base.en), on **CPU with int8 computation**. It does not compete for the GPU's model memory. Use Python 3.12 and [uv](https://docs.astral.sh/uv/); install packages into a dedicated environment. The example keeps the environment, downloads, and caches outside the repository:

```powershell
$speechWork = [IO.Path]::GetFullPath('..\..\work')
$speechRoot = Join-Path $speechWork 'companion-speech'
$venv = Join-Path $speechWork '.venv-speech'
$env:UV_CACHE_DIR = Join-Path $speechRoot 'uv-cache'
$env:HF_HOME = Join-Path $speechRoot 'huggingface'
$env:XDG_CACHE_HOME = Join-Path $speechRoot 'cache'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:DO_NOT_TRACK = '1'
$env:COMPANION_SPEECH_MODEL_DIR = Join-Path $speechRoot 'model'
uv venv --python 3.12 $venv
$python = Join-Path $venv 'Scripts\python.exe'
uv pip install --python $python -r .\speech\requirements.txt

@'
import os
from huggingface_hub import snapshot_download
snapshot_download(
    'Systran/faster-whisper-base.en',
    revision='3d3d5dee26484f91867d81cb899cfcf72b96be6c',
    local_dir=os.environ['COMPANION_SPEECH_MODEL_DIR'],
    allow_patterns=['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*', 'preprocessor_config.json'],
)
'@ | & $python -

.\scripts\start-speech.ps1 -RuntimeRoot $speechWork
Invoke-RestMethod 'http://127.0.0.1:8178/health'
```

The health response must contain `ready: true`, `model: base.en`, and `device: cpu`. The helper loads the model before reporting ready, requires local files, and forces Hugging Face offline mode during startup and inference. It binds only to `127.0.0.1:8178`, accepts bounded raw audio at `/transcribe`, rejects browser origins and foreign Host headers, and decodes in memory. It does not download models while transcribing. Requirements are pinned to the installed environment in [`speech/requirements.txt`](speech/requirements.txt).

After setup, launch everything together:

```powershell
.\scripts\start-local.ps1 -RuntimeRoot $runtimeRoot -SpeechRuntimeRoot $speechWork
```

### Direct launch or optional OpenAI

The local launcher sets the app's configuration without a `.env` file. For direct development launch with `pnpm start`, or double-clicking `Companion.exe`, copy `.env.example` to a private `.env` in the repository or beside the executable. Keep `COMPANION_PROVIDER=local` and `COMPANION_LOCAL_MODEL=companion-math`; start the local services first, then restart the app. A `.env` selects the provider but does not start services.

OpenAI remains an explicit alternative. Set `COMPANION_PROVIDER=openai`, add your own `OPENAI_API_KEY`, and restart. Reasoning defaults to `gpt-6.1-sol` through `COMPANION_MODEL`; submitted audio uses `gpt-transcribe`. This mode sends submitted content to OpenAI and requires internet access, API credit, and model access. The app never switches from local mode to cloud mode automatically. Real OpenAI calls have not been validated with user credentials.

</details>

## Group discussion design demo

Choose **Group discussion** in the reader, or open `/group.html` in the local browser preview. The intended pilot is one paper with the University of Washington theory group; no institutional endorsement or university service is implied.

The prototype keeps an original fixed-point passage beside questions, attributed contributions, review, and resolution history. Try contributing an explanation, reviewing a particular revision, resolving a question, then reopening it when a gap appears. The **Demo member** selector simulates participants on one device. It is not authentication or a permission boundary. Data stays in this browser/app profile, separately from personal notes and familiarity settings.

[DISCUSSION_FLOW.md](DISCUSSION_FLOW.md) describes the flow and which parts are implemented. The separate shared room now provides real local accounts and server-saved collaboration. This design demo keeps its simulated participants and browser-only data. Paper uploads and voice drafting in group discussions remain later work; its prepared AI-style example is a labeled illustration rather than a live answer.

For development, dictate requests into this Codex chat and describe independent tasks together. Codex can explore the interface and discussion design in parallel. Companion's own microphone currently routes mathematical questions to its selected provider; the app has no command bridge to this Codex conversation.

## Development and interfaces

| Interface | Open it with | Where its discussion data lives |
| --- | --- | --- |
| Math assistant | `Start Companion.cmd` | Personal notes and preferences in this browser |
| Shared reading room | Open **Shared room**, or `scripts/start-shared.ps1` | SQLite on this PC |
| Group discussion design demo | `/group.html` through `npm run preview` | This browser/app profile |
| Personal reader and corner | `scripts/start-local.ps1` | Personal app profile; selected AI provider answers questions |

- Local PDFs up to **10 MB and 20 pages**, selectable text, and page navigation. Extracted notation can be imperfect; scanned pages have no OCR.
- Explicit familiarity settings for Cauchy sequences, completeness, geometric series, and metric spaces. AI questions receive the settings; sample walkthroughs use the relevant prepared variations.
- A local glossary, passage enlargement, and single-variable plots using a restricted parser without `eval`. Use explicit multiplication such as `2*x`. Graphs are numerical sketches.
- Source-linked notes in localStorage, removal, and Markdown export. Export important notes; this prototype is not a backup service.
- Cancellation, stale-response protection, and optional read-aloud. Read-aloud starts disabled; local mode uses only a device voice marked local, or keeps the answer as text if none is available.

The app performs its own math actions. General PC control, following arbitrary external windows, proactive AI suggestions, symbolic algebra, and continuous voice remain future work.

The implementation uses Electron, plain JavaScript ES modules, HTML/CSS, and PDF.js. The Electron main process owns the provider connection; renderers have no Node integration.

```powershell
pnpm preview  # Browser preview at http://127.0.0.1:4173
npm run shared # Shared room at http://127.0.0.1:4174/room.html
pnpm test     # Math, tutor, PDF, provider, discussion, server and training-data checks
pnpm check    # JavaScript syntax checks
```

The older browser preview on port 4173 offers the prepared sample, local tools, PDF reading, and group design demo. The assistant on port 4174 connects to local AI and speech through its own bounded server endpoints. Its personal session does not grant reading-room membership. The native corner remains in the original Electron reader. Model weights, Ollama, the Python environment, speech helper, and server are separate from the packaged desktop app; retain the source checkout and runtime folders for the launch scripts.

The shared core and HTTP API have 18 automated tests covering member permissions, invitation races and expiry, revision conflicts, duplicate sends, restart persistence, and request boundaries. Test accounts use temporary or in-memory databases. See [QA.md](QA.md) for the final combined test run and browser checks, and [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidance.

## Training experiment

[`training/README.md`](training/README.md) describes a separate LoRA pilot using Qwen3.5-2B, original synthetic examples, and held-out before/after prompts. The first run completed 12 training steps and saved real adapter weights, but **failed mathematical quality review and was not activated**. The app keeps its separate Qwen3.5-4B model. See [`training/RESULTS.md`](training/RESULTS.md) for measured results and errors. Training output and model weights stay out of Git.

## Data, privacy, and verification limits

Opening a PDF and moving the pointer do not upload it. An explicit AI question sends the pinned passage, paper name/page, question, recent conversation, and familiarity settings to the selected provider. In local mode, those requests go to the loopback model service; recordings go to the loopback speech helper. There is no automatic cloud fallback. Initial package and model downloads contact their public repositories.

Audio stays in memory and the app/helper do not save recordings or transcripts to disk. Saved notes and preferences remain in the local app profile. Local read-aloud requires an offline device voice; optional cloud mode may use a system voice that requires a network connection. In OpenAI mode, submitted questions and audio are sent to OpenAI. Keep credentials, private papers, recordings, screenshots, and personal notes out of this public repository.

Shared-room questions, source passages, contributions, reviews, and resolutions are saved on the local server and visible to its authenticated members. The room does not read personal notes or familiarity settings, record audio, or call an AI service. Draft text stays in the page until submitted and is not a durable backup. Hosting, HTTPS, operational backups, and a membership policy must be chosen before colleagues can use a remote service.

The local model has answered test questions, but observed answers include proof gaps and an incorrect example detail. These checks establish working inference, not mathematical reliability. Speech was checked using computer-generated WAV and WebM/Opus recordings, including invalid-input and size-limit tests; actual microphone hardware, accents, and noisy-room performance still need testing. [QA.md](QA.md) records the checks and their limits.

[DESIGN.md](DESIGN.md) preserves the original product vision and proposed contracts. This README describes the current app; [ROADMAP.md](ROADMAP.md) separates implemented features from remaining work.
