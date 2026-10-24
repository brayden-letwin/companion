# Companion local fine-tuning pilot

This is a real **BF16 LoRA training workflow**, separate from the prompted model running in the app. A renamed Ollama model or a system prompt alone is not a fine-tune.

An actual local pilot completed on 2026-10-24 and saved a trained adapter. **It failed mathematical quality review and was not promoted into the app.** See [RESULTS.md](RESULTS.md) for measured training results, failure examples, and the paired evaluation outputs.

The pilot uses Qwen3.5-2B because the 12 GB GPU needs room for training activations. The app's initial inference model may be Qwen3.5-4B; compare the adapter against its own unchanged 2B base, not against a different model. Unsloth reports roughly 5 GB for the 2B BF16 LoRA setup and 10 GB for 4B; actual memory depends on context and settings. Its Qwen3.5 guide discourages 4-bit QLoRA, so this pilot keeps base weights in BF16.

## Data

`dataset.json` contains 24 original synthetic training examples and eight held-out evaluation examples. There are no private papers or conversations. Training focuses on concise intuitive explanations, explicit familiarity, missing assumptions, false premises, and requests for clarification. Held-out examples use different theorem families. This is enough for a small pipeline/style experiment, not evidence of broad mathematical improvement.

## Environment

Use an isolated Python 3.12 environment and CUDA-capable PyTorch. Never install into a system or shared project environment. The development machine used a virtual environment under the workspace's `work/.venv-training`, with model/package caches under `work/companion-training`.

An equivalent new setup, using your own chosen paths:

```powershell
uv venv --python 3.12 <venv-path>
uv pip install --python <venv-path>/Scripts/python.exe torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
uv pip install --python <venv-path>/Scripts/python.exe unsloth
```

First check `torch.cuda.is_available()` and a small CUDA tensor operation. Match the PyTorch CUDA build to a supported installed NVIDIA driver. The resolved package versions for an actual run are recorded in its manifest; preserve a package freeze for reproducibility.

`requirements-lock.txt` records the installed pilot environment (Python 3.12.14, PyTorch 2.14.1+cu130, Transformers 5.17.0, Unsloth 2026.10.8). To reproduce it, first install `torch==2.14.1+cu130 torchvision==0.29.1+cu130 torchaudio==2.11.0+cu130` from the CUDA index above, then install the remaining pinned packages with `uv pip install --python <venv-path>/Scripts/python.exe -r training/requirements-lock.txt`. Package availability and the NVIDIA driver must still be compatible. On this machine xformers did not match PyTorch, so Unsloth used PyTorch attention. Triton compiled its CUDA helper successfully; in restricted environments its child compiler needs permission to execute.

## Run

Commands below run from the repository root. Replace `<python>` with the isolated environment's Python executable and `<cache-path>` with a dedicated local cache directory.

```powershell
<python> training/train.py --dry-run
<python> training/train.py --download-only --cache <cache-path>
<python> training/train.py --run pilot-1 --steps 12 --max-seq-length 768 --max-minutes 20 --cache <cache-path>
```

Downloading fetches public base weights from Hugging Face; it does not upload data or train. The training command uses the cached snapshot and refuses to overwrite a run. Unload inference models before training so the GPU has room. The time budget stops training between optimizer steps; model loading, evaluation and saving are additional time. No external reporting service is enabled.

The script masks prompt tokens, trains only assistant responses, saves an adapter, and generates the same held-out questions before and after training. It never automatically promotes the adapter into Companion. Inspect `runs/<run>/manifest.json`, `training_metrics.json`, `before.json`, and `after.json`; use [rubric.md](rubric.md) to assess quality. A failed or unreviewed run is not a deployable improvement.

Model weights, caches and run outputs must remain ignored by Git. Once an adapter passes review, use a compatible merge/export workflow to produce a local inference model; adapters are not interchangeable across base models or revisions.

## References

- [Qwen3.5 fine-tuning guide](https://unsloth.ai/docs/models/qwen3.5/fine-tune)
- [Native Windows installation](https://unsloth.ai/docs/get-started/install/windows-installation)
- [LoRA method](https://huggingface.co/docs/peft/main/en/conceptual_guides/lora)

These sources describe the tools. They do not establish that this pilot improves Companion's answers.
